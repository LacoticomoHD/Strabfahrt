// HTTP-Server: statische Dateien plus kleine JSON-API. Keine externen Pakete ausser Leaflet (statisch).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Model, parseYmd } from './model.mjs';
import { Realtime, RT_ATTRIBUTION } from './realtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const MODEL_FILE = path.join(ROOT, 'data', 'model.json');

if (!fs.existsSync(MODEL_FILE)) {
  console.error('data/model.json fehlt. Bitte zuerst "npm run build:data" ausfuehren.');
  process.exit(1);
}

console.time('Modell geladen');
const model = new Model(JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8')));
console.timeEnd('Modell geladen');
const realtime = new Realtime(model, path.join(ROOT, 'data'));
console.log(realtime.enabled ? 'Echtzeit an (gtfs.de, wird bei Nutzung geladen)' : 'Echtzeit aus');

const STATIC_ROOTS = [
  { prefix: '/vendor/leaflet/', dir: path.join(ROOT, 'node_modules', 'leaflet', 'dist') },
  { prefix: '/vendor/qrcode/', dir: path.join(ROOT, 'node_modules', 'qrcode-generator', 'dist') },
  { prefix: '/', dir: path.join(ROOT, 'public') },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: https://*.tile.openstreetmap.org https://sgx.geodatenzentrum.de https://*.tiles.openrailwaymap.org",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self' https://nominatim.openstreetmap.org",
  ].join('; '),
};

// Optionale Gleisgeometrien (scripts/snap-rail.mjs). Nur gueltig fuer genau dieses Modell.
let shapesRaw = null;
let shapesGzip = null;
const SHAPES_FILE = path.join(ROOT, 'data', 'shapes.json');
if (fs.existsSync(SHAPES_FILE)) {
  const text = fs.readFileSync(SHAPES_FILE, 'utf8');
  const parsed = JSON.parse(text);
  if (parsed.meta && parsed.meta.modelBuilt === model.meta.built) {
    shapesRaw = text;
    shapesGzip = zlib.gzipSync(text);
    console.log(`Gleisgeometrien geladen (${parsed.meta.matched} Abschnitte)`);
  } else {
    console.warn('data/shapes.json passt nicht zu data/model.json und wird ignoriert. Bitte "npm run snap:rail" erneut ausfuehren.');
  }
}

function sendJson(res, status, body, extra = {}, req = null) {
  let data = Buffer.from(JSON.stringify(body));
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extra,
  };
  if (req && data.length > 2048 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    data = zlib.gzipSync(data);
    headers['Content-Encoding'] = 'gzip';
  }
  headers.Vary = 'Accept-Encoding';
  res.writeHead(status, headers);
  res.end(data);
}

const num = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

function parseTimeWindow(q) {
  const date = q.get('date') || '';
  if (!parseYmd(date)) return null;
  const t0 = num(q.get('t0'), -DAY_LIMIT, DAY_LIMIT);
  const t1 = num(q.get('t1'), -DAY_LIMIT, DAY_LIMIT);
  if (t0 === null || t1 === null || t1 < t0 || t1 - t0 > 6 * 3600) return null;
  return { date, t0, t1 };
}
const DAY_LIMIT = 3 * 86400;

// Start/Ziel aus der URL: Station (from=12) oder Punkt (fromLat=49.0&fromLon=8.4), sonst null
function parseSpec(q, prefix) {
  if (q.get(prefix) !== null && q.get(prefix) !== '') {
    const i = num(q.get(prefix), 0, model.stops.length - 1);
    return i !== null && Number.isInteger(i) ? i : null;
  }
  const lat = num(q.get(`${prefix}Lat`), 40, 60);
  const lon = num(q.get(`${prefix}Lon`), 0, 20);
  return lat !== null && lon !== null ? { lat, lon } : null;
}

// Echtzeit-Endpunkte duerfen auch von der statischen Web-Variante (anderer Ursprung) abgefragt werden
const CORS = { 'Access-Control-Allow-Origin': '*' };

const TYPE_GROUPS = { tram: [0, 1], rail: [2], fern: [100], bus: [3, 11], other: [4, 5, 6, 7, 12] };

function handleApi(url, req, res) {
  const q = url.searchParams;
  switch (url.pathname) {
    case '/api/meta':
      return sendJson(res, 200, { realtime: realtime.enabled, rtAttribution: RT_ATTRIBUTION, bbox: model.meta.bbox, area: model.meta.area || null, areaCell: model.meta.areaCell || 0, feedVersion: model.meta.feedVersion, feedStart: model.meta.feedStart || '', feedEnd: model.meta.feedEnd || '', feeds: model.meta.feeds || [], built: model.meta.built, routes: model.routes });

    case '/api/stops':
      return sendJson(res, 200, model.stops, { 'Cache-Control': 'public, max-age=3600' }, req);

    case '/api/vehicles': {
      const w = parseTimeWindow(q);
      if (!w) return sendJson(res, 400, { error: 'date, t0, t1 ungueltig (Fenster max. 6 h)' });
      let bbox = null;
      if (q.get('bbox')) {
        const b = q.get('bbox').split(',').map(Number);
        if (b.length !== 4 || b.some((x) => !Number.isFinite(x))) return sendJson(res, 400, { error: 'bbox ungueltig' });
        bbox = b;
      }
      let types = null;
      if (q.get('types')) {
        types = new Set();
        for (const key of q.get('types').split(',')) {
          if (!TYPE_GROUPS[key]) return sendJson(res, 400, { error: 'types ungueltig' });
          TYPE_GROUPS[key].forEach((t) => types.add(t));
        }
      }
      return sendJson(res, 200, model.vehicles(w.date, w.t0, w.t1, bbox, types), {}, req);
    }

    case '/api/shapes': {
      if (!shapesRaw) return sendJson(res, 404, { error: 'keine Gleisgeometrien vorhanden' });
      const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
        Vary: 'Accept-Encoding',
        ...(wantsGzip ? { 'Content-Encoding': 'gzip' } : {}),
        ...SECURITY_HEADERS,
      });
      return res.end(wantsGzip ? shapesGzip : shapesRaw);
    }

    case '/api/line': {
      const name = q.get('name') || '';
      if (!name || name.length > 20) return sendJson(res, 400, { error: 'name ungueltig' });
      return sendJson(res, 200, model.line(name));
    }

    case '/api/plan':
    case '/api/profile':
    case '/api/last': {
      const date = q.get('date') || '';
      const from = parseSpec(q, 'from');
      const to = parseSpec(q, 'to');
      const t = num(q.get('t'), -DAY_LIMIT, DAY_LIMIT);
      const opts = { accessible: q.get('acc') === '1', exclude: realtime.canceled };
      if (from === null || to === null || !parseYmd(date) || (url.pathname !== '/api/profile' && t === null)) {
        return sendJson(res, 400, { error: 'from/to (Station oder Lat/Lon), date, t ungueltig' });
      }
      if (url.pathname === '/api/profile') return sendJson(res, 200, model.profile(from, to, date, undefined, undefined, undefined, opts));
      if (url.pathname === '/api/last') return sendJson(res, 200, model.lastJourney(from, to, date, t, opts), {}, req);
      return sendJson(res, 200, model.planMany(from, to, date, t, opts, 5), {}, req);
    }

    case '/api/delays':
      realtime.touch();
      return sendJson(res, 200, realtime.snapshot(), CORS, req);

    case '/api/tripstops':
      realtime.touch();
      return sendJson(res, 200, { id: q.get('id') || '', feedTime: realtime.feedTime, s: realtime.stopTimes.get(q.get('id') || '') || [] }, CORS, req);

    case '/api/hit':
      return sendJson(res, 200, {}, CORS, req);
    case '/api/hits':
      return sendJson(res, 200, { days: [] }, CORS, req);

    case '/api/alerts':
      realtime.touch();
      return sendJson(res, 200, { updated: realtime.updated, alerts: realtime.alerts }, CORS, req);

    case '/api/stats':
      return sendJson(res, 200, realtime.statsSummary(), CORS, req);

    case '/api/disruptions': {
      const date = q.get('date') || '';
      if (!parseYmd(date)) return sendJson(res, 400, { error: 'date ungueltig' });
      return sendJson(res, 200, model.disruptions(date), { 'Cache-Control': 'public, max-age=300' });
    }

    case '/api/reach': {
      const station = num(q.get('station'), 0, model.stops.length - 1);
      const date = q.get('date') || '';
      const t = num(q.get('t'), -DAY_LIMIT, DAY_LIMIT);
      const max = num(q.get('max'), 5, 90);
      if (station === null || !Number.isInteger(station) || !parseYmd(date) || t === null || max === null) {
        return sendJson(res, 400, { error: 'station, date, t, max ungueltig' });
      }
      return sendJson(res, 200, model.reach(station, date, t, max), {}, req);
    }

    case '/api/frequency': {
      const w = parseTimeWindow(q);
      if (!w) return sendJson(res, 400, { error: 'date, t0, t1 ungueltig (Fenster max. 6 h)' });
      return sendJson(res, 200, model.frequency(w.date, w.t0, w.t1), { 'Cache-Control': 'public, max-age=300' }, req);
    }

    case '/api/search':
      return sendJson(res, 200, model.search(q.get('q') || ''));

    case '/api/tripnum':
      if (!parseYmd(q.get('date') || '')) return sendJson(res, 400, { error: 'date ungueltig' });
      return sendJson(res, 200, model.tripsByNumber(q.get('q') || '', q.get('date'), Number(q.get('t')) || 0));

    case '/api/departures': {
      const station = num(q.get('station'), 0, model.stops.length - 1);
      const date = q.get('date') || '';
      const from = num(q.get('from'), -DAY_LIMIT, DAY_LIMIT);
      if (station === null || !Number.isInteger(station) || !parseYmd(date) || from === null) {
        return sendJson(res, 400, { error: 'station, date, from ungueltig' });
      }
      const limit = Math.min(Number(q.get('limit')) || 60, 200);
      return sendJson(res, 200, model.departures(station, date, from, from + 4 * 3600, limit));
    }

    default:
      return sendJson(res, 404, { error: 'unbekannter Endpunkt' });
  }
}

function serveStatic(url, res) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, SECURITY_HEADERS);
    return res.end('Bad request');
  }
  if (rel === '/') rel = '/index.html';
  for (const { prefix, dir } of STATIC_ROOTS) {
    if (!rel.startsWith(prefix)) continue;
    const sub = rel.slice(prefix.length);
    const file = path.resolve(dir, sub);
    if (file !== dir && !file.startsWith(dir + path.sep)) continue; // kein Ausbruch aus dem Ordner
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile()) continue;
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': prefix === '/' ? 'no-cache' : 'public, max-age=86400',
      ...SECURITY_HEADERS,
    });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404, SECURITY_HEADERS);
  res.end('Nicht gefunden');
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS });
    return res.end();
  }
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handleApi(url, req, res);
    return serveStatic(url, res);
  } catch (e) {
    console.error(e);
    res.writeHead(500, SECURITY_HEADERS);
    res.end('Serverfehler');
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} ist belegt. Anderen Port nutzen, z. B. PORT=${PORT + 1} npm run dev (Windows PowerShell: $env:PORT=${PORT + 1}; npm run dev)`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => console.log(`STRABFAHRT laeuft auf http://${HOST}:${PORT}`));
