// Liest den KVV-GTFS-Feed (CC0) und schreibt ein kompaktes Modell fuer den Raum Karlsruhe.
//
// Aufruf:
//   node scripts/build-data.mjs                 laedt den Feed und baut data/model.json
//   node scripts/build-data.mjs --zip pfad.zip  nutzt eine vorhandene ZIP-Datei
//   node scripts/build-data.mjs --raw ordner    nutzt einen schon entpackten Feed
//
// Gebiet aendern: BBOX="sued,west,nord,ost" node scripts/build-data.mjs

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const FEED_URL = 'https://projekte.kvv-efa.de/GTFS/google_transit.zip';

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

async function prepareRaw() {
  const rawArg = arg('--raw');
  if (rawArg) return path.resolve(rawArg);

  const rawDir = path.join(DATA_DIR, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  let zip = arg('--zip') && path.resolve(arg('--zip'));
  if (!zip) {
    zip = path.join(DATA_DIR, 'google_transit.zip');
    if (!fs.existsSync(zip)) {
      console.log('Lade Feed:', FEED_URL);
      const res = await fetch(FEED_URL);
      if (!res.ok) throw new Error(`Download fehlgeschlagen: HTTP ${res.status}`);
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    }
  }
  console.log('Entpacke', zip);
  const cmd = process.platform === 'win32'
    ? spawnSync('tar', ['-xf', zip, '-C', rawDir])
    : spawnSync('unzip', ['-o', '-q', zip, '-d', rawDir]);
  if (cmd.status !== 0) {
    throw new Error('Entpacken fehlgeschlagen. Bitte manuell nach data/raw entpacken und --raw data/raw nutzen.');
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

// ---------- Aufbau ----------

async function main() {
  const raw = await prepareRaw();
  const f = (n) => path.join(raw, n);

  // Linien
  const routes = [];
  const routeIdx = new Map();
  await readCsv(f('routes.txt'), (g) => {
    routeIdx.set(g('route_id'), routes.length);
    routes.push([g('route_short_name') || g('route_long_name'), Number(g('route_type')), g('route_color'), g('route_text_color'), g('agency_id')]);
  });
  console.log('Linien:', routes.length);

  // Haltestellen
  const stopRows = new Map();
  await readCsv(f('stops.txt'), (g) => {
    stopRows.set(g('stop_id'), {
      id: g('stop_id'), name: g('stop_name'), lat: Number(g('stop_lat')), lon: Number(g('stop_lon')),
      parent: g('parent_station'), platform: g('platform_code'), type: g('location_type'),
    });
  });

  // Fahrten
  const trips = new Map();
  await readCsv(f('trips.txt'), (g) => {
    const wc = Number(g('wheelchair_accessible')) || 0; // 0 unbekannt, 1 ja, 2 nein
    const bk = Number(g('bikes_allowed')) || 0;
    trips.set(g('trip_id'), { route: g('route_id'), service: g('service_id'), headsign: g('trip_headsign'), flags: (wc & 3) | ((bk & 3) << 2) });
  });
  console.log('Fahrten im Feed:', trips.size);

  // Fahrzeiten, gruppiert pro Fahrt
  const services = new Map(); // service_id -> index
  const patterns = new Map(); // key -> index
  const patternList = [];
  const profiles = new Map();
  const profileList = [];
  const usedStops = new Map(); // stop_id -> index
  const stopList = [];
  const tripOut = [];
  const finished = new Set();

  const stopIndex = (id) => {
    let i = usedStops.get(id);
    if (i === undefined) {
      i = stopList.length;
      usedStops.set(id, i);
      stopList.push(id);
    }
    return i;
  };

  let currentId = null;
  let rows = [];
  let kept = 0;
  let skipped = 0;

  function flush() {
    if (currentId === null) return;
    const trip = trips.get(currentId);
    const id = currentId;
    const list = rows;
    currentId = null;
    rows = [];
    if (!trip || !routeIdx.has(trip.route) || list.length < 2) { skipped++; return; }
    list.sort((a, b) => a.seq - b.seq);

    // fehlende Zeiten auffuellen
    let prev = null;
    for (const r of list) {
      if (r.arr === null) r.arr = r.dep ?? prev;
      if (r.dep === null) r.dep = r.arr;
      if (r.arr === null) { skipped++; return; }
      prev = r.dep;
    }

    // Abschnitt im Gebiet bestimmen (plus je ein Halt davor und danach)
    let first = -1;
    let last = -1;
    list.forEach((r, i) => {
      const s = stopRows.get(r.stop);
      if (s && inBox(s.lat, s.lon)) {
        if (first < 0) first = i;
        last = i;
      }
    });
    if (first < 0) { skipped++; return; }
    const seg = list.slice(Math.max(0, first - 1), Math.min(list.length, last + 2));
    if (seg.length < 2) { skipped++; return; }

    const start = seg[0].arr;
    const stops = seg.map((r) => stopIndex(r.stop));
    const rel = [];
    for (const r of seg) rel.push(r.arr - start, r.dep - start);

    // Ohne Zielangabe im Feed wird der echte Endhalt der ungekuerzten Fahrt genommen
    const dest = trip.headsign || stopRows.get(list[list.length - 1].stop)?.name || '';
    const rIdx = routeIdx.get(trip.route);
    const pKey = `${rIdx}|${dest}|${stops.join(',')}`;
    let pIdx = patterns.get(pKey);
    if (pIdx === undefined) {
      pIdx = patternList.length;
      patterns.set(pKey, pIdx);
      patternList.push([rIdx, dest, stops]);
    }
    const tKey = rel.join(',');
    let tIdx = profiles.get(tKey);
    if (tIdx === undefined) {
      tIdx = profileList.length;
      profiles.set(tKey, tIdx);
      profileList.push(rel);
    }
    let sIdx = services.get(trip.service);
    if (sIdx === undefined) {
      sIdx = services.size;
      services.set(trip.service, sIdx);
    }
    tripOut.push([sIdx, pIdx, tIdx, start, id, trip.flags]);
    kept++;
  }

  let lineCount = 0;
  await readCsv(f('stop_times.txt'), (g) => {
    const id = g('trip_id');
    if (id !== currentId) {
      flush();
      if (finished.has(id)) throw new Error('stop_times.txt ist nicht nach trip_id gruppiert: ' + id);
      finished.add(id);
      currentId = id;
    }
    rows.push({ stop: g('stop_id'), seq: Number(g('stop_sequence')), arr: toSec(g('arrival_time')), dep: toSec(g('departure_time')) });
    if (++lineCount % 500000 === 0) console.log('  Zeilen:', lineCount);
  });
  flush();
  console.log(`Fahrten uebernommen: ${kept}, verworfen: ${skipped}`);

  // Haltestellen mit Elternstationen
  const outStops = [];
  const outIdx = new Map();
  const addStop = (id) => {
    if (outIdx.has(id)) return outIdx.get(id);
    const s = stopRows.get(id);
    if (!s) return -1;
    const i = outStops.length;
    outIdx.set(id, i);
    outStops.push([s.id, s.name, s.lat, s.lon, -1, s.platform, s.type === '1' ? 1 : 0]);
    return i;
  };
  // Reihenfolge der Indizes aus stopList beibehalten, damit Muster gueltig bleiben
  stopList.forEach((id) => addStop(id));
  const missing = stopList.filter((id) => !stopRows.has(id));
  if (missing.length) throw new Error('Unbekannte Haltestellen in stop_times: ' + missing.slice(0, 5).join(', '));
  const base = outStops.length;
  for (let i = 0; i < base; i++) {
    const parent = stopRows.get(outStops[i][0]).parent;
    if (parent && stopRows.has(parent)) outStops[i][4] = addStop(parent);
  }
  console.log(`Haltestellen: ${base} Halte, ${outStops.length - base} Elternstationen`);

  // Kalender
  const svcOut = new Array(services.size);
  await readCsv(f('calendar.txt'), (g) => {
    const i = services.get(g('service_id'));
    if (i === undefined) return;
    svcOut[i] = {
      d: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((n) => g(n)).join(''),
      s: g('start_date'), e: g('end_date'), add: [], rem: [],
    };
  });
  await readCsv(f('calendar_dates.txt'), (g) => {
    const i = services.get(g('service_id'));
    if (i === undefined) return;
    if (!svcOut[i]) svcOut[i] = { d: '0000000', s: '99999999', e: '00000000', add: [], rem: [] };
    (g('exception_type') === '1' ? svcOut[i].add : svcOut[i].rem).push(g('date'));
  });
  for (let i = 0; i < svcOut.length; i++) {
    if (!svcOut[i]) svcOut[i] = { d: '0000000', s: '99999999', e: '00000000', add: [], rem: [] };
  }

  let feedVersion = '';
  try {
    const fi = fs.readFileSync(f('feed_info.txt'), 'utf8').split(/\r?\n/);
    feedVersion = parseLine(fi[1])[5] || '';
  } catch { /* optional */ }

  const model = {
    meta: { bbox: BBOX, feedVersion, built: new Date().toISOString(), source: FEED_URL },
    routes, stops: outStops, patterns: patternList, profiles: profileList, services: svcOut, trips: tripOut,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const outFile = path.join(DATA_DIR, 'model.json');
  fs.writeFileSync(outFile, JSON.stringify(model));
  const mb = (fs.statSync(outFile).size / 1048576).toFixed(1);
  console.log(`Geschrieben: ${outFile} (${mb} MB), Muster: ${patternList.length}, Zeitprofile: ${profileList.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
