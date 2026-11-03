import { getLive, getModel, send } from './_live.mjs';

// Nächste Abfahrten einer Station mit Live-Verspätung, für das Android-Widget.
// GET /api/departures?stop=<Haltestellen-ID>&limit=6
const berlinParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const pad = (n) => String(n).padStart(2, '0');
let idIndex = null;
let idIndexModel = null;

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const stopId = url.searchParams.get('stop') || '';
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 6, 1), 20);
  try {
    const model = await getModel();
    if (idIndexModel !== model) { idIndex = new Map(model.stops.map((s, i) => [s[0], i])); idIndexModel = model; }
    let idx = idIndex.get(stopId);
    if (idx === undefined) return send(res, 404, { error: 'Haltestelle unbekannt' }, 60);
    if (model.stops[idx][4] >= 0) idx = model.stops[idx][4];
    const rt = await getLive().catch(() => null);
    const p = Object.fromEntries(berlinParts.formatToParts(new Date()).map((x) => [x.type, x.value]));
    const ymd = `${p.year}${p.month}${p.day}`;
    const now = Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
    const list = model.departures(idx, ymd, now - 30 * 60, now + 3 * 3600, 200);
    const out = [];
    for (const d of list) {
      const canceled = rt ? rt.canceled.has(d.trip) : false;
      const delay = rt && rt.delays.has(d.trip) ? rt.delays.get(d.trip) : null;
      const real = d.t + (delay || 0);
      if (real < now - 30) continue;
      const hh = Math.floor((d.t % 86400 + 86400) % 86400 / 3600);
      const mm = Math.floor((d.t % 3600 + 3600) % 3600 / 60);
      out.push({
        line: d.line, dest: d.headsign, time: `${pad(hh)}:${pad(mm)}`, min: Math.max(0, Math.round((real - now) / 60)),
        delay: delay === null ? null : Math.round(delay / 60), canceled, color: d.color || '', textColor: d.textColor || '', type: d.type, platform: d.platform || '',
      });
      if (out.length >= limit) break;
    }
    send(res, 200, { name: model.stops[idx][1], updated: Date.now(), live: Boolean(rt && rt.updated), departures: out }, 30);
  } catch (e) {
    send(res, 502, { error: String(e.message || e) }, 15);
  }
}
