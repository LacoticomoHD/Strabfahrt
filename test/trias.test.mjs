import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStopEvents, matchEvents, stopEventRequest } from '../server/trias.mjs';

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
