import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normName } from '../scripts/build-data.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'build-data.mjs');

function writeFeed(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content.trim() + '\n');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strab-build-'));
const kvv = path.join(tmp, 'kvv');
const fv = path.join(tmp, 'fv');
const rv = path.join(tmp, 'rv');

writeFeed(kvv, {
  'routes.txt': `route_id,agency_id,route_short_name,route_long_name,route_type,route_color,route_text_color
r1,a,S1,,2,00975f,FFFFFF
r2,a,3,,0,aa5500,FFFFFF`,
  'stops.txt': `stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,platform_code
PHBF,Karlsruhe Hauptbahnhof,48.9933,8.4010,1,,
HBF1,Karlsruhe Hauptbahnhof,48.9934,8.4011,,PHBF,1
DUR,Durlach Bahnhof,49.0023,8.4628,,,`,
  'trips.txt': `trip_id,route_id,service_id,trip_headsign,wheelchair_accessible,bikes_allowed
t1,r1,sv,Durlach,1,2`,
  'stop_times.txt': `trip_id,arrival_time,departure_time,stop_id,stop_sequence
t1,08:00:00,08:00:00,HBF1,1
t1,08:10:00,08:10:00,DUR,2`,
  'calendar.txt': `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
sv,1,1,1,1,1,1,1,20261101,20261231`,
  'calendar_dates.txt': 'service_id,date,exception_type',
  'feed_info.txt': `feed_publisher_name,feed_version,feed_start_date,feed_end_date
KVV,v1,20261101,20261231`,
});

// Fernverkehr: Spalten in anderer Reihenfolge, keine Zielangabe in trips.txt, Endhalt weit ausserhalb des Gebiets
writeFeed(fv, {
  'routes.txt': `route_long_name,route_short_name,agency_id,route_type,route_id
,ICE 10,1,2,f1`,
  'stops.txt': `stop_name,parent_station,stop_id,stop_lat,stop_lon,location_type
Karlsruhe Hbf,,FPH,48.99335,8.40104,1
Karlsruhe Hbf,FPH,FH1,48.99340,8.40110,
Basel SBB,,BAS,47.5474,7.5897,`,
  'trips.txt': `route_id,service_id,trip_id
f1,fs,ft1`,
  'stop_times.txt': `trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign
ft1,09:00:00,09:00:00,FH1,0,Basel SBB
ft1,10:30:00,10:30:00,BAS,1,Basel SBB`,
  'calendar.txt': `monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date,service_id
1,1,1,1,1,1,1,20261101,20261130,fs`,
  'calendar_dates.txt': 'service_id,date,exception_type',
});

// Regionalverkehr: S1 gibt es schon im KVV-Feed (wird uebersprungen), RE9 ist neu
writeFeed(rv, {
  'routes.txt': `route_id,agency_id,route_short_name,route_long_name,route_type
q1,b,S1,,2
q2,b,RE9,,2`,
  'stops.txt': `stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station
RHBF,Karlsruhe Hbf,48.99336,8.40105,,
RDUR,Karlsruhe-Durlach,49.0022,8.4627,,`,
  'trips.txt': `trip_id,route_id,service_id,trip_headsign
u1,q1,qs,Doppelt
u2,q2,qs,Durlach`,
  'stop_times.txt': `trip_id,arrival_time,departure_time,stop_id,stop_sequence
u1,07:00:00,07:00:00,RHBF,1
u1,07:05:00,07:05:00,RDUR,2
u2,07:30:00,07:30:00,RHBF,1
u2,07:36:00,07:36:00,RDUR,2`,
  'calendar.txt': `service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
qs,1,1,1,1,1,1,1,20261101,20261130`,
  'calendar_dates.txt': 'service_id,date,exception_type',
});

const run = spawnSync(process.execPath, [script, '--feeds', 'kvv,fv,rv', '--raw', kvv, '--raw-fv', fv, '--raw-rv', rv], {
  env: { ...process.env, STRAB_DATA_DIR: path.join(tmp, 'out'), STRAB_MIN_TRIPS: '1' }, encoding: 'utf8',
});
const model = run.status === 0 ? JSON.parse(fs.readFileSync(path.join(tmp, 'out', 'model.json'), 'utf8')) : null;

test('Mehr-Feed-Bau laeuft durch', () => {
  assert.equal(run.status, 0, run.stderr);
  assert.ok(model);
});

test('Namen werden fuer den Vergleich vereinheitlicht', () => {
  assert.equal(normName('KA Hauptbahnhof (Vorplatz)'), 'hbf');
  assert.equal(normName('Karlsruhe Hbf'), 'hbf');
  assert.equal(normName('Karlsruhe-Durlach'), 'durlach');
  assert.notEqual(normName('Durlach Bahnhof'), normName('Karlsruhe-Durlach'));
});

test('Feeds, Gueltigkeit und Quellenangaben stehen in den Metadaten', () => {
  const ids = model.meta.feeds.map((f) => f.id);
  assert.deepEqual(ids, ['kvv', 'fv', 'rv']);
  assert.equal(model.meta.feedEnd, '20261231');
  const f = model.meta.feeds.find((x) => x.id === 'fv');
  assert.equal(f.end, '20261130');
  assert.match(f.attribution, /CC BY 4\.0/);
});

test('Fernverkehr bekommt den Typ 100, Doppelungen bei den S-Bahnen entfallen', () => {
  const byName = (n) => model.routes.filter((r) => r[0] === n);
  assert.equal(byName('ICE 10')[0][1], 100);
  assert.equal(byName('S1').length, 1, 'S1 nur aus dem KVV-Feed');
  assert.equal(byName('RE9').length, 1);
});

test('Zielangabe kommt aus stop_headsign, wenn trips.txt keine hat', () => {
  const ice = model.routes.findIndex((r) => r[0] === 'ICE 10');
  const pat = model.patterns.find((p) => p[0] === ice);
  assert.equal(pat[1], 'Basel SBB');
});

test('Gleiche Station aus anderem Feed haengt am KVV-Hauptbahnhof', () => {
  const idx = (id) => model.stops.findIndex((s) => s[0] === id);
  const kvvParent = idx('PHBF');
  assert.ok(kvvParent >= 0);
  assert.equal(model.stops[idx('de:FH1')][4], kvvParent, 'ICE-Halt gehoert zur KVV-Station');
  assert.equal(model.stops[idx('de:RHBF')][4], kvvParent, 'Regio-Halt gehoert zur KVV-Station');
  assert.equal(model.stops[idx('de:RDUR')][4], idx('DUR'), 'Karlsruhe-Durlach haengt am KVV-Bahnhof (Namensteil + Bahnhof, unter 300 m)');
});

test('Fahrten: KVV 1, Fern 1, Regio 1 (die doppelte S1 fehlt)', () => {
  assert.equal(model.trips.length, 3);
  assert.deepEqual(model.trips.map((t) => t[4]).sort(), ['fv:ft1', 'rv:u2', 't1']);
});
