# claudedumb.com

**Is Claude being dumb right now?** A real-time community dashboard where people vote on whether Claude is having a good day or a bad day.

## What is this?

A live vibes tracker for Claude. Users can vote "Smart" or "Dumb", leave comments, attach screenshots as proof, and watch the global sentiment shift in real time — complete with a 3D globe, a wall of shame, and a 7-day trend chart.

**Live at [claudedumb.com](https://claudedumb.com)**

## Stack

- **Frontend:** Vanilla JS, [globe.gl](https://globe.gl) for the 3D globe, JetBrains Mono
- **Backend:** Node.js + Express
- **Database:** PostgreSQL (prod) / SQLite (local dev)
- **Storage:** Cloudflare R2 for screenshot uploads
- **Hosting:** Render

## Running locally

```bash
npm install
npm start
# → http://localhost:3000
```

SQLite is used automatically when no `DATABASE_URL` is set.