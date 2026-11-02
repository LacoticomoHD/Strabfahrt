// STRABFAHRT Client: Karte, Fahrzeuganimation nach Fahrplan, Suche und Abfahrtsanzeige.
// Alle Zeiten sind Berliner Wanduhrzeit, als "Pseudo-UTC"-Sekunden gefuehrt (siehe wallNow).

const L = window.L;
// Statische Variante (Artifact/GitHub Pages): Fahrplanlogik laeuft im Browser, keine Kartenkacheln
const STATIC = window.STRAB_STATIC === true;

// ---------- Hilfen ----------

const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

const berlinFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function wallNow() {
  const p = Object.fromEntries(berlinFmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000;
}

const ymdOf = (sec) => new Date(sec * 1000).toISOString().slice(0, 10).replaceAll('-', '');
const dayStart = (ymd) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)) / 1000;
const pad = (n) => String(n).padStart(2, '0');

function hhmm(sec) {
  const s = ((Math.floor(sec) % 86400) + 86400) % 86400;
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}`;
}
function hhmmss(sec) {
  const s = ((Math.floor(sec) % 86400) + 86400) % 86400;
  return `${hhmm(s)}:${pad(s % 60)}`;
}

async function api(path, params = {}) {
  if (STATIC) return (await import('./local-api.js')).handle(path, params);
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

const groupOf = (type) => (type === 0 || type === 1 ? 'tram' : type === 2 ? 'rail' : type === 3 || type === 11 ? 'bus' : 'other');
const DEFAULT_COLOR = { tram: 'd1202e', rail: '2a2a2a', bus: '7a3e98', other: '555555' };

function readable(hex) {
  const n = parseInt(hex, 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#000' : '#fff';
}

function routeStyle(route) {
  const group = groupOf(route[1]);
  const bg = /^[0-9a-f]{6}$/i.test(route[2]) ? route[2] : DEFAULT_COLOR[group];
  const fg = /^[0-9a-f]{6}$/i.test(route[3]) ? `#${route[3]}` : readable(bg);
  return { bg: `#${bg}`, fg, group };
}

function cleanHeadsign(line, hs) {
  return hs.startsWith(line + ' ') ? hs.slice(line.length + 1) : hs;
}

function pill(line, style) {
  const p = el('span', { class: 'pill' }, line);
  p.style.background = style.bg;
  p.style.color = style.fg;
  return p;
}

// ---------- Lokaler Speicher (nur dieser Browser) ----------

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Speicher gesperrt: Funktion laeuft ohne Merken weiter */ }
}

// ---------- Zustand ----------

const state = {
  sim: wallNow(),
  speed: 1,
  playing: true,
  types: new Set(['tram', 'rail', 'bus', 'other']),
  meta: null,
  stops: [],
  stations: [], // { index, lat, lon, name }
  patterns: new Map(),
  profiles: new Map(),
  trips: [],
  window: null, // { from, to, bbox, types }
  loading: false,
  selected: null, // Fahrt
  station: null, // Stationsindex
  vehicles: [],
  list: null, // 'favs' | 'nearby' | 'lines'
  hiddenLines: new Set(load('strab.hiddenLines', [])),
  favorites: load('strab.favorites', []), // stop_id-Strings der Stationen
  here: null, // { lat, lon } Standort
};

// ---------- Karte ----------

const map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: !STATIC, minZoom: STATIC ? 9 : undefined, maxZoom: STATIC ? 18 : undefined });
L.control.zoom({ position: 'bottomright' }).addTo(map);
if (!STATIC) L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19, subdomains: 'abc', className: 'base-tiles', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende',
}).addTo(map);

const overlays = {
  infra: L.tileLayer('https://{s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abc', attribution: '© <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>' }),
  signals: L.tileLayer('https://{s}.tiles.openrailwaymap.org/signals/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abc' }),
  maxspeed: L.tileLayer('https://{s}.tiles.openrailwaymap.org/maxspeed/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abc' }),
};
for (const [key, layer] of Object.entries(overlays)) {
  $(`ovl-${key}`).addEventListener('change', (e) => {
    if (e.target.checked) layer.addTo(map); else map.removeLayer(layer);
    writeHash();
  });
}

// Canvas-Ebene fuer Fahrzeuge und Haltestellen
const canvas = el('canvas');
canvas.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:500';
$('map').appendChild(canvas);
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const size = map.getSize();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = size.x * dpr;
  canvas.height = size.y * dpr;
  canvas.style.width = `${size.x}px`;
  canvas.style.height = `${size.y}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
map.on('resize', resizeCanvas);

// ---------- Hash (Ansicht teilen) ----------

function readHash() {
  try { return parseHash(); } catch { return null; }
}
function parseHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const z = Number(p.get('z'));
  const lat = Number(p.get('lat'));
  const lon = Number(p.get('lon'));
  if (Number.isFinite(z) && Number.isFinite(lat) && Number.isFinite(lon) && p.has('z')) return { z, lat, lon, ol: (p.get('ol') || '').split(',').filter(Boolean) };
  return null;
}
function writeHash() {
  const c = map.getCenter();
  const ol = Object.keys(overlays).filter((k) => map.hasLayer(overlays[k]));
  const p = new URLSearchParams({ z: map.getZoom(), lat: c.lat.toFixed(5), lon: c.lng.toFixed(5) });
  if (ol.length) p.set('ol', ol.join(','));
  try { history.replaceState(null, '', `#${p}`); } catch { /* im eingebetteten Rahmen nicht erlaubt */ }
}

// ---------- Daten laden ----------

function paddedBounds() {
  return map.getBounds().pad(0.4);
}

function contains(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

function viewBox() {
  const b = map.getBounds();
  return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
}

async function loadWindow(force = false) {
  if (state.loading) return;
  const view = viewBox();
  const w = state.window;
  const typesKey = [...state.types].sort().join(',');
  const needs = force || !w || state.sim < w.from + 30 || state.sim > w.to - Math.max(120, state.speed * 20)
    || !contains(w.bbox, view) || w.types !== typesKey;
  if (!needs) return;
  if (!state.types.size) { state.trips = []; state.window = { from: state.sim, to: state.sim + 3600, bbox: view, types: typesKey }; return; }

  state.loading = true;
  try {
    const pb = paddedBounds();
    const bbox = [pb.getSouth(), pb.getWest(), pb.getNorth(), pb.getEast()];
    const ymd = ymdOf(state.sim);
    const base = dayStart(ymd);
    const t0 = Math.floor(state.sim - base - 600);
    const length = Math.min(6 * 3600, Math.max(2400, state.speed * 150));
    const t1 = t0 + length;
    const data = await api('/api/vehicles', { date: ymd, t0, t1, bbox: bbox.map((x) => x.toFixed(5)).join(','), types: typesKey });
    for (const [k, v] of Object.entries(data.patterns)) state.patterns.set(Number(k), v);
    for (const [k, v] of Object.entries(data.profiles)) state.profiles.set(Number(k), v);
    state.trips = data.trips.map(([pid, id, start, prof]) => {
      const profile = state.profiles.get(prof);
      const t = base + start;
      return { pid, id, t0: t, end: t + profile[profile.length - 2], prof: profile, k: 0 };
    });
    state.window = { from: base + t0, to: base + t1, bbox, types: typesKey };
    if (state.list === 'lines') renderLines();
    if (state.selected) {
      const again = state.trips.find((t) => t.id === state.selected.id);
      if (again) state.selected = again;
    }
  } catch (e) {
    console.error(e);
    $('count').textContent = 'Fehler beim Laden';
  } finally {
    state.loading = false;
  }
}

// ---------- Streckenverlauf ----------

const shapeData = new Map(); // "i,j" -> flache Liste lat,lon,lat,lon...
const geomCache = new Map();

function segGeom(si, sj) {
  const key = `${si},${sj}`;
  let g = geomCache.get(key);
  if (g) return g;
  const flat = shapeData.get(key);
  let pts;
  if (flat) {
    pts = [];
    for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
  } else {
    const a = state.stops[si];
    const b = state.stops[sj];
    pts = [[a[2], a[3]], [b[2], b[3]]];
  }
  const kx = Math.cos((pts[0][0] * Math.PI) / 180) * 111320;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot((pts[i][1] - pts[i - 1][1]) * kx, (pts[i][0] - pts[i - 1][0]) * 110540));
  }
  g = { pts, cum, total: cum[cum.length - 1] };
  geomCache.set(key, g);
  return g;
}

function along(g, f) {
  const last = g.pts[g.pts.length - 1];
  if (f <= 0 || g.total === 0) return g.pts[0];
  if (f >= 1) return last;
  const d = f * g.total;
  let i = 1;
  while (i < g.cum.length - 1 && g.cum[i] < d) i++;
  const span = g.cum[i] - g.cum[i - 1] || 1;
  const t = (d - g.cum[i - 1]) / span;
  const a = g.pts[i - 1];
  const b = g.pts[i];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// ---------- Position nach Fahrplan ----------

function locate(trip, now) {
  if (now < trip.t0 || now > trip.end) return null;
  const pat = state.patterns.get(trip.pid);
  const prof = trip.prof;
  const n = pat.s.length;
  const rel = now - trip.t0;
  let k = trip.k;
  while (k < n - 1 && rel >= prof[2 * (k + 1)]) k++;
  while (k > 0 && rel < prof[2 * k]) k--;
  trip.k = k;
  const a = state.stops[pat.s[k]];
  if (k >= n - 1 || rel <= prof[2 * k + 1]) return { lat: a[2], lon: a[3], k, f: 0, atStop: true };
  const f = (rel - prof[2 * k + 1]) / (prof[2 * (k + 1)] - prof[2 * k + 1]);
  const [lat, lon] = along(segGeom(pat.s[k], pat.s[k + 1]), f);
  return { lat, lon, k, f, atStop: false };
}

// ---------- Zeichnen ----------

function drawFrame() {
  const size = map.getSize();
  ctx.clearRect(0, 0, size.x, size.y);
  const zoom = map.getZoom();
  const dark = document.documentElement.dataset.theme === 'dark';
  const stopFill = dark ? '#1b2230' : '#fff';
  const stopLine = dark ? '#9db4d8' : '#33415c';

  // Schematisches Liniennetz als Hintergrund (nur ohne Kartenkacheln)
  if (STATIC && state.networkGroups) {
    const b = map.getBounds().pad(0.1);
    const colors = dark ? ['#8aa0c4', '#a7b3c9', '#56627a'] : ['#7d8aa3', '#4a5568', '#b8c0cd'];
    const widths = [2, 2.4, 1];
    ctx.lineJoin = 'round';
    for (const g of [2, 1, 0]) {
      ctx.beginPath();
      for (const [a, c] of state.networkGroups[g]) {
        const sa = state.stops[a];
        const sc = state.stops[c];
        if ((sa[2] < b.getSouth() && sc[2] < b.getSouth()) || (sa[2] > b.getNorth() && sc[2] > b.getNorth())
          || (sa[3] < b.getWest() && sc[3] < b.getWest()) || (sa[3] > b.getEast() && sc[3] > b.getEast())) continue;
        const p1 = map.latLngToContainerPoint([sa[2], sa[3]]);
        const p2 = map.latLngToContainerPoint([sc[2], sc[3]]);
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
      }
      ctx.strokeStyle = colors[g];
      ctx.lineWidth = widths[g];
      ctx.stroke();
    }
  }

  // Haltestellen
  if (zoom >= 14) {
    ctx.fillStyle = stopFill;
    ctx.strokeStyle = stopLine;
    ctx.lineWidth = 1.5;
    const b = map.getBounds();
    for (const s of state.stations) {
      if (s.lat < b.getSouth() || s.lat > b.getNorth() || s.lon < b.getWest() || s.lon > b.getEast()) continue;
      const p = map.latLngToContainerPoint([s.lat, s.lon]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, zoom >= 16 ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      if (zoom >= 16) {
        ctx.fillStyle = dark ? '#cfd8e8' : '#33415c';
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillText(s.name, p.x + 8, p.y + 4);
        ctx.fillStyle = stopFill;
      }
    }
  }

  // Fahrzeuge
  const out = [];
  for (const trip of state.trips) {
    const pat = state.patterns.get(trip.pid);
    const route = state.meta.routes[pat.r];
    const style = routeStyle(route);
    if (!state.types.has(style.group) || state.hiddenLines.has(route[0])) continue;
    const pos = locate(trip, state.sim);
    if (!pos) continue;
    const p = map.latLngToContainerPoint([pos.lat, pos.lon]);
    if (p.x < -40 || p.y < -40 || p.x > size.x + 40 || p.y > size.y + 40) continue;
    out.push({ trip, pat, route, style, pos, x: p.x, y: p.y });
  }
  state.vehicles = out;

  if (state.selected) drawRoute(state.selected);
  if (state.here) drawHere();

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (const v of out) {
    const sel = state.selected && state.selected.id === v.trip.id;
    if (zoom >= 14) {
      ctx.font = 'bold 11px system-ui, sans-serif';
      const label = route0(v.route);
      const w = Math.max(18, ctx.measureText(label).width + 8);
      ctx.fillStyle = v.style.bg;
      roundRect(v.x - w / 2, v.y - 8, w, 16, 5);
      ctx.fill();
      ctx.lineWidth = sel ? 3 : 1.2;
      ctx.strokeStyle = sel ? '#ffcc00' : '#ffffff';
      ctx.stroke();
      ctx.fillStyle = v.style.fg;
      ctx.fillText(label, v.x, v.y + 0.5);
    } else {
      ctx.beginPath();
      ctx.arc(v.x, v.y, zoom >= 12 ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = v.style.bg;
      ctx.fill();
      ctx.lineWidth = sel ? 3 : 1.2;
      ctx.strokeStyle = sel ? '#ffcc00' : '#ffffff';
      ctx.stroke();
    }
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
  $('count').textContent = `${out.length} Fahrzeuge`;
}

const route0 = (route) => route[0];

function drawHere() {
  const p = map.latLngToContainerPoint([state.here.lat, state.here.lon]);
  ctx.beginPath();
  ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#1a73e8';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawRoute(trip) {
  const pat = state.patterns.get(trip.pid);
  if (!pat) return;
  const style = routeStyle(state.meta.routes[pat.r]);
  ctx.beginPath();
  let first = true;
  for (let i = 1; i < pat.s.length; i++) {
    for (const pt of segGeom(pat.s[i - 1], pat.s[i]).pts) {
      const p = map.latLngToContainerPoint(pt);
      if (first) { ctx.moveTo(p.x, p.y); first = false; } else ctx.lineTo(p.x, p.y);
    }
  }
  ctx.lineWidth = 4;
  ctx.strokeStyle = style.bg;
  ctx.globalAlpha = 0.65;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ---------- Uhr ----------

let last = performance.now();
let lastClockText = '';
function tick(now) {
  const dt = (now - last) / 1000;
  last = now;
  if (state.playing) state.sim += dt * state.speed;
  const text = hhmmss(state.sim);
  if (text !== lastClockText) {
    $('clock').textContent = text;
    lastClockText = text;
    if (!document.activeElement || document.activeElement.id !== 'when') {
      $('when').value = new Date(state.sim * 1000).toISOString().slice(0, 16);
    }
    if (state.selected) renderVehiclePanel();
  }
  if (state.meta) {
    loadWindow();
    drawFrame();
  }
  requestAnimationFrame(tick);
}

// ---------- Bedienung ----------

$('play').addEventListener('click', () => {
  state.playing = !state.playing;
  $('play').textContent = state.playing ? '❚❚' : '▶';
  $('play').setAttribute('aria-label', state.playing ? 'Pause' : 'Abspielen');
});
$('speed').addEventListener('change', (e) => { state.speed = Number(e.target.value); state.window = null; });
$('now').addEventListener('click', () => { state.sim = wallNow(); state.speed = 1; $('speed').value = '1'; state.window = null; });
$('when').addEventListener('change', (e) => {
  const t = Date.parse(`${e.target.value}:00Z`) / 1000;
  if (Number.isFinite(t)) { state.sim = t; state.window = null; }
});
document.querySelectorAll('input[data-type]').forEach((box) => {
  box.addEventListener('change', () => {
    if (box.checked) state.types.add(box.dataset.type); else state.types.delete(box.dataset.type);
    state.window = null;
  });
});

map.on('moveend', writeHash);

map.on('click', (e) => {
  const pt = map.latLngToContainerPoint(e.latlng);
  let best = null;
  let bestD = 18;
  for (const v of state.vehicles) {
    const d = Math.hypot(v.x - pt.x, v.y - pt.y);
    if (d < bestD) { best = v; bestD = d; }
  }
  if (best) { selectVehicle(best.trip); return; }
  if (map.getZoom() >= 14) {
    let bs = null;
    let bd = 14;
    for (const s of state.stations) {
      const p = map.latLngToContainerPoint([s.lat, s.lon]);
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < bd) { bs = s; bd = d; }
    }
    if (bs) { openStation(bs.index); return; }
  }
  closePanel();
});

// ---------- Panels ----------

function showPanel() {
  $('panel').hidden = false;
  document.body.classList.add('panel-open');
}

function closePanel() {
  state.selected = null;
  state.station = null;
  state.list = null;
  clearInterval(stationTimer);
  $('panel').hidden = true;
  document.body.classList.remove('panel-open');
}
$('panel-close').addEventListener('click', closePanel);

function selectVehicle(trip) {
  clearInterval(stationTimer);
  state.station = null;
  state.list = null;
  state.selected = trip;
  renderVehiclePanel();
}

function renderVehiclePanel() {
  const trip = state.selected;
  if (!trip) return;
  const pat = state.patterns.get(trip.pid);
  const route = state.meta.routes[pat.r];
  const style = routeStyle(route);
  const pos = locate(trip, state.sim);
  const body = $('panel-body');
  body.replaceChildren();
  body.append(el('h2', {}, pill(route[0], style), ' ', cleanHeadsign(route[0], pat.h) || 'Ziel unbekannt'));
  let sub = 'Fahrplanposition (Soll)';
  if (!pos) sub = state.sim < trip.t0 ? `Fährt ab ${hhmm(trip.t0)}` : 'Fahrt beendet';
  body.append(el('div', { class: 'sub' }, sub));
  const table = el('table');
  pat.s.forEach((si, i) => {
    const s = state.stops[si];
    const arr = trip.t0 + trip.prof[2 * i];
    const dep = trip.t0 + trip.prof[2 * i + 1];
    const cls = state.sim > dep ? 'passed' : pos && pos.k === i && pos.atStop ? 'current' : '';
    const link = el('a', { class: 'stop', role: 'button', tabindex: '0' }, s[1]);
    const open = () => openStation(s[4] >= 0 ? s[4] : si);
    link.addEventListener('click', open);
    link.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
    table.append(el('tr', { class: cls }, el('td', { class: 't' }, hhmm(i === 0 ? dep : arr)), el('td', {}, link), el('td', { class: 'r' }, s[5] ? `Steig ${s[5]}` : '')));
  });
  body.append(table);
  showPanel();
}

let stationTimer = null;
let platformFilter = null;

function refreshPanel() {
  if (state.station !== null) renderStation();
  else if (state.list === 'favs') renderFavs();
  else if (state.list === 'nearby') renderNearby();
}

async function openStation(index) {
  state.selected = null;
  state.list = null;
  state.station = index;
  platformFilter = null;
  clearInterval(stationTimer);
  await renderStation();
  stationTimer = setInterval(refreshPanel, 15000);
  const s = state.stops[index];
  map.panTo([s[2], s[3]]);
}

async function renderStation() {
  const index = state.station;
  if (index === null) return;
  const s = state.stops[index];
  let list = [];
  try {
    list = await api('/api/departures', { station: index, date: ymdOf(state.sim), from: Math.floor(state.sim - dayStart(ymdOf(state.sim))), limit: 80 });
  } catch (e) {
    console.error(e);
  }
  if (state.station !== index) return;
  const base = dayStart(ymdOf(state.sim));
  const body = $('panel-body');
  body.replaceChildren();
  const stationId = s[0];
  const isFav = state.favorites.includes(stationId);
  const star = el('button', { class: 'star', type: 'button', 'aria-pressed': String(isFav), 'aria-label': isFav ? 'Favorit entfernen' : 'Als Favorit speichern' }, isFav ? '★' : '☆');
  star.addEventListener('click', () => toggleFavorite(stationId, index));
  body.append(el('h2', {}, star, ' ', s[1]));
  body.append(el('div', { class: 'sub' }, `Abfahrten nach Fahrplan ab ${hhmm(state.sim)} (Soll, keine Echtzeit)`));

  const platforms = [...new Set(list.map((d) => d.platform).filter(Boolean))].sort();
  if (platforms.length > 1) {
    const chips = el('div', { class: 'chips' });
    const mk = (label, value) => {
      const b = el('button', { class: 'chip', type: 'button', 'aria-pressed': String(platformFilter === value) }, label);
      b.addEventListener('click', () => { platformFilter = value; renderStation(); });
      return b;
    };
    chips.append(mk('Alle', null));
    for (const p of platforms) chips.append(mk(`Steig ${p}`, p));
    body.append(chips);
  }

  const shown = list.filter((d) => !platformFilter || d.platform === platformFilter).slice(0, 40);
  if (!shown.length) {
    body.append(el('div', { class: 'empty' }, 'Keine Abfahrten in den nächsten Stunden.'));
  } else {
    const table = el('table');
    for (const d of shown) {
      const style = routeStyle([d.line, d.type, d.color, d.textColor]);
      const mins = Math.round((base + d.t - state.sim) / 60);
      table.append(el('tr', {},
        el('td', { class: 't' }, hhmm(d.t)),
        el('td', {}, pill(d.line, style), ' ', cleanHeadsign(d.line, d.headsign)),
        el('td', { class: 'r' }, d.platform ? `Steig ${d.platform} · ` : '', mins <= 0 ? 'jetzt' : `in ${mins} min`)));
    }
    body.append(table);
  }
  showPanel();
}

// ---------- Favoriten, Naehe, Linien ----------

function toggleFavorite(stationId, index) {
  const i = state.favorites.indexOf(stationId);
  if (i >= 0) state.favorites.splice(i, 1); else state.favorites.push(stationId);
  save('strab.favorites', state.favorites);
  if (state.station === index) renderStation();
}

function departuresFor(index, limit) {
  const ymd = ymdOf(state.sim);
  return api('/api/departures', { station: index, date: ymd, from: Math.floor(state.sim - dayStart(ymd)), limit }).catch(() => []);
}

function stationBlock(index, deps, extra) {
  const s = state.stops[index];
  const link = el('a', { class: 'stop', role: 'button', tabindex: '0' }, s[1]);
  const open = () => openStation(index);
  link.addEventListener('click', open);
  link.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
  const block = el('div', { class: 'block' }, el('div', { class: 'bh' }, link, extra ? el('span', { class: 'sub' }, ` ${extra}`) : ''));
  if (!deps.length) block.append(el('div', { class: 'empty' }, 'Keine Abfahrten in den nächsten Stunden.'));
  else {
    const table = el('table');
    const base = dayStart(ymdOf(state.sim));
    for (const d of deps) {
      const mins = Math.round((base + d.t - state.sim) / 60);
      table.append(el('tr', {}, el('td', { class: 't' }, hhmm(d.t)),
        el('td', {}, pill(d.line, routeStyle([d.line, d.type, d.color, d.textColor])), ' ', cleanHeadsign(d.line, d.headsign)),
        el('td', { class: 'r' }, mins <= 0 ? 'jetzt' : `in ${mins} min`)));
    }
    block.append(table);
  }
  return block;
}

function startList(mode) {
  state.selected = null;
  state.station = null;
  state.list = mode;
  clearInterval(stationTimer);
  refreshPanel();
  if (mode !== 'lines') stationTimer = setInterval(refreshPanel, 15000);
  showPanel();
}

async function renderFavs() {
  const idxById = new Map(state.stops.map((s, i) => [s[0], i]));
  const items = state.favorites.map((id) => idxById.get(id)).filter((i) => i !== undefined);
  const results = await Promise.all(items.map((i) => departuresFor(i, 3)));
  if (state.list !== 'favs') return;
  const body = $('panel-body');
  body.replaceChildren(el('h2', {}, '★ Favoriten'), el('div', { class: 'sub' }, 'Nächste Abfahrten nach Fahrplan (Soll)'));
  if (!items.length) body.append(el('div', { class: 'empty' }, 'Noch keine Favoriten. Haltestelle öffnen und den Stern antippen.'));
  items.forEach((i, n) => body.append(stationBlock(i, results[n])));
  showPanel();
}

function distanceM(lat1, lon1, lat2, lon2) {
  const kx = Math.cos(((lat1 + lat2) / 2) * Math.PI / 180) * 111320;
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 110540);
}

function locateMe() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Standort wird vom Browser nicht unterstützt'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => reject(new Error('Standort nicht verfügbar oder nicht erlaubt')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  });
}

async function renderNearby() {
  const body = $('panel-body');
  if (!state.here) {
    body.replaceChildren(el('h2', {}, '◎ In der Nähe'), el('div', { class: 'sub' }, 'Standort wird ermittelt …'));
    showPanel();
    try {
      state.here = await locateMe();
      map.setView([state.here.lat, state.here.lon], Math.max(map.getZoom(), 15));
    } catch (e) {
      if (state.list === 'nearby') body.replaceChildren(el('h2', {}, '◎ In der Nähe'), el('div', { class: 'empty' }, e.message));
      return;
    }
  }
  const near = state.stations
    .map((s) => ({ s, d: distanceM(state.here.lat, state.here.lon, s.lat, s.lon) }))
    .filter((x) => x.d <= 1500)
    .sort((a, b) => a.d - b.d)
    .slice(0, 6);
  const results = await Promise.all(near.map((x) => departuresFor(x.s.index, 2)));
  if (state.list !== 'nearby') return;
  body.replaceChildren(el('h2', {}, '◎ In der Nähe'), el('div', { class: 'sub' }, 'Haltestellen bis 1,5 km, Abfahrten nach Fahrplan (Soll)'));
  if (!near.length) body.append(el('div', { class: 'empty' }, 'Keine Haltestelle im Umkreis von 1,5 km.'));
  near.forEach((x, n) => body.append(stationBlock(x.s.index, results[n], `${Math.round(x.d / 10) * 10} m`)));
  showPanel();
}

function renderLines() {
  if (state.list !== 'lines') return;
  const found = new Map();
  for (const trip of state.trips) {
    const route = state.meta.routes[state.patterns.get(trip.pid).r];
    if (!found.has(route[0])) found.set(route[0], route);
  }
  const order = { tram: 0, rail: 1, bus: 2, other: 3 };
  const lines = [...found.values()].sort((a, b) => order[groupOf(a[1])] - order[groupOf(b[1])] || a[0].localeCompare(b[0], 'de', { numeric: true }));
  const body = $('panel-body');
  body.replaceChildren(el('h2', {}, 'Linien'), el('div', { class: 'sub' }, 'Antippen blendet eine Linie ein oder aus (gespeichert in diesem Browser)'));
  const actions = el('div', { class: 'chips' });
  const all = el('button', { class: 'chip', type: 'button' }, 'Alle an');
  all.addEventListener('click', () => { state.hiddenLines.clear(); save('strab.hiddenLines', []); renderLines(); });
  const none = el('button', { class: 'chip', type: 'button' }, 'Alle aus');
  none.addEventListener('click', () => { lines.forEach((r) => state.hiddenLines.add(r[0])); save('strab.hiddenLines', [...state.hiddenLines]); renderLines(); });
  actions.append(all, none);
  body.append(actions);
  const grid = el('div', { class: 'linegrid' });
  for (const route of lines) {
    const on = !state.hiddenLines.has(route[0]);
    const b = el('button', { class: 'linebtn', type: 'button', 'aria-pressed': String(on), 'aria-label': `Linie ${route[0]} ${on ? 'ausblenden' : 'einblenden'}` });
    b.append(pill(route[0], routeStyle(route)));
    b.addEventListener('click', () => {
      if (on) state.hiddenLines.add(route[0]); else state.hiddenLines.delete(route[0]);
      save('strab.hiddenLines', [...state.hiddenLines]);
      renderLines();
    });
    grid.append(b);
  }
  if (!lines.length) grid.append(el('div', { class: 'empty' }, 'Gerade keine Linien im Kartenausschnitt.'));
  body.append(grid);
  showPanel();
}

$('btn-favs').addEventListener('click', () => (state.list === 'favs' ? closePanel() : startList('favs')));
$('btn-nearby').addEventListener('click', () => { state.here = null; startList('nearby'); });
$('btn-lines').addEventListener('click', () => (state.list === 'lines' ? closePanel() : (state.list = 'lines', state.selected = null, state.station = null, clearInterval(stationTimer), renderLines())));

// ---------- Darstellung ----------

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('btn-theme').setAttribute('aria-pressed', String(theme === 'dark'));
}
applyTheme(load('strab.theme', null) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
$('btn-theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  save('strab.theme', next);
});

if (window.innerWidth < 700) $('bar').classList.add('collapsed');
$('collapse').addEventListener('click', () => {
  const c = $('bar').classList.toggle('collapsed');
  $('collapse').setAttribute('aria-expanded', String(!c));
});

// ---------- Suche ----------

const searchInput = $('search');
const resultsEl = $('results');
let searchSeq = 0;
let searchTimer = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 160);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { resultsEl.hidden = true; return; }
  if (e.key === 'Enter') {
    const first = resultsEl.querySelector('li');
    if (first) first.click();
  }
});
document.addEventListener('click', (e) => { if (!$('searchbox').contains(e.target)) resultsEl.hidden = true; });

async function runSearch() {
  const q = searchInput.value.trim();
  const seq = ++searchSeq;
  if (q.length < 2) { resultsEl.hidden = true; return; }
  let res = [];
  try { res = await api('/api/search', { q }); } catch (e) { console.error(e); }
  if (seq !== searchSeq) return;
  resultsEl.replaceChildren();
  for (const r of res) {
    const li = el('li', { role: 'option' }, r.name);
    li.addEventListener('click', () => {
      resultsEl.hidden = true;
      searchInput.value = r.name;
      map.setView([r.lat, r.lon], Math.max(map.getZoom(), 16));
      openStation(r.index);
    });
    resultsEl.append(li);
  }
  if (!res.length) resultsEl.append(el('li', {}, 'Nichts gefunden'));
  resultsEl.hidden = false;
}

// ---------- Start ----------

async function init() {
  const [meta, stops] = await Promise.all([api('/api/meta'), api('/api/stops')]);
  state.meta = meta;
  state.stops = stops;
  try {
    const shapes = await api('/api/shapes');
    for (const [k, v] of Object.entries(shapes.segs)) shapeData.set(k, v);
  } catch { /* ohne Gleisgeometrie fahren Fahrzeuge in Luftlinie */ }

  // Stationen = Eltern oder Halte ohne Eltern, die auch bedient werden
  const parentsWithKids = new Set();
  stops.forEach((s) => { if (s[4] >= 0) parentsWithKids.add(s[4]); });
  stops.forEach((s, i) => {
    const isStation = s[6] === 1 || s[4] < 0;
    if (!isStation) return;
    if (s[6] === 1 && !parentsWithKids.has(i)) return;
    state.stations.push({ index: i, lat: s[2], lon: s[3], name: s[1] });
  });

  if (STATIC) {
    document.body.classList.add('static');
    const groups = [[], [], []];
    for (const [a, b, g] of await api('/api/network')) groups[g].push([a, b]);
    state.networkGroups = groups;
    $('note').textContent = 'Vorschau ohne Kartenkacheln, das Liniennetz ist schematisch (Luftlinie zwischen Haltestellen). Positionen nach Fahrplan (Soll), keine Echtzeit. Daten: KVV (CC0). Ohne Gewähr.';
  }
  const h = readHash();
  const [s, w, n, e] = meta.bbox;
  if (h) map.setView([h.lat, h.lon], h.z);
  else map.fitBounds([[s, w], [n, e]]);
  if (h) for (const k of h.ol) if (overlays[k]) { overlays[k].addTo(map); $(`ovl-${k}`).checked = true; }
  map.setMaxBounds([[s - 0.3, w - 0.4], [n + 0.3, e + 0.4]]);

  resizeCanvas();
  writeHash();
}

init().then(() => requestAnimationFrame(tick)).catch((e) => {
  console.error(e);
  $('count').textContent = 'Start fehlgeschlagen';
});
