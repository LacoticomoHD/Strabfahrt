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

// Mehrere Server: overpass-api.de lehnt grosse Abfragen nachts oft mit 502/504 ab
const SERVERS = [OVERPASS, 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

async function fetchOverpass(query) {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = SERVERS[attempt % SERVERS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': 'STRABFAHRT/0.1 (Fahrplankarte Karlsruhe)' },
        body: new URLSearchParams({ data: query }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
      console.warn(`Overpass ${new URL(url).host}, Versuch ${attempt + 1}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 5000 + attempt * 10000));
    }
  }
  throw last;
}

// sel: Overpass-Auswahl ohne Gebiet, boxes: Liste "s,w,n,e". Abfrage in kleinen Paketen, Ergebnis zusammengefuehrt.
async function overpass(sel, boxes, out, cacheName, argName) {
  const given = arg(argName);
  if (given) return JSON.parse(fs.readFileSync(path.resolve(given), 'utf8'));
  const cache = path.join(DATA, cacheName);
  if (!refresh && fs.existsSync(cache)) {
    console.log('Nutze vorhandene Datei', cacheName);
    return JSON.parse(fs.readFileSync(cache, 'utf8'));
  }
  const PACK = 3;
  const seen = new Map();
  for (let i = 0; i < boxes.length; i += PACK) {
    const part = boxes.slice(i, i + PACK);
    console.log(`Lade ${cacheName}: Paket ${i / PACK + 1} von ${Math.ceil(boxes.length / PACK)}`);
    const json = await fetchOverpass(`[out:json][timeout:180];(${part.map((b) => `${sel}(${b});`).join('')});${out}`);
    for (const el of json.elements || []) seen.set(`${el.type}${el.id}`, el);
  }
  const json = { elements: [...seen.values()] };
  fs.writeFileSync(cache, JSON.stringify(json));
  return json;
}

const model = JSON.parse(fs.readFileSync(path.join(DATA, 'model.json'), 'utf8'));
const [S, W, N, E] = model.meta.bbox;
const segs = {};
const stats = { matched: 0, missed: 0, busMatched: 0, busMissed: 0 };
const round5 = (v) => Math.round(v * 1e5) / 1e5;
const flat = (pts) => pts.flatMap((p) => [round5(p[0]), round5(p[1])]);

// Abfrage-Gebiet: Kacheln (rund 5 km) um die tatsaechlich befahrenen Abschnitte statt des ganzen Rechtecks.
// Das Rechteck reicht bis Heilbronn und Freudenstadt und schliesst Stuttgart ein, dessen Netz wir nicht brauchen.
const CELL = 0.05;
const areaSet = new Set(model.meta.area || []);
const AC = model.meta.areaCell || 0;
const inArea = (st) => st[2] >= S && st[2] <= N && st[3] >= W && st[3] <= E
  && (!AC || areaSet.has(`${Math.floor(st[2] / AC)},${Math.floor(st[3] / AC)}`));
function areaClause(types, pad = 1) {
  const cells = new Set();
  for (const [route, , stops] of model.patterns) {
    if (!types.has(model.routes[route][1])) continue;
    for (let i = 1; i < stops.length; i++) {
      const a = model.stops[stops[i - 1]];
      const b = model.stops[stops[i]];
      if (!inArea(a) || !inArea(b)) continue; // Abschnitte ueber den Rand werden in der App nicht gezeigt
      const y0 = Math.floor(Math.min(a[2], b[2]) / CELL) - pad; const y1 = Math.floor(Math.max(a[2], b[2]) / CELL) + pad;
      const x0 = Math.floor(Math.min(a[3], b[3]) / CELL) - pad; const x1 = Math.floor(Math.max(a[3], b[3]) / CELL) + pad;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cells.add(`${y},${x}`);
    }
  }
  // Je Zeile zusammenhaengende Kacheln zu einem Rechteck zusammenfassen
  const rows = new Map();
  for (const c of cells) { const [y, x] = c.split(',').map(Number); if (!rows.has(y)) rows.set(y, []); rows.get(y).push(x); }
  const boxes = [];
  for (const [y, xs] of rows) {
    xs.sort((p, q) => p - q);
    let start = xs[0]; let prev = xs[0];
    for (const x of [...xs.slice(1), Infinity]) {
      if (x === prev + 1) { prev = x; continue; }
      boxes.push([y * CELL, start * CELL, (y + 1) * CELL, (prev + 1) * CELL].map((v) => v.toFixed(3)).join(','));
      start = x; prev = x;
    }
  }
  console.log('Abfrage-Kacheln:', cells.size, 'in', boxes.length, 'Rechtecken');
  return boxes;
}

// ---------- Tram und Bahn ----------
{
  // Mit Rand ums Gebiet, damit Strecken am Rand verbunden bleiben. Weichen und Nebengleise gehoeren dazu
  // (sonst fehlt an Bahnhoefen oft die Verbindung zwischen Bahnsteig- und Streckengleis), sind aber teurer.
  const railBoxes = areaClause(new Set([0, 1, 2, 100]));
  const osm = await overpass('way["railway"~"^(rail|tram|light_rail)$"]', railBoxes, 'out tags geom;', 'osm-rail3.json', '--osm');
  const SIDE = /^(yard|siding|spur|crossover)$/;
  const ways = (osm.elements || []).filter((el) => el.type === 'way' && Array.isArray(el.geometry))
    .map((el) => ({ pts: el.geometry.map((g) => [g.lat, g.lon]), f: el.tags && SIDE.test(el.tags.service || '') ? 4 : 1 }));
  console.log('Gleisabschnitte:', ways.length);
  if (!ways.length) throw new Error('Keine Gleisdaten erhalten');
  const graph = buildGraph(ways);
  console.log('Gleisgraph:', graph.coords.length, 'Knoten');

  const pairs = new Set();
  for (const [route, , stops] of model.patterns) {
    const type = model.routes[route][1];
    if (type !== 0 && type !== 1 && type !== 2 && type !== 100) continue;
    for (let i = 1; i < stops.length; i++) pairs.add(`${stops[i - 1]},${stops[i]}`);
  }
  console.log('Haltepaare Schiene:', pairs.size);
  for (const key of pairs) {
    const [a, b] = key.split(',').map(Number);
    const pts = matchSegment(graph, [model.stops[a][2], model.stops[a][3]], [model.stops[b][2], model.stops[b][3]], { snapMeters: 200, detour: 2, slack: 600 });
    if (pts) { segs[key] = flat(pts); stats.matched++; } else stats.missed++;
  }
}

// ---------- Busse ----------
const overpassSync = {};
try {
  overpassSync.road = await overpass('way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|busway|road)$"]',
    areaClause(new Set([3, 11]), 0), 'out tags geom;', 'osm-road2.json', '--osm-road');
} catch (e) {
  console.warn('Strassennetz uebersprungen:', e.message);
}
// Buslinien-Relationen sind nur eine Verfeinerung und fuer Overpass sehr teuer: hoechstens 8 Minuten, sonst ohne
let busRel = { elements: [] };
try {
  busRel = await Promise.race([
    overpass('rel["route"="bus"]', areaClause(new Set([3, 11]), 0), 'out geom;', 'osm-bus2.json', '--osm-bus'),
    new Promise((_, rej) => setTimeout(() => rej(new Error('Zeitlimit')), 8 * 60 * 1000).unref()),
  ]);
} catch (e) {
  console.warn('Buslinien-Relationen uebersprungen, Busse nur ueber das Strassennetz:', e.message);
}
try {
  const byRef = waysByRef(busRel.elements);
  console.log('Buslinien mit Wegen:', byRef.size);
  const graphs = new Map();
  const graphFor = (ref) => {
    if (!graphs.has(ref)) graphs.set(ref, byRef.has(ref) ? buildGraph(byRef.get(ref)) : null);
    return graphs.get(ref);
  };
  // Rueckgriff: alle Bus-Wege zusammen, fuer Linien ohne eigene Relation (Nummer weicht in OSM ab)
  let allGraph = null;
  const unionGraph = () => {
    if (!allGraph) allGraph = buildGraph([...byRef.values()].flat());
    return allGraph;
  };
  // Letzter Rueckgriff: das Strassennetz (Linie ohne passende Relation in OSM)
  let roadGraph;
  const roads = () => {
    if (roadGraph !== undefined) return roadGraph;
    roadGraph = null;
    try {
      const osmRoad = overpassSync.road || null;
      if (osmRoad) {
        const SLOW = /^(residential|living_street|unclassified|service)$/;
        roadGraph = buildGraph((osmRoad.elements || []).filter((el) => el.type === 'way' && Array.isArray(el.geometry))
          .map((el) => ({ pts: el.geometry.map((g) => [g.lat, g.lon]), f: SLOW.test(el.tags && el.tags.highway) ? 1.4 : 1 })));
        console.log('Strassengraph:', roadGraph.coords.length, 'Knoten');
      }
    } catch (e) { console.warn('Strassennetz nicht nutzbar:', e.message); }
    return roadGraph;
  };
  const done = new Set();
  for (const [route, , stops] of model.patterns) {
    const type = model.routes[route][1];
    if (type !== 3 && type !== 11) continue;
    const graph = graphFor(model.routes[route][0]);
    for (let i = 1; i < stops.length; i++) {
      const key = `${stops[i - 1]},${stops[i]}`;
      if (segs[key] || done.has(key)) continue;
      const a = model.stops[stops[i - 1]];
      const b = model.stops[stops[i]];
      done.add(key);
      let pts = graph ? matchSegment(graph, [a[2], a[3]], [b[2], b[3]], { snapMeters: 80 }) : null;
      let viaUnion = false;
      if (!pts && byRef.size) {
        pts = matchSegment(unionGraph(), [a[2], a[3]], [b[2], b[3]], { snapMeters: 80, detour: 2.5, slack: 300 });
        viaUnion = !!pts;
      }
      if (!pts && roads()) {
        pts = matchSegment(roads(), [a[2], a[3]], [b[2], b[3]], { snapMeters: 120, detour: 2.2, slack: 500 });
        if (pts) stats.busViaRoad = (stats.busViaRoad || 0) + 1;
      }
      if (pts) {
        segs[key] = flat(pts);
        stats.busMatched++;
        if (viaUnion) stats.busViaUnion = (stats.busViaUnion || 0) + 1;
      } else stats.busMissed++;
    }
  }
} catch (e) {
  console.warn('Bus-Wege uebersprungen:', e.message);
}

const out = { meta: { modelBuilt: model.meta.built, ...stats }, segs };
const file = path.join(DATA, 'shapes.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`Fertig: Schiene ${stats.matched} auf Gleisen (${stats.missed} Luftlinie), Busse ${stats.busMatched} auf Strassen, davon ${stats.busViaUnion || 0} ueber das gesamte Busnetz und ${stats.busViaRoad || 0} ueber das Strassennetz (${stats.busMissed} Luftlinie), ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
process.exit(0); // offene Overpass-Abfragen nach Zeitlimit nicht abwarten
