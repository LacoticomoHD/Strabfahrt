// Liest GTFS-Feeds und schreibt ein kompaktes Modell fuer den Raum Karlsruhe (data/model.json).
//
// Feeds (alle frei nutzbar):
//   kvv  Karlsruher Verkehrsverbund: Tram, Bus, S-Bahn (CC0), Pflicht
//   fv   Fernverkehr (ICE, IC, EC ...), gtfs.de, Daten von DELFI e.V. (CC BY 4.0)
//   rv   Regionalverkehr (RE, RB, S-Bahnen ...), gtfs.de, Daten von DELFI e.V. (CC BY 4.0)
// Die gtfs.de-Feeds decken nur die naechsten 30 Tage ab und sollten taeglich neu gebaut werden.
// Faellt ein optionaler Feed aus, wird er uebersprungen. Fuer Gueterzuege gibt es keine offenen Fahrplandaten.
//
// Aufruf:
//   node scripts/build-data.mjs                     laedt alle Feeds und baut data/model.json
//   node scripts/build-data.mjs --feeds kvv         nur bestimmte Feeds (auch STRAB_FEEDS=kvv,fv)
//   node scripts/build-data.mjs --zip pfad.zip      KVV aus vorhandener ZIP (--zip-fv, --zip-rv analog)
//   node scripts/build-data.mjs --raw ordner        KVV aus entpacktem Ordner (--raw-fv, --raw-rv analog)
//
// Gebiet aendern: BBOX="sued,west,nord,ost" node scripts/build-data.mjs

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.STRAB_DATA_DIR ? path.resolve(process.env.STRAB_DATA_DIR) : path.join(ROOT, 'data');

const FEEDS = [
  {
    id: 'kvv', label: 'KVV (Tram, Bus, S-Bahn)', required: true, prefix: '',
    url: 'https://projekte.kvv-efa.de/GTFS/google_transit.zip',
    license: 'CC0', attribution: 'KVV (CC0)',
  },
  {
    id: 'fv', label: 'Fernverkehr', prefix: 'fv:', forceType: 100,
    url: 'https://download.gtfs.de/germany/fv_free/latest.zip',
    license: 'CC BY 4.0', attribution: 'Fernverkehr: gtfs.de, Daten von DELFI e.V. (CC BY 4.0)',
  },
  {
    id: 'rv', label: 'Regionalverkehr', prefix: 'rv:', skipDuplicateRail: true,
    url: 'https://download.gtfs.de/germany/rv_free/latest.zip',
    license: 'CC BY 4.0', attribution: 'Regionalverkehr: gtfs.de, Daten von DELFI e.V. (CC BY 4.0)',
  },
];
const FV_TYPE = 100; // interner Typ fuer Fernverkehr

const BBOX = (process.env.BBOX || '48.90,8.20,49.15,8.65').split(',').map(Number);
if (BBOX.length !== 4 || BBOX.some(Number.isNaN)) {
  throw new Error('BBOX muss "sued,west,nord,ost" sein');
}
const [S, W, N, E] = BBOX;
const inBox = (lat, lon) => lat >= S && lat <= N && lon >= W && lon <= E;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---------- Feed beschaffen ----------

async function obtain(feed) {
  const rawArg = arg(feed.id === 'kvv' ? '--raw' : `--raw-${feed.id}`);
  if (rawArg) return path.resolve(rawArg);

  const zipArg = arg(feed.id === 'kvv' ? '--zip' : `--zip-${feed.id}`);
  let zip = zipArg && path.resolve(zipArg);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!zip) {
    zip = path.join(DATA_DIR, `${feed.id}.zip`);
    const fresh = fs.existsSync(zip) && Date.now() - fs.statSync(zip).mtimeMs < 12 * 3600 * 1000;
    if (!fresh) {
      console.log(`[${feed.id}] Lade`, feed.url);
      const res = await fetch(feed.url);
      if (!res.ok) throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    }
  }
  const rawDir = path.join(DATA_DIR, 'raw', feed.id);
  fs.rmSync(rawDir, { recursive: true, force: true });
  fs.mkdirSync(rawDir, { recursive: true });
  console.log(`[${feed.id}] Entpacke`, zip);
  const cmd = process.platform === 'win32'
    ? spawnSync('tar', ['-xf', zip, '-C', rawDir])
    : spawnSync('unzip', ['-o', '-q', zip, '-d', rawDir]);
  if (cmd.status !== 0) {
    throw new Error(`Entpacken fehlgeschlagen. Bitte manuell entpacken und --raw${feed.id === 'kvv' ? '' : `-${feed.id}`} ordner nutzen.`);
  }
  return rawDir;
}

// ---------- CSV ----------

function parseLine(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i <= n) {
    if (line[i] === '"') {
      let v = '';
      i++;
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { v += '"'; i += 2; continue; }
          i++;
          break;
        }
        v += line[i++];
      }
      out.push(v);
      i++; // Komma
    } else {
      let j = line.indexOf(',', i);
      if (j < 0) j = n;
      out.push(line.slice(i, j));
      i = j + 1;
    }
  }
  return out;
}

async function readCsv(file, onRow) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let header = null;
  for await (const raw of rl) {
    if (!raw) continue;
    const line = header ? raw : raw.replace(/^﻿/, '');
    const cells = parseLine(line);
    if (!header) {
      header = Object.fromEntries(cells.map((c, i) => [c, i]));
      continue;
    }
    onRow((name) => cells[header[name]] ?? '');
  }
}

function toSec(t) {
  if (!t) return null;
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

// Erweiterte GTFS-Typen auf unsere Grundtypen abbilden
function normType(t, feed) {
  if (feed.forceType !== undefined) return feed.forceType;
  if (t >= 100 && t < 200) return [101, 102, 103, 105].includes(t) ? FV_TYPE : 2;
  if (t >= 200 && t < 300) return 3;
  if (t >= 400 && t < 500) return 1;
  if (t >= 700 && t < 800) return 3;
  if (t >= 900 && t < 1000) return 0;
  if (t >= 1000 && t < 1100) return 4;
  return t;
}

// Haltestellennamen vergleichbar machen, um Stationen verschiedener Feeds zusammenzufuehren
const SYNONYM = { hauptbahnhof: 'hbf', bahnhof: 'bf' };
const NOISE = new Set(['karlsruhe', 'ka', 'bei']);
export function normName(name) {
  return name.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-zäöüß0-9]+/g, ' ').trim().split(/\s+/)
    .filter((w) => w && !NOISE.has(w)).map((w) => SYNONYM[w] || w).sort().join(' ');
}

const metersBetween = (a, b) => Math.hypot((b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180) * 111320, (b.lat - a.lat) * 110540);

// ---------- Gemeinsamer Zustand ueber alle Feeds ----------

const shared = {
  routes: [],
  stopRows: new Map(), // (praefixierte) Haltestellen-ID -> Zeile
  services: new Map(), // (praefixierte) Service-ID -> Index
  svc: new Map(), // Service-Index -> Kalender
  patterns: new Map(),
  patternList: [],
  profiles: new Map(),
  profileList: [],
  usedStops: new Map(), // Haltestellen-ID -> Index
  stopList: [],
  tripOut: [],
  railNames: new Set(), // Kurznamen der Schienenlinien des Haupt-Feeds, gegen Doppelungen
  feedMeta: [],
};

const stopIndex = (id) => {
  let i = shared.usedStops.get(id);
  if (i === undefined) {
    i = shared.stopList.length;
    shared.usedStops.set(id, i);
    shared.stopList.push(id);
  }
  return i;
};

async function processFeed(feed, raw) {
  const f = (n) => path.join(raw, n);
  const px = feed.prefix;
  const stats = { routes: 0, skippedRoutes: 0, kept: 0, skipped: 0 };

  // Linien
  const routeIdx = new Map();
  await readCsv(f('routes.txt'), (g) => {
    const short = g('route_short_name') || g('route_long_name');
    const type = normType(Number(g('route_type')), feed);
    if (feed.skipDuplicateRail && type === 2 && shared.railNames.has(short)) { stats.skippedRoutes++; return; }
    routeIdx.set(g('route_id'), shared.routes.length);
    shared.routes.push([short, type, g('route_color'), g('route_text_color'), px + g('agency_id')]);
    if (feed.required && type === 2) shared.railNames.add(short);
    stats.routes++;
  });

  // Haltestellen
  await readCsv(f('stops.txt'), (g) => {
    const parent = g('parent_station');
    shared.stopRows.set(px + g('stop_id'), {
      id: px + g('stop_id'), feed: feed.id, name: g('stop_name'), lat: Number(g('stop_lat')), lon: Number(g('stop_lon')),
      parent: parent ? px + parent : '', platform: g('platform_code'), type: g('location_type'),
      wb: Number(g('wheelchair_boarding')) || 0, // 0 keine Angabe (erbt von der Station), 1 stufenfrei, 2 nicht stufenfrei
    });
  });

  // Fahrten
  const trips = new Map();
  await readCsv(f('trips.txt'), (g) => {
    const wc = Number(g('wheelchair_accessible')) || 0; // 0 unbekannt, 1 ja, 2 nein
    const bk = Number(g('bikes_allowed')) || 0;
    trips.set(g('trip_id'), { route: g('route_id'), service: px + g('service_id'), headsign: g('trip_headsign'), flags: (wc & 3) | ((bk & 3) << 2) });
  });
  console.log(`[${feed.id}] Linien: ${stats.routes}${stats.skippedRoutes ? ` (${stats.skippedRoutes} uebersprungen, schon im KVV-Feed)` : ''}, Fahrten im Feed: ${trips.size}`);

  // Fahrzeiten, gruppiert pro Fahrt
  const finished = new Set();
  let currentId = null;
  let rows = [];

  function flush() {
    if (currentId === null) return;
    const trip = trips.get(currentId);
    const id = currentId;
    const list = rows;
    currentId = null;
    rows = [];
    if (!trip || !routeIdx.has(trip.route) || list.length < 2) { stats.skipped++; return; }
    list.sort((a, b) => a.seq - b.seq);

    // fehlende Zeiten auffuellen
    let prev = null;
    for (const r of list) {
      if (r.arr === null) r.arr = r.dep ?? prev;
      if (r.dep === null) r.dep = r.arr;
      if (r.arr === null) { stats.skipped++; return; }
      prev = r.dep;
    }

    // Abschnitt im Gebiet bestimmen (plus je ein Halt davor und danach)
    let first = -1;
    let last = -1;
    list.forEach((r, i) => {
      const s = shared.stopRows.get(px + r.stop);
      if (s && inBox(s.lat, s.lon)) {
        if (first < 0) first = i;
        last = i;
      }
    });
    if (first < 0) { stats.skipped++; return; }
    const seg = list.slice(Math.max(0, first - 1), Math.min(list.length, last + 2));
    if (seg.length < 2) { stats.skipped++; return; }
    if (seg.some((r) => !shared.stopRows.has(px + r.stop))) { stats.skipped++; return; }

    const start = seg[0].arr;
    const stops = seg.map((r) => stopIndex(px + r.stop));
    const rel = [];
    for (const r of seg) rel.push(r.arr - start, r.dep - start);

    // Ohne Zielangabe im Feed wird der echte Endhalt der ungekuerzten Fahrt genommen
    const dest = trip.headsign || list.find((r) => r.headsign)?.headsign || shared.stopRows.get(px + list[list.length - 1].stop)?.name || '';
    const rIdx = routeIdx.get(trip.route);
    const pKey = `${rIdx}|${dest}|${stops.join(',')}`;
    let pIdx = shared.patterns.get(pKey);
    if (pIdx === undefined) {
      pIdx = shared.patternList.length;
      shared.patterns.set(pKey, pIdx);
      shared.patternList.push([rIdx, dest, stops]);
    }
    const tKey = rel.join(',');
    let tIdx = shared.profiles.get(tKey);
    if (tIdx === undefined) {
      tIdx = shared.profileList.length;
      shared.profiles.set(tKey, tIdx);
      shared.profileList.push(rel);
    }
    let sIdx = shared.services.get(trip.service);
    if (sIdx === undefined) {
      sIdx = shared.services.size;
      shared.services.set(trip.service, sIdx);
    }
    shared.tripOut.push([sIdx, pIdx, tIdx, start, px + id, trip.flags]);
    stats.kept++;
  }

  let lineCount = 0;
  await readCsv(f('stop_times.txt'), (g) => {
    const id = g('trip_id');
    if (id !== currentId) {
      flush();
      if (finished.has(id)) throw new Error(`[${feed.id}] stop_times.txt ist nicht nach trip_id gruppiert: ${id}`);
      finished.add(id);
      currentId = id;
    }
    rows.push({ stop: g('stop_id'), seq: Number(g('stop_sequence')), arr: toSec(g('arrival_time')), dep: toSec(g('departure_time')), headsign: g('stop_headsign') });
    if (++lineCount % 1000000 === 0) console.log(`  [${feed.id}] Zeilen:`, lineCount);
  });
  flush();
  console.log(`[${feed.id}] Fahrten uebernommen: ${stats.kept}, verworfen: ${stats.skipped}`);

  // Kalender
  let minStart = '99999999';
  let maxEnd = '00000000';
  await readCsv(f('calendar.txt'), (g) => {
    if (g('start_date') && g('start_date') < minStart) minStart = g('start_date');
    if (g('end_date') && g('end_date') > maxEnd) maxEnd = g('end_date');
    const i = shared.services.get(px + g('service_id'));
    if (i === undefined) return;
    shared.svc.set(i, {
      d: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((n) => g(n)).join(''),
      s: g('start_date'), e: g('end_date'), add: [], rem: [],
    });
  });
  await readCsv(f('calendar_dates.txt'), (g) => {
    const date = g('date');
    if (g('exception_type') === '1' && date > maxEnd) maxEnd = date;
    const i = shared.services.get(px + g('service_id'));
    if (i === undefined) return;
    if (!shared.svc.has(i)) shared.svc.set(i, { d: '0000000', s: '99999999', e: '00000000', add: [], rem: [] });
    (g('exception_type') === '1' ? shared.svc.get(i).add : shared.svc.get(i).rem).push(date);
  });

  // Gueltigkeit: bevorzugt aus feed_info, sonst aus dem Kalender
  let start = minStart === '99999999' ? '' : minStart;
  let end = maxEnd === '00000000' ? '' : maxEnd;
  let version = '';
  await readCsv(f('feed_info.txt'), (g) => {
    version = g('feed_version');
    if (g('feed_start_date')) start = g('feed_start_date');
    if (g('feed_end_date')) end = g('feed_end_date');
  });
  shared.feedMeta.push({ id: feed.id, label: feed.label, license: feed.license, attribution: feed.attribution, start, end, version, trips: stats.kept });
}

// ---------- Hauptprogramm ----------

async function main() {
  const wanted = (arg('--feeds') || process.env.STRAB_FEEDS || FEEDS.map((x) => x.id).join(',')).split(',').map((x) => x.trim());
  const selected = FEEDS.filter((x) => x.required || wanted.includes(x.id));
  for (const feed of selected) {
    let raw;
    try {
      raw = await obtain(feed);
      await processFeed(feed, raw);
    } catch (e) {
      if (feed.required) throw e;
      console.warn(`[${feed.id}] uebersprungen: ${e.message}`);
    }
  }

  // Haltestellen ausgeben: erst alle benutzten (Indizes gehoeren zu den Mustern), dann Elternstationen
  const outStops = [];
  const outIdx = new Map();
  const addStop = (id) => {
    if (outIdx.has(id)) return outIdx.get(id);
    const s = shared.stopRows.get(id);
    if (!s) return -1;
    const i = outStops.length;
    outIdx.set(id, i);
    outStops.push([s.id, s.name, s.lat, s.lon, -1, s.platform, s.type === '1' ? 1 : 0, s.wb]);
    return i;
  };
  shared.stopList.forEach((id) => addStop(id));
  const missing = shared.stopList.filter((id) => !shared.stopRows.has(id));
  if (missing.length) throw new Error('Unbekannte Haltestellen in stop_times: ' + missing.slice(0, 5).join(', '));
  const base = outStops.length;

  // Haupt-Feed: Eltern uebernehmen
  for (let i = 0; i < base; i++) {
    const row = shared.stopRows.get(outStops[i][0]);
    if (row.feed === 'kvv' && row.parent && shared.stopRows.has(row.parent)) outStops[i][4] = addStop(row.parent);
  }
  // Stationen des Haupt-Feeds nach Namen ordnen (Stationen selbst und Halte ohne Eltern)
  const primary = new Map();
  for (let i = 0; i < outStops.length; i++) {
    const row = shared.stopRows.get(outStops[i][0]);
    if (row.feed !== 'kvv') continue;
    if (row.type !== '1' && outStops[i][4] >= 0) continue; // Kind einer Station
    const key = normName(row.name);
    if (!primary.has(key)) primary.set(key, new Map());
    primary.get(key).set(row.id, row);
  }
  // Andere Feeds: gleiche Station (gleicher Name, hoechstens 250 m) beim Haupt-Feed einhaengen, sonst eigene Eltern
  let merged = 0;
  const mergeCache = new Map();
  for (let i = 0; i < base; i++) {
    const row = shared.stopRows.get(outStops[i][0]);
    if (row.feed === 'kvv') continue;
    const station = row.parent && shared.stopRows.has(row.parent) ? shared.stopRows.get(row.parent) : row;
    let target = mergeCache.get(station.id);
    if (target === undefined) {
      target = null;
      let bestD = 250;
      for (const cand of (primary.get(normName(station.name)) || new Map()).values()) {
        const d = metersBetween(station, cand);
        if (d <= bestD) { bestD = d; target = cand.id; }
      }
      mergeCache.set(station.id, target);
      if (target) merged++;
    }
    if (target) outStops[i][4] = addStop(target);
    else if (row.parent && shared.stopRows.has(row.parent)) outStops[i][4] = addStop(row.parent);
  }
  console.log(`Haltestellen: ${base} Halte, ${outStops.length - base} Elternstationen, ${merged} Stationen anderer Feeds mit dem KVV-Feed zusammengefuehrt`);

  // Stufenfreiheit: ohne eigene Angabe gilt die der Station
  for (let i = 0; i < outStops.length; i++) {
    if (outStops[i][7] === 0 && outStops[i][4] >= 0) outStops[i][7] = outStops[outStops[i][4]][7] || 0;
  }

  // Kalender
  const svcOut = new Array(shared.services.size);
  for (let i = 0; i < svcOut.length; i++) svcOut[i] = shared.svc.get(i) || { d: '0000000', s: '99999999', e: '00000000', add: [], rem: [] };

  const primaryMeta = shared.feedMeta.find((m) => m.id === 'kvv') || {};
  const model = {
    meta: {
      bbox: BBOX, feedVersion: primaryMeta.version || '', feedStart: primaryMeta.start || '', feedEnd: primaryMeta.end || '',
      feeds: shared.feedMeta, built: new Date().toISOString(), source: FEEDS[0].url,
    },
    routes: shared.routes, stops: outStops, patterns: shared.patternList, profiles: shared.profileList, services: svcOut, trips: shared.tripOut,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const outFile = path.join(DATA_DIR, 'model.json');
  fs.writeFileSync(outFile, JSON.stringify(model));
  const mb = (fs.statSync(outFile).size / 1048576).toFixed(1);
  console.log(`Geschrieben: ${outFile} (${mb} MB), Linien: ${shared.routes.length}, Muster: ${shared.patternList.length}, Zeitprofile: ${shared.profileList.length}, Fahrten: ${shared.tripOut.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
