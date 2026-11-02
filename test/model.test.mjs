import test from 'node:test';
import assert from 'node:assert/strict';
import { Model, parseYmd, addDays } from '../server/model.mjs';

// Kleines Modell: eine Linie A -> B -> C, werktags (Mo-Fr), Fahrt startet 23:50 und endet nach Mitternacht.
const fixture = {
  meta: { bbox: [0, 0, 1, 1], feedVersion: 'test', built: 'x', source: 'x' },
  routes: [['1', 0, 'ff0000', 'ffffff', '02']],
  stops: [
    ['a', 'Alpha', 0.1, 0.1, -1, '1', 0],
    ['b', 'Beta', 0.2, 0.2, -1, '', 0],
    ['c', 'Gamma Hbf', 0.3, 0.3, -1, '', 0],
  ],
  patterns: [[0, 'Gamma', [0, 1, 2]]],
  profiles: [[0, 0, 600, 660, 1200, 1200]],
  services: [{ d: '1111100', s: '20260101', e: '20261231', add: ['20261107'], rem: ['20261103'] }],
  trips: [[0, 0, 0, 23 * 3600 + 50 * 60, 't1']],
};

const model = new Model(fixture);

test('Datum wird geprueft', () => {
  assert.ok(parseYmd('20261102'));
  assert.equal(parseYmd('20261302'), null);
  assert.equal(parseYmd('2026-11-02'), null);
  assert.equal(addDays('20261231', 1), '20270101');
});

test('Kalender: Wochentag, Ausnahme entfaellt, Zusatztag', () => {
  assert.ok(model.activeServices('20261102').has(0)); // Montag
  assert.ok(!model.activeServices('20261103').has(0)); // entfallen
  assert.ok(!model.activeServices('20261108').has(0)); // Sonntag
  assert.ok(model.activeServices('20261107').has(0)); // Samstag, Zusatz
});

test('Fahrt ueber Mitternacht erscheint am Folgetag mit negativer Zeit', () => {
  const r = model.vehicles('20261103', 0, 600, null, null); // Di 00:00-00:10, Fahrt startete Mo 23:50
  assert.equal(r.trips.length, 1);
  assert.equal(r.trips[0][2], 23 * 3600 + 50 * 60 - 86400);
});

test('Fahrt ausserhalb des Zeitfensters wird nicht geliefert', () => {
  const r = model.vehicles('20261102', 8 * 3600, 9 * 3600, null, null);
  assert.equal(r.trips.length, 0);
});

test('Bounding-Box-Filter', () => {
  const inside = model.vehicles('20261102', 23 * 3600, 24 * 3600, [0, 0, 1, 1], null);
  const outside = model.vehicles('20261102', 23 * 3600, 24 * 3600, [5, 5, 6, 6], null);
  assert.equal(inside.trips.length, 1);
  assert.equal(outside.trips.length, 0);
});

test('Abfahrten: Endhalt hat keine Abfahrt', () => {
  const t = 23 * 3600;
  assert.equal(model.departures(0, '20261102', t, t + 3600).length, 1);
  assert.equal(model.departures(2, '20261102', t, t + 4 * 3600).length, 0);
});

test('Suche: Teilwoerter und Kurzform Hbf', () => {
  assert.equal(model.search('Alp')[0].name, 'Alpha');
  assert.equal(model.search('gamma hbf')[0].name, 'Gamma Hbf');
  assert.equal(model.search('gamma hauptbahnhof').length, 0);
  assert.equal(model.search('x').length, 0);
});

test('Netz: jedes Haltepaar genau einmal, Richtung egal', () => {
  const net = model.network();
  assert.equal(net.length, 2);
  assert.ok(net.every((e) => e[2] === 0)); // Tram
});

// ---------- Verbindungssuche ----------

const planFixture = {
  meta: { bbox: [0, 0, 1, 1], feedVersion: 't', built: 'p', source: 'x' },
  routes: [['A', 0, 'ff0000', 'ffffff', '1'], ['B', 0, '0000ff', 'ffffff', '1'], ['D', 3, '00ff00', '000000', '1']],
  stops: [
    ['s1', 'Start', 0.10, 0.10, -1, '', 0],
    ['s2', 'Mitte', 0.20, 0.20, -1, '', 0],
    ['s3', 'Ziel', 0.30, 0.30, -1, '', 0],
  ],
  patterns: [[0, 'Mitte', [0, 1]], [1, 'Ziel', [1, 2]], [2, 'Ziel direkt', [0, 2]]],
  profiles: [[0, 0, 600, 600], [0, 0, 3600, 3600]],
  services: [{ d: '1111111', s: '20260101', e: '20261231', add: [], rem: [] }],
  trips: [
    [0, 0, 0, 8 * 3600, 'a1', 0], // Start 8:00 -> Mitte 8:10
    [0, 1, 0, 8 * 3600 + 11 * 60, 'b0', 0], // Mitte 8:11, zu knapp (Puffer 2 min)
    [0, 1, 0, 8 * 3600 + 15 * 60, 'b1', 0], // Mitte 8:15 -> Ziel 8:25
    [0, 2, 1, 8 * 3600, 'd1', 0], // direkt 8:00 -> 9:00
  ],
};
const planModel = new Model(planFixture);

test('Verbindungssuche: Umstieg mit Puffer, zu knappe Fahrt wird uebersprungen', () => {
  const r = planModel.plan(0, 2, '20261102', 7 * 3600 + 55 * 60);
  const withTransfer = r.find((j) => j.transfers === 1);
  assert.ok(withTransfer, 'Verbindung mit einem Umstieg erwartet');
  assert.equal(withTransfer.arr, 8 * 3600 + 25 * 60);
  const second = withTransfer.legs.filter((l) => l.type === 'ride')[1];
  assert.equal(second.trip, 'b1');
});

test('Verbindungssuche: Direktfahrt ist ebenfalls dabei, mit spaeterer Ankunft', () => {
  const r = planModel.plan(0, 2, '20261102', 7 * 3600 + 55 * 60);
  const direct = r.find((j) => j.transfers === 0);
  assert.ok(direct);
  assert.equal(direct.arr, 9 * 3600);
});

test('Verbindungssuche: nichts, wenn Start gleich Ziel oder keine Fahrt mehr kommt', () => {
  assert.deepEqual(planModel.plan(0, 0, '20261102', 8 * 3600), []);
  assert.deepEqual(planModel.plan(0, 2, '20261102', 12 * 3600), []);
});

test('Linienansicht: Muster je Fahrtrichtung', () => {
  const l = planModel.line('B');
  assert.equal(l.length, 1);
  assert.equal(l[0].headsign, 'Ziel');
  assert.deepEqual(l[0].stops, [1, 2]);
});
