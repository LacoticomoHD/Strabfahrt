// Echtzeit-Abfahrten über die TRIAS-Schnittstelle (VDV 431) des KVV.
// Zugang: Umgebungsvariable KVV_TRIAS_REF (RequestorRef, vertraulich), optional KVV_TRIAS_URL.
// Ergebnis wird auf die Fahrten des eigenen Modells abgebildet: gleiche Linie, gleiche Planabfahrt (± 60 s).

const DEFAULT_URL = 'https://projekte.kvv-efa.de/oftrias/trias';

export const triasEnabled = () => Boolean(process.env.KVV_TRIAS_REF);

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function stopEventRequest(ref, stopRef, whenIso, count = 40) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Trias version="1.1" xmlns="http://www.vdv.de/trias" xmlns:siri="http://www.siri.org.uk/siri" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <ServiceRequest>
    <siri:RequestTimestamp>${esc(whenIso)}</siri:RequestTimestamp>
    <siri:RequestorRef>${esc(ref)}</siri:RequestorRef>
    <RequestPayload>
      <StopEventRequest>
        <Location>
          <LocationRef><StopPointRef>${esc(stopRef)}</StopPointRef></LocationRef>
          <DepArrTime>${esc(whenIso)}</DepArrTime>
        </Location>
        <Params>
          <NumberOfResults>${count}</NumberOfResults>
          <StopEventType>departure</StopEventType>
          <IncludePreviousCalls>false</IncludePreviousCalls>
          <IncludeOnwardCalls>false</IncludeOnwardCalls>
          <IncludeRealtimeData>true</IncludeRealtimeData>
        </Params>
      </StopEventRequest>
    </RequestPayload>
  </ServiceRequest>
</Trias>`;
}

// Kleiner, toleranter XML-Leser: Namensraum-Präfixe werden ignoriert
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`));
  return m ? m[1] : null;
};
const text = (xml, name) => {
  const inner = xml && tag(xml, name);
  if (inner === null || inner === undefined) return null;
  const t = tag(inner, 'Text');
  return (t !== null ? t : inner).replace(/<[^>]+>/g, '').trim();
};
const all = (xml, name) => {
  const out = [];
  const re = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'g');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
};

export function parseStopEvents(xml) {
  const err = text(xml, 'ErrorMessage') || text(xml, 'ErrorCondition');
  const events = [];
  for (const r of all(xml, 'StopEventResult')) {
    const call = tag(r, 'ThisCall') || r;
    const dep = tag(call, 'ServiceDeparture') || '';
    const service = tag(r, 'Service') || r;
    const planned = text(dep, 'TimetabledTime');
    if (!planned) continue;
    const est = text(dep, 'EstimatedTime');
    events.push({
      line: text(service, 'PublishedLineName') || text(service, 'LineRef') || '',
      dest: text(service, 'DestinationText') || '',
      planned: Date.parse(planned) / 1000,
      estimated: est ? Date.parse(est) / 1000 : null,
      canceled: /<(?:\w+:)?Cancelled>\s*true/i.test(r),
      journey: text(service, 'JourneyRef') || '',
      stop: text(call, 'StopPointRef') || '',
      bay: text(call, 'EstimatedBay') || text(call, 'PlannedBay') || '',
    });
  }
  return { error: events.length ? null : err, events };
}

export async function fetchStopEvents(stopRef, { count = 40, timeoutMs = 6000 } = {}) {
  const ref = process.env.KVV_TRIAS_REF;
  if (!ref) throw new Error('KVV_TRIAS_REF fehlt');
  const url = process.env.KVV_TRIAS_URL || DEFAULT_URL;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'User-Agent': 'STRABFAHRT' },
      body: stopEventRequest(ref, stopRef, new Date().toISOString().replace(/\.\d+Z$/, 'Z'), count),
      signal: ctrl.signal,
    });
    const xml = await res.text();
    if (!res.ok) throw new Error(`TRIAS HTTP ${res.status}`);
    return parseStopEvents(xml);
  } finally {
    clearTimeout(timer);
  }
}

const normLine = (s) => String(s || '').toUpperCase().replace(/^(STR|STRASSENBAHN|TRAM|BUS|LINIE)\s*/, '').replace(/\s+/g, '');

// TRIAS-Halt zu einer Station des Modells: KVV-IDs wie "de:08212:802" (Station) bzw. "Pde:08212:802" im Modell
export function triasStopRef(model, idx) {
  const st = model.stops[idx];
  const id = st[0].replace(/^P/, '');
  const m = id.match(/^(de:\d{5}:\d+)/);
  return m ? m[1] : null;
}

/**
 * TRIAS-Abfahrten den Modell-Abfahrten zuordnen.
 * deps: model.departures(...) relativ zu ymd; dayStartUnix: Unix-Sekunden von 0:00 Berliner Zeit an ymd.
 * Rückgabe: Map trip -> { delay, canceled, bay }
 */
export function matchEvents(deps, events, dayStartUnix) {
  const out = new Map();
  const used = new Set();
  for (const e of events) {
    const want = normLine(e.line);
    let best = null;
    let bestD = 61;
    for (const d of deps) {
      if (used.has(d.trip) || normLine(d.line) !== want) continue;
      const diff = Math.abs(dayStartUnix + d.t - e.planned);
      if (diff < bestD) { best = d; bestD = diff; }
    }
    if (!best) continue;
    used.add(best.trip);
    out.set(best.trip, { delay: e.estimated === null ? null : Math.round(e.estimated - e.planned), canceled: e.canceled, bay: e.bay });
  }
  return out;
}
