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
  return wallOf(Date.now() / 1000);
}

// Berliner Wanduhrzeit eines Zeitpunkts (Unix-Sekunden) als Pseudo-UTC-Sekunden
function wallOf(epochSec) {
  const p = Object.fromEntries(berlinFmt.formatToParts(new Date(epochSec * 1000)).map((x) => [x.type, x.value]));
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

const groupOf = (type) => (type === 0 || type === 1 ? 'tram' : type === 2 ? 'rail' : type === 100 ? 'fern' : type === 3 || type === 11 ? 'bus' : 'other');
const DEFAULT_COLOR = { tram: 'd1202e', rail: '2a2a2a', fern: 'b71c1c', bus: '7a3e98', other: '555555' };

function readable(hex) {
  const n = parseInt(hex, 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#000' : '#fff';
}

const styleCache = new Map();
function routeStyle(route) {
  const key = `${route[1]}|${route[2]}|${route[3]}`;
  const hit = styleCache.get(key);
  if (hit) return hit;
  const st = computeStyle(route);
  styleCache.set(key, st);
  return st;
}

function computeStyle(route) {
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
// Der KVV-Feed nennt bei Fahrraedern nur "unbekannt" (0) oder "nicht erlaubt" (2), nie "erlaubt": Filter blendet nur Verbote aus
const bikeOk = (flags) => (((flags || 0) >> 2) & 3) !== 2;
const flagsOk = (flags) => (!state.onlyAccessible || accessible(flags)) && (!state.onlyBikes || bikeOk(flags));
const isDetour = (headsign) => /umleitung|\bsev\b|ersatzverkehr|schienenersatz/i.test(headsign || '');
const fmtDate = (ymd) => `${ymd.slice(6, 8)}.${ymd.slice(4, 6)}.${ymd.slice(0, 4)}`;

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
  types: new Set(['tram', 'rail', 'fern', 'bus', 'other']),
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
  canceled: new Set(), // ausgefallene Fahrten (Echtzeit)
  reasons: new Map(), // Fahrt-ID -> Grund (Echtzeit)
  rt: { active: false, updated: 0, feedTime: 0, error: null },
  demo: false, // erfundene Werte, nur zum Ansehen der Darstellung
  onlyAccessible: false,
  onlyBikes: false,
  trails: false,
  myReverse: null, // null = nach Tageszeit, sonst 'there' oder 'back'
  routeAcc: false, // barrierefrei reisen in der Verbindungssuche
  saver: false,
  groupDraft: null,
  children: new Map(), // Station -> Kinder-Halte
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
  const dpr = Math.min(window.devicePixelRatio || 1, state.saver ? 1.5 : 3);
  canvas.width = size.x * dpr;
  canvas.height = size.y * dpr;
  canvas.style.width = `${size.x}px`;
  canvas.style.height = `${size.y}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
map.on('resize', resizeCanvas);
let needsDraw = true;
let lastDraw = 0;
map.on('move zoom resize', () => { needsDraw = true; });

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
  if (state.board && state.board.length) {
    try { history.replaceState(null, '', `#${new URLSearchParams({ tafel: state.board.map((i) => state.stops[i][0]).join('~') })}`); } catch { /* eingebetteter Rahmen */ }
    return;
  }
  const c = map.getCenter();
  const ol = Object.keys(overlays).filter((k) => map.hasLayer(overlays[k]));
  const p = new URLSearchParams({ z: map.getZoom(), lat: c.lat.toFixed(5), lon: c.lng.toFixed(5) });
  if (ol.length) p.set('ol', ol.join(','));
  if (state.station !== null && state.stops[state.station]) p.set('st', state.stops[state.station][0]);
  if (state.list === 'route' && state.route.from && state.route.to) p.set('rt', `${specToLink(state.route.from)}~${specToLink(state.route.to)}`);
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

// Kurzer Hinweis, ob Zeiten live sind
const liveNote = () => (state.rt.active ? 'mit Live-Verspätungen, wo verfügbar' : 'nach Fahrplan (Soll), keine Echtzeit');

// Echtzeit fuer eine Fahrt-ID (Abfahrten, Verbindungen)
function rtOf(tripId) {
  if (state.demo) return { delay: demoDelay(tripId), canceled: false, reason: null };
  return { delay: state.delays.get(tripId), canceled: state.canceled.has(tripId), reason: state.reasons.get(tripId) || null };
}

// Zeit-Zelle: Plan-Zeit, dazu farbige Abweichung oder "fällt aus"
function depTime(d) {
  const r = rtOf(d.trip);
  const span = el('span', { class: r.canceled ? 'canc' : '' }, hhmm(d.t));
  if (r.canceled) {
    span.title = 'Fahrt fällt aus';
  } else if (r.delay !== undefined && Math.abs(r.delay) >= 30) {
    const c = delayColors(r.delay);
    const b = el('span', { class: 'dly' }, fmtDelay(r.delay).replace(' ', ''));
    b.style.background = c.bg;
    b.style.color = c.fg;
    if (r.reason) b.title = r.reason;
    return el('span', {}, span, ' ', b);
  }
  return span;
}

// Restzeit-Text mit Echtzeit
function depWhen(d, base, now, prefix = 'in ') {
  const r = rtOf(d.trip);
  if (r.canceled) return 'fällt aus';
  const mins = Math.round((base + d.t + (r.delay || 0) - now) / 60);
  return mins <= 0 ? 'jetzt' : `${prefix}${mins} min`;
}

// ---------- Position nach Fahrplan ----------

function angleBetween(p, q) {
  const dy = q[0] - p[0];
  const dx = (q[1] - p[1]) * Math.cos((p[0] * Math.PI) / 180);
  if (dx === 0 && dy === 0) return undefined;
  return Math.atan2(-dy, dx); // Bildschirm: y nach unten, Norden oben
}

function locate(trip, now, noCursor = false) {
  if (now < trip.t0 || now > trip.end) return null;
  const pat = state.patterns.get(trip.pid);
  const prof = trip.prof;
  const n = pat.s.length;
  const rel = now - trip.t0;
  let k = trip.k;
  while (k < n - 1 && rel >= prof[2 * (k + 1)]) k++;
  while (k > 0 && rel < prof[2 * k]) k--;
  if (!noCursor) trip.k = k;
  const a = state.stops[pat.s[k]];
  if (k >= n - 1 || rel <= prof[2 * k + 1]) {
    const atEnd = k >= n - 1;
    const g = atEnd ? segGeom(pat.s[k - 1], pat.s[k]) : segGeom(pat.s[k], pat.s[k + 1]);
    const heading = atEnd ? angleBetween(along(g, 0.9), along(g, 1)) : angleBetween(along(g, 0), along(g, 0.1));
    return { lat: a[2], lon: a[3], k, f: 0, atStop: true, heading };
  }
  const f = (rel - prof[2 * k + 1]) / (prof[2 * (k + 1)] - prof[2 * k + 1]);
  const g = segGeom(pat.s[k], pat.s[k + 1]);
  const [lat, lon] = along(g, f);
  return { lat, lon, k, f, atStop: false, heading: angleBetween(along(g, Math.max(0, f - 0.03)), along(g, Math.min(1, f + 0.03))) };
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
    if (!flagsOk(trip.flags)) continue;
    if (!state.demo && state.canceled.has(trip.id)) continue;
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

  // Spuren: kurzer Schweif hinter jedem Fahrzeug (Schrittweite waechst mit der Geschwindigkeit)
  if (state.trails && zoom >= 13) {
    const step = 12 * Math.max(1, state.speed);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const v of out) {
      const pts = [[v.x, v.y]];
      for (let i = 1; i <= 5; i++) {
        const past = locate(v.trip, state.sim - (v.delay || 0) - i * step, true);
        if (!past) break;
        const q = map.latLngToContainerPoint([past.lat, past.lon]);
        pts.push([q.x, q.y]);
      }
      for (let i = pts.length - 1; i >= 1; i--) {
        ctx.beginPath();
        ctx.moveTo(pts[i][0], pts[i][1]);
        ctx.lineTo(pts[i - 1][0], pts[i - 1][1]);
        ctx.lineWidth = 4;
        ctx.strokeStyle = v.style.bg;
        ctx.globalAlpha = 0.65 * (1 - (i - 1) / 5);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  for (const v of out) {
    const sel = state.selected && state.selected.id === v.trip.id;
    if (zoom >= 14) {
      ctx.font = 'bold 11px system-ui, sans-serif';
      const label = route0(v.route);
      let w = labelWidth.get(label);
      if (w === undefined) { w = Math.max(18, ctx.measureText(label).width + 8); labelWidth.set(label, w); }
      ctx.fillStyle = v.style.bg;
      roundRect(v.x - w / 2, v.y - 8, w, 16, 5);
      ctx.fill();
      ctx.lineWidth = sel ? 3 : 1.2;
      ctx.strokeStyle = sel ? '#ffcc00' : '#ffffff';
      ctx.stroke();
      ctx.fillStyle = v.style.fg;
      ctx.fillText(label, v.x, v.y + 0.5);
      const ang = v.pos.heading;
      if (ang !== undefined) {
        // Pfeil am Rand des Schilds in Fahrtrichtung
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        const dist = Math.abs(c) * (w / 2) + Math.abs(sn) * 8 + 5;
        const ax = v.x + c * dist;
        const ay = v.y + sn * dist;
        ctx.beginPath();
        ctx.moveTo(ax + c * 5, ay + sn * 5);
        ctx.lineTo(ax - c * 3 - sn * 4.5, ay - sn * 3 + c * 4.5);
        ctx.lineTo(ax - c * 3 + sn * 4.5, ay - sn * 3 - c * 4.5);
        ctx.closePath();
        ctx.fillStyle = v.style.bg;
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
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
const labelWidth = new Map(); // Breite der Liniennummer im Schild (Schrift bleibt gleich)

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

function legPoint(leg, side) {
  if (side === 'from') return leg.fromPoint ? [state.route.from.lat, state.route.from.lon] : [state.stops[leg.from][2], state.stops[leg.from][3]];
  return leg.toPoint ? [state.route.to.lat, state.route.to.lon] : [state.stops[leg.to][2], state.stops[leg.to][3]];
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
      const p1 = map.latLngToContainerPoint(legPoint(leg, 'from'));
      const p2 = map.latLngToContainerPoint(legPoint(leg, 'to'));
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
  const first = j.legs[0];
  const last = j.legs[j.legs.length - 1];
  const ends = [[legPoint(first, 'from'), '#2e7d32'], [legPoint(last, 'to'), '#d32f2f']];
  for (const [pt, color] of ends) {
    const p = map.latLngToContainerPoint(pt);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
  }
}

// ---------- Hinweise zur Gueltigkeit ----------

let lastNotice = null;
function updateNotice() {
  const m = state.meta;
  if (!m) return;
  const ymd = ymdOf(state.sim);
  let text = '';
  const days = (a, b) => Math.round((dayStart(a) - dayStart(b)) / 86400);
  const outside = (f) => (f.end && ymd > f.end) || (f.start && ymd < f.start);
  const secondary = (m.feeds || []).filter((f) => f.id !== 'kvv' && outside(f));
  if (m.feedEnd && ymd > m.feedEnd) text = `Für den ${fmtDate(ymd)} liegt kein Fahrplan vor, er gilt nur bis ${fmtDate(m.feedEnd)}. Fahrzeuge und Verbindungen fehlen.`;
  else if (m.feedStart && ymd < m.feedStart) text = `Für den ${fmtDate(ymd)} liegt kein Fahrplan vor, er gilt erst ab ${fmtDate(m.feedStart)}.`;
  else if (secondary.length) text = `Für den ${fmtDate(ymd)} fehlen Daten zu ${secondary.map((f) => f.label).join(' und ')} (verfügbar ${[...new Set(secondary.map((f) => `${fmtDate(f.start)} bis ${fmtDate(f.end)}`))].join(', ')}). Es fahren nur KVV-Linien.`;
  else if (m.feedEnd && days(m.feedEnd, ymd) <= 7) text = `Der Fahrplan gilt nur noch bis ${fmtDate(m.feedEnd)}. Danach fehlen Daten bis zum nächsten Feed.`;
  else if (m.built) {
    const age = Math.floor((Date.now() - Date.parse(m.built)) / 86400000);
    if (age > 3) text = `Fahrplandaten vom ${fmtDate(m.built.slice(0, 10).replaceAll('-', ''))}, ${age} Tage alt. Neu bauen für aktuelle Daten.`;
  }
  if (text === lastNotice) return;
  lastNotice = text;
  const box = $('notice');
  box.textContent = text ? `⚠ ${text}` : '';
  box.hidden = !text;
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
    updateNotice();
  }
  if (state.meta) {
    loadWindow();
    // Bildrate: normal voll, bei Pause 4/s, im Sparmodus 8/s (bei Pause 2,5/s); Kartenbewegung zeichnet sofort
    const interval = state.saver ? (state.playing ? 125 : 400) : (state.playing ? 0 : 250);
    if (needsDraw || now - lastDraw >= interval) {
      drawFrame();
      lastDraw = now;
      needsDraw = false;
    }
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
$('bike').addEventListener('change', (e) => { state.onlyBikes = e.target.checked; if (state.station !== null) renderStation(); });
$('trails').addEventListener('change', (e) => { state.trails = e.target.checked; needsDraw = true; });
state.saver = load('strab.saver', typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
$('saver').checked = state.saver;
$('saver').addEventListener('change', (e) => { state.saver = e.target.checked; save('strab.saver', state.saver); resizeCanvas(); needsDraw = true; });
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
  if (['route', 'line', 'detours', 'groupedit', 'alerts', 'stats'].includes(state.list)) return; // Panel bleibt offen
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
  if (isDetour(pat.h)) facts.push('⚠ Umleitung oder Ersatzverkehr');
  const wc = (trip.flags || 0) & 3;
  facts.push(wc === 1 ? '♿ barrierefrei' : wc === 2 ? 'nicht barrierefrei' : '');
  const bk = ((trip.flags || 0) >> 2) & 3;
  facts.push(bk === 1 ? '🚲 Fahrrad erlaubt' : bk === 2 ? 'Fahrrad nicht erlaubt' : 'Fahrrad: keine Angabe');
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
  const why = !state.demo && state.reasons.get(trip.id);
  let text = delay === undefined ? (state.rt.active ? 'Fahrplanposition (keine Echtzeit für diese Fahrt)' : 'Fahrplanposition (Soll)') : `${fmtDelay(delay) === '0' ? 'Pünktlich' : `${fmtDelay(delay)} gegenüber Fahrplan`}${state.demo ? ' (Demo, erfundene Werte)' : ' (Echtzeit)'}${why ? ` · ${why}` : ''}`;
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
  const members = [index, ...(state.children.get(index) || [])];
  const yes = members.filter((m) => state.stops[m][7] === 1).length;
  const no = members.filter((m) => state.stops[m][7] === 2).length;
  body.append(el('div', { class: 'sub' }, `Abfahrten ab ${hhmm(state.sim)}, ${liveNote()}`));
  body.append(el('div', { class: 'sub' }, yes + no > 0 ? `♿ Stufenfreiheit laut Feed: ${yes} Steig${yes === 1 ? '' : 'e'} ja, ${no} nein, übrige ohne Angabe` : '♿ Stufenfreiheit: keine Angabe im Feed'));

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

  const shown = list.filter((d) => (!platformFilter || d.platform === platformFilter) && flagsOk(d.flags)).slice(0, 40);
  if (!shown.length) {
    body.append(el('div', { class: 'empty' }, 'Keine Abfahrten in den nächsten Stunden.'));
  } else {
    const table = el('table');
    for (const d of shown) {
      const style = routeStyle([d.line, d.type, d.color, d.textColor]);
      table.append(el('tr', {},
        el('td', { class: 't' }, depTime(d)),
        el('td', {}, pill(d.line, style, () => openLine(d.line)), ' ', cleanHeadsign(d.line, d.headsign), isDetour(d.headsign) ? ' ⚠' : '', accessible(d.flags) ? ' ♿' : ''),
        el('td', { class: 'r' }, d.platform ? `Steig ${d.platform} · ` : '', depWhen(d, base, state.sim))));
    }
    body.append(table);
  }
  showPanel();
}

// ---------- Start und Ziel: Station oder Punkt (Adresse, Standort) ----------

const mkStation = (i) => ({ index: i, name: state.stops[i][1], lat: state.stops[i][2], lon: state.stops[i][3] });
const specParams = (prefix, r) => (r.point
  ? { [`${prefix}Lat`]: r.lat.toFixed(5), [`${prefix}Lon`]: r.lon.toFixed(5) }
  : { [prefix]: r.index });
const specToLink = (r) => (r.point ? `p:${r.lat.toFixed(5)},${r.lon.toFixed(5)}` : state.stops[r.index][0]);
function specFromLink(txt) {
  if (!txt) return null;
  if (txt.startsWith('p:')) {
    const [la, lo] = txt.slice(2).split(',').map(Number);
    return Number.isFinite(la) && Number.isFinite(lo) ? { point: true, name: 'Gewählter Punkt', lat: la, lon: lo } : null;
  }
  const i = state.stops.findIndex((x) => x[0] === txt);
  return i >= 0 ? mkStation(i) : null;
}
const accParam = () => (state.routeAcc ? { acc: 1 } : {});
const specToSaved = (r) => (r.point ? { lat: r.lat, lon: r.lon, name: r.name } : state.stops[r.index][0]);
function specFromSaved(v) {
  if (typeof v === 'string') return specFromLink(v);
  return v && Number.isFinite(v.lat) && Number.isFinite(v.lon) ? { point: true, name: v.name || 'Adresse', lat: v.lat, lon: v.lon } : null;
}

// Adresssuche ueber Nominatim (OpenStreetMap). Nur auf Klick, hoechstens eine Anfrage pro Aktion.
async function geocode(q) {
  const [s0, w, n, e] = state.meta.bbox;
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('countrycodes', 'de');
  url.searchParams.set('accept-language', 'de');
  url.searchParams.set('viewbox', `${w - 0.1},${n + 0.1},${e + 0.1},${s0 - 0.1}`);
  url.searchParams.set('bounded', '1');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nominatim: HTTP ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({ name: r.display_name.split(', ').slice(0, 4).join(', '), lat: Number(r.lat), lon: Number(r.lon) }));
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
  const f = specFromSaved(saved.from);
  const t = specFromSaved(saved.to);
  return f && t ? { from: f, to: t } : null;
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
  const deps = allDeps.filter((d) => flagsOk(d.flags));
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
      table.append(el('tr', {}, el('td', { class: 't' }, depTime(d)),
        el('td', {}, pill(d.line, routeStyle([d.line, d.type, d.color, d.textColor]), () => openLine(d.line)), ' ', cleanHeadsign(d.line, d.headsign), isDetour(d.headsign) ? ' ⚠' : '', accessible(d.flags) ? ' ♿' : ''),
        el('td', { class: 'r' }, depWhen(d, base, state.sim))));
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
  const idxById = new Map(state.stops.map((s2, i) => [s2[0], i]));
  const items = state.favorites.map((id) => idxById.get(id)).filter((i) => i !== undefined);
  const mine = getMyRoute();
  const groups = getGroups();
  const ymd = ymdOf(state.sim);
  const hour = Math.floor((state.sim - dayStart(ymd)) / 3600);
  const dir = state.myReverse || (hour >= 12 ? 'back' : 'there');
  const [A, B] = mine ? (dir === 'back' ? [mine.to, mine.from] : [mine.from, mine.to]) : [null, null];
  const groupIdx = groups.map((g) => g.stops.map((id) => idxById.get(id)).filter((i) => i !== undefined));
  const [results, myJourneys, groupResults] = await Promise.all([
    Promise.all(items.map((i) => departuresFor(i, 3))),
    mine ? api('/api/plan', { ...specParams('from', A), ...specParams('to', B), date: ymd, t: Math.floor(state.sim - dayStart(ymd)) }).catch(() => []) : Promise.resolve([]),
    Promise.all(groupIdx.map((list) => Promise.all(list.map((i) => departuresFor(i, 6))))),
  ]);
  if (state.list !== 'favs') return;
  const body = $('panel-body');
  body.replaceChildren(el('h2', {}, '★ Favoriten'), el('div', { class: 'sub' }, 'Nächste Abfahrten nach Fahrplan (Soll)'));
  if (mine) {
    const open = el('a', { class: 'stop', role: 'button', tabindex: '0' }, `${dir === 'back' ? 'Rückweg' : 'Hinweg'}: ${A.name} → ${B.name}`);
    const go = () => { state.route = { from: A, to: B }; openRoute(true); };
    open.addEventListener('click', go);
    open.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
    const flip = el('button', { class: 'chip', type: 'button' }, '⇄ umkehren');
    flip.addEventListener('click', () => { state.myReverse = dir === 'back' ? 'there' : 'back'; renderFavs(); });
    const blk = el('div', { class: 'block' }, el('div', { class: 'bh' }, open, ' ', flip));
    if (!state.myReverse) blk.append(el('div', { class: 'sub' }, 'Richtung automatisch nach Tageszeit (vor 12 Uhr Hinweg, danach Rückweg)'));
    if (!myJourneys.length) blk.append(el('div', { class: 'empty' }, 'Keine Verbindung in den nächsten Stunden.'));
    for (const j of myJourneys.slice().sort((a, b) => a.dep - b.dep).slice(0, 3)) {
      const row = el('div', { class: 'leg' }, el('b', {}, `${hhmm(j.start)} → ${hhmm(j.arr)}`), ' ');
      for (const leg of j.legs) if (leg.type === 'ride') row.append(pill(leg.line, routeStyle([leg.line, leg.routeType, leg.color, leg.textColor])), ' ');
      row.append(el('span', { class: 'sub' }, `${j.transfers === 0 ? 'direkt' : `${j.transfers} Umstieg${j.transfers > 1 ? 'e' : ''}`}`));
      blk.append(row);
    }
    body.append(blk);
  }

  // Gruppen: mehrere Haltestellen als ein Favorit, Abfahrten nach Zeit gemischt
  const base = dayStart(ymd);
  groups.forEach((g, gi) => {
    const merged = [];
    groupIdx[gi].forEach((stationIdx, k) => {
      for (const d of groupResults[gi][k]) if (flagsOk(d.flags)) merged.push({ ...d, station: state.stops[stationIdx][1] });
    });
    merged.sort((a, b) => a.t - b.t);
    const edit = el('button', { class: 'chip', type: 'button' }, 'bearbeiten');
    edit.addEventListener('click', () => openGroupEditor(gi));
    const blk = el('div', { class: 'block' }, el('div', { class: 'bh' }, `📍 ${g.name} `, edit), el('div', { class: 'sub' }, groupIdx[gi].map((i) => state.stops[i][1]).join(' · ')));
    if (!merged.length) blk.append(el('div', { class: 'empty' }, 'Keine Abfahrten in den nächsten Stunden.'));
    else {
      const table = el('table');
      for (const d of merged.slice(0, 6)) {
          table.append(el('tr', {}, el('td', { class: 't' }, depTime(d)),
          el('td', {}, pill(d.line, routeStyle([d.line, d.type, d.color, d.textColor]), () => openLine(d.line)), ' ', cleanHeadsign(d.line, d.headsign), isDetour(d.headsign) ? ' ⚠' : '', accessible(d.flags) ? ' ♿' : '', el('div', { class: 'sub' }, d.station)),
          el('td', { class: 'r' }, depWhen(d, base, state.sim))));
      }
      blk.append(table);
    }
    body.append(blk);
  });
  const add = el('button', { class: 'chip', type: 'button' }, '＋ Gruppe anlegen');
  add.addEventListener('click', () => openGroupEditor(null));
  body.append(el('div', { class: 'chips' }, add));

  if (!items.length && !mine && !groups.length) body.append(el('div', { class: 'empty' }, 'Noch keine Favoriten. Haltestelle öffnen und den Stern antippen.'));
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
  const order = { tram: 0, rail: 1, fern: 2, bus: 3, other: 4 };
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
let boardCountdown = 0;
let boardSeq = 0;
let boardUi = { adding: false, qr: false };

async function openBoard(stations) {
  closePanel();
  state.board = (Array.isArray(stations) ? stations : [stations]).slice(0, 6);
  boardUi = { adding: false, qr: false };
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
  boardSeq++;
  $('board').hidden = true;
  document.body.classList.remove('board-open');
  try { if (wakeLock) wakeLock.release(); } catch { /* egal */ }
  wakeLock = null;
  writeHash();
}

function boardTick() {
  const clock = document.getElementById('bclock');
  if (clock) clock.textContent = hhmmss(wallNow());
  if (++boardCountdown >= 10) { boardCountdown = 0; renderBoard(); }
}

function qrElement(url) {
  if (typeof qrcode !== 'function') return null;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const doc = new DOMParser().parseFromString(qr.createSvgTag(4, 2), 'image/svg+xml');
  const svg = document.importNode(doc.documentElement, true);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  return svg;
}

async function renderBoard() {
  const stations = state.board;
  if (!stations || !stations.length) return;
  const mySeq = ++boardSeq;
  const now = wallNow();
  const ymd = ymdOf(now);
  const per = stations.length === 1 ? 14 : stations.length === 2 ? 10 : 7;
  const data = await Promise.all(stations.map((i) => api('/api/departures', { station: i, date: ymd, from: Math.floor(now - dayStart(ymd)), limit: per }).catch(() => [])));
  if (mySeq !== boardSeq || state.board !== stations) return;
  const base = dayStart(ymd);
  const view = $('board');
  view.replaceChildren();

  const mk = (label, fn) => { const b = el('button', { type: 'button', class: 'chip' }, label); b.addEventListener('click', fn); return b; };
  const buttons = el('div', { class: 'bbtns' },
    mk('＋ Haltestelle', () => { boardUi.adding = !boardUi.adding; renderBoard(); }),
    mk('QR-Code', () => { writeHash(); boardUi.qr = !boardUi.qr; renderBoard(); }),
    mk('Vollbild', () => { try { document.documentElement.requestFullscreen(); } catch { /* nicht erlaubt */ } }),
    mk('Zur Karte', closeBoard));
  view.append(el('div', { class: 'bhead' }, el('div', { class: 'bname' }, stations.map((i) => state.stops[i][1]).join(' · ')), el('div', { class: 'bclock', id: 'bclock' }, hhmmss(now)), buttons));

  if (boardUi.adding) {
    view.append(el('div', { class: 'badd' }, suggestField('Haltestelle hinzufügen', null, (r) => {
      if (!r) return;
      if (!stations.includes(r.index) && stations.length < 6) stations.push(r.index);
      boardUi.adding = false;
      writeHash();
      renderBoard();
    }, { stationsOnly: true })));
  }
  if (boardUi.qr) {
    const qr = qrElement(location.href);
    view.append(el('div', { class: 'bqr' }, qr ? el('div', { class: 'qrbox' }, qr) : el('div', { class: 'empty' }, 'QR-Code nicht verfügbar'),
      el('div', { class: 'sub' }, 'Mit dem Handy scannen, um diese Tafel zu öffnen.'), el('div', { class: 'sub urltext' }, location.href)));
  }

  const cols = el('div', { class: stations.length > 1 ? 'bcols multi' : 'bcols' });
  stations.forEach((idx, n) => {
    const col = el('div', { class: 'bcol' });
    if (stations.length > 1) {
      const rm = el('button', { type: 'button', class: 'chip', 'aria-label': 'Haltestelle entfernen' }, '✕');
      rm.addEventListener('click', () => { stations.splice(n, 1); writeHash(); renderBoard(); });
      col.append(el('div', { class: 'bsub' }, state.stops[idx][1], ' ', rm));
    }
    const rows = el('div', { class: 'brows' });
    const list = data[n].filter((d) => flagsOk(d.flags));
    if (!list.length) rows.append(el('div', { class: 'empty' }, 'Keine Abfahrten in den nächsten Stunden.'));
    for (const d of list) {
      rows.append(el('div', { class: 'brow' },
        el('span', { class: 'bt' }, depTime(d)),
        pill(d.line, routeStyle([d.line, d.type, d.color, d.textColor])),
        el('span', { class: 'bh2' }, cleanHeadsign(d.line, d.headsign), isDetour(d.headsign) ? ' ⚠' : '', accessible(d.flags) ? ' ♿' : ''),
        el('span', { class: 'bp' }, d.platform ? `Steig ${d.platform}` : ''),
        el('span', { class: 'bm' }, depWhen(d, base, now, ''))));
    }
    col.append(rows);
    cols.append(col);
  });
  view.append(cols, el('div', { class: 'bnote sub' }, `Zeiten ${liveNote()}. Daten: ${state.attribution || 'KVV (CC0)'}.`));
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

function suggestField(label, initial, onPick, opts = {}) {
  const wrap = el('div', { class: 'sf' });
  const input = el('input', { type: 'search', placeholder: label, autocomplete: 'off', 'aria-label': label });
  if (initial) input.value = initial.name;
  const ul = el('ul', { class: 'sfl' });
  ul.hidden = true;
  let seq = 0;
  let timer = null;
  const pick = (r) => { input.value = r.name; ul.hidden = true; onPick(r); };

  const addressRow = (q) => {
    const li = el('li', { class: 'addr' }, `🔎 Adresse suchen: „${q}“`);
    li.addEventListener('click', async () => {
      ul.replaceChildren(el('li', { class: 'note' }, 'Suche Adresse …'));
      try {
        const res = await geocode(q);
        ul.replaceChildren();
        for (const r of res) {
          const li2 = el('li', {}, `📍 ${r.name}`);
          li2.addEventListener('click', () => pick({ point: true, ...r }));
          ul.append(li2);
        }
        if (!res.length) ul.append(el('li', { class: 'note' }, 'Keine Adresse im Kartengebiet gefunden'));
      } catch (e) {
        console.error(e);
        ul.replaceChildren(el('li', { class: 'note' }, 'Adresssuche hier nicht verfügbar'));
      }
    });
    return li;
  };

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
        li.addEventListener('click', () => pick(mkStation(r.index)));
        ul.append(li);
      }
      if (!opts.stationsOnly) ul.append(addressRow(q));
      ul.hidden = ul.children.length === 0;
    }, 160);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const a = ul.querySelector('li.addr');
      if (a && ul.children.length === 1) a.click();
    }
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
  const fromField = suggestField('Start (Haltestelle oder Adresse)', state.route.from, (r) => { state.route.from = r; });
  const toField = suggestField('Ziel (Haltestelle oder Adresse)', state.route.to, (r) => { state.route.to = r; });
  const timeInput = el('input', { type: 'time', class: 'timebox', 'aria-label': 'Abfahrt ab', value: hhmm(state.sim) });
  const status = el('div', { class: 'sub' }, state.rt.active ? 'Nach Fahrplan, Live-Verspätungen werden angezeigt, ausgefallene Fahrten gemieden.' : 'Nach Fahrplan (Soll), ohne Echtzeit.');
  const results = el('div', { class: 'results' });
  const chart = el('div', { class: 'chart' });

  const here = el('button', { class: 'chip', type: 'button' }, 'Mein Standort als Start');
  here.addEventListener('click', async () => {
    try {
      state.here = await locateMe();
      state.route.from = { point: true, name: 'Mein Standort', lat: state.here.lat, lon: state.here.lon };
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
      state.journeys = await api('/api/plan', { ...specParams('from', from), ...specParams('to', to), date: ymd, t: hh * 3600 + mm * 60, ...accParam() });
    } catch (e) {
      console.error(e);
      status.textContent = 'Suche fehlgeschlagen.';
      return;
    }
    status.textContent = state.journeys.length ? `${state.journeys.length} Verbindung${state.journeys.length > 1 ? 'en' : ''} nach Fahrplan (Soll)${state.routeAcc ? ', nur barrierefreie Fahrten' : ''}` : `Keine Verbindung in den nächsten 5 Stunden gefunden${state.routeAcc ? ' (nur barrierefreie Fahrten)' : ''}.`;
    renderJourneys(results);
    scheduleHash();
  };
  const go = el('button', { class: 'chip go', type: 'button' }, 'Suchen');
  go.addEventListener('click', search);

  const setTime = (minutes) => {
    const t = Math.min(23 * 60 + 59, Math.max(0, minutes));
    timeInput.value = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  };
  const earlier = el('button', { class: 'chip', type: 'button' }, '← Früher');
  earlier.addEventListener('click', () => {
    const [hh, mm] = timeInput.value.split(':').map(Number);
    setTime((hh || 0) * 60 + (mm || 0) - 30);
    search();
  });
  const later = el('button', { class: 'chip', type: 'button' }, 'Später →');
  later.addEventListener('click', () => {
    if (state.journeys.length) setTime(Math.floor(Math.min(...state.journeys.map((j) => j.dep)) / 60) + 1);
    else { const [hh, mm] = timeInput.value.split(':').map(Number); setTime((hh || 0) * 60 + (mm || 0) + 30); }
    search();
  });

  const lastBtn = el('button', { class: 'chip', type: 'button' }, 'Letzte Verbindung');
  lastBtn.addEventListener('click', async () => {
    const { from, to } = state.route;
    if (!from || !to) { status.textContent = 'Bitte Start und Ziel aus der Liste wählen.'; return; }
    const [hh, mm] = timeInput.value.split(':').map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) { status.textContent = 'Bitte eine Uhrzeit angeben.'; return; }
    status.textContent = 'Suche läuft …';
    results.replaceChildren();
    state.journey = null;
    try {
      state.journeys = await api('/api/last', { ...specParams('from', from), ...specParams('to', to), date: ymdOf(state.sim), t: hh * 3600 + mm * 60, ...accParam() });
    } catch (e) {
      console.error(e);
      status.textContent = 'Suche fehlgeschlagen.';
      return;
    }
    status.textContent = state.journeys.length
      ? `Letzte Verbindung ab ${timeInput.value} Uhr, bevor die Nachtpause beginnt (nach Fahrplan, Soll)`
      : `Ab ${timeInput.value} Uhr fährt nichts mehr.`;
    renderJourneys(results);
  });
  const accBtn = el('button', { class: 'chip', type: 'button', 'aria-pressed': String(state.routeAcc), title: 'Nutzt nur Fahrten mit ♿ und meidet Halte, die laut Feed nicht stufenfrei sind. Bei den meisten Halten fehlt die Angabe, sie gelten dann als nutzbar.' }, '♿ barrierefrei reisen');
  accBtn.addEventListener('click', () => {
    state.routeAcc = !state.routeAcc;
    accBtn.setAttribute('aria-pressed', String(state.routeAcc));
    if (state.journeys.length) search();
  });
  const profile = el('button', { class: 'chip', type: 'button' }, 'Reisezeit über den Tag');
  profile.addEventListener('click', async () => {
    const { from, to } = state.route;
    if (!from || !to) { status.textContent = 'Bitte Start und Ziel aus der Liste wählen.'; return; }
    chart.replaceChildren(el('div', { class: 'sub' }, 'Berechne …'));
    let rows = [];
    try {
      rows = await api('/api/profile', { ...specParams('from', from), ...specParams('to', to), date: ymdOf(state.sim), ...accParam() });
    } catch (e) {
      console.error(e);
      chart.replaceChildren(el('div', { class: 'sub' }, 'Berechnung fehlgeschlagen.'));
      return;
    }
    const vals = rows.map((r) => r[1]).filter((v) => v !== null);
    if (!vals.length) { chart.replaceChildren(el('div', { class: 'sub' }, 'An diesem Tag keine Verbindungen.')); return; }
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    chart.replaceChildren(el('div', { class: 'sub' }, `Gesamtzeit bis zur Ankunft, wenn du zur Uhrzeit losgehst (mit Warten). Kürzeste: ${min} min (grün). Antippen sucht ab dieser Zeit.`));
    for (const [t, m] of rows) {
      const bar = el('span', { class: 'cb' });
      bar.style.width = m === null ? '0' : `${Math.max(4, (m / max) * 100)}%`;
      bar.style.background = m === min ? '#2e7d32' : 'var(--accent)';
      const row = el('button', { class: 'crow', type: 'button' }, el('span', { class: 'ct' }, hhmm(t)), el('span', { class: 'cw' }, bar), el('span', { class: 'cm' }, m === null ? '–' : `${m} min`));
      row.addEventListener('click', () => { setTime(Math.floor(t / 60)); search(); });
      chart.append(row);
    }
  });

  const mine = getMyRoute();
  const extras = el('div', { class: 'chips' });
  const save = el('button', { class: 'chip', type: 'button' }, 'Als Mein Weg speichern');
  save.addEventListener('click', () => {
    if (!state.route.from || !state.route.to) { status.textContent = 'Erst Start und Ziel wählen.'; return; }
    save_('strab.myroute', { from: specToSaved(state.route.from), to: specToSaved(state.route.to) });
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
    el('div', { class: 'chips' }, here, swap, go), el('div', { class: 'chips' }, earlier, later, profile), el('div', { class: 'chips' }, lastBtn, accBtn), status, results, chart, extras);
  if (state.journeys.length) renderJourneys(results);
  showPanel();
  if (autorun) search();
}

function downloadIcs(j, note) {
  const base = dayStart(ymdOf(state.sim));
  const stamp = (secs) => {
    const d = new Date((base + secs) * 1000);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
  };
  const esc = (t) => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const lines = j.legs.map((l) => (l.type === 'walk'
    ? `Fußweg ${Math.max(1, Math.round(l.secs / 60))} min`
    : `${l.line} ${hhmm(l.dep)} ${state.stops[l.from][1]} → ${hhmm(l.arr)} ${state.stops[l.to][1]} (Richtung ${cleanHeadsign(l.line, l.headsign)})`));
  const now = new Date();
  const nowStamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//STRABFAHRT//DE', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${Date.now()}-${Math.round(j.arr)}@strabfahrt`, `DTSTAMP:${nowStamp}`,
    `DTSTART:${stamp(j.start)}`, `DTEND:${stamp(j.arr)}`,
    `SUMMARY:${esc(`Fahrt: ${state.route.from.name} → ${state.route.to.name}`)}`,
    `DESCRIPTION:${esc(`${lines.join('\n')}\n(Fahrplan Soll, ohne Echtzeit)`)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  try {
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    const a = el('a', { href: url, download: 'verbindung.ics' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    note.textContent = 'Kalenderdatei erstellt (Uhrzeiten in deiner Ortszeit)';
  } catch (e) {
    console.error(e);
    note.textContent = 'Download ist hier nicht möglich';
  }
}

function renderJourneys(container) {
  container.replaceChildren();
  state.journeys.forEach((j) => {
    const card = el('div', { class: 'jcard', role: 'button', tabindex: '0', 'aria-pressed': String(state.journey === j) });
    const mins = Math.round((j.arr - j.start) / 60);
    card.append(el('div', { class: 'jh' }, `${hhmm(j.start)} → ${hhmm(j.arr)}`, el('span', { class: 'sub' }, ` · ${mins} min · ${j.transfers === 0 ? 'direkt' : `${j.transfers} Umstieg${j.transfers > 1 ? 'e' : ''}`}`)));
    for (const leg of j.legs) {
      if (leg.type === 'walk') {
        const m = Math.max(1, Math.round(leg.secs / 60));
        const text = leg.fromPoint ? `Fußweg ${m} min zur Haltestelle ${state.stops[leg.to][1]}` : leg.toPoint ? `Fußweg ${m} min zum Ziel` : `Fußweg ${m} min nach ${state.stops[leg.to][1]}`;
        card.append(el('div', { class: 'leg walk' }, text));
      } else {
        const style = routeStyle([leg.line, leg.routeType, leg.color, leg.textColor]);
        card.append(el('div', { class: 'leg' },
          pill(leg.line, style, () => openLine(leg.line)), ' ',
          el('span', {}, depTime({ t: leg.dep, trip: leg.trip }), ` ${state.stops[leg.from][1]}`),
          rtOf(leg.trip).canceled ? el('div', { class: 'sub warn' }, '⚠ Diese Fahrt fällt aus') : '',
          el('div', { class: 'sub' }, `Richtung ${cleanHeadsign(leg.line, leg.headsign)}${isDetour(leg.headsign) ? ' · ⚠ Umleitung/Ersatzverkehr' : ''}${accessible(leg.flags) ? ' · ♿' : ''}`),
          el('span', {}, `${hhmm(leg.arr)} ${state.stops[leg.to][1]}`)));
      }
    }
    const note = el('div', { class: 'sub' });
    const ics = el('button', { class: 'chip', type: 'button' }, 'In Kalender');
    ics.addEventListener('click', (ev) => { ev.stopPropagation(); downloadIcs(j, note); });
    ics.addEventListener('keydown', (ev) => ev.stopPropagation());
    card.append(el('div', { class: 'chips' }, ics), note);
    const pick = () => {
      state.journey = j;
      const pts = j.legs.flatMap((l) => (l.type === 'ride' ? l.stops.map((i) => [state.stops[i][2], state.stops[i][3]]) : [legPoint(l, 'from'), legPoint(l, 'to')]));
      map.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 16 });
      renderJourneys(container);
    };
    card.addEventListener('click', pick);
    card.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') pick(); });
    container.append(card);
  });
}

$('btn-route').addEventListener('click', () => (state.list === 'route' ? closePanel() : openRoute()));

// ---------- Haltestellengruppen ----------

const getGroups = () => {
  const g = load('strab.groups', []);
  return Array.isArray(g) ? g.filter((x) => x && typeof x.name === 'string' && Array.isArray(x.stops)) : [];
};

function openGroupEditor(index) {
  const groups = getGroups();
  state.groupDraft = index === null ? { index: null, name: '', ids: [] } : { index, name: groups[index].name, ids: [...groups[index].stops] };
  state.selected = null;
  state.station = null;
  state.follow = null;
  clearInterval(stationTimer);
  state.list = 'groupedit';
  renderGroupEditor();
}

function renderGroupEditor() {
  const d = state.groupDraft;
  if (!d) return;
  const body = $('panel-body');
  const byId = new Map(state.stops.map((s2, i) => [s2[0], i]));
  body.replaceChildren(el('h2', {}, d.index === null ? 'Neue Gruppe' : 'Gruppe bearbeiten'),
    el('div', { class: 'sub' }, 'Mehrere Haltestellen als ein Favorit, zum Beispiel alle Haltestellen rund ums Zuhause.'));
  const name = el('input', { type: 'text', class: 'urlbox', placeholder: 'Name der Gruppe, z. B. Zuhause', 'aria-label': 'Name der Gruppe', maxlength: '40', value: d.name });
  name.addEventListener('input', () => { d.name = name.value; });
  body.append(name);
  const list = el('div', { class: 'block' });
  if (!d.ids.length) list.append(el('div', { class: 'empty' }, 'Noch keine Haltestelle in der Gruppe.'));
  for (const id of d.ids) {
    const i = byId.get(id);
    const rm = el('button', { class: 'chip', type: 'button', 'aria-label': 'Entfernen' }, '✕');
    rm.addEventListener('click', () => { d.ids = d.ids.filter((x) => x !== id); renderGroupEditor(); });
    list.append(el('div', { class: 'leg' }, i === undefined ? id : state.stops[i][1], ' ', rm));
  }
  body.append(list);
  body.append(suggestField('Haltestelle hinzufügen', null, (r) => {
    if (!r) return;
    const id = state.stops[r.index][0];
    if (!d.ids.includes(id)) d.ids.push(id);
    renderGroupEditor();
  }, { stationsOnly: true }));
  const note = el('div', { class: 'sub' });
  const save1 = el('button', { class: 'chip go', type: 'button' }, 'Speichern');
  save1.addEventListener('click', () => {
    if (!d.name.trim()) { note.textContent = 'Bitte einen Namen eingeben.'; return; }
    if (!d.ids.length) { note.textContent = 'Bitte mindestens eine Haltestelle hinzufügen.'; return; }
    const groups = getGroups();
    const entry = { name: d.name.trim(), stops: d.ids };
    if (d.index === null) groups.push(entry); else groups[d.index] = entry;
    save('strab.groups', groups);
    state.groupDraft = null;
    startList('favs');
  });
  const cancel = el('button', { class: 'chip', type: 'button' }, 'Abbrechen');
  cancel.addEventListener('click', () => { state.groupDraft = null; startList('favs'); });
  const row = el('div', { class: 'chips' }, save1, cancel);
  if (d.index !== null) {
    const del = el('button', { class: 'chip', type: 'button' }, 'Gruppe löschen');
    del.addEventListener('click', () => {
      const groups = getGroups();
      groups.splice(d.index, 1);
      save('strab.groups', groups);
      state.groupDraft = null;
      startList('favs');
    });
    row.append(del);
  }
  body.append(row, note);
  showPanel();
}

// ---------- Umleitungen heute ----------

async function openDetours() {
  state.selected = null;
  state.station = null;
  state.follow = null;
  state.lineView = null;
  state.journey = null;
  clearInterval(stationTimer);
  state.list = 'detours';
  const ymd = ymdOf(state.sim);
  const body = $('panel-body');
  body.replaceChildren(el('h2', {}, '⚠ Umleitungen und Ersatzverkehr'), el('div', { class: 'sub' }, 'Lade …'));
  showPanel();
  let rows = [];
  try { rows = await api('/api/disruptions', { date: ymd }); } catch (e) { console.error(e); }
  if (state.list !== 'detours') return;
  body.replaceChildren(el('h2', {}, '⚠ Umleitungen und Ersatzverkehr'),
    el('div', { class: 'sub' }, `${fmtDate(ymd)}. Aus den Zielangaben im Fahrplan abgeleitet, keine Störungsmeldungen des KVV. Aktuelle Meldungen stehen auf kvv.de.`));
  if (!rows.length) body.append(el('div', { class: 'empty' }, 'Für diesen Tag sind im Fahrplan keine Umleitungen oder Ersatzverkehre vermerkt.'));
  for (const r of rows) {
    const style = routeStyle([r.line, r.type, r.color, r.textColor]);
    body.append(el('div', { class: 'block' },
      el('div', { class: 'bh' }, pill(r.line, style, () => openLine(r.line)), ` ${r.detour} von ${r.total} Fahrten`),
      el('div', { class: 'sub' }, `Abfahrten von ${hhmm(r.first)} bis ${hhmm(r.last)} Uhr`),
      ...r.headsigns.map((h) => el('div', { class: 'sub' }, h))));
  }
  showPanel();
}
$('btn-detours').addEventListener('click', () => (state.list === 'detours' ? closePanel() : openDetours()));

// ---------- Echtzeit: Anzeige, Meldungen, Puenktlichkeit ----------

function rtGet(pathName) {
  return state.rtBase ? fetch(`${state.rtBase.replace(/\/$/, '')}${pathName}`).then((r) => r.json()) : api(pathName);
}

function setNote() {
  if (STATIC && !TILES) return;
  $('note').textContent = `Positionen nach Fahrplan${state.rt.active ? ', verschoben um Live-Verspätungen, wo verfügbar' : ' (Soll), keine Echtzeit'}. Daten: ${state.attribution}. Karte: © OpenStreetMap-Mitwirkende. Ohne Gewähr.`;
}

function updateLive() {
  setNote();
  const box = $('live');
  const r = state.rt;
  if (!r.updated && !r.error) { box.hidden = true; return; }
  box.hidden = false;
  const age = r.feedTime ? Math.round(Date.now() / 1000 - r.feedTime) : null;
  const stale = r.error || age === null || age > 300;
  box.className = stale ? 'live stale' : 'live';
  box.textContent = r.error && !r.updated ? '● Live-Daten nicht erreichbar' : `● Live ${r.feedTime ? hhmmss(wallOf(r.feedTime)) : ''}`;
  box.title = `Echtzeit von gtfs.de. ${state.delays.size} Fahrten mit Verspätungsangabe, ${state.canceled.size} Ausfälle.${r.error ? ` Letzter Fehler: ${r.error}` : ''}`;
}

async function openAlerts() {
  state.selected = null; state.station = null; state.follow = null; state.lineView = null; state.journey = null;
  clearInterval(stationTimer);
  state.list = 'alerts';
  const body = $('panel-body');
  body.replaceChildren(el('h2', {}, '📢 Meldungen'), el('div', { class: 'sub' }, 'Lade …'));
  showPanel();
  let data = { alerts: [] };
  try { data = await rtGet('/api/alerts'); } catch (e) { console.error(e); }
  if (state.list !== 'alerts') return;
  body.replaceChildren(el('h2', {}, '📢 Meldungen'), el('div', { class: 'sub' }, 'Störungs- und Baustellenmeldungen aus dem Echtzeitstream (gtfs.de), Region Karlsruhe zuerst.'));
  if (!data.alerts.length) body.append(el('div', { class: 'empty' }, 'Gerade keine Meldungen für das Gebiet.'));
  for (const a of data.alerts) {
    const det = el('details', { class: 'block' }, el('summary', {}, a.header));
    if (a.text && a.text !== a.header) det.append(el('div', { class: 'atext' }, a.text));
    if (a.url && /^https?:\/\//.test(a.url)) det.append(el('a', { href: a.url, target: '_blank', rel: 'noreferrer' }, 'Mehr dazu'));
    body.append(det);
  }
  showPanel();
}

async function openStats() {
  state.selected = null; state.station = null; state.follow = null; state.lineView = null; state.journey = null;
  clearInterval(stationTimer);
  state.list = 'stats';
  const body = $('panel-body');
  body.replaceChildren(el('h2', {}, '⏱ Pünktlichkeit'), el('div', { class: 'sub' }, 'Lade …'));
  showPanel();
  let data = { days: 0, lines: [] };
  try { data = await rtGet('/api/stats'); } catch (e) { console.error(e); }
  if (state.list !== 'stats') return;
  if (data.unsupported) {
    body.replaceChildren(el('h2', {}, '⏱ Pünktlichkeit'), el('div', { class: 'empty' }, 'Die Statistik braucht einen dauerhaft laufenden Server mit Speicher. Der kostenlose Live-Dienst liefert nur aktuelle Verspätungen.'));
    showPanel();
    return;
  }
  body.replaceChildren(el('h2', {}, '⏱ Pünktlichkeit'),
    el('div', { class: 'sub' }, data.days
      ? `Mitgeschrieben vom Server, solange die App offen war: ${data.days} Tag${data.days > 1 ? 'e' : ''} (${fmtDate(data.from)} bis ${fmtDate(data.to)}). "Spät" heißt ab 3 Minuten. Nur Fahrten mit Echtzeitangabe.`
      : 'Noch keine Daten. Der Server schreibt mit, sobald Echtzeit läuft und die App geöffnet ist.'));
  if (data.lines.length) {
    const table = el('table');
    table.append(el('tr', { class: 'th' }, el('td', {}, 'Linie'), el('td', { class: 'r' }, 'Fahrten'), el('td', { class: 'r' }, 'Ø'), el('td', { class: 'r' }, 'spät'), el('td', { class: 'r' }, 'Ausfall')));
    for (const l of data.lines.slice(0, 60)) {
      const route = state.meta.routes.find((r) => r[0] === l.line && r[1] === l.type) || [l.line, l.type, '', ''];
      const late = el('td', { class: 'r' }, `${l.latePct} %`);
      if (l.latePct >= 20) late.style.color = '#d32f2f';
      table.append(el('tr', {}, el('td', {}, pill(l.line, routeStyle(route), () => openLine(l.line))), el('td', { class: 'r' }, String(l.trips)),
        el('td', { class: 'r' }, fmtDelay(l.avg)), late, el('td', { class: 'r' }, String(l.canceled))));
    }
    body.append(table);
  }
  showPanel();
}

$('btn-alerts').addEventListener('click', () => (state.list === 'alerts' ? closePanel() : openAlerts()));
$('btn-stats').addEventListener('click', () => (state.list === 'stats' ? closePanel() : openStats()));

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

if (window.innerWidth < 900) $('bar').classList.add('collapsed');
$('collapse').setAttribute('aria-expanded', String(!$('bar').classList.contains('collapsed')));
$('collapse').textContent = $('bar').classList.contains('collapsed') ? 'Optionen ▸' : 'Optionen ▾';
$('collapse').addEventListener('click', () => {
  const c = $('bar').classList.toggle('collapsed');
  $('collapse').setAttribute('aria-expanded', String(!c));
  $('collapse').textContent = c ? 'Optionen ▸' : 'Optionen ▾';
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
if (!window.STRAB_NATIVE && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  try { navigator.serviceWorker.register('sw.js').catch(() => {}); } catch { /* im eingebetteten Rahmen nicht erlaubt */ }
}

// ---------- Start ----------

// Nur fuer automatische Tests: mit "dbg" im Hash ist der Zustand im Browser erreichbar
if (new URLSearchParams(location.hash.slice(1)).has('dbg')) window.__strab = { state, map };

async function init() {
  const [meta, stops] = await Promise.all([api('/api/meta'), api('/api/stops')]);
  state.meta = meta;
  state.stops = stops;
  stops.forEach((st, i) => { if (st[4] >= 0) { if (!state.children.has(st[4])) state.children.set(st[4], []); state.children.get(st[4]).push(i); } });
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

  state.attribution = (meta.feeds && meta.feeds.length ? meta.feeds.map((f) => f.attribution) : ['KVV (CC0)']).join('; ');
  if (!(STATIC && !TILES)) $('note').textContent = `Positionen nach Fahrplan (Soll), keine Echtzeit. Daten: ${state.attribution}. Karte: © OpenStreetMap-Mitwirkende. Ohne Gewähr.`;
  if (STATIC && !TILES) {
    document.body.classList.add('static');
    const groups = [[], [], []];
    for (const [a, b, g] of await api('/api/network')) groups[g].push([a, b]);
    state.networkGroups = groups;
    $('note').textContent = 'Vorschau ohne Kartenkacheln, das Liniennetz ist schematisch (Luftlinie zwischen Haltestellen). Positionen nach Fahrplan (Soll), keine Echtzeit. Daten: ' + state.attribution + '. Ohne Gewähr.';
  }
  // Echtzeit: vom eigenen Server oder, in der statischen Variante, von einem Live-Server (STRAB_RT_URL)
  let rtBase = STATIC ? (window.STRAB_RT_URL || '') : '';
  // App: Live-Adresse aus config.json der Webseite, damit sie ohne neue APK geaendert werden kann
  if (STATIC && !rtBase && window.STRAB_DATA_URL) {
    try { rtBase = (await (await fetch(`${window.STRAB_DATA_URL}config.json`, { cache: 'no-cache' })).json()).rtUrl || ''; } catch { /* offline */ }
  }
  if (meta.realtime || rtBase) {
    const poll = async () => {
      try {
        const j = rtBase ? await (await fetch(`${rtBase.replace(/\/$/, '')}/api/delays`)).json() : await api('/api/delays');
        if (!j || j.enabled === false) return;
        state.delays = new Map(Object.entries(j.d || {}).map(([k, v]) => [k, Number(v)]));
        state.canceled = new Set(j.c || []);
        state.reasons = new Map(Object.entries(j.r || {}));
        state.rt = { active: !!j.updated, updated: j.updated, feedTime: j.feedTime, error: j.error };
      } catch (e) {
        state.rt = { ...state.rt, error: e.message };
      }
      updateLive();
    };
    state.rtBase = rtBase;
    poll();
    setInterval(poll, 20000);
    if (!state.attribution.includes('Echtzeit')) state.attribution += `; ${meta.rtAttribution || 'Echtzeit: gtfs.de (CC BY-SA 4.0)'}`;
    $('btn-alerts').hidden = false;
    $('btn-stats').hidden = false;
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
  const boardIdx = h && h.tafel ? h.tafel.split('~').map(idOf).filter((i) => i >= 0) : [];
  if (boardIdx.length) {
    openBoard(boardIdx);
  } else if (h && h.rt) {
    const [a, b] = h.rt.split('~');
    const fa = specFromLink(a);
    const tb = specFromLink(b);
    if (fa && tb) {
      state.route = { from: fa, to: tb };
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
