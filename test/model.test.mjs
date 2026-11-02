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

test('Erreichbarkeit: nur Stationen innerhalb der Zeit, Umstieg eingerechnet', () => {
  const in30 = Object.fromEntries(planModel.reach(0, '20261102', 7 * 3600 + 55 * 60, 30));
  assert.equal(in30[1], 15, 'Mitte nach 15 Minuten (8:10)');
  assert.equal(in30[2], 30, 'Ziel nach 30 Minuten (8:25 mit Umstieg)');
  const in20 = Object.fromEntries(planModel.reach(0, '20261102', 7 * 3600 + 55 * 60, 20));
  assert.equal(in20[1], 15);
  assert.equal(in20[2], undefined);
});

test('Takt: Abfahrten je Station im Fenster, Endhalt zaehlt nicht', () => {
  const f = Object.fromEntries(planModel.frequency('20261102', 8 * 3600, 9 * 3600));
  assert.equal(f[0], 2); // a1 und d1 ab Start
  assert.equal(f[1], 2); // b0 und b1 ab Mitte
  assert.equal(f[2], undefined); // Ziel ist nur Endhalt
});

test('Adresse als Start und Ziel: Fussweg am Anfang und Ende, Ankunft inklusive Weg', () => {
  const start = { lat: 0.1005, lon: 0.1 }; // rund 55 m von "Start"
  const ziel = { lat: 0.3005, lon: 0.3 }; // rund 55 m von "Ziel"
  const js = planModel.plan(start, ziel, '20261102', 7 * 3600 + 55 * 60);
  const viaMitte = js.find((j) => j.transfers === 1);
  assert.ok(viaMitte, 'Verbindung mit Umstieg erwartet');
  assert.equal(viaMitte.legs[0].type, 'walk');
  assert.equal(viaMitte.legs[0].fromPoint, true);
  const last = viaMitte.legs[viaMitte.legs.length - 1];
  assert.equal(last.toPoint, true);
  assert.equal(viaMitte.arr, 8 * 3600 + 25 * 60 + last.secs);
  assert.ok(viaMitte.start < viaMitte.dep, 'Losgehen vor der Abfahrt');
});

test('Punkt ohne Haltestelle in der Naehe: keine Verbindung', () => {
  assert.deepEqual(planModel.plan({ lat: 0.9, lon: 0.9 }, 2, '20261102', 8 * 3600), []);
});

test('Reisezeit-Profil: bester Abfahrtszeitpunkt hat die kuerzeste Gesamtzeit', () => {
  const p = planModel.profile(0, 2, '20261102', 7 * 3600, 8 * 3600, 1800);
  assert.deepEqual(p.map((x) => x[0]), [7 * 3600, 7 * 3600 + 1800, 8 * 3600]);
  assert.deepEqual(p.map((x) => x[1]), [85, 55, 25]);
});

// ---------- Barrierefrei, letzte Verbindung, Umleitungen ----------

const accFixture = JSON.parse(JSON.stringify(planFixture));
accFixture.stops[1].push(1); // Mitte stufenfrei (Index 7 = wheelchair_boarding)
accFixture.stops.forEach((s) => { while (s.length < 8) s.push(0); });
accFixture.trips[0][5] = 1; // a1 barrierefrei
accFixture.trips[2][5] = 1; // b1 barrierefrei

test('Barrierefrei reisen: nur ausdruecklich barrierefreie Fahrten', () => {
  const m = new Model(accFixture);
  const js = m.plan(0, 2, '20261102', 7 * 3600 + 55 * 60, { accessible: true });
  assert.equal(js.length, 1);
  assert.equal(js[0].transfers, 1);
  assert.equal(js[0].arr, 8 * 3600 + 25 * 60);
  // ohne Filter gibt es zusaetzlich die Direktfahrt
  assert.ok(m.plan(0, 2, '20261102', 7 * 3600 + 55 * 60).some((j) => j.transfers === 0));
});

test('Barrierefrei reisen: nicht stufenfreier Umsteigehalt sperrt die Verbindung', () => {
  const blocked = JSON.parse(JSON.stringify(accFixture));
  blocked.stops[1][7] = 2;
  assert.deepEqual(new Model(blocked).plan(0, 2, '20261102', 7 * 3600 + 55 * 60, { accessible: true }), []);
});

test('Letzte Verbindung: spaeteste Abfahrt, leer wenn danach nichts mehr faehrt', () => {
  const last = planModel.lastJourney(0, 2, '20261102', 7 * 3600);
  assert.ok(last.length);
  assert.equal(last[0].dep, 8 * 3600);
  assert.deepEqual(planModel.lastJourney(0, 2, '20261102', 9 * 3600), []);
});

test('Umleitungen: Linien mit Umleitungs-Zielangabe werden gezaehlt', () => {
  const m = new Model({
    meta: { bbox: [0, 0, 1, 1], built: 'd' },
    routes: [['3', 0, '', '', '1']],
    stops: [['a', 'A', 0.1, 0.1, -1, '', 0, 0], ['b', 'B', 0.2, 0.2, -1, '', 0, 0]],
    patterns: [[0, '3 Heide (Umleitung)', [0, 1]], [0, '3 Heide', [0, 1]]],
    profiles: [[0, 0, 600, 600]],
    services: [{ d: '1111111', s: '20260101', e: '20261231', add: [], rem: [] }],
    trips: [[0, 0, 0, 8 * 3600, 'x1', 0], [0, 1, 0, 9 * 3600, 'x2', 0], [0, 1, 0, 10 * 3600, 'x3', 0]],
  });
  const d = m.disruptions('20261102');
  assert.equal(d.length, 1);
  assert.equal(d[0].line, '3');
  assert.equal(d[0].detour, 1);
  assert.equal(d[0].total, 3);
  assert.deepEqual(d[0].headsigns, ['3 Heide (Umleitung)']);
});
