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
