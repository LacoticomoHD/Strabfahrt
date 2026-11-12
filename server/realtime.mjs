// Echtzeit aus dem GTFS-Realtime-Stream von gtfs.de (CC BY-SA 4.0).
// Laedt den Stream (rund 11 MB) nur, solange jemand die App nutzt, filtert auf das Kartengebiet
// und liefert Verspaetungen, Ausfaelle und Meldungen. Schreibt eine kleine Puenktlichkeits-Statistik mit.
//
// Umgebung: STRAB_RT=0 schaltet ab, STRAB_RT_URL anderer Stream, STRAB_RT_INTERVAL Sekunden (Standard 60).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const RT_ATTRIBUTION = 'Echtzeit: gtfs.de (CC BY-SA 4.0)';

const CANCELED = 3; // TripDescriptor.ScheduleRelationship.CANCELED
const IDLE_MS = 5 * 60 * 1000; // ohne Abrufe nach 5 Minuten pausieren
// Fahrzeugmerkmale und Quellenvermerke, keine Stoerungen
// Orte und Betreiber im KVV-Netz: eine Meldung gilt nur als relevant, wenn sie einen davon nennt
// oder ausdrücklich eine Haltestelle bzw. Fahrt im Gebiet betrifft (Linien allein reichen nicht: S1 gibt es auch in Stuttgart)
export const KVV_PLACES = /karlsruhe|\bka\b|\bkvv\b|\bvbk\b|\bavg\b|albtal|durlach|ettlingen|bruchsal|rastatt|wörth|rheinstetten|stutensee|bretten|baden-baden|gaggenau|gernsbach|forbach|bühl|achern|freudenstadt|bad herrenalb|ittersbach|söllingen|berghausen|weingarten \(baden\)|jöhlingen|eppingen|öhringen|mosbach|neckarsulm|bad friedrichshall|neckarelz|neckarzimmern|gundelsheim|haßmersheim|grombach|eutingen|horb|sinsheim|bad rappenau|menzingen|odenheim|ubstadt|graben-neudorf|philippsburg|waghäusel|bad schönborn|östringen|germersheim|rheinzabern|jockgrim|kandel|linkenheim|leopoldshafen|eggenstein|hochstetten|blankenloch|neureut|knielingen|maxau|daxlanden|rüppurr|malsch|durmersheim|bietigheim \(baden\)|muggensturm|kuppenheim|ötigheim|steinmauern|sinzheim|ottersweier|renchen|oppenau|bad peterstal|kraichtal|bad wildbad|neuenbürg|herrenalb|marxzell|waldbronn|karlsbad|pfinztal|remchingen|wilferdingen|kämpfelbach|ispringen|flehingen|sulzfeld|gölshausen|kürnbach|zaisenhausen|gondelsheim|helmsheim|heidelsheim|untergrombach|weingarten/i;

const NOISE = /echtzeitdaten aufbereitet|zug getrennt|zugteil|wlan|klimaanlage|niederflur|stufenlos|rollstuhl|barrierefrei|\bwc\b|check-in|fahrradmitnahme|ruhebereich|steckdose/i;

// Verspaetung einer Fahrt: letzte Angabe an einem Halt, der schon erreicht ist, sonst die erste
export function tripDelay(tu, nowSec) {
  const ups = (tu.stopTimeUpdate || []).filter((u) => (u.departure && u.departure.delay != null) || (u.arrival && u.arrival.delay != null));
  if (!ups.length) return tu.delay != null ? Number(tu.delay) : null;
  let pick = ups[0];
  for (const u of ups) {
    const ev = u.departure && u.departure.time ? Number(u.departure.time) : u.arrival && u.arrival.time ? Number(u.arrival.time) : null;
    if (ev !== null && ev <= nowSec) pick = u;
  }
  const d = pick.departure && pick.departure.delay != null ? pick.departure.delay : pick.arrival.delay;
  return Number(d);
}

/** Ist-Zeiten je Halt aus einer Fahrt-Meldung: flache Liste [Plan-Ankunft, Abweichung, Plan-Abfahrt, Abweichung, ...] (Unix-Sekunden, 0/null = fehlt). */
export function stopTimesOf(tu) {
  const out = [];
  for (const u of tu.stopTimeUpdate || []) {
    const a = u.arrival; const d = u.departure;
    const at = a && a.time && a.delay != null ? Number(a.time) - Number(a.delay) : 0;
    const dt = d && d.time && d.delay != null ? Number(d.time) - Number(d.delay) : 0;
    if (!at && !dt) continue;
    out.push(at, at ? Number(a.delay) : null, dt, dt ? Number(d.delay) : null);
  }
  return out;
}

const pick = (ts) => {
  if (!ts || !ts.translation || !ts.translation.length) return '';
  const de = ts.translation.find((t) => (t.language || '').toLowerCase().startsWith('de'));
  return (de || ts.translation[0]).text || '';
};

const berlinDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
const berlinToday = () => berlinDay.format(new Date()).replaceAll('-', '');

export class Realtime {
  // opts.map: Zuordnung direkt uebergeben (statt data/rt-map.json), opts.persist=false: keine Statistik-Datei
  constructor(model, dataDir, { url, interval, map, persist = true, collect = false } = {}) {
    this.model = model;
    this.dataDir = dataDir;
    this.url = url || process.env.STRAB_RT_URL || 'https://realtime.gtfs.de/realtime-free.pb';
    this.interval = Math.max(20, Number(interval || process.env.STRAB_RT_INTERVAL || 60)) * 1000;
    this.enabled = process.env.STRAB_RT !== '0';
    this.delays = new Map();
    this.canceled = new Set();
    this.alerts = [];
    this.reasons = new Map(); // Fahrt-ID -> Grund der Verspaetung
    this.stopTimes = new Map(); // Fahrt-ID -> Ist-Zeiten je Halt (siehe stopTimesOf)
    this.updated = 0;
    this.feedTime = 0;
    this.error = null;
    this.lastAccess = 0;
    this.timer = null;
    this.busy = false;

    this.tripIndex = new Map(model.trips.map((t, i) => [t.id, i]));
    this.persist = persist;
    this.collect = persist || collect; // Statistik im Speicher sammeln (Vercel speichert sie selbst)
    const mapFile = dataDir ? path.join(dataDir, 'rt-map.json') : '';
    this.map = { trips: {}, routes: [], stops: [] };
    if (map) {
      if (map.modelBuilt === model.meta.built) this.map = map;
      else console.warn('rt-map passt nicht zum Modell, KVV-Echtzeit fehlt');
    } else if (mapFile && fs.existsSync(mapFile)) {
      const m = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
      if (m.modelBuilt === model.meta.built) this.map = m;
      else console.warn('data/rt-map.json passt nicht zu data/model.json, KVV-Echtzeit fehlt bis zum naechsten build:data');
    }
    this.routeSet = new Set(this.map.routes);
    this.stopSet = new Set(this.map.stops);

    this.statsFile = dataDir ? path.join(dataDir, 'stats.json') : '';
    this.stats = {};
    if (persist && this.statsFile) {
      try { this.stats = JSON.parse(fs.readFileSync(this.statsFile, 'utf8')); } catch { /* neu */ }
    }
    this.seen = new Map(); // "Datum|Fahrt" -> letzte Verspaetung (fuer die Statistik)

    if (this.enabled) {
      try {
        this.proto = require('gtfs-realtime-bindings').transit_realtime;
      } catch {
        console.warn('Paket gtfs-realtime-bindings fehlt (npm install), Echtzeit aus');
        this.enabled = false;
      }
    }
  }

  // Bei jedem Abruf aufrufen: startet den Abruf-Takt, falls er pausiert
  touch() {
    if (!this.enabled) return;
    this.lastAccess = Date.now();
    if (!this.timer) {
      this.fetchOnce();
      this.timer = setInterval(() => {
        if (Date.now() - this.lastAccess > IDLE_MS) { clearInterval(this.timer); this.timer = null; return; }
        this.fetchOnce();
      }, this.interval);
      this.timer.unref?.();
    }
  }

  // Eigene Fahrt-IDs zu einer Stream-Fahrt, gefiltert auf den Betriebstag
  ownIds(streamId, startDate) {
    const out = [];
    for (const p of ['fv:', 'rv:']) if (this.tripIndex.has(p + streamId)) out.push(p + streamId);
    for (const id of this.map.trips[streamId] || []) {
      const ti = this.tripIndex.get(id);
      if (ti === undefined) continue;
      if (startDate && !this.model.activeServices(startDate).has(this.model.trips[ti].service)) continue;
      out.push(id);
    }
    return out;
  }

  async fetchOnce() {
    if (this.busy) return;
    this.busy = true;
    try {
      const res = await fetch(this.url, { headers: { 'User-Agent': 'STRABFAHRT/0.1 (Fahrplankarte Karlsruhe)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      this.ingest(this.proto.FeedMessage.decode(buf));
      this.error = null;
    } catch (e) {
      this.error = e.message;
      console.warn('Echtzeit-Abruf fehlgeschlagen:', e.message);
    } finally {
      this.busy = false;
    }
  }

  ingest(feed) {
    const nowSec = Math.floor(Date.now() / 1000);
    const delays = new Map();
    const canceled = new Set();
    const alerts = [];
    const reasons = new Map();
    const stopTimes = new Map();
    for (const e of feed.entity) {
      const tu = e.tripUpdate;
      if (tu && tu.trip && tu.trip.tripId) {
        const ids = this.ownIds(tu.trip.tripId, tu.trip.startDate);
        if (!ids.length) continue;
        const isCanceled = tu.trip.scheduleRelationship === CANCELED;
        const d = isCanceled ? null : tripDelay(tu, nowSec);
        const st = isCanceled ? [] : stopTimesOf(tu);
        for (const id of ids) {
          if (st.length) stopTimes.set(id, st);
          if (isCanceled) canceled.add(id);
          else if (d !== null && Number.isFinite(d)) delays.set(id, d);
          this.record(tu.trip.startDate, id, isCanceled ? 'X' : d);
        }
      } else if (e.alert) {
        const ents = e.alert.informedEntity || [];
        const header = pick(e.alert.headerText);
        const text = pick(e.alert.descriptionText);
        const label = header || text;
        if (!label || NOISE.test(label)) continue;
        // Nur Fahrten betroffen und kurzer Text: Grund einer Verspaetung, kommt an die Fahrt
        const isNotice = label.includes(':') || text.length > 120;
        if (ents.length && ents.every((x) => x.trip && x.trip.tripId) && label.length <= 120) {
          let hit = false;
          for (const x of ents) for (const id of this.ownIds(x.trip.tripId, x.trip.startDate)) { reasons.set(id, label); hit = true; }
          if (!isNotice || !hit) continue;
        }
        const byStopOrTrip = ents.some((x) => (x.stopId && this.stopSet.has(x.stopId)) || (x.trip && x.trip.tripId && this.ownIds(x.trip.tripId).length));
        const byRoute = ents.some((x) => x.routeId && this.routeSet.has(x.routeId));
        // Nur das KVV-Gebiet: Haltestelle/Fahrt dort, oder Linie dort UND ein Ort aus dem Gebiet im Text
        // Ort in der Überschrift (im Text steht oft nur "Richtung Karlsruhe" bei Meldungen weit weg)
        const placed = KVV_PLACES.test(header || text.split('\n')[0]);
        if (!byStopOrTrip && !(byRoute && placed)) continue;
        const periods = (e.alert.activePeriod || []).map((p) => [Number(p.start || 0), Number(p.end || 0)]);
        if (periods.length && !periods.some(([a, b]) => (!a || a <= nowSec + 86400) && (!b || b >= nowSec))) continue;
        const local = /karlsruhe|\bka\b|kvv|vbk|durlach|ettlingen|bruchsal|rastatt|wörth|rheinstetten|stutensee|bretten/i.test(`${header} ${text}`);
        if (!placed) continue; // Überschrift nennt nur Orte außerhalb (z. B. Schorndorf, Stuttgart)
        if (alerts.some((a) => a.header === (header || text.split('\n')[0].slice(0, 120)))) continue;
        alerts.push({ id: e.id, header: header || text.split('\n')[0].slice(0, 120), text, url: pick(e.alert.url), periods, local });
      }
    }
    this.delays = delays;
    this.canceled = canceled;
    this.alerts = alerts.sort((x, y) => Number(y.local) - Number(x.local)).slice(0, 100);
    this.reasons = reasons;
    this.stopTimes = stopTimes;
    this.updated = Date.now();
    this.feedTime = Number(feed.header && feed.header.timestamp) || 0;
    this.flushStats();
  }

  record(startDate, id, value) {
    if (!this.collect) return;
    if (!startDate || startDate > berlinToday()) return; // Vorab-Angaben fuer morgen nicht zaehlen
    this.seen.set(`${startDate}|${id}`, value);
  }

  // Statistik: je Tag und Linie Fahrten, mittlere Verspaetung, Anteil ab 3 Minuten zu spaet, Ausfaelle
  flushStats() {
    if (!this.collect) return;
    if (Date.now() - (this.lastFlush || 0) < 10 * 60 * 1000 && this.seen.size < 50000) return;
    this.lastFlush = Date.now();
    const day = new Map();
    for (const [key, v] of this.seen) {
      const [date, id] = key.split('|');
      const ti = this.tripIndex.get(id);
      if (ti === undefined) continue;
      const route = this.model.routes[this.model.patterns[this.model.trips[ti].pattern].route];
      const k = `${date}|${route[0]}|${route[1]}`;
      let e = day.get(k);
      if (!e) day.set(k, (e = { n: 0, sum: 0, late: 0, early: 0, canceled: 0 }));
      if (v === 'X') { e.canceled++; continue; }
      e.n++;
      e.sum += v;
      if (v >= 180) e.late++;
      if (v <= -60) e.early++;
    }
    for (const [k, e] of day) {
      const [date, line, type] = k.split('|');
      this.stats[date] = this.stats[date] || {};
      this.stats[date][`${line}|${type}`] = e;
    }
    const keep = Object.keys(this.stats).sort().slice(-30);
    this.stats = Object.fromEntries(keep.map((d) => [d, this.stats[d]]));
    // Nur Eintraege der letzten zwei Tage im Speicher halten
    const cutoff = keep.slice(-2)[0] || '';
    for (const key of this.seen.keys()) if (key.slice(0, 8) < cutoff) this.seen.delete(key);
    if (this.persist && this.statsFile) {
      try { fs.writeFileSync(this.statsFile, JSON.stringify(this.stats)); } catch (e) { console.warn('Statistik nicht gespeichert:', e.message); }
    }
  }

  statsSummary() {
    const lines = new Map();
    const days = Object.keys(this.stats).sort();
    for (const d of days) {
      for (const [k, e] of Object.entries(this.stats[d])) {
        let a = lines.get(k);
        if (!a) lines.set(k, (a = { n: 0, sum: 0, late: 0, early: 0, canceled: 0 }));
        for (const f of ['n', 'sum', 'late', 'early', 'canceled']) a[f] += e[f];
      }
    }
    return {
      days: days.length, from: days[0] || null, to: days[days.length - 1] || null,
      lines: [...lines].map(([k, a]) => {
        const [line, type] = k.split('|');
        return { line, type: Number(type), trips: a.n, canceled: a.canceled, avg: a.n ? Math.round(a.sum / a.n) : 0, latePct: a.n ? Math.round((100 * a.late) / a.n) : 0, earlyPct: a.n ? Math.round((100 * a.early) / a.n) : 0 };
      }).filter((x) => x.trips + x.canceled >= 5).sort((x, y) => y.latePct - x.latePct || y.avg - x.avg),
    };
  }

  snapshot() {
    return {
      enabled: this.enabled, updated: this.updated, feedTime: this.feedTime, error: this.error,
      d: Object.fromEntries(this.delays), c: [...this.canceled], r: Object.fromEntries(this.reasons),
    };
  }
}
