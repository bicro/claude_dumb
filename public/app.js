// ============================================================
// claudedumb.com — Frontend
// ============================================================

let globeInstance = null;

const COMPONENTS = [
  { id: 'rwppv331jlwc', name: 'claude.ai' },
  { id: '0qbwn08sd68x', name: 'platform.claude.com' },
  { id: 'k8w3r06qmzrp', name: 'Claude API' },
  { id: 'yyzkbfz2thpt', name: 'Claude Code' },
  { id: '0scnb50nvy53', name: 'Claude for Gov' },
];

// No browser geolocation needed — server resolves location from IP

// ---- Globe ----
async function initGlobe() {
  const wrapper = document.getElementById('globe-wrapper');

  let countries = { features: [] };
  try {
    const res = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
    const topo = await res.json();
    countries = toGeoJSON(topo, 'countries');
  } catch (e) { console.warn('Country data failed'); }

  const w = wrapper.clientWidth;
  const h = wrapper.clientHeight || w;

  globeInstance = Globe()(wrapper)
    .width(w)
    .height(h)
    .backgroundColor('rgba(0,0,0,0)')
    .showGraticules(false)
    .showAtmosphere(true)
    .atmosphereColor('#E36B2B')
    .atmosphereAltitude(0.15)
    .pointOfView({ lat: 20, lng: 10, altitude: 2.2 })
    .polygonsData(countries.features)
    .polygonCapColor(() => '#e4ddd2')
    .polygonSideColor(() => 'rgba(200,185,165,0.3)')
    .polygonStrokeColor(() => '#c0b5a0')
    .polygonAltitude(0.004)
    // Use HTML elements for pulsing energy dots
    .htmlElementsData([])
    .htmlLat('lat')
    .htmlLng('lng')
    .htmlAltitude(0.01)
    .htmlElement(d => {
      const el = document.createElement('div');
      el.className = 'energy-dot';
      el.style.color = d.color;
      el.style.opacity = d.opacity;
      const core = document.createElement('div');
      core.className = 'energy-core';
      core.style.width = d.coreSize + 'px';
      core.style.height = d.coreSize + 'px';
      const ring = document.createElement('div');
      ring.className = 'energy-ring';
      ring.style.animationDelay = (Math.random() * 2).toFixed(1) + 's';
      const ring2 = document.createElement('div');
      ring2.className = 'energy-ring2';
      ring2.style.animationDelay = (Math.random() * 2 + 0.3).toFixed(1) + 's';
      el.appendChild(core);
      el.appendChild(ring);
      el.appendChild(ring2);
      return el;
    })
    .htmlTransitionDuration(600);

  const mat = globeInstance.globeMaterial();
  mat.color.set('#f2ece3');
  mat.shininess = 3;

  const ctrl = globeInstance.controls();
  ctrl.autoRotate = true;
  ctrl.autoRotateSpeed = 0.4;
  ctrl.enableDamping = true;
  ctrl.dampingFactor = 0.12;
  ctrl.minDistance = 120;
  ctrl.maxDistance = 500;

  window.addEventListener('resize', () => {
    globeInstance.width(wrapper.clientWidth).height(wrapper.clientHeight);
  });
}

// TopoJSON decoder
function toGeoJSON(topo, name) {
  const obj = topo.objects[name], arcs = topo.arcs, tf = topo.transform;
  function dArc(idx) {
    const rev = idx < 0, i = rev ? ~idx : idx, arc = arcs[i], c = [];
    let x = 0, y = 0;
    for (const [dx, dy] of arc) { x += dx; y += dy; c.push([x * tf.scale[0] + tf.translate[0], y * tf.scale[1] + tf.translate[1]]); }
    if (rev) c.reverse(); return c;
  }
  function dRing(r) { const c = []; for (const i of r) c.push(...dArc(i)); return c; }
  function dGeom(g) {
    if (g.type === 'GeometryCollection') return { type: 'FeatureCollection', features: g.geometries.map(x => ({ type: 'Feature', geometry: dGeom(x), properties: x.properties || {} })) };
    if (g.type === 'Polygon') return { type: 'Polygon', coordinates: g.arcs.map(dRing) };
    if (g.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: g.arcs.map(p => p.map(dRing)) };
    return { type: g.type, coordinates: [] };
  }
  if (obj.type === 'GeometryCollection') return { type: 'FeatureCollection', features: obj.geometries.map(g => ({ type: 'Feature', geometry: dGeom(g), properties: g.properties || {} })) };
  return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: dGeom(obj), properties: {} }] };
}

// ---- Vote dots (energy orbs) ----
function loadVotes() {
  fetch('/api/votes/recent').then(r => r.json()).then(data => {
    if (!globeInstance) return;
    const points = data
      .filter(v => v.latitude != null && v.longitude != null)
      .map(v => {
        const fade = Math.max(0.15, 1 - (v.hours_ago / 24));
        const s = v.vote === 'smart';
        return {
          lat: v.latitude, lng: v.longitude, vote: v.vote,
          color: s ? '#5a9a1f' : '#d63031',
          opacity: fade,
          coreSize: 4 + fade * 6,
          timeLabel: v.hours_ago < 1 ? `${Math.round(v.hours_ago * 60)}m ago` : `${Math.round(v.hours_ago)}h ago`,
        };
      });
    globeInstance.htmlElementsData(points);

    // Update activity feed
    updateActivityFeed(data);
  });
}

function updateActivityFeed(votes) {
  const list = document.getElementById('activity-list');
  if (!list) return;
  list.innerHTML = '';
  const recent = votes.slice(0, 30);
  for (const v of recent) {
    const item = document.createElement('div');
    item.className = 'activity-item';

    const dot = document.createElement('span');
    dot.className = 'activity-dot ' + v.vote;

    const textWrap = document.createElement('div');
    textWrap.className = 'activity-text';

    const topLine = document.createElement('span');
    const voteSpan = document.createElement('span');
    voteSpan.className = 'activity-vote ' + v.vote;
    voteSpan.textContent = v.vote;
    topLine.appendChild(voteSpan);

    if (v.city) {
      const citySpan = document.createElement('span');
      citySpan.className = 'activity-city';
      citySpan.textContent = ` from ${v.city}`;
      topLine.appendChild(citySpan);
    }
    textWrap.appendChild(topLine);

    if (v.comment) {
      const commentEl = document.createElement('span');
      commentEl.className = 'activity-comment';
      commentEl.textContent = `"${v.comment}"`;
      textWrap.appendChild(commentEl);
    }

    const timeStr = v.hours_ago < 0.017 ? 'now'
      : v.hours_ago < 1 ? `${Math.round(v.hours_ago * 60)}m`
      : `${Math.round(v.hours_ago)}h`;
    const time = document.createElement('span');
    time.className = 'activity-time';
    time.textContent = timeStr;

    item.appendChild(dot);
    item.appendChild(textWrap);
    item.appendChild(time);
    list.appendChild(item);
  }
}

// ---- Vibes + tiles ----
function updateVibes() {
  Promise.all([
    fetch('/api/votes/vibes').then(r => r.json()),
    fetch('/api/votes/hourly').then(r => r.json()),
  ]).then(([totals, hourly]) => {
    const total = totals.smart + totals.dumb;
    const pct = total > 0 ? Math.round(totals.smart / total * 100) : 50;

    const el = document.getElementById('vibes-status');
    if (total === 0) { el.textContent = 'No Votes Yet'; el.className = 'vibes-hero-status mixed'; }
    else if (pct >= 70) { el.textContent = 'Being Smart'; el.className = 'vibes-hero-status smart'; }
    else if (pct >= 40) { el.textContent = 'Kinda Dumb'; el.className = 'vibes-hero-status mixed'; }
    else { el.textContent = 'Being Dumb'; el.className = 'vibes-hero-status dumb'; }

    document.getElementById('vibes-count').textContent = `${total} vote${total !== 1 ? 's' : ''} in the last 24 hours`;

    // Tiles
    const tilesEl = document.getElementById('vibes-tiles');
    tilesEl.innerHTML = '';
    const hourMap = {};
    for (const h of hourly) hourMap[h.hour] = h;

    const now = new Date();
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now);
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() - i);
      const utcKey = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0') + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':00:00';
      const localKey = d.toISOString().slice(0, 13).replace('T', ' ') + ':00:00';
      const data = hourMap[localKey] || hourMap[utcKey];

      const tile = document.createElement('div');
      tile.className = 'vibes-tile';
      let color, label;
      const hr = d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
      if (!data || (data.smart + data.dumb === 0)) {
        color = '#e8e4de';
        label = `${hr}: no votes`;
      } else {
        const r = data.smart / (data.smart + data.dumb);
        const v = data.smart + data.dumb;
        if (r >= 0.7) color = '#5a9a1f';
        else if (r >= 0.5) color = '#8cb83a';
        else if (r >= 0.3) color = '#d4a017';
        else color = '#d63031';
        label = `${hr}: ${Math.round(r * 100)}% smart (${v})`;
      }
      tile.style.backgroundColor = color;
      const tt = document.createElement('div');
      tt.className = 'vibes-tile-tooltip';
      tt.textContent = label;
      tile.appendChild(tt);
      tilesEl.appendChild(tile);
    }
  });
}

// ---- Status ----
async function loadOfficialStatus() {
  try {
    const res = await fetch('/api/claude-status');
    const d = await res.json();
    if (d.error) return;

    const banner = document.getElementById('overall-banner');
    const ind = d.status?.indicator || 'none';
    banner.className = 'overall-banner ' + (ind === 'none' ? 'operational' : ind);
    document.getElementById('overall-text').textContent = d.status?.description || 'All Systems Operational';

    const sm = {};
    for (const c of (d.components || [])) sm[c.id] = c.status;

    const container = document.getElementById('uptime-cards');
    container.innerHTML = '';
    for (const comp of COMPONENTS) {
      const s = sm[comp.id] || 'operational';
      const card = document.createElement('div');
      card.className = 'uptime-card';
      card.innerHTML = `
        <div class="uptime-header">
          <span class="uptime-name">${comp.name}</span>
          <span class="uptime-status ${s}">${fmtStatus(s)}</span>
        </div>
        <div class="uptime-bars" id="bars-${comp.id}"></div>
        <div class="uptime-footer">
          <span>30d</span>
          <span class="uptime-pct" id="pct-${comp.id}">...</span>
          <span>now</span>
        </div>`;
      container.appendChild(card);
      loadUptimeBars(comp.id);
    }

    const inc = d.incidents || [];
    const incS = document.getElementById('incidents-section');
    const incL = document.getElementById('incidents-list');
    if (inc.length) {
      incS.style.display = 'block';
      incL.innerHTML = '';
      for (const i of inc) {
        const c = document.createElement('div');
        c.className = 'incident-card' + (i.impact === 'major' ? ' major' : '');
        c.innerHTML = `<div class="incident-name">${i.name}</div><div class="incident-status">${i.status}</div>`;
        incL.appendChild(c);
      }
    } else incS.style.display = 'none';
  } catch { document.getElementById('overall-text').textContent = 'Unable to load'; }
}

async function loadUptimeBars(cid) {
  try {
    const res = await fetch(`/api/uptime/${cid}`);
    const d = await res.json();
    const bEl = document.getElementById(`bars-${cid}`);
    const pEl = document.getElementById(`pct-${cid}`);
    if (!bEl) return;
    const allD = [];
    for (const m of (d.months || [])) for (const day of (m.days || [])) allD.push(day);
    const days = allD.slice(-30);
    bEl.innerHTML = '';
    for (const day of days) {
      const b = document.createElement('div');
      b.className = 'uptime-bar';
      b.style.backgroundColor = day.color || '#76ad2a';
      const tt = document.createElement('div');
      tt.className = 'uptime-bar-tooltip';
      const ds = day.date ? new Date(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
      const ev = (day.events || []).map(e => e.name).join(', ');
      tt.textContent = ev ? `${ds}: ${ev}` : `${ds}: OK`;
      b.appendChild(tt);
      bEl.appendChild(b);
    }
    const lm = (d.months || []).slice(-1)[0];
    pEl.textContent = lm?.uptime_percentage != null ? `${(lm.uptime_percentage * 100).toFixed(1)}%` : '—';
  } catch {}
}

function fmtStatus(s) { return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }

// ---- Meter ----
function updateMeter() {
  fetch('/api/votes/counts').then(r => r.json()).then(d => {
    const t = d.smart + d.dumb;
    const sp = t > 0 ? (d.smart / t * 100) : 50;
    document.getElementById('meter-smart').style.width = sp + '%';
    document.getElementById('meter-dumb').style.width = (100 - sp) + '%';
    document.getElementById('count-smart').textContent = `${d.smart} smart`;
    document.getElementById('count-dumb').textContent = `${d.dumb} dumb`;
  });
}

// ---- Vote ----
async function submitVote(type) {
  const fb = document.getElementById('vote-status');
  const commentInput = document.getElementById('comment-input');
  const comment = commentInput.value.trim() || null;

  fb.textContent = 'voting...';
  fb.className = 'vote-feedback';
  try {
    const res = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vote: type, comment }),
    });
    const data = await res.json();
    if (data.success) {
      const cityMsg = data.city ? ` from ${data.city}` : '';
      fb.textContent = `recorded${cityMsg}`;
      fb.className = 'vote-feedback success';
      commentInput.value = '';
      updateVibes(); updateMeter(); loadVotes();
    } else {
      fb.textContent = data.error || 'failed';
      fb.className = 'vote-feedback error';
    }
  } catch {
    fb.textContent = 'network error';
    fb.className = 'vote-feedback error';
  }
}

document.getElementById('btn-smart').addEventListener('click', () => submitVote('smart'));
document.getElementById('btn-dumb').addEventListener('click', () => submitVote('dumb'));

// ---- Init ----
initGlobe().then(loadVotes);
updateVibes();
updateMeter();
loadOfficialStatus();
setInterval(() => { updateVibes(); updateMeter(); loadVotes(); }, 30000);
setInterval(loadOfficialStatus, 120000);
