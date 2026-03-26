const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Index for time-based queries
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_votes_created_at ON votes(created_at)`);
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
    async getRecentVoteByIP(ip) {
      const { rows } = await pool.query(
        `SELECT id FROM votes WHERE ip = $1 AND created_at > NOW() - INTERVAL '5 minutes'`,
        [ip]
      );
      return rows[0] || null;
    },
    async insertVote(vote, latitude, longitude, city, comment, ip) {
      await pool.query(
        `INSERT INTO votes (vote, latitude, longitude, city, comment, ip) VALUES ($1, $2, $3, $4, $5, $6)`,
        [vote, latitude, longitude, city, comment, ip]
      );
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  try { sqliteDb.exec("ALTER TABLE votes ADD COLUMN city TEXT"); } catch {}
  try { sqliteDb.exec("ALTER TABLE votes ADD COLUMN comment TEXT"); } catch {}

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
    async getRecentVoteByIP(ip) {
      return sqliteDb.prepare(
        `SELECT id FROM votes WHERE ip = ? AND created_at > datetime('now', '-5 minutes')`
      ).get(ip) || null;
    },
    async insertVote(vote, latitude, longitude, city, comment, ip) {
      sqliteDb.prepare(
        'INSERT INTO votes (vote, latitude, longitude, city, comment, ip) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(vote, latitude, longitude, city, comment, ip);
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

app.post('/api/vote', async (req, res) => {
  try {
    const { vote, comment } = req.body;
    if (!vote || !['smart', 'dumb'].includes(vote)) {
      return res.status(400).json({ error: 'Invalid vote' });
    }

    const cleanComment = comment ? String(comment).slice(0, 120).trim() : null;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

    const recent = await db.getRecentVoteByIP(ip);
    if (recent) {
      return res.status(429).json({ error: 'You can vote once every 5 minutes' });
    }

    const geo = await geolocateIP(ip);
    const latitude = geo?.lat || null;
    const longitude = geo?.lng || null;
    const city = geo ? `${geo.city}, ${geo.country}` : null;

    await db.insertVote(vote, latitude, longitude, city, cleanComment, ip);
    res.json({ success: true, city });
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
