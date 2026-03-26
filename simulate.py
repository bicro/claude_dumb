#!/usr/bin/env python3
"""
Simulate ~138 users voting from cities around the world.
Spreads votes across the last 24 hours with realistic patterns.

Usage:
  python3 simulate.py                           # Seed 138 votes (SQLite local)
  python3 simulate.py --clear                   # Wipe and re-seed (SQLite local)
  python3 simulate.py --live                    # Drip 1-3 votes every 2-5 min (SQLite)
  python3 simulate.py --api http://localhost:3456 --live   # Drip via API (works against deployed server)
  DATABASE_URL=postgres://... python3 simulate.py --clear  # Seed directly into Postgres
"""

import random
import time
import sys
import os
import json
from datetime import datetime, timedelta
from urllib.request import Request, urlopen
from urllib.error import URLError

# Load .env file if present
env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, val = line.split('=', 1)
                os.environ.setdefault(key.strip(), val.strip())

DB_PATH = os.path.join(os.path.dirname(__file__), 'votes.db')

CITIES = [
    {"city": "San Francisco", "lat": 37.77, "lng": -122.42, "w": 8},
    {"city": "New York", "lat": 40.71, "lng": -74.01, "w": 9},
    {"city": "Los Angeles", "lat": 34.05, "lng": -118.24, "w": 6},
    {"city": "Seattle", "lat": 47.61, "lng": -122.33, "w": 5},
    {"city": "Austin", "lat": 30.27, "lng": -97.74, "w": 4},
    {"city": "Toronto", "lat": 43.65, "lng": -79.38, "w": 4},
    {"city": "Chicago", "lat": 41.88, "lng": -87.63, "w": 3},
    {"city": "Denver", "lat": 39.74, "lng": -104.99, "w": 2},
    {"city": "Miami", "lat": 25.76, "lng": -80.19, "w": 2},
    {"city": "Vancouver", "lat": 49.28, "lng": -123.12, "w": 3},
    {"city": "Mexico City", "lat": 19.43, "lng": -99.13, "w": 2},
    {"city": "Boston", "lat": 42.36, "lng": -71.06, "w": 3},
    {"city": "London", "lat": 51.51, "lng": -0.13, "w": 7},
    {"city": "Berlin", "lat": 52.52, "lng": 13.41, "w": 5},
    {"city": "Paris", "lat": 48.86, "lng": 2.35, "w": 4},
    {"city": "Amsterdam", "lat": 52.37, "lng": 4.90, "w": 3},
    {"city": "Stockholm", "lat": 59.33, "lng": 18.07, "w": 2},
    {"city": "Dublin", "lat": 53.35, "lng": -6.26, "w": 2},
    {"city": "Zurich", "lat": 47.38, "lng": 8.54, "w": 2},
    {"city": "Barcelona", "lat": 41.39, "lng": 2.17, "w": 2},
    {"city": "Warsaw", "lat": 52.23, "lng": 21.01, "w": 2},
    {"city": "Lisbon", "lat": 38.72, "lng": -9.14, "w": 1},
    {"city": "Tokyo", "lat": 35.68, "lng": 139.65, "w": 6},
    {"city": "Singapore", "lat": 1.35, "lng": 103.82, "w": 4},
    {"city": "Bangalore", "lat": 12.97, "lng": 77.59, "w": 5},
    {"city": "Mumbai", "lat": 19.08, "lng": 72.88, "w": 3},
    {"city": "Seoul", "lat": 37.57, "lng": 126.98, "w": 3},
    {"city": "Beijing", "lat": 39.90, "lng": 116.40, "w": 2},
    {"city": "Shanghai", "lat": 31.23, "lng": 121.47, "w": 2},
    {"city": "Tel Aviv", "lat": 32.09, "lng": 34.78, "w": 3},
    {"city": "Dubai", "lat": 25.20, "lng": 55.27, "w": 2},
    {"city": "Jakarta", "lat": -6.21, "lng": 106.85, "w": 1},
    {"city": "Taipei", "lat": 25.03, "lng": 121.57, "w": 2},
    {"city": "Sydney", "lat": -33.87, "lng": 151.21, "w": 4},
    {"city": "Melbourne", "lat": -37.81, "lng": 144.96, "w": 3},
    {"city": "Auckland", "lat": -36.85, "lng": 174.76, "w": 1},
    {"city": "Sao Paulo", "lat": -23.55, "lng": -46.63, "w": 3},
    {"city": "Buenos Aires", "lat": -34.60, "lng": -58.38, "w": 2},
    {"city": "Bogota", "lat": 4.71, "lng": -74.07, "w": 1},
    {"city": "Santiago", "lat": -33.45, "lng": -70.67, "w": 1},
    {"city": "Lagos", "lat": 6.52, "lng": 3.38, "w": 1},
    {"city": "Cape Town", "lat": -33.93, "lng": 18.42, "w": 1},
    {"city": "Nairobi", "lat": -1.29, "lng": 36.82, "w": 1},
]

SMART_COMMENTS = [
    "opus is cracked rn", "sonnet 4 is goated", "just shipped a whole app with claude code",
    "actually impressed today", "better than yesterday for sure", "claude code just refactored my entire codebase",
    "the vibes are good", "fast and accurate today", "best coding assistant", "claude understood my codebase instantly",
    "wrote perfect tests first try", "one-shotted a complex bug fix", "artifacts are fire",
    "thinking mode is incredible", "no complaints today", "claude > gpt today",
    None, None, None, None, None, None, None, None,
]

DUMB_COMMENTS = [
    "keeps forgetting context", "hallucinating imports again", "won't stop apologizing",
    "gave me python when I asked for rust", "infinite loop of errors", "broke my working code",
    "refuses to do simple tasks", "way too verbose today", "can't follow instructions",
    "lost the plot mid-conversation", "suggested deprecated APIs", "claude is cooked",
    "rate limited AND dumb", "getting worse every week", "keeps repeating itself",
    None, None, None, None, None, None, None, None, None, None,
]


def jitter(val, amount=0.3):
    return val + random.uniform(-amount, amount)


def pick_vote():
    return 'smart' if random.random() < 0.62 else 'dumb'


def pick_comment(vote):
    pool = SMART_COMMENTS if vote == 'smart' else DUMB_COMMENTS
    return random.choice(pool)


# ---- Database backends ----

def get_db():
    """Return a DB connection — PostgreSQL if DATABASE_URL is set, else SQLite."""
    database_url = os.environ.get('DATABASE_URL')
    if database_url:
        import psycopg2
        conn = psycopg2.connect(database_url)
        conn.autocommit = False
        return ('pg', conn)
    else:
        import sqlite3
        conn = sqlite3.connect(DB_PATH)
        return ('sqlite', conn)


def init_table(db_type, conn):
    cur = conn.cursor()
    if db_type == 'pg':
        cur.execute("""
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
        """)
        conn.commit()
    else:
        cur.execute("""
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
        """)
        conn.commit()


def clear_votes(db_type, conn):
    conn.cursor().execute("DELETE FROM votes")
    conn.commit()
    print("Cleared all votes")


def seed_votes(db_type, conn, count=None):
    if count is None:
        count = random.randint(42, 212)
    now = datetime.utcnow()
    pool = []
    for c in CITIES:
        pool.extend([c] * c['w'])

    cur = conn.cursor()
    for i in range(count):
        city = random.choice(pool)
        hours_ago = random.betavariate(2, 5) * 24
        ts = now - timedelta(hours=hours_ago)
        fake_ip = f"sim-{i}-{city['city'].replace(' ', '')}"
        vote = pick_vote()
        comment = pick_comment(vote)

        if db_type == 'pg':
            cur.execute(
                "INSERT INTO votes (vote, latitude, longitude, city, comment, ip, created_at) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (vote, jitter(city['lat']), jitter(city['lng']), city['city'], comment, fake_ip, ts),
            )
        else:
            cur.execute(
                "INSERT INTO votes (vote, latitude, longitude, city, comment, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (vote, jitter(city['lat']), jitter(city['lng']), city['city'], comment, fake_ip, ts.strftime('%Y-%m-%d %H:%M:%S')),
            )

    conn.commit()
    print(f"Seeded {count} votes across {len(CITIES)} cities ({db_type})")


def live_mode_db(db_type, conn):
    """Drip votes directly into DB."""
    print("Live mode (DB): adding votes every 2-5 minutes (Ctrl+C to stop)")
    pool = []
    for c in CITIES:
        pool.extend([c] * c['w'])

    cur = conn.cursor()
    tick = 0
    while True:
        n = random.randint(1, 3)
        for _ in range(n):
            city = random.choice(pool)
            fake_ip = f"live-{tick}-{random.randint(1000,9999)}"
            vote = pick_vote()
            comment = pick_comment(vote)
            if db_type == 'pg':
                cur.execute(
                    "INSERT INTO votes (vote, latitude, longitude, city, comment, ip) VALUES (%s, %s, %s, %s, %s, %s)",
                    (vote, jitter(city['lat']), jitter(city['lng']), city['city'], comment, fake_ip),
                )
            else:
                cur.execute(
                    "INSERT INTO votes (vote, latitude, longitude, city, comment, ip) VALUES (?, ?, ?, ?, ?, ?)",
                    (vote, jitter(city['lat']), jitter(city['lng']), city['city'], comment, fake_ip),
                )
        conn.commit()
        tick += 1
        print(f"[{datetime.now().strftime('%H:%M:%S')}] +{n} votes (tick {tick})")
        time.sleep(random.uniform(120, 300))


def live_mode_api(base_url):
    """Drip votes via HTTP API — works against any deployed server."""
    print(f"Live mode (API): posting to {base_url} every 2-5 minutes (Ctrl+C to stop)")
    pool = []
    for c in CITIES:
        pool.extend([c] * c['w'])

    tick = 0
    while True:
        n = random.randint(1, 3)
        for _ in range(n):
            city = random.choice(pool)
            vote = pick_vote()
            comment = pick_comment(vote)
            payload = json.dumps({"vote": vote, "comment": comment}).encode()
            fake_ip = f"{random.randint(1,223)}.{random.randint(0,255)}.{random.randint(0,255)}.{random.randint(1,254)}"
            req = Request(
                f"{base_url.rstrip('/')}/api/vote",
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "X-Forwarded-For": fake_ip,
                },
                method="POST",
            )
            try:
                resp = urlopen(req, timeout=10)
                result = json.loads(resp.read())
                status = "ok" if result.get("success") else result.get("error", "?")
            except URLError as e:
                status = str(e)
            print(f"  {vote} ({city['city']}) -> {status}")
        tick += 1
        print(f"[{datetime.now().strftime('%H:%M:%S')}] +{n} votes (tick {tick})")
        time.sleep(random.uniform(120, 300))


def drip_votes(db_type, conn):
    """Add a small batch of votes with timestamps spread across the last 30 min. Designed for cron."""
    pool = []
    for c in CITIES:
        pool.extend([c] * c['w'])

    now = datetime.utcnow()
    n = random.randint(3, 12)
    cur = conn.cursor()

    for i in range(n):
        city = random.choice(pool)
        # Spread across last 30 min so they don't all appear at once
        minutes_ago = random.uniform(0, 30)
        ts = now - timedelta(minutes=minutes_ago)
        fake_ip = f"drip-{int(now.timestamp())}-{i}-{random.randint(100,999)}"
        vote = pick_vote()
        comment = pick_comment(vote)

        if db_type == 'pg':
            cur.execute(
                "INSERT INTO votes (vote, latitude, longitude, city, comment, ip, created_at) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                (vote, jitter(city['lat']), jitter(city['lng']), city['city'], comment, fake_ip, ts),
            )
        else:
            cur.execute(
                "INSERT INTO votes (vote, latitude, longitude, city, comment, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (vote, jitter(city['lat']), jitter(city['lng']), city['city'], comment, fake_ip, ts.strftime('%Y-%m-%d %H:%M:%S')),
            )

    conn.commit()
    print(f"[{datetime.now().strftime('%H:%M:%S')}] Dripped {n} votes ({db_type})")


def main():
    # Check for --api mode
    api_url = None
    if '--api' in sys.argv:
        idx = sys.argv.index('--api')
        if idx + 1 < len(sys.argv):
            api_url = sys.argv[idx + 1]
        else:
            print("Usage: --api <base_url>")
            sys.exit(1)

    if api_url and '--live' in sys.argv:
        live_mode_api(api_url)
        return

    # DB mode
    db_type, conn = get_db()
    init_table(db_type, conn)

    if '--clear' in sys.argv:
        clear_votes(db_type, conn)
        seed_votes(db_type, conn)
    elif '--drip' in sys.argv:
        drip_votes(db_type, conn)
    elif '--live' in sys.argv:
        live_mode_db(db_type, conn)
    else:
        if db_type == 'sqlite':
            import sqlite3
            existing = conn.execute("SELECT COUNT(*) FROM votes WHERE ip LIKE 'sim-%'").fetchone()[0]
        else:
            cur = conn.cursor()
            cur.execute("SELECT COUNT(*) FROM votes WHERE ip LIKE 'sim-%'")
            existing = cur.fetchone()[0]

        if existing > 0:
            print(f"Already have {existing} simulated votes. Use --clear to reset.")
        else:
            seed_votes(db_type, conn)

    conn.close()


if __name__ == '__main__':
    main()
