// Laedt data/model.json und beantwortet Zeit- und Ortsanfragen. Keine Abhaengigkeiten, kein Netzwerk.

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
  // data: bereits geparstes data/model.json (laeuft in Node und im Browser)
  constructor(m) {
    this.meta = m.meta;
    this.routes = m.routes;
    this.stops = m.stops;
    this.patterns = m.patterns.map(([route, headsign, stops]) => ({ route, headsign, stops }));
    this.profiles = m.profiles;
    this.services = m.services;
    this.trips = m.trips.map(([service, pattern, profile, start, id, flags]) => ({ service, pattern, profile, start, id, flags: flags || 0 }));

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
      trips.push([trip.pattern, trip.id, start, trip.profile, trip.flags]);
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
            out.push({ t: dep, line: r[0], type: r[1], color: r[2], textColor: r[3], headsign: p.headsign, platform: this.stops[sIdx][5], stop: sIdx, trip: t.id, flags: t.flags });
          }
        }
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out.slice(0, limit);
  }

  // ---------- Linien ----------

  // Haeufigstes Muster je Fahrtrichtung einer Linie (Name wie im Fahrplan, z. B. "S1" oder "3")
  line(name) {
    // Richtung = Endhaltestelle (Station), je Richtung das haeufigste Muster
    const byEnd = new Map();
    this.patterns.forEach((p, pid) => {
      if (this.routes[p.route][0] !== name) return;
      const last = p.stops[p.stops.length - 1];
      const key = this.stops[last][4] >= 0 ? this.stops[last][4] : last;
      const trips = this.patternTrips[pid].length;
      const cur = byEnd.get(key);
      if (!cur || trips > cur.trips) byEnd.set(key, { route: p.route, headsign: p.headsign, stops: p.stops, trips });
    });
    return [...byEnd.values()].sort((a, b) => b.trips - a.trips).slice(0, 4);
  }

  // ---------- Verbindungssuche (RAPTOR) ----------

  _planIndex() {
    if (this._pi) return this._pi;
    const group = this.stops.map((s, i) => (s[4] >= 0 ? s[4] : i));
    const patGroups = this.patterns.map((p) => p.stops.map((i) => group[i]));
    const groupPatterns = new Map();
    patGroups.forEach((gs, pid) => gs.forEach((g, pos) => {
      if (!groupPatterns.has(g)) groupPatterns.set(g, []);
      groupPatterns.get(g).push([pid, pos]);
    }));
    // Fusswege zwischen Stationen bis 250 m
    const CELL = 0.004;
    const grid = new Map();
    const cellOf = (lat, lon) => `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;
    for (const g of groupPatterns.keys()) {
      const k = cellOf(this.stops[g][2], this.stops[g][3]);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(g);
    }
    const walk = new Map();
    for (const g of groupPatterns.keys()) {
      const lat = this.stops[g][2];
      const lon = this.stops[g][3];
      const kx = Math.cos((lat * Math.PI) / 180) * 111320;
      const cy = Math.floor(lat / CELL);
      const cx = Math.floor(lon / CELL);
      const out = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          for (const h of grid.get(`${cy + dy},${cx + dx}`) || []) {
            if (h === g) continue;
            const d = Math.hypot((this.stops[h][3] - lon) * kx, (this.stops[h][2] - lat) * 110540);
            if (d <= 250) out.push([h, Math.round(d / 1.2) + 30]);
          }
        }
      }
      if (out.length) walk.set(g, out);
    }
    this._pi = { group, patGroups, groupPatterns, walk };
    return this._pi;
  }

  // RAPTOR-Kern. dst < 0: ohne Zielpruning (fuer Erreichbarkeit). limit: spaeteste interessante Ankunft.
  _raptor(src, dst, ymd, depSec, { maxRounds = 4, window = 5 * 3600, minTransfer = 120, limit = Infinity } = {}) {
    const pi = this._planIndex();
    const N = this.stops.length;

    // Fahrten im Zeitfenster, gruppiert nach Muster
    const byPattern = new Map();
    for (const dayOffset of [-1, 0, 1]) {
      const shift = dayOffset * DAY;
      for (const sIdx of this.activeServices(addDays(ymd, dayOffset))) {
        for (const ti of this.tripsByService[sIdx]) {
          const t = this.trips[ti];
          const start = t.start + shift;
          if (start > depSec + window) continue;
          if (start + this.profileEnd[t.profile] < depSec) continue;
          let list = byPattern.get(t.pattern);
          if (!list) byPattern.set(t.pattern, (list = []));
          list.push({ ti, start });
        }
      }
    }
    for (const list of byPattern.values()) list.sort((a, b) => a.start - b.start);

    const best = new Float64Array(N).fill(Infinity);
    const dstBest = () => (dst >= 0 ? best[dst] : Infinity);
    let prevTau = new Float64Array(N).fill(Infinity);
    let prevBuf = new Float64Array(N);
    const parents = [];

    const relaxWalk = (tau, buf, par, fromSet) => {
      const added = [];
      for (const g of fromSet) {
        const here = par.get(g);
        if (here && here.type === 'walk') continue; // keine Fussweg-Ketten
        for (const [h, secs] of pi.walk.get(g) || []) {
          const t = tau[g] + secs;
          if (t < best[h] && t <= limit) {
            tau[h] = t;
            buf[h] = 0;
            best[h] = t;
            par.set(h, { type: 'walk', from: g, secs });
            added.push(h);
          }
        }
      }
      return added;
    };

    // Runde 0: Start, plus Fusswege
    const tau0 = Float64Array.from(prevTau);
    const buf0 = Float64Array.from(prevBuf);
    const par0 = new Map();
    tau0[src] = depSec;
    best[src] = depSec;
    let marked = new Set([src, ...relaxWalk(tau0, buf0, par0, [src])]);
    parents.push(par0);
    prevTau = tau0;
    prevBuf = buf0;

    const roundsReachingDst = [];
    for (let k = 1; k <= maxRounds && marked.size; k++) {
      const tau = Float64Array.from(prevTau);
      const buf = Float64Array.from(prevBuf);
      const par = new Map();
      const queue = new Map();
      for (const g of marked) {
        for (const [pid, pos] of pi.groupPatterns.get(g) || []) {
          if (!byPattern.has(pid)) continue;
          const cur = queue.get(pid);
          if (cur === undefined || pos < cur) queue.set(pid, pos);
        }
      }
      const rideEnds = [];
      for (const [pid, startPos] of queue) {
        const gs = pi.patGroups[pid];
        const list = byPattern.get(pid);
        let cur = null;
        let boardPos = -1;
        for (let pos = startPos; pos < gs.length; pos++) {
          const g = gs[pos];
          if (cur) {
            const arr = cur.start + this.profiles[this.trips[cur.ti].profile][2 * pos];
            if (arr < best[g] && arr < dstBest() && arr <= limit) {
              tau[g] = arr;
              buf[g] = minTransfer;
              best[g] = arr;
              par.set(g, { type: 'ride', pid, ti: cur.ti, start: cur.start, boardPos, alightPos: pos });
              rideEnds.push(g);
            }
          }
          const ready = prevTau[g] + prevBuf[g];
          if (ready < Infinity && pos < gs.length - 1) {
            let found = null;
            let foundDep = Infinity;
            for (const c of list) {
              const dep = c.start + this.profiles[this.trips[c.ti].profile][2 * pos + 1];
              if (dep >= ready && dep < foundDep) { found = c; foundDep = dep; }
            }
            if (found) {
              const curDep = cur ? cur.start + this.profiles[this.trips[cur.ti].profile][2 * pos + 1] : Infinity;
              if (foundDep < curDep) { cur = found; boardPos = pos; }
            }
          }
        }
      }
      const added = relaxWalk(tau, buf, par, rideEnds);
      marked = new Set([...rideEnds, ...added]);
      parents.push(par);
      prevTau = tau;
      prevBuf = buf;
      if (dst >= 0 && par.has(dst)) roundsReachingDst.push(k);
    }
    return { pi, parents, best, roundsReachingDst };
  }

  // Frueheste Ankunft mit 0 bis maxRounds Umstiegen. Zeiten in Sekunden seit 00:00 von ymd.
  plan(fromIdx, toIdx, ymd, depSec, opts = {}) {
    const pi = this._planIndex();
    const src = pi.group[fromIdx];
    const dst = pi.group[toIdx];
    if (src === dst) return [];
    const { parents, roundsReachingDst } = this._raptor(src, dst, ymd, depSec, opts);

    const build = (k) => {
      const legs = [];
      let kk = k;
      let g = dst;
      for (let guard = 0; guard < 40; guard++) {
        let p = parents[kk].get(g);
        while (!p && kk > 0) { kk--; p = parents[kk].get(g); }
        if (!p) break;
        if (p.type === 'walk') {
          legs.push({ type: 'walk', from: p.from, to: g, secs: p.secs });
          g = p.from;
          continue;
        }
        const t = this.trips[p.ti];
        const pat = this.patterns[p.pid];
        const prof = this.profiles[t.profile];
        const route = this.routes[pat.route];
        legs.push({
          type: 'ride', line: route[0], routeType: route[1], color: route[2], textColor: route[3], headsign: pat.headsign,
          trip: t.id, flags: t.flags, from: pi.patGroups[p.pid][p.boardPos], to: g,
          dep: p.start + prof[2 * p.boardPos + 1], arr: p.start + prof[2 * p.alightPos],
          stops: pat.stops.slice(p.boardPos, p.alightPos + 1),
        });
        g = pi.patGroups[p.pid][p.boardPos];
        kk--;
        if (kk < 0) break;
      }
      legs.reverse();
      return legs;
    };

    return roundsReachingDst.map((k) => {
      const legs = build(k);
      const rides = legs.filter((l) => l.type === 'ride');
      if (!rides.length) return null;
      let arr = rides[rides.length - 1].arr;
      const last = legs[legs.length - 1];
      if (last.type === 'walk') arr += last.secs;
      return { dep: rides[0].dep, arr, transfers: rides.length - 1, legs };
    }).filter(Boolean);
  }

  // Alle Stationen, die ab fromIdx in maxMinutes erreichbar sind: Liste [Stationsindex, Minuten]
  reach(fromIdx, ymd, depSec, maxMinutes = 30) {
    const pi = this._planIndex();
    const src = pi.group[fromIdx];
    const limit = depSec + maxMinutes * 60;
    const { best } = this._raptor(src, -1, ymd, depSec, { window: maxMinutes * 60, limit });
    const out = [];
    for (let g = 0; g < best.length; g++) {
      if (g !== src && best[g] <= limit) out.push([g, Math.max(1, Math.round((best[g] - depSec) / 60))]);
    }
    return out;
  }

  // Abfahrten pro Station im Zeitfenster [from, to): Liste [Stationsindex, Anzahl]
  frequency(ymd, from, to) {
    const key = `${ymd}|${from}|${to}`;
    this._freq = this._freq || new Map();
    if (this._freq.has(key)) return this._freq.get(key);
    const counts = new Map();
    for (const { trip, start } of this.activeTrips(ymd, from, to)) {
      const p = this.patterns[trip.pattern];
      const prof = this.profiles[trip.profile];
      for (let i = 0; i < p.stops.length - 1; i++) {
        const dep = start + prof[2 * i + 1];
        if (dep < from || dep >= to) continue;
        const si = p.stops[i];
        const g = this.stops[si][4] >= 0 ? this.stops[si][4] : si;
        counts.set(g, (counts.get(g) || 0) + 1);
      }
    }
    const out = [...counts];
    this._freq.set(key, out);
    if (this._freq.size > 12) this._freq.delete(this._freq.keys().next().value);
    return out;
  }

  // Alle befahrenen Haltepaare mit Verkehrsmittel-Gruppe (fuer die Hintergrundkarte ohne Kacheln)
  network() {
    const seen = new Map();
    for (const p of this.patterns) {
      const type = this.routes[p.route][1];
      const g = type === 0 || type === 1 ? 0 : type === 2 ? 1 : 2;
      for (let i = 1; i < p.stops.length; i++) {
        const a = p.stops[i - 1];
        const b = p.stops[i];
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        const old = seen.get(key);
        if (old === undefined || g < old) seen.set(key, g);
      }
    }
    return [...seen].map(([k, g]) => { const [a, b] = k.split(',').map(Number); return [a, b, g]; });
  }
}
