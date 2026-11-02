// STRABFAHRT Client: Karte, Fahrzeuganimation nach Fahrplan, Suche und Abfahrtsanzeige.
// Alle Zeiten sind Berliner Wanduhrzeit, als "Pseudo-UTC"-Sekunden gefuehrt (siehe wallNow).

const L = window.L;
// Statische Variante (Artifact/GitHub Pages): Fahrplanlogik laeuft im Browser, keine Kartenkacheln
const STATIC = window.STRAB_STATIC === true;
// Kacheln: immer in der Server-Variante, in der statischen nur mit --tiles (Webspace, nicht Artifact)
const TILES = !STATIC || window.STRAB_TILES === true;

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

function pill(line, style, onClick) {
  const p = el('span', { class: onClick ? 'pill pillbtn' : 'pill' }, line);
  p.style.background = style.bg;
  p.style.color = style.fg;
  if (onClick) {
    p.setAttribute('role', 'button');
    p.setAttribute('tabindex', '0');
    p.setAttribute('aria-label', `Linie ${line} ansehen`);
    p.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    p.addEventListener('keydown', (e) => { if (e.key === 'Enter') onClick(); });
  }
  return p;
}

const accessible = (flags) => ((flags || 0) & 3) === 1;

// ---------- Lokaler Speicher (nur dieser Browser) ----------

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  return save_(key, value);
}
function save_(key, value) {
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
  delays: new Map(), // Fahrt-ID -> Verspaetung in Sekunden (+ zu spaet, - zu frueh), aus Echtzeitquelle
  demo: false, // erfundene Werte, nur zum Ansehen der Darstellung
  onlyAccessible: false,
  follow: null, // Fahrt-ID, der die Karte folgt
  lineView: null, // { name, dirs, active }
  route: { from: null, to: null },
  journeys: [],
  journey: null, // gewaehlte Verbindung
  takt: { on: false, key: null, loading: false, data: new Map() }, // Abfahrten pro Stunde je Station
  reach: null, // { center, max, items: [[station, minuten]] }
  board: null, // Stationsindex der Vollbild-Tafel
};

// ---------- Karte ----------

const map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: TILES, minZoom: STATIC ? 9 : undefined, maxZoom: STATIC ? 18 : undefined });
L.control.zoom({ position: 'bottomright' }).addTo(map);
if (TILES) L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
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
  const view = p.has('z') && Number.isFinite(z) && Number.isFinite(lat) && Number.isFinite(lon);
  const out = { z: view ? z : null, lat, lon, st: p.get('st'), tafel: p.get('tafel'), rt: p.get('rt'), ol: (p.get('ol') || '').split(',').filter(Boolean) };
  return view || out.st || out.tafel || out.rt ? out : null;
}
let hashTimer = null;
function scheduleHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(writeHash, 400);
}
function writeHash() {
  if (state.board !== null && state.stops[state.board]) {
    try { history.replaceState(null, '', `#${new URLSearchParams({ tafel: state.stops[state.board][0] })}`); } catch { /* eingebetteter Rahmen */ }
    return;
  }
  const c = map.getCenter();
  const ol = Object.keys(overlays).filter((k) => map.hasLayer(overlays[k]));
  const p = new URLSearchParams({ z: map.getZoom(), lat: c.lat.toFixed(5), lon: c.lng.toFixed(5) });
  if (ol.length) p.set('ol', ol.join(','));
  if (state.station !== null && state.stops[state.station]) p.set('st', state.stops[state.station][0]);
  if (state.list === 'route' && state.route.from && state.route.to) p.set('rt', `${state.stops[state.route.from.index][0]}~${state.stops[state.route.to.index][0]}`);
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
    state.trips = data.trips.map(([pid, id, start, prof, flags]) => {
      const profile = state.profiles.get(prof);
      const t = base + start;
      return { pid, id, flags: flags || 0, t0: t, end: t + profile[profile.length - 2], prof: profile, k: 0 };
    });
    state.window = { from: base + t0, to: base + t1, bbox, types: typesKey };
    if (state.list === 'lines') renderLines();
    if (state.selected) {
      const again = state.trips.find((t) => t.id === state.selected.id);
      if (again) { state.selected = again; renderVehiclePanel(); }
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

// ---------- Verspaetung ----------

function demoDelay(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 600) - 150; // -150 bis +449 Sekunden
}

function delayOf(trip) {
  if (state.demo) return demoDelay(trip.id);
  return state.delays.get(trip.id);
}

function fmtDelay(d) {
  const a = Math.abs(d);
  if (a < 30) return '0';
  const sign = d > 0 ? '+' : '-';
  return a < 60 ? `${sign}${Math.round(a)} s` : `${sign}${Math.round(a / 60)} min`;
}

function delayColors(d) {
  if (d >= 30) return { bg: '#d32f2f', fg: '#ffffff' }; // zu spaet: rot
  if (d <= -30) return { bg: '#8fd3ff', fg: '#06324d' }; // zu frueh: hellblau
  return { bg: '#2e7d32', fg: '#ffffff' }; // puenktlich: gruen
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
  if (!TILES && state.networkGroups) {
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

  if (state.takt.on) drawTakt(zoom);
  else if (state.reach) drawReach(zoom);

  // Haltestellen
  if (zoom >= 14 && !state.takt.on) {
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
  let followPos = null;
  for (const trip of state.trips) {
    const pat = state.patterns.get(trip.pid);
    const route = state.meta.routes[pat.r];
    const style = routeStyle(route);
    if (!state.types.has(style.group) || state.hiddenLines.has(route[0])) continue;
    if (state.onlyAccessible && !accessible(trip.flags)) continue;
    const delay = delayOf(trip);
    const pos = locate(trip, state.sim - (delay || 0));
    if (!pos) continue;
    if (state.follow === trip.id) followPos = pos;
    const p = map.latLngToContainerPoint([pos.lat, pos.lon]);
    if (p.x < -40 || p.y < -40 || p.x > size.x + 40 || p.y > size.y + 40) continue;
    out.push({ trip, pat, route, style, pos, delay, x: p.x, y: p.y });
  }
  state.vehicles = out;
  if (followPos) {
    const c = map.latLngToContainerPoint([followPos.lat, followPos.lon]);
    const dx = c.x - size.x / 2;
    const dy = c.y - size.y / 2;
    if (Math.hypot(dx, dy) > 1.5) map.panBy([dx, dy], { animate: false });
  }

  drawOverlays();
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
      if (v.delay !== undefined) {
        const text = fmtDelay(v.delay);
        const c = delayColors(v.delay);
        ctx.font = 'bold 10px system-ui, sans-serif';
        const bw = ctx.measureText(text).width + 8;
        const bx = v.x + w / 2 + 3 + bw / 2;
        ctx.fillStyle = c.bg;
        roundRect(bx - bw / 2, v.y - 7, bw, 14, 4);
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = dark ? '#1b2230' : '#ffffff';
        ctx.stroke();
        ctx.fillStyle = c.fg;
        ctx.fillText(text, bx, v.y + 0.5);
      }
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

function drawPath(stopIdxs, color, width = 4, alpha = 0.65) {
  ctx.beginPath();
  let first = true;
  for (let i = 1; i < stopIdxs.length; i++) {
    for (const pt of segGeom(stopIdxs[i - 1], stopIdxs[i]).pts) {
      const p = map.latLngToContainerPoint(pt);
      if (first) { ctx.moveTo(p.x, p.y); first = false; } else ctx.lineTo(p.x, p.y);
    }
  }
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawRoute(trip) {
  const pat = state.patterns.get(trip.pid);
  if (!pat) return;
  drawPath(pat.s, routeStyle(state.meta.routes[pat.r]).bg);
}

function drawOverlays() {
  if (state.lineView) {
    const d = state.lineView.dirs[state.lineView.active];
    if (d) drawPath(d.stops, routeStyle(state.meta.routes[d.route]).bg, 5, 0.8);
  }
  const j = state.journey;
  if (!j) return;
  for (const leg of j.legs) {
    if (leg.type === 'ride') {
      drawPath(leg.stops, `#${/^[0-9a-f]{6}$/i.test(leg.color) ? leg.color : '444444'}`, 6, 0.85);
    } else {
      const a = state.stops[leg.from];
      const b = state.stops[leg.to];
      const p1 = map.latLngToContainerPoint([a[2], a[3]]);
      const p2 = map.latLngToContainerPoint([b[2], b[3]]);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.setLineDash([2, 7]);
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.strokeStyle = document.documentElement.dataset.theme === 'dark' ? '#e6ebf5' : '#1d2330';
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  const rides = j.legs.filter((l) => l.type === 'ride');
  const ends = [[state.stops[rides[0].from], '#2e7d32'], [state.stops[j.legs[j.legs.length - 1].to], '#d32f2f']];
  for (const [st, color] of ends) {
    const p = map.latLngToContainerPoint([st[2], st[3]]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }
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
    if (state.selected) updateVehiclePanel();
    if (!tlDragging) tl.value = String(Math.min(1439, Math.floor((state.sim - dayStart(ymdOf(state.sim))) / 60)));
    if (state.takt.on) loadTakt();
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
$('demo').addEventListener('change', (e) => { state.demo = e.target.checked; if (state.selected) renderVehiclePanel(); });
$('acc').addEventListener('change', (e) => { state.onlyAccessible = e.target.checked; if (state.station !== null) renderStation(); });
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

map.on('moveend', scheduleHash);
map.on('dragstart', () => { if (state.follow) { state.follow = null; if (state.selected) renderVehiclePanel(); } });

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
  if (state.list === 'route' || state.list === 'line') return; // Panel bleibt offen
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
  state.follow = null;
  state.lineView = null;
  state.journey = null;
  clearInterval(stationTimer);
  scheduleHash();
  $('panel').hidden = true;
  document.body.classList.remove('panel-open');
}
$('panel-close').addEventListener('click', closePanel);

function selectVehicle(trip) {
  clearInterval(stationTimer);
  state.station = null;
  state.list = null;
  state.lineView = null;
  state.journey = null;
  if (state.follow !== trip.id) state.follow = null;
  state.selected = trip;
  renderVehiclePanel();
  scheduleHash();
}

let vehicleView = null;

function renderVehiclePanel() {
  const trip = state.selected;
  if (!trip) return;
  const pat = state.patterns.get(trip.pid);
  const route = state.meta.routes[pat.r];
  const style = routeStyle(route);
  const body = $('panel-body');
  body.replaceChildren();
  body.append(el('h2', {}, pill(route[0], style, () => openLine(route[0])), ' ', cleanHeadsign(route[0], pat.h) || 'Ziel unbekannt'));
  const sub = el('div', { class: 'sub' });
  body.append(sub);

  const facts = [];
  const wc = (trip.flags || 0) & 3;
  facts.push(wc === 1 ? '♿ barrierefrei' : wc === 2 ? 'nicht barrierefrei' : '');
  const bk = ((trip.flags || 0) >> 2) & 3;
  facts.push(bk === 1 ? '🚲 Fahrrad erlaubt' : bk === 2 ? 'Fahrrad nicht erlaubt' : '');
  const info = facts.filter(Boolean).join(' · ');
  if (info) body.append(el('div', { class: 'sub' }, info));

  const follow = el('button', { class: 'chip', type: 'button', 'aria-pressed': String(state.follow === trip.id) }, state.follow === trip.id ? 'Folgen beenden' : 'Fahrzeug folgen');
  follow.addEventListener('click', () => {
    state.follow = state.follow === trip.id ? null : trip.id;
    if (state.follow && map.getZoom() < 15) map.setZoom(15, { animate: false });
    renderVehiclePanel();
  });
  body.append(el('div', { class: 'chips' }, follow));

  const table = el('table');
  const rows = [];
  pat.s.forEach((si, i) => {
    const s2 = state.stops[si];
    const dep = trip.t0 + trip.prof[2 * i + 1];
    const arr = trip.t0 + trip.prof[2 * i];
    const link = el('a', { class: 'stop', role: 'button', tabindex: '0' }, s2[1]);
    const open = () => openStation(s2[4] >= 0 ? s2[4] : si);
    link.addEventListener('click', open);
    link.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
    const tr = el('tr', {}, el('td', { class: 't' }, hhmm(i === 0 ? dep : arr)), el('td', {}, link), el('td', { class: 'r' }, s2[5] ? `Steig ${s2[5]}` : ''));
    rows.push({ tr, dep });
    table.append(tr);
  });
  body.append(table);
  vehicleView = { trip, sub, rows };
  updateVehiclePanel();
  showPanel();
}

// Sekuendlich: nur Klassen und Text anpassen, damit Tippen auf Knoepfe nicht ins Leere geht
function updateVehiclePanel() {
  if (!vehicleView || vehicleView.trip !== state.selected) return;
  const { trip, sub, rows } = vehicleView;
  const delay = delayOf(trip);
  const pos = locate(trip, state.sim - (delay || 0));
  let text = delay === undefined ? 'Fahrplanposition (Soll)' : `${fmtDelay(delay)} gegenüber Fahrplan${state.demo ? ' (Demo, erfundene Werte)' : ''}`;
  if (!pos) text = state.sim < trip.t0 ? `Fährt ab ${hhmm(trip.t0)}` : 'Fahrt beendet';
  if (sub.textContent !== text) sub.textContent = text;
  rows.forEach((r, i) => {
    const cls = state.sim > r.dep ? 'passed' : pos && pos.k === i && pos.atStop ? 'current' : '';
    if (r.tr.className !== cls) r.tr.className = cls;
  });
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
  state.lineView = null;
  state.journey = null;
  state.follow = null;
  platformFilter = null;
  clearInterval(stationTimer);
  scheduleHash();
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
  const share = el('button', { class: 'chip', type: 'button' }, 'Link kopieren');
  share.addEventListener('click', () => copyCurrentLink(share));
  const board = el('button', { class: 'chip', type: 'button' }, 'Als Tafel öffnen');
  board.addEventListener('click', () => openBoard(index));
  body.append(el('div', { class: 'chips' }, share, board));
  const reachRow = el('div', { class: 'chips' }, el('span', { class: 'sub' }, 'Wohin komme ich in:'));
  for (const m of [15, 30, 45, 60]) {
    const b = el('button', { class: 'chip', type: 'button', 'aria-pressed': String(state.reach && state.reach.center === index && state.reach.max === m) }, `${m} min`);
    b.addEventListener('click', () => showReach(index, m));
    reachRow.append(b);
  }
  body.append(reachRow);
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

  const shown = list.filter((d) => (!platformFilter || d.platform === platformFilter) && (!state.onlyAccessible || accessible(d.flags))).slice(0, 40);
  if (!shown.length) {
    body.append(el('div', { class: 'empty' }, 'Keine Abfahrten in den nächsten Stunden.'));
  } else {
    const table = el('table');
    for (const d of shown) {
      const style = routeStyle([d.line, d.type, d.color, d.textColor]);
      const mins = Math.round((base + d.t - state.sim) / 60);
      table.append(el('tr', {},
        el('td', { class: 't' }, hhmm(d.t)),
        el('td', {}, pill(d.line, style, () => openLine(d.line)), ' ', cleanHeadsign(d.line, d.headsign), accessible(d.flags) ? ' ♿' : ''),
        el('td', { class: 'r' }, d.platform ? `Steig ${d.platform} · ` : '', mins <= 0 ? 'jetzt' : `in ${mins} min`)));
    }
    body.append(table);
  }
  showPanel();
}

// ---------- Favoriten, Naehe, Linien ----------

async function copyCurrentLink(btn) {
  writeHash();
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = 'Kopiert';
  } catch {
    btn.replaceWith(el('input', { class: 'urlbox', value: url, readonly: 'readonly', 'aria-label': 'Link' }));
  }
}

// Mein Weg: eine gespeicherte Strecke (Haltestellen-IDs, stabil ueber Fahrplanwechsel)
function getMyRoute() {
  const saved = load('strab.myroute', null);
  if (!saved) return null;
  const byId = new Map(state.stops.map((s, i) => [s[0], i]));
  const f = byId.get(saved.from);
  const t = byId.get(saved.to);
  if (f === undefined || t === undefined) return null;
  const mk = (i) => ({ index: i, name: state.stops[i][1], lat: state.stops[i][2], lon: state.stops[i][3] });
  return { from: mk(f), to: mk(t) };
}

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

function stationBlock(index, allDeps, extra) {
  const deps = state.onlyAccessible ? allDeps.filter((d) => accessible(d.flags)) : allDeps;
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
        el('td', {}, pill(d.line, routeStyle([d.line, d.type, d.color, d.textColor]), () => openLine(d.line)), ' ', cleanHeadsign(d.line, d.headsign), accessible(d.flags) ? ' ♿' : ''),
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
  const mine = getMyRoute();
  const ymd = ymdOf(state.sim);
  const [results, myJourneys] = await Promise.all([
    Promise.all(items.map((i) => departuresFor(i, 3))),
    mine ? api('/api/plan', { from: mine.from.index, to: mine.to.index, date: ymd, t: Math.floor(state.sim - dayStart(ymd)) }).catch(() => []) : Promise.resolve([]),
  ]);
  if (state.list !== 'favs') return;
  const body = $('panel-body');
  body.replaceChildren(el('h2', {}, '★ Favoriten'), el('div', { class: 'sub' }, 'Nächste Abfahrten nach Fahrplan (Soll)'));
  if (mine) {
    const open = el('a', { class: 'stop', role: 'button', tabindex: '0' }, `Mein Weg: ${mine.from.name} → ${mine.to.name}`);
    const go = () => { state.route = { from: mine.from, to: mine.to }; openRoute(true); };
    open.addEventListener('click', go);
    open.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    const blk = el('div', { class: 'block' }, el('div', { class: 'bh' }, open));
    if (!myJourneys.length) blk.append(el('div', { class: 'empty' }, 'Keine Verbindung in den nächsten Stunden.'));
    for (const j of myJourneys.slice().sort((a, b) => a.dep - b.dep).slice(0, 3)) {
      const row = el('div', { class: 'leg' }, el('b', {}, `${hhmm(j.dep)} → ${hhmm(j.arr)}`), ' ');
      for (const leg of j.legs) if (leg.type === 'ride') row.append(pill(leg.line, routeStyle([leg.line, leg.routeType, leg.color, leg.textColor])), ' ');
      row.append(el('span', { class: 'sub' }, `${j.transfers === 0 ? 'direkt' : `${j.transfers} Umstieg${j.transfers > 1 ? 'e' : ''}`}`));
      blk.append(row);
    }
    body.append(blk);
  }
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
function openLinesPanel() {
  state.selected = null;
  state.station = null;
  state.follow = null;
  clearInterval(stationTimer);
  state.list = 'lines';
  renderLines();
}
$('btn-lines').addEventListener('click', () => (state.list === 'lines' ? closePanel() : openLinesPanel()));

// Nachtverkehr: springt auf 01:30 der kommenden Nacht und zeigt, welche Linien dann fahren
$('night').addEventListener('click', () => {
  const ymd = ymdOf(state.sim);
  const sod = state.sim - dayStart(ymd);
  const day = sod < 5 * 3600 ? ymd : ymdOf(state.sim + 86400);
  state.sim = dayStart(day) + 90 * 60;
  state.window = null;
  openLinesPanel();
});

// Zeitleiste: Schieber fuer die Uhrzeit des angezeigten Tages
let tlDragging = false;
const tl = $('tl');
tl.addEventListener('pointerdown', () => { tlDragging = true; });
for (const ev of ['pointerup', 'pointercancel', 'blur', 'change']) tl.addEventListener(ev, () => { tlDragging = false; });
tl.addEventListener('input', (e) => {
  state.sim = dayStart(ymdOf(state.sim)) + Number(e.target.value) * 60;
  state.window = null;
});

// ---------- Takt-Karte und Erreichbarkeit ----------

async function loadTakt() {
  const ymd = ymdOf(state.sim);
  const hour = Math.floor((state.sim - dayStart(ymd)) / 3600);
  const key = `${ymd}|${hour}`;
  if (state.takt.key === key || state.takt.loading) return;
  state.takt.loading = true;
  try {
    state.takt.data = new Map(await api('/api/frequency', { date: ymd, t0: hour * 3600, t1: hour * 3600 + 3600 }));
    state.takt.key = key;
  } catch (e) {
    console.error(e);
  } finally {
    state.takt.loading = false;
  }
  updateLegend();
}

$('takt').addEventListener('change', (e) => {
  state.takt.on = e.target.checked;
  if (state.takt.on) { state.reach = null; state.takt.key = null; loadTakt(); }
  updateLegend();
});

async function showReach(index, max) {
  const ymd = ymdOf(state.sim);
  let items = [];
  try {
    items = await api('/api/reach', { station: index, date: ymd, t: Math.floor(state.sim - dayStart(ymd)), max });
  } catch (e) {
    console.error(e);
    return;
  }
  state.takt.on = false;
  $('takt').checked = false;
  state.reach = { center: index, max, items };
  updateLegend();
  const pts = [[state.stops[index][2], state.stops[index][3]], ...items.map(([g]) => [state.stops[g][2], state.stops[g][3]])];
  map.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 14 });
  if (state.station === index) renderStation();
}

function updateLegend() {
  const box = $('legend');
  box.replaceChildren();
  const dot = (color) => { const d = el('i', { class: 'dot' }); d.style.background = color; return d; };
  if (state.takt.on) {
    const hour = state.takt.key ? Number(state.takt.key.split('|')[1]) : Math.floor((state.sim - dayStart(ymdOf(state.sim))) / 3600);
    box.append(el('b', {}, `Abfahrten pro Stunde, ${pad(hour)}–${pad((hour + 1) % 24)} Uhr`), ' ',
      dot(TAKT_COLORS[0]), '12+ ', dot(TAKT_COLORS[1]), '6–11 ', dot(TAKT_COLORS[2]), '3–5 ', dot(TAKT_COLORS[3]), '1–2 ', dot(TAKT_COLORS[4]), 'keine');
    box.hidden = false;
  } else if (state.reach) {
    const r = state.reach;
    const off = el('button', { type: 'button', class: 'chip' }, 'Aus');
    off.addEventListener('click', () => { state.reach = null; updateLegend(); if (state.station !== null) renderStation(); });
    box.append(el('b', {}, `Erreichbar in ${r.max} min ab ${state.stops[r.center][1]}`), ' ', dot(reachColor(0.1)), 'nah ', dot(reachColor(0.55)), 'mittel ', dot(reachColor(1)), 'am Limit ', off);
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

const TAKT_COLORS = ['#0b7a3b', '#4caf50', '#fbc02d', '#fb8c00', '#9e9e9e'];
const TAKT_RADIUS = [8, 6.5, 5.5, 4.5, 3];
const taktTier = (c) => (c >= 12 ? 0 : c >= 6 ? 1 : c >= 3 ? 2 : c >= 1 ? 3 : 4);
const reachColor = (f) => `hsl(${Math.round(130 - 120 * Math.min(1, Math.max(0, f)))} 75% 45%)`;

function inView(lat, lon, b) {
  return lat >= b.getSouth() && lat <= b.getNorth() && lon >= b.getWest() && lon <= b.getEast();
}

function drawTakt(zoom) {
  const b = map.getBounds();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.font = 'bold 10px system-ui, sans-serif';
  for (const s of state.stations) {
    if (!inView(s.lat, s.lon, b)) continue;
    const c = state.takt.data.get(s.index) || 0;
    const tier = taktTier(c);
    if (tier === 4 && zoom < 13) continue;
    const p = map.latLngToContainerPoint([s.lat, s.lon]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, TAKT_RADIUS[tier] + (zoom >= 14 ? 2 : 0), 0, Math.PI * 2);
    ctx.fillStyle = TAKT_COLORS[tier];
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    if (zoom >= 15 && c > 0) {
      ctx.fillStyle = '#fff';
      ctx.fillText(String(c), p.x, p.y + 0.5);
    }
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

function drawReach(zoom) {
  const r = state.reach;
  const b = map.getBounds();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.font = 'bold 10px system-ui, sans-serif';
  for (const [g, min] of r.items) {
    const st = state.stops[g];
    if (!inView(st[2], st[3], b)) continue;
    const p = map.latLngToContainerPoint([st[2], st[3]]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, zoom >= 14 ? 9 : 5.5, 0, Math.PI * 2);
    ctx.fillStyle = reachColor(min / r.max);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    if (zoom >= 14) {
      ctx.fillStyle = '#fff';
      ctx.fillText(String(min), p.x, p.y + 0.5);
    }
  }
  const c = state.stops[r.center];
  const p = map.latLngToContainerPoint([c[2], c[3]]);
  ctx.beginPath();
  ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
  ctx.fillStyle = '#1a73e8';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

// ---------- Vollbild-Tafel ----------

let boardTimer = null;
let wakeLock = null;

async function openBoard(index) {
  closePanel();
  state.board = index;
  $('board').hidden = false;
  document.body.classList.add('board-open');
  writeHash();
  clearInterval(boardTimer);
  await renderBoard();
  boardTimer = setInterval(boardTick, 1000);
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* nicht verfuegbar oder verweigert */ }
}

function closeBoard() {
  clearInterval(boardTimer);
  state.board = null;
  $('board').hidden = true;
  document.body.classList.remove('board-open');
  try { if (wakeLock) wakeLock.release(); } catch { /* egal */ }
  wakeLock = null;
  writeHash();
}

let boardCountdown = 0;
function boardTick() {
  const clock = document.getElementById('bclock');
  if (clock) clock.textContent = hhmmss(wallNow());
  if (++boardCountdown >= 10) { boardCountdown = 0; renderBoard(); }
}

async function renderBoard() {
  const index = state.board;
  if (index === null) return;
  const now = wallNow();
  const ymd = ymdOf(now);
  let list = [];
  try {
    list = await api('/api/departures', { station: index, date: ymd, from: Math.floor(now - dayStart(ymd)), limit: 14 });
  } catch (e) {
    console.error(e);
  }
  if (state.board !== index) return;
  const base = dayStart(ymd);
  const view = $('board');
  view.replaceChildren();
  const close = el('button', { type: 'button', class: 'chip' }, 'Zur Karte');
  close.addEventListener('click', closeBoard);
  const full = el('button', { type: 'button', class: 'chip' }, 'Vollbild');
  full.addEventListener('click', () => { try { document.documentElement.requestFullscreen(); } catch { /* nicht erlaubt */ } });
  view.append(el('div', { class: 'bhead' }, el('div', { class: 'bname' }, state.stops[index][1]), el('div', { class: 'bclock', id: 'bclock' }, hhmmss(now)), el('div', { class: 'bbtns' }, full, close)));
  const rows = el('div', { class: 'brows' });
  if (!list.length) rows.append(el('div', { class: 'empty' }, 'Keine Abfahrten in den nächsten Stunden.'));
  for (const d of list) {
    const mins = Math.round((base + d.t - now) / 60);
    rows.append(el('div', { class: 'brow' },
      el('span', { class: 'bt' }, hhmm(d.t)),
      pill(d.line, routeStyle([d.line, d.type, d.color, d.textColor])),
      el('span', { class: 'bh2' }, cleanHeadsign(d.line, d.headsign), accessible(d.flags) ? ' ♿' : ''),
      el('span', { class: 'bp' }, d.platform ? `Steig ${d.platform}` : ''),
      el('span', { class: 'bm' }, mins <= 0 ? 'jetzt' : `${mins} min`)));
  }
  view.append(rows, el('div', { class: 'bnote sub' }, 'Nach Fahrplan (Soll), keine Echtzeit. Daten: KVV (CC0).'));
}

// ---------- Linienansicht ----------

function boundsOfStops(idxs) {
  const pts = idxs.map((i) => [state.stops[i][2], state.stops[i][3]]);
  return L.latLngBounds(pts);
}

async function openLine(name) {
  let dirs = [];
  try { dirs = await api('/api/line', { name }); } catch (e) { console.error(e); }
  state.selected = null;
  state.station = null;
  state.follow = null;
  state.journey = null;
  clearInterval(stationTimer);
  state.list = 'line';
  state.lineView = { name, dirs, active: 0 };
  renderLine();
  if (dirs[0]) map.fitBounds(boundsOfStops(dirs[0].stops), { padding: [40, 40], maxZoom: 15 });
}

function renderLine() {
  const lv = state.lineView;
  if (!lv) return;
  const body = $('panel-body');
  body.replaceChildren();
  if (!lv.dirs.length) {
    body.append(el('h2', {}, `Linie ${lv.name}`), el('div', { class: 'empty' }, 'Kein Verlauf im Kartengebiet gefunden.'));
    showPanel();
    return;
  }
  const route = state.meta.routes[lv.dirs[0].route];
  body.append(el('h2', {}, pill(route[0], routeStyle(route)), ' ', `Linie ${lv.name}`));
  body.append(el('div', { class: 'sub' }, 'Verlauf im Kartengebiet, Richtung wählen'));
  const chips = el('div', { class: 'chips' });
  lv.dirs.forEach((d, i) => {
    const b = el('button', { class: 'chip', type: 'button', 'aria-pressed': String(i === lv.active) }, `Richtung ${cleanHeadsign(lv.name, d.headsign) || '?'}`);
    b.addEventListener('click', () => { lv.active = i; renderLine(); map.fitBounds(boundsOfStops(d.stops), { padding: [40, 40], maxZoom: 15 }); });
    chips.append(b);
  });
  body.append(chips);
  const table = el('table');
  for (const si of lv.dirs[lv.active].stops) {
    const s2 = state.stops[si];
    const link = el('a', { class: 'stop', role: 'button', tabindex: '0' }, s2[1]);
    const open = () => openStation(s2[4] >= 0 ? s2[4] : si);
    link.addEventListener('click', open);
    link.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
    table.append(el('tr', {}, el('td', {}, link), el('td', { class: 'r' }, s2[5] ? `Steig ${s2[5]}` : '')));
  }
  body.append(table);
  showPanel();
}

// ---------- Verbindungssuche ----------

function suggestField(label, initial, onPick) {
  const wrap = el('div', { class: 'sf' });
  const input = el('input', { type: 'search', placeholder: label, autocomplete: 'off', 'aria-label': label });
  if (initial) input.value = initial.name;
  const ul = el('ul', { class: 'sfl' });
  ul.hidden = true;
  let seq = 0;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    onPick(null);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      const mine = ++seq;
      if (q.length < 2) { ul.hidden = true; return; }
      let res = [];
      try { res = await api('/api/search', { q }); } catch (e) { console.error(e); }
      if (mine !== seq) return;
      ul.replaceChildren();
      for (const r of res) {
        const li = el('li', {}, r.name);
        li.addEventListener('click', () => { input.value = r.name; ul.hidden = true; onPick(r); });
        ul.append(li);
      }
      ul.hidden = !res.length;
    }, 160);
  });
  wrap.append(input, ul);
  wrap.setValue = (r) => { input.value = r ? r.name : ''; ul.hidden = true; };
  return wrap;
}

function openRoute(autorun = false) {
  state.selected = null;
  state.station = null;
  state.follow = null;
  state.lineView = null;
  clearInterval(stationTimer);
  state.list = 'route';
  renderRoutePanel(autorun);
}

function renderRoutePanel(autorun = false) {
  const body = $('panel-body');
  body.replaceChildren(el('h2', {}, '⇄ Verbindung'));
  const fromField = suggestField('Start', state.route.from, (r) => { state.route.from = r; });
  const toField = suggestField('Ziel', state.route.to, (r) => { state.route.to = r; });
  const timeInput = el('input', { type: 'time', class: 'timebox', 'aria-label': 'Abfahrt ab', value: hhmm(state.sim) });
  const status = el('div', { class: 'sub' }, 'Nach Fahrplan (Soll), ohne Echtzeit.');
  const results = el('div', { class: 'results' });

  const here = el('button', { class: 'chip', type: 'button' }, 'Mein Standort als Start');
  here.addEventListener('click', async () => {
    try {
      state.here = await locateMe();
      const near = state.stations.map((s2) => ({ s2, d: distanceM(state.here.lat, state.here.lon, s2.lat, s2.lon) })).sort((a, b) => a.d - b.d)[0];
      if (!near || near.d > 2000) throw new Error('Keine Haltestelle im Umkreis von 2 km');
      state.route.from = { index: near.s2.index, name: near.s2.name, lat: near.s2.lat, lon: near.s2.lon };
      fromField.setValue(state.route.from);
    } catch (e) { status.textContent = e.message; }
  });
  const swap = el('button', { class: 'chip', type: 'button' }, 'Tauschen');
  swap.addEventListener('click', () => {
    [state.route.from, state.route.to] = [state.route.to, state.route.from];
    renderRoutePanel();
  });

  const search = async () => {
    const { from, to } = state.route;
    if (!from || !to) { status.textContent = 'Bitte Start und Ziel aus der Liste wählen.'; return; }
    const [hh, mm] = timeInput.value.split(':').map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) { status.textContent = 'Bitte eine Uhrzeit angeben.'; return; }
    status.textContent = 'Suche läuft …';
    results.replaceChildren();
    state.journey = null;
    const ymd = ymdOf(state.sim);
    try {
      state.journeys = await api('/api/plan', { from: from.index, to: to.index, date: ymd, t: hh * 3600 + mm * 60 });
    } catch (e) {
      console.error(e);
      status.textContent = 'Suche fehlgeschlagen.';
      return;
    }
    status.textContent = state.journeys.length ? `${state.journeys.length} Verbindung${state.journeys.length > 1 ? 'en' : ''} nach Fahrplan (Soll)` : 'Keine Verbindung in den nächsten 5 Stunden gefunden.';
    renderJourneys(results);
    scheduleHash();
  };
  const go = el('button', { class: 'chip go', type: 'button' }, 'Suchen');
  go.addEventListener('click', search);

  const shiftTime = (deltaMin) => {
    const [hh, mm] = timeInput.value.split(':').map(Number);
    const t = Math.min(23 * 60 + 59, Math.max(0, (hh || 0) * 60 + (mm || 0) + deltaMin));
    timeInput.value = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
    search();
  };
  const earlier = el('button', { class: 'chip', type: 'button' }, '← Früher');
  earlier.addEventListener('click', () => shiftTime(-30));
  const later = el('button', { class: 'chip', type: 'button' }, 'Später →');
  later.addEventListener('click', () => {
    if (state.journeys.length) {
      const first = Math.min(...state.journeys.map((j) => j.dep));
      const t = Math.min(23 * 60 + 59, Math.floor(first / 60) + 1);
      timeInput.value = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
      search();
    } else shiftTime(30);
  });

  const mine = getMyRoute();
  const extras = el('div', { class: 'chips' });
  const save = el('button', { class: 'chip', type: 'button' }, 'Als Mein Weg speichern');
  save.addEventListener('click', () => {
    if (!state.route.from || !state.route.to) { status.textContent = 'Erst Start und Ziel wählen.'; return; }
    save_('strab.myroute', { from: state.stops[state.route.from.index][0], to: state.stops[state.route.to.index][0] });
    save.textContent = 'Gespeichert';
  });
  extras.append(save);
  if (mine) {
    const load_ = el('button', { class: 'chip', type: 'button' }, 'Mein Weg laden');
    load_.addEventListener('click', () => { state.route = { from: mine.from, to: mine.to }; renderRoutePanel(true); });
    extras.append(load_);
  }
  const link = el('button', { class: 'chip', type: 'button' }, 'Link kopieren');
  link.addEventListener('click', () => copyCurrentLink(link));
  extras.append(link);

  body.append(fromField, toField, el('div', { class: 'rowbtns' }, 'Abfahrt ab ', timeInput),
    el('div', { class: 'chips' }, here, swap, go), el('div', { class: 'chips' }, earlier, later), status, results, extras);
  if (state.journeys.length) renderJourneys(results);
  showPanel();
  if (autorun) search();
}

function renderJourneys(container) {
  container.replaceChildren();
  state.journeys.forEach((j, n) => {
    const card = el('div', { class: 'jcard', role: 'button', tabindex: '0', 'aria-pressed': String(state.journey === j) });
    const mins = Math.round((j.arr - j.dep) / 60);
    card.append(el('div', { class: 'jh' }, `${hhmm(j.dep)} → ${hhmm(j.arr)}`, el('span', { class: 'sub' }, ` · ${mins} min · ${j.transfers === 0 ? 'direkt' : `${j.transfers} Umstieg${j.transfers > 1 ? 'e' : ''}`}`)));
    for (const leg of j.legs) {
      if (leg.type === 'walk') {
        card.append(el('div', { class: 'leg walk' }, `Fußweg ${Math.max(1, Math.round(leg.secs / 60))} min nach ${state.stops[leg.to][1]}`));
      } else {
        const style = routeStyle([leg.line, leg.routeType, leg.color, leg.textColor]);
        card.append(el('div', { class: 'leg' },
          pill(leg.line, style, () => openLine(leg.line)), ' ',
          el('span', {}, `${hhmm(leg.dep)} ${state.stops[leg.from][1]}`),
          el('div', { class: 'sub' }, `Richtung ${cleanHeadsign(leg.line, leg.headsign)}${accessible(leg.flags) ? ' · ♿' : ''}`),
          el('span', {}, `${hhmm(leg.arr)} ${state.stops[leg.to][1]}`)));
      }
    }
    const pick = () => {
      state.journey = j;
      const idxs = j.legs.flatMap((l) => (l.type === 'ride' ? l.stops : [l.from, l.to]));
      map.fitBounds(boundsOfStops(idxs), { padding: [60, 60], maxZoom: 16 });
      renderJourneys(container);
    };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') pick(); });
    container.append(card);
  });
}

$('btn-route').addEventListener('click', () => (state.list === 'route' ? closePanel() : openRoute()));

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

// ---------- Installieren (PWA) ----------

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  $('btn-install').hidden = false;
});
$('btn-install').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  try { await installEvent.userChoice; } catch { /* abgebrochen */ }
  installEvent = null;
  $('btn-install').hidden = true;
});
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch { /* im eingebetteten Rahmen nicht erlaubt */ }
}

// ---------- Start ----------

// Nur fuer automatische Tests: mit "dbg" im Hash ist der Zustand im Browser erreichbar
if (new URLSearchParams(location.hash.slice(1)).has('dbg')) window.__strab = { state, map };

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

  if (STATIC && !TILES) {
    document.body.classList.add('static');
    const groups = [[], [], []];
    for (const [a, b, g] of await api('/api/network')) groups[g].push([a, b]);
    state.networkGroups = groups;
    $('note').textContent = 'Vorschau ohne Kartenkacheln, das Liniennetz ist schematisch (Luftlinie zwischen Haltestellen). Positionen nach Fahrplan (Soll), keine Echtzeit. Daten: KVV (CC0). Ohne Gewähr.';
  }
  if (meta.realtime) {
    const poll = async () => {
      try { state.delays = new Map(Object.entries(await api('/api/delays')).map(([k, v]) => [k, Number(v)])); } catch (e) { console.error(e); }
    };
    poll();
    setInterval(poll, 20000);
  }
  const h = readHash();
  const [s, w, n, e] = meta.bbox;
  if (h && h.z !== null) map.setView([h.lat, h.lon], h.z);
  else map.fitBounds([[s, w], [n, e]]);
  if (h) for (const k of h.ol) if (overlays[k]) { overlays[k].addTo(map); $(`ovl-${k}`).checked = true; }
  map.setMaxBounds([[s - 0.3, w - 0.4], [n + 0.3, e + 0.4]]);

  resizeCanvas();
  writeHash();
  const idOf = (id) => stops.findIndex((x) => x[0] === id);
  if (h && h.tafel && idOf(h.tafel) >= 0) {
    openBoard(idOf(h.tafel));
  } else if (h && h.rt) {
    const [a, b] = h.rt.split('~');
    const mk = (i) => ({ index: i, name: stops[i][1], lat: stops[i][2], lon: stops[i][3] });
    if (idOf(a) >= 0 && idOf(b) >= 0) {
      state.route = { from: mk(idOf(a)), to: mk(idOf(b)) };
      openRoute(true);
    }
  } else if (h && h.st && idOf(h.st) >= 0) {
    openStation(idOf(h.st));
  }
}

init().then(() => requestAnimationFrame(tick)).catch((e) => {
  console.error(e);
  $('count').textContent = 'Start fehlgeschlagen';
});
