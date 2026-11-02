// Laedt data/model.json und beantwortet Zeit- und Ortsanfragen. Keine Abhaengigkeiten, kein Netzwerk.

import fs from 'node:fs';

const DAY = 86400;

export function parseYmd(s) {
  if (!/^\d{8}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

export function formatYmd(date) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return p(date.getUTCFullYear(), 4) + p(date.getUTCMonth() + 1) + p(date.getUTCDate());
}

export function addDays(ymd, n) {
  const d = parseYmd(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return formatYmd(d);
}

export class Model {
  constructor(file) {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.meta = m.meta;
    this.routes = m.routes;
    this.stops = m.stops;
    this.patterns = m.patterns.map(([route, headsign, stops]) => ({ route, headsign, stops }));
    this.profiles = m.profiles;
    this.services = m.services;
    this.trips = m.trips.map(([service, pattern, profile, start, id]) => ({ service, pattern, profile, start, id }));

    // Dauer je Zeitprofil (letzte Ankunft)
    this.profileEnd = this.profiles.map((p) => p[p.length - 2]);

    // Umgrenzung je Muster
    for (const p of this.patterns) {
      let s = 90, w = 180, n = -90, e = -180;
      for (const i of p.stops) {
        const st = this.stops[i];
        if (st[2] < s) s = st[2];
        if (st[2] > n) n = st[2];
        if (st[3] < w) w = st[3];
        if (st[3] > e) e = st[3];
      }
      p.bbox = [s, w, n, e];
    }

    // Fahrten je Betriebstag-Typ und je Muster
    this.tripsByService = this.services.map(() => []);
    this.patternTrips = this.patterns.map(() => []);
    this.trips.forEach((t, i) => {
      this.tripsByService[t.service].push(i);
      this.patternTrips[t.pattern].push(i);
    });
    for (const list of this.patternTrips) list.sort((a, b) => this.trips[a].start - this.trips[b].start);

    // Haltestelle -> Muster mit Position
    this.stopPatterns = new Map();
    this.patterns.forEach((p, pid) => {
      p.stops.forEach((s, pos) => {
        if (!this.stopPatterns.has(s)) this.stopPatterns.set(s, []);
        this.stopPatterns.get(s).push([pid, pos]);
      });
    });

    // Kinder je Station
    this.children = new Map();
    this.stops.forEach((st, i) => {
      if (st[4] >= 0) {
        if (!this.children.has(st[4])) this.children.set(st[4], []);
        this.children.get(st[4]).push(i);
      }
    });

    // Suchindex: Stationen (Eltern) und Halte ohne Eltern
    this.searchable = [];
    const seen = new Set();
    this.stops.forEach((st, i) => {
      const isStation = st[6] === 1 || st[4] < 0;
      if (!isStation) return;
      const used = st[6] === 1 ? this.children.has(i) : this.stopPatterns.has(i);
      if (!used) return;
      const key = st[1] + '|' + st[0];
      if (seen.has(key)) return;
      seen.add(key);
      this.searchable.push({ index: i, name: st[1], lower: st[1].toLowerCase() });
    });

    this.activeCache = new Map();
  }

  serviceActive(sIdx, ymd, weekdayMon0) {
    const s = this.services[sIdx];
    if (s.rem.includes(ymd)) return false;
    if (s.add.includes(ymd)) return true;
    return s.d[weekdayMon0] === '1' && ymd >= s.s && ymd <= s.e;
  }

  // Menge der Betriebstag-Typen, die an diesem Datum fahren
  activeServices(ymd) {
    let set = this.activeCache.get(ymd);
    if (set) return set;
    const date = parseYmd(ymd);
    const wd = (date.getUTCDay() + 6) % 7;
    set = new Set();
    for (let i = 0; i < this.services.length; i++) {
      if (this.serviceActive(i, ymd, wd)) set.add(i);
    }
    this.activeCache.set(ymd, set);
    if (this.activeCache.size > 12) this.activeCache.delete(this.activeCache.keys().next().value);
    return set;
  }

  // Alle Fahrten, die irgendwann in [t0,t1] (Sekunden seit 00:00 von ymd) unterwegs sind.
  // Zeiten werden auf ymd bezogen (Fahrten vom Vortag erhalten negative Verschiebung).
  *activeTrips(ymd, t0, t1) {
    for (const dayOffset of [-1, 0, 1]) {
      const day = addDays(ymd, dayOffset);
      const shift = dayOffset * DAY;
      for (const sIdx of this.activeServices(day)) {
        for (const ti of this.tripsByService[sIdx]) {
          const t = this.trips[ti];
          const start = t.start + shift;
          if (start > t1) continue;
          if (start + this.profileEnd[t.profile] < t0) continue;
          yield { trip: t, start };
        }
      }
    }
  }

  vehicles(ymd, t0, t1, bbox, routeTypes) {
    const patterns = {};
    const profiles = {};
    const trips = [];
    for (const { trip, start } of this.activeTrips(ymd, t0, t1)) {
      const p = this.patterns[trip.pattern];
      if (routeTypes && !routeTypes.has(this.routes[p.route][1])) continue;
      if (bbox) {
        const b = p.bbox;
        if (b[2] < bbox[0] || b[0] > bbox[2] || b[3] < bbox[1] || b[1] > bbox[3]) continue;
      }
      if (!patterns[trip.pattern]) patterns[trip.pattern] = { r: p.route, h: p.headsign, s: p.stops };
      if (!profiles[trip.profile]) profiles[trip.profile] = this.profiles[trip.profile];
      trips.push([trip.pattern, trip.id, start, trip.profile]);
    }
    return { patterns, profiles, trips };
  }

  search(q, limit = 12) {
    // Abkuerzungen: Wort passt entweder direkt oder ueber die Langform
    const ALIASES = { hbf: 'hauptbahnhof', bf: 'bahnhof', str: 'straße' };
    const needle = q.trim().toLowerCase();
    const tokens = needle.split(/\s+/).filter(Boolean);
    if (needle.length < 2) return [];
    const starts = [];
    const contains = [];
    for (const s of this.searchable) {
      if (s.lower.startsWith(needle)) starts.push(s);
      else if (tokens.every((t) => s.lower.includes(t) || (ALIASES[t] && s.lower.includes(ALIASES[t])))) contains.push(s);
    }
    return [...starts, ...contains].slice(0, limit).map((s) => {
      const st = this.stops[s.index];
      return { index: s.index, name: st[1], lat: st[2], lon: st[3] };
    });
  }

  // Abfahrten an einer Station (inkl. aller Steige), Zeiten relativ zu ymd
  departures(stationIdx, ymd, from, to, limit = 60) {
    const stopIdxs = new Set([stationIdx, ...(this.children.get(stationIdx) || [])]);
    const out = [];
    for (const sIdx of stopIdxs) {
      for (const [pid, pos] of this.stopPatterns.get(sIdx) || []) {
        const p = this.patterns[pid];
        if (pos === p.stops.length - 1) continue; // Endhalt: keine Abfahrt
        for (const dayOffset of [-1, 0, 1]) {
          const active = this.activeServices(addDays(ymd, dayOffset));
          const shift = dayOffset * DAY;
          for (const ti of this.patternTrips[pid]) {
            const t = this.trips[ti];
            if (!active.has(t.service)) continue;
            const dep = t.start + shift + this.profiles[t.profile][pos * 2 + 1];
            if (dep < from || dep > to) continue;
            const r = this.routes[p.route];
            out.push({ t: dep, line: r[0], type: r[1], color: r[2], textColor: r[3], headsign: p.headsign, platform: this.stops[sIdx][5], stop: sIdx, trip: t.id });
          }
        }
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out.slice(0, limit);
  }
}
