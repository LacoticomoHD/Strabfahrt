// Echtzeit-Abfahrten über TRIAS (VDV 431): KVV als Hauptquelle, MobiData BW (EFA-BW) als Ausweichquelle.
// Zugang je Quelle über Umgebungsvariablen (RequestorRef vertraulich):
//   KVV_TRIAS_REF [KVV_TRIAS_URL], MOBIDATA_TRIAS_REF [MOBIDATA_TRIAS_URL]
// Ergebnis wird auf die Fahrten des eigenen Modells abgebildet: gleiche Linie, gleiche Planabfahrt (± 60 s).

export const SOURCES = {
  kvv: { refEnv: 'KVV_TRIAS_REF', urlEnv: 'KVV_TRIAS_URL', url: 'https://projekte.kvv-efa.de/oftrias/trias' },
  mobidata: { refEnv: 'MOBIDATA_TRIAS_REF', urlEnv: 'MOBIDATA_TRIAS_URL', url: 'https://efa-bw.de/trias' },
};

export const sourceEnabled = (name) => Boolean(SOURCES[name] && process.env[SOURCES[name].refEnv]);
export const enabledSources = () => Object.keys(SOURCES).filter(sourceEnabled);
export const triasEnabled = () => enabledSources().length > 0;

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function stopEventRequest(ref, stopRef, whenIso, count = 40) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Trias version="1.1" xmlns="http://www.vdv.de/trias" xmlns:siri="http://www.siri.org.uk/siri" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <ServiceRequest>
    <siri:RequestTimeStamp>${esc(whenIso)}</siri:RequestTimeStamp>
    <siri:RequestorRef>${esc(ref)}</siri:RequestorRef>
    <RequestPayload>
      <StopEventRequest>
        <Location>
          <LocationRef>${/^de:\d{5}:\d+$/.test(stopRef) ? `<StopPlaceRef>${esc(stopRef)}</StopPlaceRef>` : `<StopPointRef>${esc(stopRef)}</StopPointRef>`}</LocationRef>
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

export async function fetchStopEvents(stopRef, { count = 40, timeoutMs = 6000, source = 'kvv' } = {}) {
  const src = SOURCES[source];
  const ref = src && process.env[src.refEnv];
  if (!ref) throw new Error(`${src ? src.refEnv : source} fehlt`);
  const url = process.env[src.urlEnv] || src.url;
  const body = stopEventRequest(ref, stopRef, new Date().toISOString().replace(/\.\d+Z$/, 'Z'), count);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/xml; charset=utf-8', 'User-Agent': 'STRABFAHRT' }, body, signal: ctrl.signal });
    const xml = await res.text();
    const raw = xml.slice(0, 1500).split(ref).join('***'); // zur Fehlersuche, Kennung geschwärzt
    if (!res.ok) return { error: `TRIAS HTTP ${res.status}`, events: [], raw, status: res.status, url, source };
    if (!xml.trim()) return { error: 'leere Antwort', events: [], raw, status: res.status, url, source };
    const first = (xml.match(/<(?:\w+:)?StopEventResult\b[\s\S]*?<\/(?:\w+:)?StopEventResult>/) || [''])[0];
    const tags = [...new Set((first.match(/<(?:\w+:)?[A-Za-z]+/g) || []).map((t) => t.replace(/^<(?:\w+:)?/, '')))];
    return { ...parseStopEvents(xml), raw, tags, status: res.status, url, source };
  } catch (e) {
    return { error: String(e.message || e), events: [], raw: '', status: 0, url, source };
  } finally {
    clearTimeout(timer);
  }
}

// Liniennamen vergleichbar machen. Fernzüge: TRIAS nennt die Zugnummer, das Modell die Linie, daher nur die Gattung vergleichen.
export const normLine = (s) => {
  const t = String(s || '').toUpperCase().replace(/&GT;|&LT;|&AMP;/g, ' ').replace(/^(STR|STRASSENBAHN|TRAM|BUS|LINIE)\s*/, '').replace(/\s+(INTERCITY\w*|EUROCITY\w*|NIGHTJET|RAILJET\w*)$/, '').trim();
  const fv = t.match(/^(ICE|ICE-?S|IC|EC|ECE|EN|NJ|RJ|RJX|TGV|FLX)\b/);
  return fv ? fv[1] : t.replace(/\s+/g, '');
};

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
  // Manche Quellen liefern dieselbe Abfahrt doppelt (mit und ohne Prognose): Einträge mit Prognose zuerst zuordnen
  const ordered = [...events].sort((a, b) => (a.estimated === null) - (b.estimated === null) || a.planned - b.planned);
  for (const e of ordered) {
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
