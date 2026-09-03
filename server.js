const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

// Keep claudedumb.com as the single canonical domain. Render terminates TLS and
// forwards the original Host header, so this also covers both HTTP and HTTPS.
app.use((req, res, next) => {
  const hostname = (req.hostname || '').toLowerCase();
  if (hostname === 'claudebad.com' || hostname === 'www.claudebad.com') {
    return res.redirect(301, `https://claudedumb.com${req.originalUrl}`);
  }
  next();
});

// Keep the sitemap aligned with the daily stories that are substantial enough
// to index. The checked-in file remains a resilient fallback if reporting data
// is temporarily unavailable.
app.get('/sitemap.xml', async (req, res) => {
  try {
    const days = 90;
    const votes = await db.getCommunityReportVotes(days);
    const report = buildCommunityReport(votes, days);
    const storyEntries = report.daily
      .filter(day => day.total >= 10)
      .map(day => sitemapEntry({
        loc: `https://claudedumb.com/reports/${day.day}`,
        lastmod: day.day === report.endDate ? report.updatedAt : day.day,
        image: `https://claudedumb.com/api/report-card/${day.day}/card.png?width=1080&theme=light`,
      }))
      .join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${sitemapEntry({ loc: 'https://claudedumb.com/' })}${sitemapEntry({ loc: 'https://claudedumb.com/reports', lastmod: report.updatedAt })}${storyEntries}</urlset>`;

    res.set({
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
    });
    res.send(xml);
  } catch (error) {
    console.error('Dynamic sitemap error:', error);
    res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---- R2 Storage ----
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';
let r2;
if (process.env.R2_ACCOUNT_ID) {
  r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function uploadToR2(key, buffer, contentType) {
  if (!r2) return null;
  await r2.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  return key;
}

async function saveScreenshot(voteId, fullBuffer, thumbBuffer) {
  const fullKey = `screenshots/${voteId}-full.png`;
  const thumbKey = `screenshots/${voteId}-thumb.jpg`;

  if (r2) {
    await Promise.all([
      uploadToR2(fullKey, fullBuffer, 'image/png'),
      uploadToR2(thumbKey, thumbBuffer, 'image/jpeg'),
    ]);
  } else {
    const dir = path.join(__dirname, 'uploads', 'screenshots');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(__dirname, 'uploads', fullKey), fullBuffer);
    fs.writeFileSync(path.join(__dirname, 'uploads', thumbKey), thumbBuffer);
  }

  return fullKey;
}

function getScreenshotUrl(key, thumb = false) {
  if (!key) return null;
  const k = thumb ? key.replace(/-full\.(jpg|png)/, '-thumb.jpg') : key;
  if (R2_PUBLIC_URL) return `${R2_PUBLIC_URL}/${k}`;
  return `/uploads/${k}`;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function sitemapEntry({ loc, lastmod, image }) {
  return `  <url>
    <loc>${escapeXml(loc)}</loc>${lastmod ? `
    <lastmod>${escapeXml(lastmod)}</lastmod>` : ''}${image ? `
    <image:image>
      <image:loc>${escapeXml(image)}</image:loc>
    </image:image>` : ''}
  </url>
`;
}

// ---- Multer ----
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mimetype));
  },
});

function handleUpload(req, res, next) {
  upload.single('screenshot')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Screenshot must be under 5MB' });
      return res.status(400).json({ error: 'Upload error' });
    }
    next();
  });
}

// ---- Database abstraction: PostgreSQL (production) or SQLite (local dev) ----
let db;

if (process.env.DATABASE_URL) {
  // PostgreSQL
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  db = {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS votes (
          id SERIAL PRIMARY KEY,
          vote TEXT NOT NULL CHECK(vote IN ('smart', 'dumb')),
          latitude DOUBLE PRECISION,
          longitude DOUBLE PRECISION,
          city TEXT,
          comment TEXT,
          ip TEXT,
          screenshot_key TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_votes_created_at ON votes(created_at)`);
      await pool.query(`ALTER TABLE votes ADD COLUMN IF NOT EXISTS screenshot_key TEXT`).catch(() => {});

      await pool.query(`
        CREATE TABLE IF NOT EXISTS reactions (
          id SERIAL PRIMARY KEY,
          vote_id INTEGER NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('up', 'down')),
          ip TEXT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(vote_id, ip)
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_reactions_vote_id ON reactions(vote_id)`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS share_clicks (
          id SERIAL PRIMARY KEY,
          vote_id INTEGER NOT NULL,
          ip TEXT NOT NULL,
          referrer TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(vote_id, ip)
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_share_clicks_vote_id ON share_clicks(vote_id)`);

      console.log('PostgreSQL connected');
    },
    async getRecentVotes() {
      const { rows } = await pool.query(`
        SELECT vote, latitude, longitude, city, comment, created_at,
               EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600 as hours_ago
        FROM votes
        WHERE created_at > NOW() - INTERVAL '24 hours'
          AND latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY created_at DESC
      `);
      return rows;
    },
    async getVoteCounts() {
      const { rows } = await pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN vote = 'smart' THEN 1 ELSE 0 END), 0)::int as smart,
          COALESCE(SUM(CASE WHEN vote = 'dumb' THEN 1 ELSE 0 END), 0)::int as dumb
        FROM votes
        WHERE created_at > NOW() - INTERVAL '1 hour'
      `);
      return rows[0];
    },
    async getHourlyVotes() {
      const { rows } = await pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('hour', created_at), 'YYYY-MM-DD HH24:00:00') as hour,
          COALESCE(SUM(CASE WHEN vote = 'smart' THEN 1 ELSE 0 END), 0)::int as smart,
          COALESCE(SUM(CASE WHEN vote = 'dumb' THEN 1 ELSE 0 END), 0)::int as dumb
        FROM votes
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY DATE_TRUNC('hour', created_at)
        ORDER BY hour ASC
      `);
      return rows;
    },
    async getVibes() {
      const { rows } = await pool.query(`
        SELECT
          COALESCE(SUM(CASE WHEN vote = 'smart' THEN 1 ELSE 0 END), 0)::int as smart,
          COALESCE(SUM(CASE WHEN vote = 'dumb' THEN 1 ELSE 0 END), 0)::int as dumb
        FROM votes
        WHERE created_at > NOW() - INTERVAL '24 hours'
      `);
      return rows[0];
    },
    async getDailyVotes() {
      const { rows } = await pool.query(`
        SELECT
          TO_CHAR(DATE_TRUNC('day', created_at), 'YYYY-MM-DD') as day,
          COALESCE(SUM(CASE WHEN vote = 'smart' THEN 1 ELSE 0 END), 0)::int as smart,
          COALESCE(SUM(CASE WHEN vote = 'dumb' THEN 1 ELSE 0 END), 0)::int as dumb
        FROM votes
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY DATE_TRUNC('day', created_at)
        ORDER BY day ASC
      `);
      return rows;
    },
    async getCommunityReportVotes(days = 30) {
      const safeDays = Math.min(Math.max(Number.parseInt(days, 10) || 30, 7), 730);
      const { rows } = await pool.query(`
        SELECT vote, city, comment, screenshot_key, created_at
        FROM votes
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY created_at ASC
      `, [safeDays]);
      return rows;
    },
    async getCommunityReportVotesForRange(startDay, endDay) {
      const { rows } = await pool.query(`
        SELECT vote, city, comment, screenshot_key, created_at
        FROM votes
        WHERE created_at >= $1::date
          AND created_at < ($2::date + INTERVAL '1 day')
        ORDER BY created_at ASC
      `, [startDay, endDay]);
      return rows;
    },
    async getRecentVoteByIP(ip) {
      const { rows } = await pool.query(
        `SELECT id FROM votes WHERE ip = $1 AND created_at > NOW() - INTERVAL '5 minutes'`,
        [ip]
      );
      return rows[0] || null;
    },
    async insertVote(vote, latitude, longitude, city, comment, ip) {
      const { rows } = await pool.query(
        `INSERT INTO votes (vote, latitude, longitude, city, comment, ip) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [vote, latitude, longitude, city, comment, ip]
      );
      return rows[0].id;
    },
    async updateVoteScreenshot(id, screenshotKey) {
      await pool.query(`UPDATE votes SET screenshot_key = $1 WHERE id = $2`, [screenshotKey, id]);
    },
    async getVoteById(id) {
      const { rows } = await pool.query(
        `SELECT id, vote, comment, city, screenshot_key, created_at FROM votes WHERE id = $1`, [id]
      );
      return rows[0] || null;
    },
    async getWallItems(limit, offset, ip) {
      const { rows } = await pool.query(`
        SELECT v.id, v.vote, v.comment, v.city, v.latitude, v.longitude, v.created_at, v.screenshot_key,
          COALESCE(r.score, 0)::int as score,
          COALESCE(r.ups, 0)::int as ups,
          COALESCE(r.downs, 0)::int as downs,
          ur.type as user_reaction
        FROM votes v
        LEFT JOIN (
          SELECT vote_id,
            SUM(CASE WHEN type='up' THEN 1 ELSE 0 END) - SUM(CASE WHEN type='down' THEN 1 ELSE 0 END) as score,
            SUM(CASE WHEN type='up' THEN 1 ELSE 0 END) as ups,
            SUM(CASE WHEN type='down' THEN 1 ELSE 0 END) as downs
          FROM reactions GROUP BY vote_id
        ) r ON r.vote_id = v.id
        LEFT JOIN reactions ur ON ur.vote_id = v.id AND ur.ip = $3
        WHERE v.comment IS NOT NULL AND v.comment != ''
        ORDER BY (COALESCE(r.score, 0) + 1.0 + CASE WHEN v.screenshot_key IS NOT NULL THEN 3.0 ELSE 0.0 END) / POWER(EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 3600 + 2, 1.5) DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset, ip]);
      return rows;
    },
    async getFeedNewest(limit, offset, ip) {
      const { rows } = await pool.query(`
        SELECT v.id, v.vote, v.comment, v.city, v.latitude, v.longitude, v.screenshot_key, v.created_at,
          EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 3600 as hours_ago,
          COALESCE(r.score, 0)::int as score,
          ur.type as user_reaction
        FROM votes v
        LEFT JOIN (
          SELECT vote_id, SUM(CASE WHEN type='up' THEN 1 ELSE -1 END) as score
          FROM reactions GROUP BY vote_id
        ) r ON r.vote_id = v.id
        LEFT JOIN reactions ur ON ur.vote_id = v.id AND ur.ip = $3
        ORDER BY v.created_at DESC
        LIMIT $1 OFFSET $2
      `, [limit, offset, ip]);
      return rows;
    },
    async getFeedPostById(id, ip) {
      const { rows } = await pool.query(`
        SELECT v.id, v.vote, v.comment, v.city, v.latitude, v.longitude, v.screenshot_key, v.created_at,
          EXTRACT(EPOCH FROM (NOW() - v.created_at)) / 3600 as hours_ago,
          COALESCE(r.score, 0)::int as score,
          ur.type as user_reaction
        FROM votes v
        LEFT JOIN (
          SELECT vote_id, SUM(CASE WHEN type='up' THEN 1 ELSE -1 END) as score
          FROM reactions GROUP BY vote_id
        ) r ON r.vote_id = v.id
        LEFT JOIN reactions ur ON ur.vote_id = v.id AND ur.ip = $2
        WHERE v.id = $1
      `, [id, ip]);
      return rows[0] || null;
    },
    async getReactionScore(voteId) {
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(CASE WHEN type='up' THEN 1 ELSE -1 END), 0)::int as score FROM reactions WHERE vote_id = $1`,
        [voteId]
      );
      return rows[0].score;
    },
    async getUserReaction(voteId, ip) {
      const { rows } = await pool.query(
        `SELECT type FROM reactions WHERE vote_id = $1 AND ip = $2`, [voteId, ip]
      );
      return rows[0] || null;
    },
    async upsertReaction(voteId, ip, type) {
      await pool.query(
        `INSERT INTO reactions (vote_id, type, ip) VALUES ($1, $2, $3)
         ON CONFLICT (vote_id, ip) DO UPDATE SET type = EXCLUDED.type`,
        [voteId, type, ip]
      );
    },
    async deleteReaction(voteId, ip) {
      await pool.query(`DELETE FROM reactions WHERE vote_id = $1 AND ip = $2`, [voteId, ip]);
    },
    async trackShareClick(voteId, ip, referrer) {
      await pool.query(
        `INSERT INTO share_clicks (vote_id, ip, referrer) VALUES ($1, $2, $3) ON CONFLICT (vote_id, ip) DO NOTHING`,
        [voteId, ip, referrer]
      ).catch(() => {});
    },
    async getLeaderboard(limit) {
      const { rows } = await pool.query(`
        SELECT v.id, v.comment, v.city, v.screenshot_key, v.created_at,
               COUNT(DISTINCT sc.ip)::int as influence
        FROM votes v
        JOIN share_clicks sc ON sc.vote_id = v.id
        WHERE v.screenshot_key IS NOT NULL
        GROUP BY v.id, v.comment, v.city, v.screenshot_key, v.created_at
        ORDER BY influence DESC
        LIMIT $1
      `, [limit]);
      return rows;
    },
  };
} else {
  // SQLite for local dev
  const Database = require('better-sqlite3');
  const sqliteDb = new Database(path.join(__dirname, 'votes.db'));
  sqliteDb.pragma('journal_mode = WAL');

  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vote TEXT NOT NULL CHECK(vote IN ('smart', 'dumb')),
      latitude REAL,
      longitude REAL,
      city TEXT,
      comment TEXT,
      ip TEXT,
      screenshot_key TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try { sqliteDb.exec("ALTER TABLE votes ADD COLUMN city TEXT"); } catch {}
  try { sqliteDb.exec("ALTER TABLE votes ADD COLUMN comment TEXT"); } catch {}
  try { sqliteDb.exec("ALTER TABLE votes ADD COLUMN screenshot_key TEXT"); } catch {}

  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vote_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('up', 'down')),
      ip TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(vote_id, ip)
    )
  `);

  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS share_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vote_id INTEGER NOT NULL,
      ip TEXT NOT NULL,
      referrer TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(vote_id, ip)
    )
  `);

  db = {
    async init() { console.log('SQLite connected'); },
    async getRecentVotes() {
      return sqliteDb.prepare(`
        SELECT vote, latitude, longitude, city, comment, created_at,
               (julianday('now') - julianday(created_at)) * 24 as hours_ago
        FROM votes
        WHERE created_at > datetime('now', '-24 hours')
          AND latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY created_at DESC
      `).all();
    },
    async getVoteCounts() {
      return sqliteDb.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN vote = 'smart' THEN 1 ELSE 0 END), 0) as smart,
          COALESCE(SUM(CASE WHEN vote = 'dumb' THEN 1 ELSE 0 END), 0) as dumb
        FROM votes
        WHERE created_at > datetime('now', '-1 hour')
      `).get();
    },
    async getHourlyVotes() {
      return sqliteDb.prepare(`
        SELECT
          strftime('%Y-%m-%d %H:00:00', created_at) as hour,
          COALESCE(SUM(CASE WHEN vote = 'smart' THEN 1 ELSE 0 END), 0) as smart,
          COALESCE(SUM(CASE WHEN vote = 'dumb' THEN 1 ELSE 0 END), 0) as dumb
        FROM votes
        WHERE created_at > datetime('now', '-24 hours')
        GROUP BY strftime('%Y-%m-%d %H', created_at)
        ORDER BY hour ASC
      `).all();
    },
    async getVibes() {
      return sqliteDb.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN vote = 'smart' THEN 1 ELSE 0 END), 0) as smart,
          COALESCE(SUM(CASE WHEN vote = 'dumb' THEN 1 ELSE 0 END), 0) as dumb
        FROM votes
        WHERE created_at > datetime('now', '-24 hours')
      `).get();
    },
    async getDailyVotes() {
      return sqliteDb.prepare(`
        SELECT
          strftime('%Y-%m-%d', created_at) as day,
          COALESCE(SUM(CASE WHEN vote = 'smart' THEN 1 ELSE 0 END), 0) as smart,
          COALESCE(SUM(CASE WHEN vote = 'dumb' THEN 1 ELSE 0 END), 0) as dumb
        FROM votes
        WHERE created_at > datetime('now', '-7 days')
        GROUP BY strftime('%Y-%m-%d', created_at)
        ORDER BY day ASC
      `).all();
    },
    async getCommunityReportVotes(days = 30) {
      const safeDays = Math.min(Math.max(Number.parseInt(days, 10) || 30, 7), 730);
      return sqliteDb.prepare(`
        SELECT vote, city, comment, screenshot_key, created_at
        FROM votes
        WHERE created_at >= datetime('now', ?)
        ORDER BY created_at ASC
      `).all(`-${safeDays} days`);
    },
    async getCommunityReportVotesForRange(startDay, endDay) {
      return sqliteDb.prepare(`
        SELECT vote, city, comment, screenshot_key, created_at
        FROM votes
        WHERE created_at >= datetime(?)
          AND created_at < datetime(?, '+1 day')
        ORDER BY created_at ASC
      `).all(startDay, endDay);
    },
    async getRecentVoteByIP(ip) {
      return sqliteDb.prepare(
        `SELECT id FROM votes WHERE ip = ? AND created_at > datetime('now', '-5 minutes')`
      ).get(ip) || null;
    },
    async insertVote(vote, latitude, longitude, city, comment, ip) {
      const info = sqliteDb.prepare(
        'INSERT INTO votes (vote, latitude, longitude, city, comment, ip) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(vote, latitude, longitude, city, comment, ip);
      return Number(info.lastInsertRowid);
    },
    async updateVoteScreenshot(id, screenshotKey) {
      sqliteDb.prepare('UPDATE votes SET screenshot_key = ? WHERE id = ?').run(screenshotKey, id);
    },
    async getVoteById(id) {
      return sqliteDb.prepare(
        'SELECT id, vote, comment, city, screenshot_key, created_at FROM votes WHERE id = ?'
      ).get(id) || null;
    },
    async getWallItems(limit, offset, ip) {
      return sqliteDb.prepare(`
        SELECT v.id, v.vote, v.comment, v.city, v.latitude, v.longitude, v.created_at, v.screenshot_key,
          COALESCE(r.score, 0) as score,
          COALESCE(r.ups, 0) as ups,
          COALESCE(r.downs, 0) as downs,
          ur.type as user_reaction
        FROM votes v
        LEFT JOIN (
          SELECT vote_id,
            SUM(CASE WHEN type='up' THEN 1 ELSE 0 END) - SUM(CASE WHEN type='down' THEN 1 ELSE 0 END) as score,
            SUM(CASE WHEN type='up' THEN 1 ELSE 0 END) as ups,
            SUM(CASE WHEN type='down' THEN 1 ELSE 0 END) as downs
          FROM reactions GROUP BY vote_id
        ) r ON r.vote_id = v.id
        LEFT JOIN reactions ur ON ur.vote_id = v.id AND ur.ip = ?
        WHERE v.comment IS NOT NULL AND v.comment != ''
        ORDER BY CAST(COALESCE(r.score, 0) + 1 + CASE WHEN v.screenshot_key IS NOT NULL THEN 3 ELSE 0 END AS REAL) / (((julianday('now') - julianday(v.created_at)) * 24 + 2) * ((julianday('now') - julianday(v.created_at)) * 24 + 2)) DESC
        LIMIT ? OFFSET ?
      `).all(ip, limit, offset);
    },
    async getFeedNewest(limit, offset, ip) {
      return sqliteDb.prepare(`
        SELECT v.id, v.vote, v.comment, v.city, v.latitude, v.longitude, v.screenshot_key, v.created_at,
          (julianday('now') - julianday(v.created_at)) * 24 as hours_ago,
          COALESCE(r.score, 0) as score,
          ur.type as user_reaction
        FROM votes v
        LEFT JOIN (
          SELECT vote_id, SUM(CASE WHEN type='up' THEN 1 ELSE -1 END) as score
          FROM reactions GROUP BY vote_id
        ) r ON r.vote_id = v.id
        LEFT JOIN reactions ur ON ur.vote_id = v.id AND ur.ip = ?
        ORDER BY v.created_at DESC
        LIMIT ? OFFSET ?
      `).all(ip, limit, offset);
    },
    async getFeedPostById(id, ip) {
      return sqliteDb.prepare(`
        SELECT v.id, v.vote, v.comment, v.city, v.latitude, v.longitude, v.screenshot_key, v.created_at,
          (julianday('now') - julianday(v.created_at)) * 24 as hours_ago,
          COALESCE(r.score, 0) as score,
          ur.type as user_reaction
        FROM votes v
        LEFT JOIN (
          SELECT vote_id, SUM(CASE WHEN type='up' THEN 1 ELSE -1 END) as score
          FROM reactions GROUP BY vote_id
        ) r ON r.vote_id = v.id
        LEFT JOIN reactions ur ON ur.vote_id = v.id AND ur.ip = ?
        WHERE v.id = ?
      `).get(ip, id) || null;
    },
    async getReactionScore(voteId) {
      const row = sqliteDb.prepare(
        `SELECT COALESCE(SUM(CASE WHEN type='up' THEN 1 ELSE -1 END), 0) as score FROM reactions WHERE vote_id = ?`
      ).get(voteId);
      return row.score;
    },
    async getUserReaction(voteId, ip) {
      return sqliteDb.prepare(
        'SELECT type FROM reactions WHERE vote_id = ? AND ip = ?'
      ).get(voteId, ip) || null;
    },
    async upsertReaction(voteId, ip, type) {
      sqliteDb.prepare(
        `INSERT INTO reactions (vote_id, type, ip) VALUES (?, ?, ?)
         ON CONFLICT (vote_id, ip) DO UPDATE SET type = excluded.type`
      ).run(voteId, type, ip);
    },
    async deleteReaction(voteId, ip) {
      sqliteDb.prepare('DELETE FROM reactions WHERE vote_id = ? AND ip = ?').run(voteId, ip);
    },
    async trackShareClick(voteId, ip, referrer) {
      try {
        sqliteDb.prepare(
          'INSERT OR IGNORE INTO share_clicks (vote_id, ip, referrer) VALUES (?, ?, ?)'
        ).run(voteId, ip, referrer);
      } catch {}
    },
    async getLeaderboard(limit) {
      return sqliteDb.prepare(`
        SELECT v.id, v.comment, v.city, v.screenshot_key, v.created_at,
               COUNT(DISTINCT sc.ip) as influence
        FROM votes v
        JOIN share_clicks sc ON sc.vote_id = v.id
        WHERE v.screenshot_key IS NOT NULL
        GROUP BY v.id
        ORDER BY influence DESC
        LIMIT ?
      `).all(limit);
    },
  };
}

// ---- IP Geolocation cache ----
const geoCache = new Map();

async function geolocateIP(ip) {
  if (!ip || ip === '::1' || ip === '127.0.0.1' || ip.startsWith('192.168.') || ip.startsWith('10.')) {
    return null;
  }
  if (geoCache.has(ip)) return geoCache.get(ip);
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,lat,lon,city,country`);
    const data = await res.json();
    if (data.status === 'success') {
      const result = { lat: data.lat, lng: data.lon, city: data.city, country: data.country };
      geoCache.set(ip, result);
      return result;
    }
  } catch {}
  geoCache.set(ip, null);
  return null;
}

// ---- Crawlable community report ----
function utcDay(date) {
  const value = typeof date === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:/.test(date)
    ? `${date.replace(' ', 'T')}Z`
    : date;
  return new Date(value).toISOString().slice(0, 10);
}

function summarizeVotes(rows) {
  const summary = rows.reduce((sum, row) => ({
    smart: sum.smart + row.smart,
    dumb: sum.dumb + row.dumb,
    total: sum.total + row.total,
  }), { smart: 0, dumb: 0, total: 0 });
  return {
    ...summary,
    dumbPercent: summary.total ? Math.round((summary.dumb / summary.total) * 100) : 0,
  };
}

function classifyCommunitySignal(total, dumbPercent) {
  if (total < 3) return { label: 'QUIET', headline: 'Not enough signal yet', accent: '#aaa39a' };
  if (dumbPercent >= 80) return { label: 'ROUGH', headline: 'Community signal was rough', accent: '#e36b2b' };
  if (dumbPercent >= 65) return { label: 'SHAKY', headline: 'Claude had a shaky day', accent: '#e3a52b' };
  if (dumbPercent >= 45) return { label: 'MIXED', headline: 'The community was split', accent: '#6f8fa8' };
  return { label: 'SOLID', headline: 'Claude had a solid day', accent: '#58b985' };
}

function formatReportDate(day, options = {}) {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: options.short ? 'short' : 'long',
    day: 'numeric',
    year: options.noYear ? undefined : 'numeric',
    timeZone: 'UTC',
  });
}

function reportNoun(count) {
  return count === 1 ? 'report' : 'reports';
}

function comparisonCopy(story) {
  if (story.baselineDumbPercent === null) return 'There is not enough prior data for a seven-day comparison.';
  const magnitude = Math.abs(story.deltaVsBaseline);
  if (magnitude <= 4) return `That was roughly in line with the prior seven-day baseline of ${story.baselineDumbPercent}% negative.`;
  const direction = story.deltaVsBaseline > 0 ? 'more' : 'less';
  return `That was ${magnitude} percentage points ${direction} negative than the prior seven-day baseline.`;
}

function buildCommunityReport(votes, days = 30, endDate = new Date()) {
  const windowEnd = new Date(endDate);
  const dayRows = new Map();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(windowEnd);
    date.setUTCDate(date.getUTCDate() - offset);
    const day = utcDay(date);
    dayRows.set(day, { day, smart: 0, dumb: 0, total: 0, contextReports: 0, countries: new Map() });
  }

  const countries = new Map();
  let contextReports = 0;
  for (const row of votes) {
    const day = dayRows.get(utcDay(row.created_at));
    if (!day || (row.vote !== 'smart' && row.vote !== 'dumb')) continue;
    day[row.vote] += 1;
    day.total += 1;
    if (row.comment || row.screenshot_key) {
      day.contextReports += 1;
      contextReports += 1;
    }
    if (row.city) {
      const country = String(row.city).split(',').pop().trim();
      if (country) {
        day.countries.set(country, (day.countries.get(country) || 0) + 1);
        countries.set(country, (countries.get(country) || 0) + 1);
      }
    }
  }

  const daily = [...dayRows.values()];
  daily.forEach((row, index) => {
    row.dumbPercent = row.total ? Math.round((row.dumb / row.total) * 100) : 0;
    row.signal = classifyCommunitySignal(row.total, row.dumbPercent);
    const baseline = summarizeVotes(daily.slice(Math.max(0, index - 7), index));
    row.baselineDumbPercent = baseline.total ? baseline.dumbPercent : null;
    row.deltaVsBaseline = baseline.total ? row.dumbPercent - baseline.dumbPercent : 0;
    if (row.total >= 5 && baseline.total && row.deltaVsBaseline >= 12) {
      row.signal = { label: 'SPIKE', headline: 'Negative reports jumped', accent: '#e36b2b' };
    } else if (row.total >= 5 && baseline.total && row.deltaVsBaseline <= -12) {
      row.signal = { label: 'RECOVERY', headline: 'Claude bounced back', accent: '#58b985' };
    }
    row.visibleCountries = [...row.countries.entries()]
      .filter(([, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1])
      .map(([country, count]) => ({ country, count }));
    delete row.countries;
  });

  const totalSummary = summarizeVotes(daily);
  const lastSeven = summarizeVotes(daily.slice(-7));
  const previousSeven = summarizeVotes(daily.slice(-14, -7));
  const peakDay = daily.reduce((peak, row) => row.total > peak.total ? row : peak, daily[0]);
  const visibleCountries = [...countries.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([country, count]) => ({ country, count }));

  return {
    days,
    startDate: daily[0].day,
    endDate: daily[daily.length - 1].day,
    updatedAt: new Date().toISOString(),
    daily,
    ...totalSummary,
    lastSeven,
    previousSeven,
    weekDelta: previousSeven.total ? lastSeven.dumbPercent - previousSeven.dumbPercent : 0,
    peakDay,
    contextReports,
    visibleCountries,
  };
}

function renderTrendBars(days) {
  const maxTotal = Math.max(...days.map(day => day.total), 1);
  return days.map(day => {
    const height = Math.max(8, Math.round((day.total / maxTotal) * 100));
    const label = `${formatReportDate(day.day, { short: true })}: ${day.total} ${reportNoun(day.total)}, ${day.dumbPercent}% negative`;
    const contents = `<span class="trend-bar" style="--height:${height}%;--negative:${day.dumbPercent}%;--signal:${day.signal.accent}"></span><span>${new Date(`${day.day}T00:00:00Z`).getUTCDate()}</span>`;
    return day.total
      ? `<a class="trend-day" href="/reports/${day.day}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${contents}</a>`
      : `<span class="trend-day" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${contents}</span>`;
  }).join('');
}

function renderDailyCard(story, index) {
  const alt = `Claude community report for ${formatReportDate(story.day)}: ${story.dumbPercent}% negative from ${story.total} ${reportNoun(story.total)}`;
  return `<article class="dispatch-card" data-report-day="${story.day}">
    <a class="dispatch-image-link" href="/reports/${story.day}">
      <img src="/api/report-card/${story.day}/card.png?width=540&amp;theme=light" srcset="/api/report-card/${story.day}/card.png?width=540&amp;theme=light 540w, /api/report-card/${story.day}/card.png?width=1080&amp;theme=light 1080w" sizes="(max-width: 700px) 82vw, 390px" width="540" height="675" alt="${escapeHtml(alt)}" ${index ? 'loading="lazy"' : ''}>
    </a>
    <div class="dispatch-caption">
      <a href="/reports/${story.day}" aria-label="Read the ${formatReportDate(story.day)} report"><time datetime="${story.day}">${formatReportDate(story.day, { short: true })}</time><strong>${escapeHtml(story.signal.headline)}</strong></a>
    </div>
  </article>`;
}

function reportDocumentHead({ title, description, canonical, image, robots = 'index, follow, max-image-preview:large', schema, ogType = 'article' }) {
  return `<meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta name="robots" content="${robots}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="${ogType}">
  <meta property="og:site_name" content="claudedumb.com">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${canonical}">
  ${image ? `<meta property="og:image" content="${escapeHtml(image)}">
  <meta property="og:image:width" content="1080">
  <meta property="og:image:height" content="1350">` : ''}
  <meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
  ${schema ? `<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>` : ''}
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/reports.css">`;
}

function renderReportHeader() {
  return `<header class="site-header">
    <a href="/" class="logo">claude<span>dumb</span><small>.com</small></a>
    <nav><a class="header-cta" href="/">← Live status &amp; report</a></nav>
  </header>`;
}

function renderCommunityReportPage(report) {
  const lead = report.daily.slice().reverse().find(day => day.total > 0) || report.daily[report.daily.length - 1];
  const leadIsToday = lead.day === report.endDate;
  const feedDays = report.daily.slice().reverse().filter(day => day.total > 0).slice(0, 14);
  const trendDays = report.daily.slice(-14);
  const weekDirection = Math.abs(report.weekDelta) <= 4
    ? 'about even with the previous week'
    : `${Math.abs(report.weekDelta)} points ${report.weekDelta > 0 ? 'more' : 'less'} negative than the previous week`;
  const description = `${lead.dumbPercent}% of ${lead.total} Claude community ${reportNoun(lead.total)} were negative in the latest daily signal. Explore the visual dispatch and 30-day history.`;
  const canonical = 'https://claudedumb.com/reports';
  const image = lead.total ? `https://claudedumb.com/api/report-card/${lead.day}/card.png?width=1080&theme=light` : null;
  const schema = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'CollectionPage', name: 'Claude Community Dispatch', url: canonical, dateModified: report.updatedAt, ...(image ? { primaryImageOfPage: image } : {}) },
      { '@type': 'Dataset', name: 'Claude Community Quality Reports', url: canonical, temporalCoverage: `${report.startDate}/${report.endDate}`, creator: { '@type': 'Organization', name: 'claudedumb.com' }, measurementTechnique: 'Voluntary community reports submitted to claudedumb.com' },
    ],
  };
  const dailyRows = report.daily.slice().reverse().map(row => `<tr><th scope="row"><a href="/reports/${row.day}">${formatReportDate(row.day, { short: true })}</a></th><td>${row.total}</td><td>${row.smart}</td><td>${row.dumb}</td><td>${row.dumbPercent}%</td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  ${reportDocumentHead({ title: 'Claude Vibe Dispatch: Daily Community Stories', description, canonical, image, schema, ogType: 'website' })}
</head>
<body>
  ${renderReportHeader()}
  <main>
    <nav class="crumb" aria-label="Breadcrumb"><a href="/">Home</a> / Dispatches</nav>
    <section class="lead-story" style="--lead-accent:${lead.signal.accent}">
      <div class="lead-copy">
        <p class="eyebrow">${leadIsToday ? 'Today’s dispatch' : 'Latest dispatch'} · ${formatReportDate(lead.day, { short: true })}${leadIsToday ? ' · updating' : ''}</p>
        <span class="signal-stamp">${lead.signal.label}</span>
        <h1>${escapeHtml(lead.signal.headline)}.</h1>
        <p class="lead-dek"><strong>${lead.dumbPercent}% negative</strong> from ${lead.total} community ${reportNoun(lead.total)}${leadIsToday ? ' so far today' : ''}. ${comparisonCopy(lead)}</p>
        ${lead.total ? '' : '<a class="primary-action" href="/">Be the first to report</a>'}
      </div>
      <div class="signal-now" aria-label="Today’s Claude community signal">
        <span>negative share</span><strong>${lead.dumbPercent}%</strong><small>${lead.dumb} dumb · ${lead.smart} smart</small>
      </div>
    </section>

    <section class="trend-strip" aria-labelledby="trend-title">
      <div class="section-intro"><div><p class="eyebrow">Fourteen-day pulse</p><h2 id="trend-title">The shape of the signal</h2></div><p>${report.lastSeven.total} ${reportNoun(report.lastSeven.total)} this week · ${report.lastSeven.dumbPercent}% negative · ${weekDirection}.</p></div>
      <div class="trend-bars">${renderTrendBars(trendDays)}</div>
      <div class="trend-legend"><span><i class="legend-dumb"></i> negative</span><span><i class="legend-smart"></i> positive</span><small>bar height = report volume</small></div>
    </section>

    <section class="dispatch-section" aria-labelledby="dispatch-title">
      <div class="section-intro dispatch-intro"><div><p class="eyebrow">Daily evidence</p><h2 id="dispatch-title">Recent reports</h2></div><div class="dispatch-tools"><p>Swipe through each day.</p><div class="rail-controls"><button type="button" id="dispatch-prev" aria-label="Previous dispatch">←</button><span id="dispatch-position">1 / ${feedDays.length}</span><button type="button" id="dispatch-next" aria-label="Next dispatch">→</button></div></div></div>
      <div class="dispatch-rail" id="dispatch-rail" tabindex="0">${feedDays.length ? feedDays.map(renderDailyCard).join('') : '<p class="empty-dispatch">No daily dispatches yet. Community reports will appear here.</p>'}</div>
    </section>

    <details class="source-notes">
      <summary><span>Methodology and complete 30-day data</span><small>View source notes ↓</small></summary>
      <div class="source-grid">
        <div class="table-wrap"><table><thead><tr><th>Date</th><th>Total</th><th>Smart</th><th>Dumb</th><th>Negative</th></tr></thead><tbody>${dailyRows}</tbody></table></div>
        <aside><h2>How to read this</h2><p class="source-summary">${report.contextReports} reports included context. ${report.visibleCountries.length} countries cleared the privacy threshold.</p><ul><li>Reports are voluntary community submissions, not unique users.</li><li>“Dumb” can mean poor quality, slowness, an error, or an outage.</li><li>Daily boundaries use UTC and today remains incomplete.</li><li>Locations are approximate and only shown at country level after three reports.</li></ul><a href="https://status.claude.com/" target="_blank" rel="noopener">Compare Claude’s official status ↗</a></aside>
      </div>
    </details>
  </main>
  <footer>Independent community tracker · not affiliated with Anthropic</footer>
  <script src="/analytics.js"></script>
  <script src="/reports.js"></script>
</body>
</html>`;
}

function renderDailyStoryPage(report, story) {
  const date = formatReportDate(story.day);
  const title = `${story.signal.headline}: Claude Community Report for ${date}`;
  const description = `${story.dumbPercent}% of ${story.total} community ${reportNoun(story.total)} rated Claude negatively on ${date}. ${comparisonCopy(story)}`;
  const canonical = `https://claudedumb.com/reports/${story.day}`;
  const image = `https://claudedumb.com/api/report-card/${story.day}/card.png?width=1080&theme=light`;
  const robots = story.total >= 10 ? 'index, follow, max-image-preview:large' : 'noindex, follow, max-image-preview:large';
  const schema = {
    '@context': 'https://schema.org', '@type': 'Article', headline: title, description, url: canonical, image,
    datePublished: `${story.day}T23:59:00Z`, dateModified: story.day === utcDay(new Date()) ? report.updatedAt : `${story.day}T23:59:00Z`,
    author: { '@type': 'Organization', name: 'claudedumb.com', url: 'https://claudedumb.com/' },
    mainEntityOfPage: canonical,
  };
  const countryCopy = story.visibleCountries.length
    ? `The country-level sample included ${story.visibleCountries.map(item => `${item.country} (${item.count})`).join(', ')}.`
    : 'No country cleared the three-report privacy threshold for this day.';

  return `<!DOCTYPE html><html lang="en"><head>${reportDocumentHead({ title, description, canonical, image, robots, schema })}</head>
<body>${renderReportHeader()}<main>
  <nav class="crumb" aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/reports">Dispatches</a> / ${date}</nav>
  <article class="story-layout" style="--lead-accent:${story.signal.accent}">
    <div class="story-copy">
      <p class="eyebrow">Daily dispatch · ${date}${story.day === utcDay(new Date()) ? ' · updating' : ''}</p>
      <span class="signal-stamp">${story.signal.label}</span>
      <h1>${escapeHtml(story.signal.headline)}.</h1>
      <p class="story-lede">On ${date}, the community submitted <strong>${story.total} ${reportNoun(story.total)}</strong>. ${story.dumb} marked Claude dumb and ${story.smart} marked it smart, producing a <strong>${story.dumbPercent}% negative signal</strong>.</p>
      <p>${comparisonCopy(story)} ${countryCopy}</p>
      <p class="caveat">This describes community perception, not a verified root cause or official incident. A negative report may reflect response quality, slowness, an error, or an outage.</p>
    </div>
    <figure class="story-visual"><img src="/api/report-card/${story.day}/card.png?width=540&amp;theme=light" srcset="/api/report-card/${story.day}/card.png?width=540&amp;theme=light 540w, /api/report-card/${story.day}/card.png?width=1080&amp;theme=light 1080w" sizes="(max-width: 800px) 92vw, 480px" width="540" height="675" alt="Claude community report for ${date}: ${story.dumbPercent}% negative from ${story.total} ${reportNoun(story.total)}"><figcaption><a href="/api/report-card/${story.day}/card.png?width=1080&amp;theme=light&amp;download=1" download>Download share card ↓</a></figcaption></figure>
  </article>
  <section class="story-evidence"><p class="eyebrow">The numbers</p><div><span><strong>${story.total}</strong> total reports</span><span><strong class="dumb">${story.dumb}</strong> dumb</span><span><strong class="smart">${story.smart}</strong> smart</span><span><strong>${story.contextReports}</strong> with context</span></div></section>
  <aside class="next-dispatch"><a href="/reports">← Browse every daily report</a><a href="/">Report how Claude is doing now →</a></aside>
</main><footer>Independent community tracker · not affiliated with Anthropic</footer><script src="/analytics.js"></script><script src="/reports.js"></script></body></html>`;
}

const storyCache = new Map();

async function loadStory(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const cached = storyCache.get(day);
  if (cached && cached.expires > Date.now()) return cached.value;
  const endDate = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(endDate.getTime()) || day > utcDay(new Date())) return null;
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - 29);
  const rows = await db.getCommunityReportVotesForRange(utcDay(startDate), day);
  const report = buildCommunityReport(rows, 30, endDate);
  const story = report.daily.find(row => row.day === day);
  const value = story && story.total ? { report, story } : null;
  storyCache.set(day, { value, expires: Date.now() + 5 * 60 * 1000 });
  return value;
}

function renderReportCardSvg(story) {
  const negativeWidth = Math.round(820 * story.dumbPercent / 100);
  const comparison = story.baselineDumbPercent === null
    ? 'NO PRIOR BASELINE'
    : `${story.deltaVsBaseline >= 0 ? '+' : ''}${story.deltaVsBaseline} PTS VS PRIOR 7 DAYS`;
  return `<svg width="1080" height="1350" viewBox="0 0 1080 1350" xmlns="http://www.w3.org/2000/svg">
    <defs><pattern id="grid" width="36" height="36" patternUnits="userSpaceOnUse"><path d="M36 0H0V36" fill="none" stroke="#ded8d1" stroke-width="1"/></pattern></defs>
    <rect width="1080" height="1350" fill="#f6f3ef"/><rect width="1080" height="1350" fill="url(#grid)" opacity=".58"/><rect width="12" height="1350" fill="${story.signal.accent}"/>
    <text x="84" y="92" fill="#1a1815" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="34" font-weight="800">claude<tspan fill="#e36b2b">dumb</tspan><tspan fill="#b5b0a8" font-size="18">.com</tspan></text>
    <text x="996" y="92" fill="#8a8480" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="18" text-anchor="end">DAILY DISPATCH</text>
    <line x1="84" y1="132" x2="996" y2="132" stroke="#e5e0da" stroke-width="2"/>
    <text x="84" y="204" fill="#8a8480" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="24">${escapeXml(formatReportDate(story.day).toUpperCase())}</text>
    <text x="84" y="306" fill="${story.signal.accent}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="50" font-weight="800" letter-spacing="5">${story.signal.label}</text>
    <text x="84" y="412" fill="#1a1815" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="58" font-weight="700">${escapeXml(story.signal.headline)}</text>
    <text x="84" y="674" fill="#1a1815" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="230" font-weight="800" letter-spacing="-18">${story.dumbPercent}%</text>
    <text x="84" y="732" fill="#8a8480" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="25" letter-spacing="3">NEGATIVE COMMUNITY SIGNAL</text>
    <rect x="84" y="798" width="820" height="48" rx="8" fill="#5a9a1f"/><rect x="84" y="798" width="${negativeWidth}" height="48" rx="8" fill="#d63031"/>
    <text x="84" y="920" fill="#1a1815" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="34" font-weight="700">${story.total} ${reportNoun(story.total).toUpperCase()}</text>
    <text x="84" y="972" fill="#8a8480" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="23">${story.dumb} DUMB  ·  ${story.smart} SMART  ·  ${story.contextReports} WITH CONTEXT</text>
    <rect x="84" y="1052" width="820" height="1" fill="#e5e0da"/>
    <text x="84" y="1120" fill="${story.signal.accent}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="24" font-weight="700">${escapeXml(comparison)}</text>
    <text x="84" y="1238" fill="#8a8480" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="19">VOLUNTARY REPORTS · NOT OFFICIAL ANTHROPIC STATUS</text>
    <text x="996" y="1290" fill="#1a1815" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="20" text-anchor="end">claudedumb.com/reports</text>
  </svg>`;
}

app.get('/reports', async (req, res) => {
  try {
    const days = 30;
    const votes = await db.getCommunityReportVotes(days);
    const report = buildCommunityReport(votes, days);
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.send(renderCommunityReportPage(report));
  } catch (e) {
    console.error('Community report error:', e);
    res.status(500).send('Unable to load the community report right now.');
  }
});

app.get('/reports/:day', async (req, res) => {
  try {
    const result = await loadStory(req.params.day);
    if (!result) return res.status(404).send('Daily report not found.');
    res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    res.send(renderDailyStoryPage(result.report, result.story));
  } catch (e) {
    console.error('Daily report error:', e);
    res.status(500).send('Unable to load this daily report right now.');
  }
});

app.get('/api/report-card/:day/card.png', async (req, res) => {
  try {
    const result = await loadStory(req.params.day);
    if (!result) return res.status(404).send('Report card not found.');
    const requestedWidth = Number.parseInt(req.query.width, 10) || 1080;
    const width = requestedWidth <= 540 ? 540 : 1080;
    const image = await sharp(Buffer.from(renderReportCardSvg(result.story)))
      .resize({ width })
      .png({ compressionLevel: 9 })
      .toBuffer();
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      ...(req.query.download === '1' ? { 'Content-Disposition': `attachment; filename="claude-community-report-${req.params.day}.png"` } : {}),
    });
    res.send(image);
  } catch (e) {
    console.error('Report card error:', e);
    res.status(500).send('Unable to generate this report card right now.');
  }
});

// ---- API Routes ----

app.get('/api/votes/recent', async (req, res) => {
  try { res.json(await db.getRecentVotes()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/votes/counts', async (req, res) => {
  try { res.json(await db.getVoteCounts()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/votes/hourly', async (req, res) => {
  try { res.json(await db.getHourlyVotes()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/votes/vibes', async (req, res) => {
  try { res.json(await db.getVibes()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/votes/daily', async (req, res) => {
  try { res.json(await db.getDailyVotes()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/claude-status', async (req, res) => {
  try {
    const response = await fetch('https://status.claude.com/api/v2/summary.json');
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch Claude status' });
  }
});

app.get('/api/uptime/:componentId', async (req, res) => {
  try {
    const { componentId } = req.params;
    if (!/^[a-z0-9]+$/.test(componentId)) {
      return res.status(400).json({ error: 'Invalid component ID' });
    }
    const response = await fetch(`https://status.claude.com/uptime/${componentId}.json`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to fetch uptime data' });
  }
});

// ---- Unified Feed ----
app.get('/api/feed', async (req, res) => {
  try {
    const sort = req.query.sort || 'newest';
    const limit = Math.min(parseInt(req.query.limit) || 30, 50);
    const offset = parseInt(req.query.offset) || 0;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

    let items;
    if (sort === 'trending') {
      items = await db.getWallItems(limit, offset, ip);
    } else {
      items = await db.getFeedNewest(limit, offset, ip);
    }

    const result = items.map(item => ({
      id: item.id,
      vote: item.vote || 'dumb',
      comment: item.comment,
      city: item.city,
      latitude: item.latitude,
      longitude: item.longitude,
      created_at: item.created_at,
      hours_ago: item.hours_ago,
      score: item.score || 0,
      user_reaction: item.user_reaction || null,
      thumb_url: item.screenshot_key ? getScreenshotUrl(item.screenshot_key, true) : null,
      full_url: item.screenshot_key ? getScreenshotUrl(item.screenshot_key, false) : null,
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Single Post by ID (for shared links) ----
app.get('/api/feed/post/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid post ID' });
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    const item = await db.getFeedPostById(id, ip);
    if (!item) return res.status(404).json({ error: 'Post not found' });
    res.json({
      id: item.id,
      vote: item.vote || 'dumb',
      comment: item.comment,
      city: item.city,
      latitude: item.latitude,
      longitude: item.longitude,
      created_at: item.created_at,
      hours_ago: item.hours_ago,
      score: item.score || 0,
      user_reaction: item.user_reaction || null,
      thumb_url: item.screenshot_key ? getScreenshotUrl(item.screenshot_key, true) : null,
      full_url: item.screenshot_key ? getScreenshotUrl(item.screenshot_key, false) : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Wall of Shame (legacy) ----
app.get('/api/wall', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = parseInt(req.query.offset) || 0;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    const items = await db.getWallItems(limit, offset, ip);
    const result = items.map(item => ({
      id: item.id,
      comment: item.comment,
      city: item.city,
      latitude: item.latitude,
      longitude: item.longitude,
      created_at: item.created_at,
      score: item.score,
      ups: item.ups,
      downs: item.downs,
      user_reaction: item.user_reaction || null,
      thumb_url: getScreenshotUrl(item.screenshot_key, true),
      full_url: getScreenshotUrl(item.screenshot_key, false),
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Reactions ----
app.post('/api/react', async (req, res) => {
  try {
    const { voteId, type } = req.body;
    if (!voteId || !['up', 'down'].includes(type)) {
      return res.status(400).json({ error: 'Invalid reaction' });
    }
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

    const existing = await db.getUserReaction(voteId, ip);
    if (existing && existing.type === type) {
      await db.deleteReaction(voteId, ip);
    } else {
      await db.upsertReaction(voteId, ip, type);
    }

    const score = await db.getReactionScore(voteId);
    const current = await db.getUserReaction(voteId, ip);
    res.json({ score, userReaction: current?.type || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Leaderboard ----
app.get('/api/leaderboard', async (req, res) => {
  try {
    const items = await db.getLeaderboard(10);
    const result = items.map(item => ({
      id: item.id,
      comment: item.comment,
      city: item.city,
      influence: item.influence,
      thumb_url: getScreenshotUrl(item.screenshot_key, true),
    }));
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- OG Card Generation ----
app.get('/api/og-card/:voteId', async (req, res) => {
  try {
    const voteId = parseInt(req.params.voteId);
    const vote = await db.getVoteById(voteId);
    if (!vote || !vote.screenshot_key) return res.status(404).send('Not found');

    // Get screenshot buffer
    let screenshotBuf;
    if (R2_PUBLIC_URL) {
      const resp = await fetch(`${R2_PUBLIC_URL}/${vote.screenshot_key}`);
      screenshotBuf = Buffer.from(await resp.arrayBuffer());
    } else {
      const filePath = path.join(__dirname, 'uploads', vote.screenshot_key);
      if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
      screenshotBuf = fs.readFileSync(filePath);
    }

    const W = 1200, H = 630;
    const pad = 40;
    const headerH = 70;
    const footerH = 80;
    const imgArea = H - headerH - footerH;

    const screenshot = await sharp(screenshotBuf)
      .resize({ width: W - pad * 2, height: imgArea - 20, fit: 'inside' })
      .toBuffer();
    const meta = await sharp(screenshot).metadata();

    const sx = Math.round((W - meta.width) / 2);
    const sy = headerH + Math.round((imgArea - meta.height) / 2);

    const comment = vote.comment ? escapeXml(vote.comment.slice(0, 80)) : '';
    const city = vote.city ? escapeXml(vote.city) : '';

    // Accent bar at top
    const svgText = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${W}" height="4" fill="#E36B2B"/>
      <text x="${pad}" y="42" font-family="monospace" font-size="28" font-weight="800" fill="#E36B2B">claudedumb.com</text>
      <text x="${W - pad}" y="42" font-family="monospace" font-size="14" font-weight="600" fill="#555" text-anchor="end">the claude vibe check</text>
      <rect x="${sx - 12}" y="${sy - 12}" width="${meta.width + 24}" height="${meta.height + 24}" rx="8" fill="#2a2723"/>
      ${comment ? `<text x="${pad}" y="${H - 50}" font-family="monospace" font-size="16" fill="#b5b0a8" font-style="italic">\u201C${comment}\u201D</text>` : ''}
      ${city ? `<text x="${W - pad}" y="${H - 50}" font-family="monospace" font-size="13" fill="#555" text-anchor="end">${city}</text>` : ''}
    </svg>`;

    const card = await sharp({
      create: { width: W, height: H, channels: 4, background: { r: 22, g: 20, b: 18, alpha: 255 } }
    })
      .composite([
        { input: Buffer.from(svgText), left: 0, top: 0 },
        { input: screenshot, left: sx, top: sy },
      ])
      .png()
      .toBuffer();

    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
    res.send(card);
  } catch (e) {
    console.error('OG card error:', e);
    res.status(500).send('Error generating card');
  }
});

// ---- Share Page ----
app.get('/s/:voteId', async (req, res) => {
  try {
    const voteId = parseInt(req.params.voteId);
    const vote = await db.getVoteById(voteId);
    if (!vote) return res.redirect('/');

    // Track click
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    const referrer = req.headers.referer || null;
    await db.trackShareClick(voteId, ip, referrer);

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const screenshotUrl = vote.screenshot_key ? getScreenshotUrl(vote.screenshot_key, false) : null;
    const comment = vote.comment ? escapeHtml(vote.comment) : (vote.vote === 'smart' ? 'Claude is being smart' : 'Claude is being dumb');
    const ogImageUrl = vote.screenshot_key ? `${baseUrl}/api/og-card/${voteId}` : null;

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${vote.vote === 'smart' ? 'Claude is being smart' : 'Claude is being dumb'} \u2014 claudedumb.com</title>
  <meta property="og:title" content="${vote.vote === 'smart' ? 'Claude is being smart right now' : 'Claude is being dumb right now'}">
  <meta property="og:description" content="${comment}">
  ${ogImageUrl ? `<meta property="og:image" content="${ogImageUrl}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">` : ''}
  <meta property="og:url" content="${baseUrl}/s/${voteId}">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="${ogImageUrl ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${vote.vote === 'smart' ? 'Claude is being smart right now' : 'Claude is being dumb right now'}">
  <meta name="twitter:description" content="${comment}">
  ${ogImageUrl ? `<meta name="twitter:image" content="${ogImageUrl}">` : ''}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'JetBrains Mono', monospace; background: #1a1815; color: #f6f3ef; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 2rem; }
    .card { max-width: 720px; width: 100%; text-align: center; }
    .card h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .card h1 span { color: #E36B2B; }
    .card img { max-width: 100%; border-radius: 12px; margin: 1.5rem 0; border: 1px solid #333; }
    .card .comment { color: #b5b0a8; font-style: italic; margin-bottom: 0.5rem; }
    .card .city { color: #666; font-size: 14px; margin-bottom: 1.5rem; }
    .card .cta { display: inline-block; padding: 12px 32px; background: #E36B2B; color: #fff; text-decoration: none; border-radius: 8px; font-weight: 700; font-family: inherit; }
    .card .cta:hover { background: #c95a22; }
  </style>
</head>
<body>
  <div class="card">
    <h1>claude<span>dumb</span>.com</h1>
    ${screenshotUrl ? `<img src="${screenshotUrl}" alt="Screenshot">` : ''}
    ${vote.comment ? `<p class="comment">\u201C${comment}\u201D</p>` : ''}
    ${vote.city ? `<p class="city">${escapeHtml(vote.city)}</p>` : ''}
    <a class="cta" href="/">Is Claude being dumb right now?</a>
  </div>
</body>
</html>`);
  } catch (e) {
    console.error('Share page error:', e);
    res.redirect('/');
  }
});

// Blocked IPs/cities - add entries to blocked.json, no restart needed
function getBlockList() {
  try {
    return JSON.parse(require('fs').readFileSync('./blocked.json', 'utf8'));
  } catch { return { ips: [], cities: [] }; }
}

app.post('/api/vote', handleUpload, async (req, res) => {
  try {
    const { vote, comment } = req.body;
    if (!vote || !['smart', 'dumb'].includes(vote)) {
      return res.status(400).json({ error: 'Invalid vote' });
    }

    const cleanComment = comment ? String(comment).slice(0, 120).trim() : null;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

    // Check IP block list
    const blocked = getBlockList();
    if (blocked.ips.some(b => ip.includes(b))) {
      return res.status(403).json({ error: 'Blocked' });
    }

    const recent = await db.getRecentVoteByIP(ip);
    if (recent) {
      return res.status(429).json({ error: 'You can vote once every 5 minutes' });
    }

    const geo = await geolocateIP(ip);
    const latitude = geo?.lat || null;
    const longitude = geo?.lng || null;
    const city = geo ? `${geo.city}, ${geo.country}` : null;

    // Check city block list
    if (city && blocked.cities.some(b => city.toLowerCase().includes(b.toLowerCase()))) {
      return res.status(403).json({ error: 'Blocked' });
    }

    const voteId = await db.insertVote(vote, latitude, longitude, city, cleanComment, ip);

    // Process screenshot if present
    let screenshotSaved = false;
    if (req.file) {
      try {
        const fullBuf = await sharp(req.file.buffer)
          .resize({ width: 2560, withoutEnlargement: true })
          .png()
          .toBuffer();
        const thumbBuf = await sharp(req.file.buffer)
          .resize({ width: 300, withoutEnlargement: true })
          .jpeg({ quality: 70 })
          .toBuffer();
        const key = await saveScreenshot(voteId, fullBuf, thumbBuf);
        await db.updateVoteScreenshot(voteId, key);
        screenshotSaved = true;
      } catch (err) {
        console.error('Screenshot save failed:', err);
      }
    }

    res.json({ success: true, city, voteId, screenshotSaved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Start ----
db.init().then(() => {
  app.listen(PORT, () => {
    console.log(`claudedumb.com running at http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
