import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Model } from '../server/model.mjs';
import { Realtime, tripDelay, stopTimesOf } from '../server/realtime.mjs';

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

test('Verspaetung: mehr als 3 Minuten zu frueh gilt als unglaubwuerdig', () => {
  const tu = { stopTimeUpdate: [{ departure: { delay: -437, time: 100 } }, { departure: { delay: 115, time: 9e9 } }] };
  assert.equal(tripDelay(tu, 300), null);
  assert.equal(tripDelay({ stopTimeUpdate: [{ departure: { delay: -120, time: 100 } }] }, 300), -120);
  assert.equal(tripDelay({ stopTimeUpdate: [], delay: -3600 }, 0), null);
  assert.deepEqual(stopTimesOf(tu), [0, null, 9e9 - 115, 115]);
});

test('Zuordnung: Stream-Fahrt trifft nur die KVV-Fahrt des richtigen Betriebstags', () => {
  rt.ingest({
    header: { timestamp: 1 },
    entity: [
      { id: '1', tripUpdate: { trip: { tripId: 's1', startDate: '20261102' }, stopTimeUpdate: [{ departure: { delay: 120 } }] } }, // Montag
      { id: '2', tripUpdate: { trip: { tripId: '777', startDate: '20261102', scheduleRelationship: 3 } } },
      { id: '3', tripUpdate: { trip: { tripId: 'fremd', startDate: '20261102' }, stopTimeUpdate: [{ departure: { delay: 5 } }] } },
      { id: 'a1', alert: { informedEntity: [{ routeId: 'r9' }], headerText: tr('Karlsruhe: Bauarbeiten Linie 3') } },
      { id: 'a6', alert: { informedEntity: [{ routeId: 'r9' }], headerText: tr('Neckarsulm - Stuttgart: Zugausfall') } }, // vom Rand nach außen
      { id: 'a5', alert: { informedEntity: [{ routeId: 'r9' }], headerText: tr('Hauptbahnhof - Vaihingen: S1 bis S6 nachts') } }, // Linie im Gebiet, Ort nicht
      { id: 'a2', alert: { informedEntity: [{ routeId: 'anderswo' }], headerText: tr('Woanders') } },
      { id: 'a3', alert: { informedEntity: [{ trip: { tripId: 's1', startDate: '20261102' } }], headerText: tr('Defektes Stellwerk') } },
      { id: 'a4', alert: { informedEntity: [{ trip: { tripId: 's1', startDate: '20261102' } }], headerText: tr('Stufenloses Fahrzeug, WLAN') } },
    ],
  });
  const s = rt.snapshot();
  assert.deepEqual(s.d, { 'k-werktag': 120 });
  assert.deepEqual(s.c, ['fv:777']);
  assert.deepEqual(rt.alerts.map((a) => a.header), ['Karlsruhe: Bauarbeiten Linie 3'], 'nur Meldungen mit Ort im KVV-Gebiet');
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

test('Feed ohne Uhrzeiten: Planzeit aus der Zuordnung (stop_sequence), Einträge ohne Zuordnung fallen weg', () => {
  const r = new Realtime(model, dir);
  r.map.seq = { s9: [0, 8 * 3600, 3, 8 * 3600 + 600] };
  const tu = { trip: { tripId: 's9', startDate: '20260105' }, stopTimeUpdate: [
    { stopSequence: 0, departure: { delay: 60, time: 0 } },
    { stopSequence: 3, arrival: { delay: 120, time: 0 } },
    { stopSequence: 7, arrival: { delay: 999, time: 0 } },
  ] };
  const nt = r.withTimes(tu);
  assert.equal(nt.stopTimeUpdate.length, 2);
  const day0 = r.dayStart('20260105');
  assert.equal(nt.stopTimeUpdate[0].departure.time, day0 + 8 * 3600 + 60);
  // Zwischen den Halten zählt der zuletzt erreichte (erster), nicht der letzte Eintrag
  assert.equal(tripDelay(nt, day0 + 8 * 3600 + 300), 60);
  // Ohne jede Zuordnung: Verspätung der ersten Angabe
  assert.equal(tripDelay(r.withTimes({ trip: { tripId: 'x' }, stopTimeUpdate: [{ stopSequence: 1, departure: { delay: 30, time: 0 } }, { stopSequence: 5, arrival: { delay: 400, time: 0 } }] }), 0), 30);
});

test('Ausgelassene Halte (SKIPPED) werden gesammelt, nicht als Zeit gewertet', () => {
  const r = new Realtime(model, dir);
  r.map.seq = { s9: [0, 8 * 3600, 3, 8 * 3600 + 600] };
  const nt = r.withTimes({ trip: { tripId: 's9', startDate: '20260105' }, stopTimeUpdate: [
    { stopSequence: 0, departure: { delay: 60, time: 0 } },
    { stopSequence: 3, scheduleRelationship: 1 },
  ] });
  assert.equal(nt.stopTimeUpdate.length, 1);
  assert.deepEqual(nt.skipped, [r.dayStart('20260105') + 8 * 3600 + 600]);
});

test('Fahrgast-Meldung: einmal je Absender, Bahn gilt als stehend', () => {
  const r = new Realtime(model, dir);
  const id = model.trips[0].id;
  assert.equal(r.addPassengerReport(id, 'a').n, 1);
  assert.equal(r.addPassengerReport(id, 'a').n, 1);
  assert.equal(r.addPassengerReport(id, 'b').n, 2);
  assert.ok(r.standing.has(id));
  assert.equal(r.addPassengerReport('gibt-es-nicht', 'a').ok, false);
});

test('stopSequence -> Position im Linienverlauf über die Planzeit (Zählung ab 0)', () => {
  const r = new Realtime(model, dir);
  r.map.seq = { s1: [0, 8 * 3600, 1, 8 * 3600 + 600] };
  assert.equal(r.seqPosition('k-werktag', 's1', '20260105', 1), 1);
  assert.equal(r.seqPosition('k-werktag', 's1', '20260105', 0), 0);
  // ohne Zuordnung: stopSequence direkt, außerhalb des Verlaufs -1
  assert.equal(r.seqPosition('k-werktag', 'unbekannt', '20260105', 1), 1);
  assert.equal(r.seqPosition('k-werktag', 'unbekannt', '20260105', 5), -1);
});
