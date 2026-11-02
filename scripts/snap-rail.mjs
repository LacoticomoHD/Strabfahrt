// Legt Tram- und Bahnfahrten auf OpenStreetMap-Gleise und schreibt data/shapes.json.
//
//   node scripts/snap-rail.mjs                 laedt Gleise per Overpass-API und rechnet
//   node scripts/snap-rail.mjs --osm datei.json  nutzt vorhandene Overpass-Antwort (out geom)
//
// Voraussetzung: data/model.json existiert (npm run build:data).
// Netzwerk: nur der Overpass-Abruf. Wird auf dem eigenen Rechner ausgefuehrt, nicht auf dem Server.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, matchSegment } from './lib/rail.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function loadOsm(bbox) {
  const file = arg('--osm');
  if (file) return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const [s, w, n, e] = bbox;
  const query = `[out:json][timeout:120];way["railway"~"^(rail|tram|light_rail)$"]["service"!~"yard|siding|spur|crossover"](${s},${w},${n},${e});out geom;`;
  console.log('Lade Gleise von', OVERPASS);
  const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: query }) });
  if (!res.ok) throw new Error(`Overpass: HTTP ${res.status}`);
  const json = await res.json();
  fs.writeFileSync(path.join(DATA, 'osm-rail.json'), JSON.stringify(json));
  return json;
}

const model = JSON.parse(fs.readFileSync(path.join(DATA, 'model.json'), 'utf8'));
const osm = await loadOsm(model.meta.bbox);
const ways = (osm.elements || [])
  .filter((el) => el.type === 'way' && Array.isArray(el.geometry))
  .map((el) => el.geometry.map((g) => [g.lat, g.lon]));
console.log('Gleisabschnitte:', ways.length);
if (!ways.length) throw new Error('Keine Gleisdaten erhalten');

const graph = buildGraph(ways);
console.log('Graph:', graph.coords.length, 'Knoten');

// Alle Haltepaare von Tram (0), Stadtbahn (1) und Bahn (2)
const pairs = new Set();
for (const [route, , stops] of model.patterns) {
  const type = model.routes[route][1];
  if (type !== 0 && type !== 1 && type !== 2) continue;
  for (let i = 1; i < stops.length; i++) pairs.add(`${stops[i - 1]},${stops[i]}`);
}
console.log('Haltepaare:', pairs.size);

const segs = {};
let matched = 0;
let missed = 0;
let n = 0;
for (const key of pairs) {
  const [a, b] = key.split(',').map(Number);
  const sa = model.stops[a];
  const sb = model.stops[b];
  const pts = matchSegment(graph, [sa[2], sa[3]], [sb[2], sb[3]]);
  if (pts) {
    segs[key] = pts.flatMap((p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]);
    matched++;
  } else {
    missed++;
  }
  if (++n % 500 === 0) console.log(`  ${n}/${pairs.size}`);
}

const out = { meta: { modelBuilt: model.meta.built, matched, missed }, segs };
const file = path.join(DATA, 'shapes.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`Fertig: ${matched} Abschnitte auf Gleisen, ${missed} bleiben Luftlinie (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`);
