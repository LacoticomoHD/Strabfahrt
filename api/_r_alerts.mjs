import { getLive, send } from './_live.mjs';

export default async function handler(req, res) {
  try {
    const rt = await getLive();
    // Selbst erkannte Störungen als Meldung vorn anhängen (Android-App benachrichtigt bei Favoriten und deren Linien)
    const fmt = (u) => new Date(u * 1000).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
    const day = new Date().toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' });
    const inferred = (rt.incidents || []).map((x) => ({
      id: `inc-${x.station}`,
      header: `Vermutlich Störung an ${x.name} (${day})`,
      text: `${x.lines.length > 1 ? 'Linien' : 'Linie'} ${x.lines.join(', ')}: Rund um jetzt fallen dort ${x.affected} von ${x.total} Fahrten aus oder sind mehr als 8 Minuten verspätet${x.more ? (x.more > 10 ? ', Auswirkungen auch an vielen weiteren Haltestellen' : `, auch an ${x.more} weiteren Haltestellen`) : ''}. Erkannt seit ${fmt(x.since)} Uhr. Von STRABFAHRT aus den Live-Daten erkannt, keine Meldung des KVV, Grund unbekannt.`,
      inferred: true, station: x.station, lines: x.lines, local: true, periods: [],
    }));
    send(res, 200, { updated: rt.updated, alerts: [...inferred, ...rt.alerts] }, 60);
  } catch (e) {
    send(res, 200, { updated: 0, alerts: [], error: e.message }, 10);
  }
}
