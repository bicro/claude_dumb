// ============================================================
// claudedumb.com — Frontend
// ============================================================

let globeInstance = null;
let selectedFile = null;
const _pinnedParam = new URLSearchParams(window.location.search).get('post');
let currentSort = _pinnedParam ? 'trending' : 'newest';
let feedOffset = 0;
let feedLoading = false;
let feedExhausted = false;
const FEED_PAGE_SIZE = 30;

const COMPONENTS = [
  { id: 'rwppv331jlwc', name: 'claude.ai' },
  { id: '0qbwn08sd68x', name: 'platform.claude.com' },
  { id: 'k8w3r06qmzrp', name: 'Claude API' },
  { id: 'yyzkbfz2thpt', name: 'Claude Code' },
  { id: '0scnb50nvy53', name: 'Claude for Gov' },
];

// ---- Globe ----
async function initGlobe() {
  const wrapper = document.getElementById('globe-wrapper');

  let countries = { features: [] };
  try {
    const res = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
    const topo = await res.json();
    countries = toGeoJSON(topo, 'countries');
  } catch (e) { console.warn('Country data failed'); }

  const w = wrapper.clientWidth || 340;
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
    .polygonCapColor(() => '#d4c9b8')
    .polygonSideColor(() => 'rgba(180,165,140,0.4)')
    .polygonStrokeColor(() => '#a89880')
    .polygonAltitude(0.004)
    .pointsData([])
    .pointLat('lat')
    .pointLng('lng')
    .pointColor('color')
    .pointAltitude(0.008)
    .pointRadius('radius')
    .pointsMerge(true)
    .pointsTransitionDuration(600)
    .ringsData([])
    .ringLat('lat')
    .ringLng('lng')
    .ringColor('ringColor')
    .ringMaxRadius('maxR')
    .ringPropagationSpeed('speed')
    .ringRepeatPeriod('period')
    .ringAltitude(0.005);

  const mat = globeInstance.globeMaterial();
  mat.color.set('#e8e0d4');
  mat.shininess = 5;

  globeInstance.renderer().setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const ctrl = globeInstance.controls();
  ctrl.autoRotate = true;
  ctrl.autoRotateSpeed = 0.4;
  ctrl.enableDamping = true;
  ctrl.dampingFactor = 0.12;
  ctrl.minDistance = 120;
  ctrl.maxDistance = 500;

  function resizeGlobe() {
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;
    if (w > 0 && h > 0) {
      globeInstance.width(w).height(h);
      // Scale camera altitude so globe fits smaller containers
      const minDim = Math.min(w, h);
      const altitude = minDim < 200 ? 4.5 : minDim < 300 ? 3.8 : minDim < 400 ? 3.2 : minDim < 500 ? 2.8 : minDim < 600 ? 2.5 : 2.2;
      globeInstance.pointOfView({ altitude });
    }
  }
  window.addEventListener('resize', resizeGlobe);
  // Re-check after layout settles
  setTimeout(resizeGlobe, 200);
}

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

// ---- Vote dots + zone markers ----
function loadVotes() {
  fetch('/api/votes/recent').then(r => r.json()).then(data => {
    if (!globeInstance) return;
    const filtered = data.filter(v => v.latitude != null && v.longitude != null);

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

    const zones = clusterVotes(filtered);
    globeInstance.htmlElementsData(zones);
  });
}

function clusterVotes(votes) {
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
    if (cell.count < 3) continue;
    const lat = cell.lat / cell.count;
    const lng = cell.lng / cell.count;
    const ratio = cell.smart / cell.count;
    const type = ratio >= 0.6 ? 'hot' : ratio <= 0.4 ? 'cold' : null;
    if (!type) continue;
    zones.push({ lat, lng, type, smart: cell.smart, dumb: cell.dumb, count: cell.count, ratio });
  }
  const hot = zones.filter(z => z.type === 'hot').sort((a, b) => b.count - a.count).slice(0, 4);
  const cold = zones.filter(z => z.type === 'cold').sort((a, b) => b.count - a.count).slice(0, 4);
  return [...hot, ...cold];
}

function setupZoneMarkers() {
  if (!globeInstance) return;
  globeInstance
    .htmlLat('lat')
    .htmlLng('lng')
    .htmlAltitude(d => d.type === 'hot' ? 0.06 : 0.03)
    .htmlElement(d => d.type === 'hot' ? createHotZone(d) : createColdZone(d))
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
  for (let i = 0; i < 3; i++) { const s = document.createElement('div'); s.className = 'meteor-streak'; el.appendChild(s); }
  for (let i = 0; i < 2; i++) { const r = document.createElement('div'); r.className = 'impact-ring'; el.appendChild(r); }
  const holo = document.createElement('div');
  holo.className = 'kaiju-holo';
  const icon = document.createElement('div');
  icon.className = 'kaiju-icon';
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
      if (!data || (data.smart + data.dumb === 0)) { color = '#e8e4de'; label = `${hr}: no votes`; }
      else {
        const r = data.smart / (data.smart + data.dumb);
        const v = data.smart + data.dumb;
        if (r >= 0.7) color = '#5a9a1f'; else if (r >= 0.5) color = '#8cb83a'; else if (r >= 0.3) color = '#d4a017'; else color = '#d63031';
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

// ---- Official Status (header indicator) ----
async function loadOfficialStatus() {
  try {
    const res = await fetch('/api/claude-status');
    const d = await res.json();
    if (d.error) return;
    const ind = d.status?.indicator || 'none';
    const dot = document.getElementById('header-status-dot');
    const text = document.getElementById('header-status-text');
    dot.className = 'header-status-dot ' + (ind === 'none' ? 'operational' : ind);
    text.textContent = d.status?.description || 'All Systems Operational';
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

// ---- Screenshot Drop Zone ----
function initAttach() {
  const drop = document.getElementById('screenshot-drop');
  const fileInput = document.getElementById('screenshot-input');
  const preview = document.getElementById('upload-preview');
  const previewImg = document.getElementById('preview-img');
  const removeBtn = document.getElementById('upload-remove');

  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) setFile(f);
  });

  removeBtn.addEventListener('click', clearFile);

  function setFile(file) {
    if (file.size > 5 * 1024 * 1024) {
      document.getElementById('vote-status').textContent = 'Screenshot must be under 5MB';
      document.getElementById('vote-status').className = 'vote-feedback error';
      return;
    }
    selectedFile = file;
    previewImg.src = URL.createObjectURL(file);
    preview.style.display = 'flex';
    drop.style.display = 'none';
  }
  function clearFile() {
    selectedFile = null; fileInput.value = ''; previewImg.src = '';
    preview.style.display = 'none';
    drop.style.display = '';
  }
}

// ---- Vote ----
async function submitVote(type) {
  const fb = document.getElementById('vote-status');
  const commentInput = document.getElementById('comment-input');
  const comment = commentInput.value.trim() || null;
  fb.textContent = 'voting...';
  fb.className = 'vote-feedback';
  try {
    let res;
    if (selectedFile) {
      const formData = new FormData();
      formData.append('vote', type);
      if (comment) formData.append('comment', comment);
      formData.append('screenshot', selectedFile);
      res = await fetch('/api/vote', { method: 'POST', body: formData });
    } else {
      res = await fetch('/api/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vote: type, comment }),
      });
    }
    const data = await res.json();
    if (data.success) {
      const cityMsg = data.city ? ` from ${data.city}` : '';
      fb.textContent = `recorded${cityMsg}`;
      fb.className = 'vote-feedback success';
      commentInput.value = '';
      selectedFile = null;
      document.getElementById('screenshot-input').value = '';
      document.getElementById('preview-img').src = '';
      document.getElementById('upload-preview').style.display = 'none';
      document.getElementById('screenshot-drop').style.display = '';
      updateVibes(); updateMeter(); loadVotes(); updateTrend(); loadFeed();
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

// Mobile vote bar (no comment/screenshot, just vote)
function submitMobileVote(type) {
  const fb = document.getElementById('mobile-vote-status');
  fb.textContent = 'voting...';
  fb.className = 'mobile-vote-feedback show';
  fetch('/api/vote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vote: type }),
  }).then(r => r.json()).then(data => {
    if (data.success) {
      const cityMsg = data.city ? ` from ${data.city}` : '';
      fb.textContent = `recorded${cityMsg}`;
      fb.className = 'mobile-vote-feedback show success';
      updateVibes(); updateMeter(); loadVotes(); updateTrend(); loadFeed();
    } else {
      fb.textContent = data.error || 'failed';
      fb.className = 'mobile-vote-feedback show error';
    }
    setTimeout(() => { fb.className = 'mobile-vote-feedback'; }, 2000);
  }).catch(() => {
    fb.textContent = 'network error';
    fb.className = 'mobile-vote-feedback show error';
    setTimeout(() => { fb.className = 'mobile-vote-feedback'; }, 2000);
  });
}

document.getElementById('mobile-btn-smart').addEventListener('click', () => submitMobileVote('smart'));
document.getElementById('mobile-btn-dumb').addEventListener('click', () => submitMobileVote('dumb'));

// ---- Unified Feed ----
function flyToVote(lat, lng) {
  if (!globeInstance || lat == null || lng == null) return;
  globeInstance.controls().autoRotate = false;
  globeInstance.pointOfView({ lat, lng, altitude: 1.8 }, 1200);
  setTimeout(() => { if (globeInstance) globeInstance.controls().autoRotate = true; }, 6000);
}

const pinnedPostId = new URLSearchParams(window.location.search).get('post');
const pinnedPostPromise = pinnedPostId
  ? fetch(`/api/feed/post/${pinnedPostId}`).then(r => r.ok ? r.json() : null).catch(() => null)
  : Promise.resolve(null);

function loadFeed(append) {
  if (append && (feedLoading || feedExhausted)) return;
  feedLoading = true;
  if (!append) { feedOffset = 0; feedExhausted = false; }
  fetch(`/api/feed?sort=${currentSort}&limit=${FEED_PAGE_SIZE}&offset=${feedOffset}`).then(r => r.json()).then(async items => {
    const list = document.getElementById('feed-list');
    if (!list) return;
    if (!append) {
      list.innerHTML = '';
    }
    if (items.length < FEED_PAGE_SIZE) feedExhausted = true;
    feedOffset += items.length;
    if (items.length === 0 && !append) {
      list.insertAdjacentHTML('beforeend', `<div class="feed-empty">${currentSort === 'trending' ? 'No screenshots yet. Vote dumb with proof!' : 'No votes in the last 24 hours.'}</div>`);
      feedLoading = false;
      return;
    }

    // Remove pinned post from tab results to avoid duplicate
    if (pinnedPostId && !append) {
      const idx = items.findIndex(i => String(i.id) === pinnedPostId);
      if (idx !== -1) items.splice(idx, 1);
    }

    // Pin the shared post at the top of trending only
    const pinnedPost = !append && currentSort === 'trending' ? await pinnedPostPromise : null;
    if (pinnedPost) {
      const card = renderFeedCard(pinnedPost);
      card.classList.add('feed-card-pinned');
      list.appendChild(card);
    }

    for (const item of items) {
      list.appendChild(renderFeedCard(item));
    }
    feedLoading = false;

    // If the container isn't full enough to scroll, load more
    if (!feedExhausted) {
      const el = document.querySelector('.feed-list');
      const useMobile = window.innerWidth <= 800;
      const needsMore = useMobile
        ? document.body.scrollHeight <= window.innerHeight
        : el && el.scrollHeight <= el.clientHeight;
      if (needsMore) loadFeed(true);
    }
  }).catch(() => { feedLoading = false; });
}

function renderFeedCard(item) {
  const card = document.createElement('div');
  card.className = 'feed-card';

  const body = document.createElement('div');
  body.className = 'feed-card-body';

  // Meta line: vote label · city · time (top)
  const meta = document.createElement('div');
  meta.className = 'feed-card-meta';
  const voteLabel = document.createElement('span');
  voteLabel.className = 'feed-vote-label ' + item.vote;
  voteLabel.textContent = item.vote;
  meta.appendChild(voteLabel);
  const parts = [];
  if (item.city) parts.push(item.city);
  parts.push(getRelativeTime(item.created_at));
  meta.appendChild(document.createTextNode(' \u00B7 ' + parts.join(' \u00B7 ')));
  body.appendChild(meta);

  if (item.comment) {
    const comment = document.createElement('div');
    comment.className = 'feed-card-comment';
    comment.textContent = item.comment;
    body.appendChild(comment);
  }

  const hasContent = item.comment || item.thumb_url;

  // Screenshot below text, full width
  if (item.thumb_url) {
    const imgWrap = document.createElement('div');
    imgWrap.className = 'feed-card-image-wrap';
    const img = document.createElement('img');
    img.className = 'feed-card-image';
    img.src = item.full_url || item.thumb_url;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('click', (e) => { e.stopPropagation(); openLightbox(item.full_url); });
    img.onerror = () => { imgWrap.style.display = 'none'; };
    imgWrap.appendChild(img);
    body.appendChild(imgWrap);
  }

  // Actions line: only show for posts with content
  if (hasContent) {
    const actions = document.createElement('div');
    actions.className = 'feed-card-actions';

    const upBtn = document.createElement('button');
    upBtn.className = 'reaction-btn up' + (item.user_reaction === 'up' ? ' active' : '');
    upBtn.innerHTML = '\u25B2';
    upBtn.addEventListener('click', (e) => { e.stopPropagation(); handleReaction(item.id, 'up', card); });

    const scoreEl = document.createElement('span');
    scoreEl.className = 'reaction-score';
    scoreEl.textContent = item.score;

    const downBtn = document.createElement('button');
    downBtn.className = 'reaction-btn down' + (item.user_reaction === 'down' ? ' active' : '');
    downBtn.innerHTML = '\u25BC';
    downBtn.addEventListener('click', (e) => { e.stopPropagation(); handleReaction(item.id, 'down', card); });

    actions.appendChild(upBtn);
    actions.appendChild(scoreEl);
    actions.appendChild(downBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'share-btn';
    copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>';
    copyBtn.title = 'Copy link';
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(`${window.location.origin}/?post=${item.id}`);
      copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(() => { copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>'; }, 2000);
    });
    actions.appendChild(copyBtn);

    if (item.thumb_url) {
      const dlBtn = document.createElement('button');
      dlBtn.className = 'share-btn';
      dlBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
      dlBtn.title = 'Download image';
      dlBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const a = document.createElement('a');
        a.href = `/api/og-card/${item.id}`;
        a.download = `claudedumb-${item.id}.png`;
        a.click();
      });
      actions.appendChild(dlBtn);

      const shareBtn = document.createElement('button');
      shareBtn.className = 'share-btn';
      shareBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
      shareBtn.title = 'Share on X';
      shareBtn.addEventListener('click', (e) => { e.stopPropagation(); shareVote(item.id, item.comment, item.vote); });
      actions.appendChild(shareBtn);
    }

    body.appendChild(actions);
  } else {
    card.classList.add('feed-card-minimal');
  }

  card.appendChild(body);

  card.addEventListener('click', () => flyToVote(item.latitude, item.longitude));

  // Collapse heavily downvoted posts
  if (item.score <= -3) {
    card.classList.add('feed-card-collapsed');
    const expandBtn = document.createElement('button');
    expandBtn.className = 'feed-card-expand';
    expandBtn.textContent = 'show hidden post (score: ' + item.score + ')';
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.remove('feed-card-collapsed');
      expandBtn.remove();
    });
    card.prepend(expandBtn);
  }

  return card;
}

function getRelativeTime(dateStr) {
  const now = new Date();
  const then = new Date(dateStr);
  const hours = (now - then) / 3600000;
  if (hours < 0.017) return 'now';
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// ---- Feed Tabs ----
document.getElementById('tab-newest').addEventListener('click', () => switchTab('newest'));
document.getElementById('tab-trending').addEventListener('click', () => switchTab('trending'));
// Sync active tab UI with currentSort (may differ from HTML default when ?post= is present)
document.querySelectorAll('.feed-tab').forEach(t => t.classList.toggle('active', t.dataset.sort === currentSort));

function switchTab(sort) {
  currentSort = sort;
  document.querySelectorAll('.feed-tab').forEach(t => t.classList.toggle('active', t.dataset.sort === sort));
  loadFeed(false);
}

// Infinite scroll + jump to top
const feedListEl = document.querySelector('.feed-list');
const jumpBtn = document.getElementById('jump-to-top');

feedListEl.addEventListener('scroll', function() {
  if (this.scrollTop + this.clientHeight >= this.scrollHeight - 200) {
    loadFeed(true);
  }
  jumpBtn.classList.toggle('visible', this.scrollTop > 400);
});

// Mobile: window is the scroll container
window.addEventListener('scroll', function() {
  if (window.innerWidth <= 800) {
    if (window.scrollY + window.innerHeight >= document.body.scrollHeight - 200) {
      loadFeed(true);
    }
    jumpBtn.classList.toggle('visible', window.scrollY > 400);
  }
});

jumpBtn.addEventListener('click', () => {
  if (window.innerWidth <= 800) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    feedListEl.scrollTo({ top: 0, behavior: 'smooth' });
  }
});

// ---- Reactions ----
async function handleReaction(voteId, type, cardEl) {
  try {
    const res = await fetch('/api/react', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voteId, type }),
    });
    const data = await res.json();
    const scoreEl = cardEl.querySelector('.reaction-score');
    scoreEl.textContent = data.score;
    const upBtn = cardEl.querySelector('.reaction-btn.up');
    const downBtn = cardEl.querySelector('.reaction-btn.down');
    upBtn.classList.toggle('active', data.userReaction === 'up');
    downBtn.classList.toggle('active', data.userReaction === 'down');
  } catch {}
}

// ---- Share ----
function shareVote(voteId, comment, vote) {
  const vibe = vote === 'smart' ? 'smart' : 'dumb';
  const text = comment
    ? `claude is being ${vibe} rn: "${comment}" \u2014 claudedumb.com`
    : `claude is being ${vibe} rn \u2014 claudedumb.com`;
  const url = `${window.location.origin}/s/${voteId}`;
  window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank', 'width=550,height=420');
}

// ---- Lightbox ----
function openLightbox(imageUrl) {
  document.getElementById('lightbox-img').src = imageUrl;
  document.getElementById('lightbox').style.display = 'flex';
}
function closeLightbox() {
  document.getElementById('lightbox-img').src = '';
  document.getElementById('lightbox').style.display = 'none';
}
document.getElementById('lightbox-backdrop').addEventListener('click', closeLightbox);
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

// ---- Leaderboard ----
function loadLeaderboard() {
  fetch('/api/leaderboard').then(r => r.json()).then(items => {
    const list = document.getElementById('leaderboard-list');
    list.innerHTML = '';
    if (items.length === 0) { list.innerHTML = '<div class="leaderboard-empty">No shares yet</div>'; return; }
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const row = document.createElement('div');
      row.className = 'leaderboard-item';
      row.innerHTML = `<span class="leaderboard-rank">#${i + 1}</span>` +
        `<img class="leaderboard-thumb" src="${item.thumb_url}" alt="">` +
        `<span class="leaderboard-text">${item.comment || item.city || 'Screenshot'}</span>` +
        `<span class="leaderboard-score">${item.influence} click${item.influence !== 1 ? 's' : ''}</span>`;
      list.appendChild(row);
    }
  }).catch(() => {});
}

document.getElementById('leaderboard-toggle').addEventListener('click', () => {
  const list = document.getElementById('leaderboard-list');
  const btn = document.getElementById('leaderboard-toggle');
  const showing = list.style.display !== 'none';
  list.style.display = showing ? 'none' : '';
  btn.textContent = showing ? 'Top Influencers' : 'Hide Influencers';
  if (!showing) loadLeaderboard();
});

// ---- 7-Day Trend ----
function updateTrend() {
  fetch('/api/votes/daily').then(r => r.json()).then(rows => {
    const dayMap = {};
    for (const r of rows) dayMap[r.day] = r;
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
    const valid = points.filter(p => p.pct !== null);
    const pctEl = document.getElementById('trend-pct-inline') || document.getElementById('trend-pct');
    if (valid.length >= 2) {
      const diff = valid[valid.length - 1].pct - valid[0].pct;
      const arrow = diff > 0 ? '\u2191' : diff < 0 ? '\u2193' : '\u2192';
      pctEl.textContent = `${arrow} ${Math.abs(diff)}pts`;
      pctEl.className = 'trend-pct ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : '');
    } else { pctEl.textContent = ''; }

    const container = document.getElementById('trend-chart-inline') || document.getElementById('trend-chart');
    const W = container.clientWidth || 800, H = container.clientHeight || 80;
    const pad = { top: 20, bottom: 22, left: 12, right: 12 };
    const plotW = W - pad.left - pad.right, plotH = H - pad.top - pad.bottom;
    const xStep = points.length > 1 ? plotW / (points.length - 1) : 0;
    const coords = points.map((p, i) => ({ x: pad.left + i * xStep, y: p.pct !== null ? pad.top + plotH - (p.pct / 100 * plotH) : null, ...p }));
    const validCoords = coords.filter(c => c.y !== null);
    let pathD = '';
    if (validCoords.length >= 2) {
      pathD = `M${validCoords[0].x},${validCoords[0].y}`;
      for (let i = 1; i < validCoords.length; i++) {
        const prev = validCoords[i - 1], curr = validCoords[i], cpx = (prev.x + curr.x) / 2;
        pathD += ` C${cpx},${prev.y} ${cpx},${curr.y} ${curr.x},${curr.y}`;
      }
    }
    let areaD = validCoords.length >= 2 ? pathD + ` L${validCoords[validCoords.length - 1].x},${H - pad.bottom} L${validCoords[0].x},${H - pad.bottom} Z` : '';
    let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<defs><linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--green)" stop-opacity="0.2"/><stop offset="100%" stop-color="var(--green)" stop-opacity="0"/></linearGradient></defs>`;
    const midY = pad.top + plotH / 2;
    svg += `<line x1="${pad.left}" y1="${midY}" x2="${W - pad.right}" y2="${midY}" stroke="var(--border)" stroke-dasharray="4 4"/>`;
    svg += `<text x="${W - pad.right + 4}" y="${midY + 4}" fill="var(--text-3)" font-size="11" font-family="var(--font)" font-weight="600">50%</text>`;
    if (areaD) svg += `<path d="${areaD}" fill="url(#trendGrad)"/>`;
    if (pathD) svg += `<path d="${pathD}" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round"/>`;
    for (const c of coords) {
      svg += `<text x="${c.x}" y="${H - 4}" text-anchor="middle" fill="var(--text-2)" font-size="11" font-weight="600" font-family="var(--font)">${c.label}</text>`;
      if (c.y !== null) {
        const dotColor = c.pct >= 70 ? 'var(--green)' : c.pct >= 40 ? 'var(--yellow)' : 'var(--red)';
        svg += `<circle cx="${c.x}" cy="${c.y}" r="5" fill="${dotColor}" stroke="var(--bg-card)" stroke-width="2"/>`;
        svg += `<text x="${c.x}" y="${c.y - 10}" text-anchor="middle" fill="var(--text)" font-size="12" font-weight="700" font-family="var(--font)">${c.pct}%</text>`;
      }
    }
    svg += `</svg>`;
    container.innerHTML = svg;
  });
}


// ---- Init ----
initAttach();
initGlobe().then(() => { setupZoneMarkers(); loadVotes(); });
updateVibes();
updateMeter();
updateTrend();
loadOfficialStatus();
loadFeed();
setInterval(() => { updateVibes(); updateMeter(); loadVotes(); }, 30000);
setInterval(() => { updateTrend(); loadFeed(); }, 60000);
setInterval(loadOfficialStatus, 120000);
window.addEventListener('resize', updateTrend);
