import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStopEvents, matchEvents, stopEventRequest, dedupeEvents, normBay } from '../server/trias.mjs';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<trias:Trias xmlns:trias="http://www.vdv.de/trias" xmlns:siri="http://www.siri.org.uk/siri" version="1.1">
 <trias:ServiceDelivery><trias:DeliveryPayload><trias:StopEventResponse>
  <trias:StopEventResult><trias:StopEvent>
   <trias:ThisCall><trias:CallAtStop>
    <trias:StopPointRef>de:08212:802:11:11</trias:StopPointRef>
    <trias:PlannedBay><trias:Text>1</trias:Text></trias:PlannedBay>
    <trias:ServiceDeparture><trias:TimetabledTime>2026-11-04T13:10:00Z</trias:TimetabledTime><trias:EstimatedTime>2026-11-04T13:11:24Z</trias:EstimatedTime></trias:ServiceDeparture>
   </trias:CallAtStop></trias:ThisCall>
   <trias:Service><trias:JourneyRef>kvv:21005:E:H:j26:123</trias:JourneyRef>
    <trias:PublishedLineName><trias:Text>S5</trias:Text></trias:PublishedLineName>
    <trias:DestinationText><trias:Text>Söllingen</trias:Text></trias:DestinationText></trias:Service>
  </trias:StopEvent></trias:StopEventResult>
  <trias:StopEventResult><trias:StopEvent>
   <trias:ThisCall><trias:CallAtStop>
    <trias:ServiceDeparture><trias:TimetabledTime>2026-11-04T13:12:00Z</trias:TimetabledTime></trias:ServiceDeparture>
   </trias:CallAtStop></trias:ThisCall>
   <trias:Service><trias:PublishedLineName><trias:Text>Str 2</trias:Text></trias:PublishedLineName><trias:Cancelled>true</trias:Cancelled></trias:Service>
  </trias:StopEvent></trias:StopEventResult>
 </trias:StopEventResponse></trias:DeliveryPayload></trias:ServiceDelivery>
</trias:Trias>`;

test('TRIAS: Abfahrten mit Namensraum-Präfix lesen', () => {
  const r = parseStopEvents(XML);
  assert.equal(r.events.length, 2);
  assert.equal(r.events[0].line, 'S5');
  assert.equal(r.events[0].estimated - r.events[0].planned, 84);
  assert.equal(r.events[0].bay, '1');
  assert.equal(r.events[1].estimated, null);
  assert.equal(r.events[1].canceled, true);
});

test('TRIAS: Zuordnung zu Modellfahrten über Linie und Planzeit', () => {
  const day = Date.UTC(2026, 10, 4) / 1000 - 3600; // 0:00 Berlin (MEZ)
  const deps = [
    { t: 14 * 3600 + 10 * 60, line: 'S5', trip: 'a' },
    { t: 14 * 3600 + 12 * 60, line: '2', trip: 'b' },
    { t: 14 * 3600 + 40 * 60, line: 'S5', trip: 'c' },
  ];
  const m = matchEvents(deps, parseStopEvents(XML).events, day);
  assert.equal(m.get('a').delay, 84);
  assert.equal(m.get('b').canceled, true);
  assert.equal(m.has('c'), false);
});

test('TRIAS: Anfrage enthält Kennung und Halt, maskiert Sonderzeichen', () => {
  const x = stopEventRequest('ab<c', 'de:08212:802', '2026-11-04T13:00:00Z', 5);
  assert.match(x, /<siri:RequestorRef>ab&lt;c<\/siri:RequestorRef>/);
  assert.match(x, /<StopPlaceRef>de:08212:802<\/StopPlaceRef>/);
  assert.match(x, /<siri:RequestTimeStamp>/);
});

test('isMainlineRail erkennt Regional- und Fernzüge, nicht Tram/S-Bahn', async () => {
  const { isMainlineRail } = await import('../api/_kvv.mjs');
  for (const line of ['RE1', 'RE 45', 'RB 71', 'IC 61', 'ICE', 'MEX17', 'IRE 3']) assert.ok(isMainlineRail({ line, type: 2 }), line);
  for (const line of ['1', 'S31', 'S5', '42', 'E', 'SEV S4']) assert.ok(!isMainlineRail({ line, type: 0 }), line);
  assert.ok(isMainlineRail({ line: 'XYZ', type: 100 }));
});

test('normLine gleicht Fernzug-Nummern und Leerzeichen an', async () => {
  const { normLine } = await import('../server/trias.mjs');
  assert.equal(normLine('ICE 203 InterCityExpress'), normLine('ICE 43'));
  assert.equal(normLine('IC 2263'), normLine('IC 61'));
  assert.equal(normLine('RE 1'), normLine('RE1'));
  assert.equal(normLine('STR 1'), '1');
  assert.notEqual(normLine('S1'), normLine('S11'));
});

test('matchEvents bevorzugt bei doppelten Einträgen den mit Prognose', () => {
  const deps = [{ trip: 'T1', line: 'S31', t: 3600 }];
  const events = [
    { line: 'S31', planned: 1000 + 3600, estimated: null, canceled: false, bay: '' },
    { line: 'S31', planned: 1000 + 3600, estimated: 1000 + 3600 + 120, canceled: false, bay: '2' },
  ];
  const m = matchEvents(deps, events, 1000);
  assert.equal(m.get('T1').delay, 120);
});

test('normBay vereinheitlicht KVV- und DB-Schreibweisen', () => {
  assert.equal(normBay('Gleis 1b'), '1B');
  assert.equal(normBay('1B'), '1B');
  assert.equal(normBay('Gleis 1(U)'), '1(U)');
  assert.equal(normBay('1U.'), '1(U)');
  assert.equal(normBay('Bstg. 3'), '3');
  assert.equal(normBay(''), '');
});

const ev = (o) => ({ line: '2', ref: 'kvv:21002:E:H', origin: 'Wolfartsweier', dest: 'Siemensallee', planned: 5000, estimated: null, canceled: false, bay: '1', journey: '', ...o });

test('dedupeEvents: gleicher Eintrag doppelt ergibt eine Einheit mit Prognose', () => {
  const r = dedupeEvents([ev({ journey: 'j1' }), ev({ journey: 'j1', estimated: 5060 })]);
  assert.equal(r.length, 1);
  assert.equal(r[0].units, 1);
  assert.equal(r[0].estimated, 5060);
});

test('dedupeEvents: gekoppelte Einheiten werden gezählt', () => {
  const r = dedupeEvents([ev({ journey: 'j1' }), ev({ journey: 'j2', dest: 'Knielingen' })]);
  assert.equal(r.length, 1);
  assert.equal(r[0].units, 2);
  assert.deepEqual(r[0].dests, ['Siemensallee', 'Knielingen']);
});

test('dedupeEvents: DB-Kopie fällt weg und reicht die Prognose weiter', () => {
  const r = dedupeEvents([
    ev({ line: 'S5', ref: 'kvv:22305:E:H', origin: 'Pforzheim Hbf', dest: 'Wörth Badepark', bay: '' }),
    ev({ line: 'S5', ref: 'ddb:920S5:D:H', origin: 'Pforzheim Hbf', dest: 'Wörth Badepark', planned: 5060, estimated: 5180, bay: '4' }),
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].estimated, 5120);
  assert.equal(r[0].bay, '4');
});

test('dedupeEvents: DB-Kurzläufer mit anderem Ziel bleibt erhalten', () => {
  const r = dedupeEvents([
    ev({ line: 'S5', ref: 'kvv:22305:E:H', origin: 'Pforzheim Hbf', dest: 'Wörth Badepark' }),
    ev({ line: 'S5', ref: 'ddb:920S5:D:H', origin: 'Pforzheim Hbf', dest: 'Söllingen' }),
  ]);
  assert.equal(r.length, 2);
});
