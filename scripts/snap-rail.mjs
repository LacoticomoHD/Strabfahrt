// Legt Fahrten auf OpenStreetMap-Wege und schreibt data/shapes.json.
//   Tram und Bahn: Gleise (Overpass: railway=rail|tram|light_rail)
//   Busse:         Wege der Buslinien-Relationen (Overpass: route=bus), je Liniennummer
//
//   node scripts/snap-rail.mjs                  nutzt vorhandene Dateien in data/ oder laedt per Overpass
//   node scripts/snap-rail.mjs --refresh        laedt immer neu
//   node scripts/snap-rail.mjs --osm a.json --osm-bus b.json   eigene Overpass-Antworten (out geom)
//
// Voraussetzung: data/model.json existiert (npm run build:data).
// Netzwerk: nur der Overpass-Abruf. Faellt der Bus-Teil aus, bleiben Busse in Luftlinie.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, matchSegment, waysByRef } from './lib/rail.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const refresh = process.argv.includes('--refresh');

async function overpass(query, cacheName, argName) {
  const given = arg(argName);
  if (given) return JSON.parse(fs.readFileSync(path.resolve(given), 'utf8'));
  const cache = path.join(DATA, cacheName);
  if (!refresh && fs.existsSync(cache)) {
    console.log('Nutze vorhandene Datei', cacheName);
    return JSON.parse(fs.readFileSync(cache, 'utf8'));
  }
  console.log('Lade von', OVERPASS, '->', cacheName);
  let json = null;
  for (let attempt = 1; attempt <= 3 && !json; attempt++) {
    try {
      const res = await fetch(OVERPASS, {
        method: 'POST',
        headers: { 'User-Agent': 'STRABFAHRT/0.1 (Fahrplankarte Karlsruhe)' },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } catch (e) {
      console.warn(`Overpass, Versuch ${attempt}: ${e.message}`);
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, attempt * 20000));
    }
  }
  fs.writeFileSync(cache, JSON.stringify(json));
  return json;
}

const model = JSON.parse(fs.readFileSync(path.join(DATA, 'model.json'), 'utf8'));
const [S, W, N, E] = model.meta.bbox;
const segs = {};
const stats = { matched: 0, missed: 0, busMatched: 0, busMissed: 0 };
const round5 = (v) => Math.round(v * 1e5) / 1e5;
const flat = (pts) => pts.flatMap((p) => [round5(p[0]), round5(p[1])]);

// ---------- Tram und Bahn ----------
{
  const osm = await overpass(
    `[out:json][timeout:120];way["railway"~"^(rail|tram|light_rail)$"]["service"!~"yard|siding|spur|crossover"](${S},${W},${N},${E});out geom;`,
    'osm-rail.json', '--osm');
  const ways = (osm.elements || []).filter((el) => el.type === 'way' && Array.isArray(el.geometry)).map((el) => el.geometry.map((g) => [g.lat, g.lon]));
  console.log('Gleisabschnitte:', ways.length);
  if (!ways.length) throw new Error('Keine Gleisdaten erhalten');
  const graph = buildGraph(ways);
  console.log('Gleisgraph:', graph.coords.length, 'Knoten');

  const pairs = new Set();
  for (const [route, , stops] of model.patterns) {
    const type = model.routes[route][1];
    if (type !== 0 && type !== 1 && type !== 2) continue;
    for (let i = 1; i < stops.length; i++) pairs.add(`${stops[i - 1]},${stops[i]}`);
  }
  console.log('Haltepaare Schiene:', pairs.size);
  for (const key of pairs) {
    const [a, b] = key.split(',').map(Number);
    const pts = matchSegment(graph, [model.stops[a][2], model.stops[a][3]], [model.stops[b][2], model.stops[b][3]]);
    if (pts) { segs[key] = flat(pts); stats.matched++; } else stats.missed++;
  }
}

// ---------- Busse ----------
try {
  const osm = await overpass(`[out:json][timeout:240];rel["route"="bus"](${S},${W},${N},${E});out geom;`, 'osm-bus.json', '--osm-bus');
  const byRef = waysByRef(osm.elements);
  console.log('Buslinien mit Wegen:', byRef.size);
  const graphs = new Map();
  const graphFor = (ref) => {
    if (!graphs.has(ref)) graphs.set(ref, byRef.has(ref) ? buildGraph(byRef.get(ref)) : null);
    return graphs.get(ref);
  };
  const done = new Set();
  for (const [route, , stops] of model.patterns) {
    const type = model.routes[route][1];
    if (type !== 3 && type !== 11) continue;
    const graph = graphFor(model.routes[route][0]);
    for (let i = 1; i < stops.length; i++) {
      const key = `${stops[i - 1]},${stops[i]}`;
      if (segs[key] || done.has(key)) continue;
      if (!graph) { stats.busMissed++; done.add(key); continue; }
      const a = model.stops[stops[i - 1]];
      const b = model.stops[stops[i]];
      const pts = matchSegment(graph, [a[2], a[3]], [b[2], b[3]], { snapMeters: 80 });
      done.add(key);
      if (pts) { segs[key] = flat(pts); stats.busMatched++; } else stats.busMissed++;
    }
  }
} catch (e) {
  console.warn('Bus-Wege uebersprungen:', e.message);
}

const out = { meta: { modelBuilt: model.meta.built, ...stats }, segs };
const file = path.join(DATA, 'shapes.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`Fertig: Schiene ${stats.matched} auf Gleisen (${stats.missed} Luftlinie), Busse ${stats.busMatched} auf Strassen (${stats.busMissed} Luftlinie), ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
