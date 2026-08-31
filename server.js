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
      const safeDays = Math.min(Math.max(Number.parseInt(days, 10) || 30, 7), 90);
      const { rows } = await pool.query(`
        SELECT vote, city, comment, screenshot_key, created_at
        FROM votes
        WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
        ORDER BY created_at ASC
      `, [safeDays]);
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
      const safeDays = Math.min(Math.max(Number.parseInt(days, 10) || 30, 7), 90);
      return sqliteDb.prepare(`
        SELECT vote, city, comment, screenshot_key, created_at
        FROM votes
        WHERE created_at >= datetime('now', ?)
        ORDER BY created_at ASC
      `).all(`-${safeDays} days`);
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

function buildCommunityReport(votes, days = 30) {
  const now = new Date();
  const dayRows = new Map();
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - offset);
    dayRows.set(utcDay(date), { day: utcDay(date), smart: 0, dumb: 0, total: 0 });
  }

  const countries = new Map();
  let smart = 0;
  let dumb = 0;
  let contextReports = 0;

  for (const row of votes) {
    if (row.vote === 'smart') smart += 1;
    if (row.vote === 'dumb') dumb += 1;
    if (row.comment || row.screenshot_key) contextReports += 1;

    const day = dayRows.get(utcDay(row.created_at));
    if (day && (row.vote === 'smart' || row.vote === 'dumb')) {
      day[row.vote] += 1;
      day.total += 1;
    }

    if (row.city) {
      const country = String(row.city).split(',').pop().trim();
      if (country) countries.set(country, (countries.get(country) || 0) + 1);
    }
  }

  const daily = [...dayRows.values()];
  const lastSeven = daily.slice(-7).reduce((sum, row) => ({
    smart: sum.smart + row.smart,
    dumb: sum.dumb + row.dumb,
    total: sum.total + row.total,
  }), { smart: 0, dumb: 0, total: 0 });
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
    updatedAt: now.toISOString(),
    daily,
    total: smart + dumb,
    smart,
    dumb,
    dumbPercent: smart + dumb ? Math.round((dumb / (smart + dumb)) * 100) : 0,
    lastSeven: {
      ...lastSeven,
      dumbPercent: lastSeven.total ? Math.round((lastSeven.dumb / lastSeven.total) * 100) : 0,
    },
    peakDay,
    contextReports,
    visibleCountries,
  };
}

function renderCommunityReportPage(report) {
  const formatDate = day => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
  const schema = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: 'Claude Community Quality Report',
    description: `Daily smart and dumb community reports about Claude over the last ${report.days} days.`,
    url: 'https://claudedumb.com/reports',
    temporalCoverage: `${report.startDate}/${report.endDate}`,
    dateModified: report.updatedAt,
    creator: { '@type': 'Organization', name: 'claudedumb.com', url: 'https://claudedumb.com/' },
    measurementTechnique: 'Voluntary community reports submitted to claudedumb.com',
    variableMeasured: [
      { '@type': 'PropertyValue', name: 'Smart reports', value: report.smart },
      { '@type': 'PropertyValue', name: 'Dumb reports', value: report.dumb },
      { '@type': 'PropertyValue', name: 'Dumb report share', value: `${report.dumbPercent}%` },
    ],
  }).replace(/</g, '\\u003c');
  const dailyRows = report.daily.slice().reverse().map(row => `
    <tr>
      <th scope="row">${formatDate(row.day)}</th>
      <td>${row.total}</td>
      <td class="smart">${row.smart}</td>
      <td class="dumb">${row.dumb}</td>
      <td>${row.total ? Math.round((row.dumb / row.total) * 100) : 0}%</td>
    </tr>`).join('');
  const countryRows = report.visibleCountries.length
    ? report.visibleCountries.map(item => `<li><span>${escapeHtml(item.country)}</span><strong>${item.count} reports</strong></li>`).join('')
    : '<li class="muted">No country has reached the 3-report privacy threshold yet.</li>';
  const narrative = report.total
    ? `Community members submitted <strong>${report.total} reports</strong> in the last ${report.days} days. ${report.dumbPercent}% marked Claude as dumb. The busiest day was <strong>${formatDate(report.peakDay.day)}</strong> with ${report.peakDay.total} reports.`
    : `No community reports were submitted in this ${report.days}-day window.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Community Quality Report & History | claudedumb.com</title>
  <meta name="description" content="Explore 30 days of Claude community quality reports, daily smart-vs-dumb history, trends, and transparent methodology.">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <link rel="canonical" href="https://claudedumb.com/reports">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="claudedumb.com">
  <meta property="og:title" content="Claude Community Quality Report & History">
  <meta property="og:description" content="30 days of community-reported Claude quality trends and daily history.">
  <meta property="og:url" content="https://claudedumb.com/reports">
  <meta name="twitter:card" content="summary">
  <script type="application/ld+json">${schema}</script>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/reports.css">
</head>
<body>
  <header class="site-header">
    <a href="/" class="logo">claude<span>dumb</span><small>.com</small></a>
    <a href="/">Live vibe check →</a>
  </header>
  <main>
    <nav class="crumb" aria-label="Breadcrumb"><a href="/">Home</a> / Community report</nav>
    <section class="intro">
      <p class="eyebrow">Community data · updated daily</p>
      <h1>Claude Community Quality Report</h1>
      <p class="dek">A transparent, rolling history of whether community members found Claude smart or dumb—not an official Anthropic uptime report.</p>
      <p class="updated">Updated <time datetime="${report.updatedAt}">${formatDate(report.endDate)}</time> · Reporting window ${formatDate(report.startDate)}–${formatDate(report.endDate)}</p>
    </section>
    <section class="metrics" aria-label="Community report metrics">
      <article><span>7-day reports</span><strong>${report.lastSeven.total}</strong></article>
      <article><span>Marked dumb</span><strong class="dumb">${report.lastSeven.dumbPercent}%</strong></article>
      <article><span>Marked smart</span><strong class="smart">${report.lastSeven.smart}</strong></article>
      <article><span>30-day context</span><strong>${report.contextReports}</strong></article>
    </section>
    <section class="card story">
      <p class="eyebrow">What the community reported</p>
      <h2>The last 30 days in one sentence</h2>
      <p>${narrative}</p>
      <p class="caveat">A “dumb” report can describe poor answer quality, slowness, an error, or an outage. This dataset measures community perception; it does not establish root cause.</p>
    </section>
    <section class="grid">
      <article class="card table-card">
        <div class="section-heading">
          <div><p class="eyebrow">Daily history</p><h2>Smart vs. dumb reports</h2></div>
          <a href="/">Submit a live report →</a>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Total</th><th>Smart</th><th>Dumb</th><th>Dumb share</th></tr></thead>
            <tbody>${dailyRows}</tbody>
          </table>
        </div>
      </article>
      <aside class="card countries">
        <p class="eyebrow">Approximate geography</p>
        <h2>Countries with 3+ reports</h2>
        <ul>${countryRows}</ul>
        <p class="caveat">Locations are derived approximately from IP addresses. Cities are never published here, and countries below the threshold are hidden.</p>
      </aside>
    </section>
    <section class="card methodology">
      <p class="eyebrow">Methodology</p>
      <h2>How to read this report</h2>
      <ul>
        <li>Each row represents a voluntary “smart” or “dumb” submission to claudedumb.com.</li>
        <li>People may submit again after five minutes, so reports are not unique users.</li>
        <li>Daily boundaries use UTC. The current day is incomplete and may change.</li>
        <li>Community signals can surface quality problems before an official incident, but they do not replace <a href="https://status.claude.com/" target="_blank" rel="noopener">Claude’s official status page</a>.</li>
      </ul>
    </section>
    <section class="cta">
      <h2>How is Claude behaving for you?</h2>
      <p>Add your signal to tomorrow’s report.</p>
      <a href="/">Submit a community report</a>
    </section>
  </main>
  <footer>Independent community tracker · not affiliated with Anthropic · <a href="/">claudedumb.com</a></footer>
  <script src="/analytics.js"></script>
</body>
</html>`;
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
