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
    // Use native points layer (GPU-rendered, much faster than HTML elements)
    .pointsData([])
    .pointLat('lat')
    .pointLng('lng')
    .pointColor('color')
    .pointAltitude(0.008)
    .pointRadius('radius')
    .pointsMerge(true)  // merge into single geometry for performance
    .pointsTransitionDuration(600)

    // Rings layer for the pulsing effect (GPU-rendered)
    .ringsData([])
    .ringLat('lat')
    .ringLng('lng')
    .ringColor('ringColor')
    .ringMaxRadius('maxR')
    .ringPropagationSpeed('speed')
    .ringRepeatPeriod('period')
    .ringAltitude(0.005);

  const mat = globeInstance.globeMaterial();
  mat.color.set('#f2ece3');
  mat.shininess = 3;

  // Cap pixel ratio for performance on retina displays
  globeInstance.renderer().setPixelRatio(Math.min(window.devicePixelRatio, 2));

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

// ---- Vote dots (GPU-rendered points + rings) + zone markers ----
function loadVotes() {
  fetch('/api/votes/recent').then(r => r.json()).then(data => {
    if (!globeInstance) return;

    const filtered = data.filter(v => v.latitude != null && v.longitude != null);

    // Points (solid dots)
    const points = filtered.map(v => {
      const fade = Math.max(0.2, 1 - (v.hours_ago / 24));
      const s = v.vote === 'smart';
      const r = s ? 90 : 214, g = s ? 154 : 48, b = s ? 31 : 49;
      return {
        lat: v.latitude, lng: v.longitude, vote: v.vote,
        color: `rgba(${r},${g},${b},${fade.toFixed(2)})`,
        radius: 0.3 + fade * 0.35,
      };
    });
    globeInstance.pointsData(points);

    // Rings (pulsing effect) — only on recent votes (last 6h)
    const rings = filtered
      .filter(v => v.hours_ago < 6)
      .map(v => {
        const s = v.vote === 'smart';
        const fade = Math.max(0.2, 1 - (v.hours_ago / 6));
        return {
          lat: v.latitude, lng: v.longitude,
          ringColor: () => s ? `rgba(90,154,31,${(fade * 0.6).toFixed(2)})` : `rgba(214,48,49,${(fade * 0.6).toFixed(2)})`,
          maxR: 3 + fade * 2,
          speed: 1.5 + Math.random(),
          period: 1500 + Math.random() * 1000,
        };
      });
    globeInstance.ringsData(rings);

    // Cluster votes into zones and render markers
    const zones = clusterVotes(filtered);
    globeInstance.htmlElementsData(zones);

    updateActivityFeed(data);
  });
}

// ---- Cluster votes into geographic zones ----
function clusterVotes(votes) {
  // Grid-based clustering: 30-degree cells
  const cells = {};
  for (const v of votes) {
    const key = `${Math.round(v.latitude / 25) * 25},${Math.round(v.longitude / 30) * 30}`;
    if (!cells[key]) cells[key] = { lat: 0, lng: 0, smart: 0, dumb: 0, count: 0 };
    cells[key].lat += v.latitude;
    cells[key].lng += v.longitude;
    cells[key].count++;
    if (v.vote === 'smart') cells[key].smart++;
    else cells[key].dumb++;
  }

  const zones = [];
  for (const [, cell] of Object.entries(cells)) {
    if (cell.count < 3) continue; // need at least 3 votes to show a marker
    const lat = cell.lat / cell.count;
    const lng = cell.lng / cell.count;
    const ratio = cell.smart / cell.count;
    const type = ratio >= 0.6 ? 'hot' : ratio <= 0.4 ? 'cold' : null;
    if (!type) continue;

    zones.push({ lat, lng, type, smart: cell.smart, dumb: cell.dumb, count: cell.count, ratio });
  }

  // Limit to top 4 hot and top 4 cold by vote count
  const hot = zones.filter(z => z.type === 'hot').sort((a, b) => b.count - a.count).slice(0, 4);
  const cold = zones.filter(z => z.type === 'cold').sort((a, b) => b.count - a.count).slice(0, 4);

  return [...hot, ...cold];
}

// Configure the HTML elements layer for zone markers
function setupZoneMarkers() {
  if (!globeInstance) return;
  globeInstance
    .htmlLat('lat')
    .htmlLng('lng')
    .htmlAltitude(d => d.type === 'hot' ? 0.06 : 0.03)
    .htmlElement(d => {
      if (d.type === 'hot') return createHotZone(d);
      return createColdZone(d);
    })
    .htmlTransitionDuration(800);
}

function createHotZone(d) {
  const el = document.createElement('div');
  el.className = 'zone-hot';

  const img = document.createElement('img');
  img.src = '/avatar.jpg';
  img.className = 'zone-hot-avatar';
  el.appendChild(img);

  const ring = document.createElement('div');
  ring.className = 'zone-hot-ring';
  el.appendChild(ring);

  const label = document.createElement('div');
  label.className = 'zone-hot-label';
  label.textContent = `${Math.round(d.ratio * 100)}% vibes`;
  el.appendChild(label);

  return el;
}

function createColdZone(d) {
  const el = document.createElement('div');
  el.className = 'zone-cold';

  // Meteor streaks
  for (let i = 0; i < 3; i++) {
    const streak = document.createElement('div');
    streak.className = 'meteor-streak';
    el.appendChild(streak);
  }

  // Impact rings
  for (let i = 0; i < 2; i++) {
    const ring = document.createElement('div');
    ring.className = 'impact-ring';
    el.appendChild(ring);
  }

  // Kaiju hologram
  const holo = document.createElement('div');
  holo.className = 'kaiju-holo';

  const icon = document.createElement('div');
  icon.className = 'kaiju-icon';
  // Alternate between kaiju icons
  const icons = ['\u{1F9E0}', '\u{1F4A5}', '\u{26A0}\uFE0F}', '\u{1F525}'];
  icon.textContent = d.ratio <= 0.25 ? '\u{1F4A5}' : '\u{26A0}\uFE0F';
  holo.appendChild(icon);

  const scanline = document.createElement('div');
  scanline.className = 'kaiju-scanline';
  holo.appendChild(scanline);

  el.appendChild(holo);

  const label = document.createElement('div');
  label.className = 'zone-cold-label';
  label.textContent = d.ratio <= 0.25 ? 'CRITICAL' : 'WARNING';
  el.appendChild(label);

  return el;
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
    // Collect only real days (with a date), skip offsets and future placeholders
    const allD = [];
    for (const m of (d.months || [])) for (const day of (m.days || [])) if (day.date) allD.push(day);
    // Filter to only days up to today, then take last 30
    const today = new Date().toISOString().slice(0, 10);
    const pastDays = allD.filter(day => day.date.slice(0, 10) <= today);
    const days = pastDays.slice(-30);
    bEl.innerHTML = '';
    for (const day of days) {
      const b = document.createElement('div');
      b.className = 'uptime-bar';
      b.style.backgroundColor = day.color || '#76ad2a';
      const tt = document.createElement('div');
      tt.className = 'uptime-bar-tooltip';
      const ds = new Date(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const ev = (day.events || []).map(e => e.name).join(', ');
      tt.textContent = ev ? `${ds}: ${ev}` : `${ds}: OK`;
      b.appendChild(tt);
      bEl.appendChild(b);
    }
    // Calculate actual 30-day uptime from the days we're showing
    const totalSecs = days.length * 86400;
    const downSecs = days.reduce((sum, day) => sum + (day.p || 0) + (day.m || 0), 0);
    const uptimePct = totalSecs > 0 ? ((totalSecs - downSecs) / totalSecs * 100).toFixed(2) : '—';
    pEl.textContent = uptimePct !== '—' ? `${uptimePct}%` : '—';
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
      updateVibes(); updateMeter(); loadVotes(); updateTrend();
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

// ---- 7-Day Trend ----
function updateTrend() {
  fetch('/api/votes/daily').then(r => r.json()).then(rows => {
    const dayMap = {};
    for (const r of rows) dayMap[r.day] = r;

    // Build 7 data points (one per day)
    const points = [];
    const now = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const label = d.toLocaleDateString('en-US', { weekday: 'short' });
      const data = dayMap[key];
      if (data && (data.smart + data.dumb > 0)) {
        points.push({ label, pct: Math.round(data.smart / (data.smart + data.dumb) * 100), votes: data.smart + data.dumb });
      } else {
        points.push({ label, pct: null, votes: 0 });
      }
    }

    // Update summary
    const valid = points.filter(p => p.pct !== null);
    const pctEl = document.getElementById('trend-pct');
    if (valid.length >= 2) {
      const diff = valid[valid.length - 1].pct - valid[0].pct;
      const arrow = diff > 0 ? '\u2191' : diff < 0 ? '\u2193' : '\u2192';
      pctEl.textContent = `${arrow} ${Math.abs(diff)}pts`;
      pctEl.className = 'trend-pct ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : '');
    } else {
      pctEl.textContent = '';
    }

    // Render SVG
    const container = document.getElementById('trend-chart');
    const W = container.clientWidth || 800;
    const H = 100;
    const pad = { top: 16, bottom: 24, left: 12, right: 12 };
    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top - pad.bottom;

    // Scale: y goes from 0..100 (percent smart)
    const xStep = points.length > 1 ? plotW / (points.length - 1) : 0;
    const coords = points.map((p, i) => ({
      x: pad.left + i * xStep,
      y: p.pct !== null ? pad.top + plotH - (p.pct / 100 * plotH) : null,
      ...p,
    }));
    const validCoords = coords.filter(c => c.y !== null);

    let pathD = '';
    if (validCoords.length >= 2) {
      // Smooth curve using cardinal spline
      pathD = `M${validCoords[0].x},${validCoords[0].y}`;
      for (let i = 1; i < validCoords.length; i++) {
        const prev = validCoords[i - 1];
        const curr = validCoords[i];
        const cpx = (prev.x + curr.x) / 2;
        pathD += ` C${cpx},${prev.y} ${cpx},${curr.y} ${curr.x},${curr.y}`;
      }
    }

    // Area fill path
    let areaD = '';
    if (validCoords.length >= 2) {
      areaD = pathD + ` L${validCoords[validCoords.length - 1].x},${H - pad.bottom} L${validCoords[0].x},${H - pad.bottom} Z`;
    }

    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<defs><linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">`;
    svg += `<stop offset="0%" stop-color="var(--green)" stop-opacity="0.2"/>`;
    svg += `<stop offset="100%" stop-color="var(--green)" stop-opacity="0"/>`;
    svg += `</linearGradient></defs>`;

    // 50% reference line
    const midY = pad.top + plotH / 2;
    svg += `<line x1="${pad.left}" y1="${midY}" x2="${W - pad.right}" y2="${midY}" stroke="var(--border)" stroke-dasharray="4 4"/>`;
    svg += `<text x="${W - pad.right + 4}" y="${midY + 3}" fill="var(--text-3)" font-size="9" font-family="var(--font)">50%</text>`;

    // Area + line
    if (areaD) svg += `<path d="${areaD}" fill="url(#trendGrad)"/>`;
    if (pathD) svg += `<path d="${pathD}" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round"/>`;

    // Dots + labels
    for (const c of coords) {
      const lx = c.x;
      const ly = H - 4;
      svg += `<text x="${lx}" y="${ly}" text-anchor="middle" fill="var(--text-3)" font-size="10" font-family="var(--font)">${c.label}</text>`;
      if (c.y !== null) {
        const dotColor = c.pct >= 70 ? 'var(--green)' : c.pct >= 40 ? 'var(--yellow)' : 'var(--red)';
        svg += `<circle cx="${c.x}" cy="${c.y}" r="4" fill="${dotColor}" stroke="var(--bg-card)" stroke-width="2"/>`;
        svg += `<text x="${c.x}" y="${c.y - 8}" text-anchor="middle" fill="var(--text-2)" font-size="10" font-weight="600" font-family="var(--font)">${c.pct}%</text>`;
      }
    }

    svg += `</svg>`;
    container.innerHTML = svg;
  });
}

// ---- Init ----
initGlobe().then(() => {
  setupZoneMarkers();
  loadVotes();
});
updateVibes();
updateMeter();
updateTrend();
loadOfficialStatus();
setInterval(() => { updateVibes(); updateMeter(); loadVotes(); }, 30000);
setInterval(updateTrend, 60000);
setInterval(loadOfficialStatus, 120000);
window.addEventListener('resize', updateTrend);
