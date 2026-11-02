import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Model } from '../server/model.mjs';
import { Realtime, tripDelay } from '../server/realtime.mjs';

const model = new Model({
  meta: { bbox: [0, 0, 1, 1], built: 'rt-test' },
  routes: [['3', 0, '', '', '1'], ['ICE 1', 100, '', '', 'fv:1']],
  stops: [['a', 'A', 0.1, 0.1, -1, '', 0, 0], ['b', 'B', 0.2, 0.2, -1, '', 0, 0]],
  patterns: [[0, 'B', [0, 1]], [1, 'B', [0, 1]]],
  profiles: [[0, 0, 600, 600]],
  services: [{ d: '1111100', s: '20260101', e: '20261231', add: [], rem: [] }, { d: '0000011', s: '20260101', e: '20261231', add: [], rem: [] }],
  trips: [[0, 0, 0, 8 * 3600, 'k-werktag', 0], [1, 0, 0, 8 * 3600, 'k-wochenende', 0], [0, 1, 0, 9 * 3600, 'fv:777', 0]],
});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strab-rt-'));
fs.writeFileSync(path.join(dir, 'rt-map.json'), JSON.stringify({ modelBuilt: 'rt-test', trips: { s1: ['k-werktag', 'k-wochenende'] }, routes: ['r9'], stops: ['p9'] }));
const rt = new Realtime(model, dir);
rt.enabled = true;

const tr = (s) => ({ translation: [{ text: s, language: 'de' }] });

test('Verspaetung: letzte erreichte Angabe zaehlt', () => {
  const tu = { stopTimeUpdate: [{ departure: { delay: 60, time: 100 } }, { arrival: { delay: 240, time: 200 } }, { arrival: { delay: 30, time: 9e9 } }] };
  assert.equal(tripDelay(tu, 300), 240);
  assert.equal(tripDelay(tu, 50), 60);
  assert.equal(tripDelay({ stopTimeUpdate: [] }, 0), null);
});

test('Zuordnung: Stream-Fahrt trifft nur die KVV-Fahrt des richtigen Betriebstags', () => {
  rt.ingest({
    header: { timestamp: 1 },
    entity: [
      { id: '1', tripUpdate: { trip: { tripId: 's1', startDate: '20261102' }, stopTimeUpdate: [{ departure: { delay: 120 } }] } }, // Montag
      { id: '2', tripUpdate: { trip: { tripId: '777', startDate: '20261102', scheduleRelationship: 3 } } },
      { id: '3', tripUpdate: { trip: { tripId: 'fremd', startDate: '20261102' }, stopTimeUpdate: [{ departure: { delay: 5 } }] } },
      { id: 'a1', alert: { informedEntity: [{ routeId: 'r9' }], headerText: tr('Bauarbeiten Linie 3') } },
      { id: 'a2', alert: { informedEntity: [{ routeId: 'anderswo' }], headerText: tr('Woanders') } },
      { id: 'a3', alert: { informedEntity: [{ trip: { tripId: 's1', startDate: '20261102' } }], headerText: tr('Defektes Stellwerk') } },
      { id: 'a4', alert: { informedEntity: [{ trip: { tripId: 's1', startDate: '20261102' } }], headerText: tr('Stufenloses Fahrzeug, WLAN') } },
    ],
  });
  const s = rt.snapshot();
  assert.deepEqual(s.d, { 'k-werktag': 120 });
  assert.deepEqual(s.c, ['fv:777']);
  assert.deepEqual(rt.alerts.map((a) => a.header), ['Bauarbeiten Linie 3']);
  assert.deepEqual(s.r, { 'k-werktag': 'Defektes Stellwerk' }, 'Grund an der Fahrt, Fahrzeugmerkmal verworfen');
});

test('Statistik: Fahrten je Linie, Ausfaelle getrennt', () => {
  rt.lastFlush = 0;
  rt.flushStats();
  const sum = rt.statsSummary();
  assert.equal(sum.days, 1);
  const raw = rt.stats['20261102'];
  assert.equal(raw['3|0'].n, 1);
  assert.equal(raw['ICE 1|100'].canceled, 1);
});
