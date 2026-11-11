// Fleet-referenced sensor validation with conformal test martingales.
//
// 1. Physics model, learned during the commissioning power ascension: the rise
//    from core inlet to each outlet thermocouple is y = b_uk * P / mdot + d_uk
//    (energy balance: dT = Q / (mdot cp), times the local peaking at that
//    position), with a per-channel installation offset d_uk.
// 2. Residuals split into a channel part e = r - median_k(r) and a unit-wide part
//    c = the shift that at least ~3/4 of the unit's channels share (cold-junction,
//    flow or power problems move every channel; one or two bad channels do not).
// 3. Every day, each channel's mean |e| is ranked against every other channel in
//    the fleet the same day (a conformal p-value: identical units are each other's
//    reference). Unit-common residuals are ranked against the other units.
// 4. p-values feed a Shiryaev-Roberts conformal martingale per stream. Under no
//    fault the p-values are uniform, R_n - n is a martingale, and the mean time to
//    a false alarm is at least the threshold A (days), with no distributional model.

import { STEPS_PER_DAY } from './fleet.js';

const median = a => { const s = Float64Array.from(a).sort(); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const mad = a => { const m = median(a); return 1.4826 * median(a.map(x => Math.abs(x - m))); };

export const DEFAULTS = { threshold: 1e6, unitThreshold: 3e5, quarantine: true, minPower: 0.3, tolerance: 1.0, unitTolerance: 1.0 };

// mixture betting function g(p) = integral_0^1 eps * p^(eps-1) d eps
export function bet(p) {
  const L = Math.log(p);
  if (Math.abs(L) < 1e-8) return 0.5;
  return (p * (L - 1) + 1) / (p * L * L);
}

export function fitModel(sim) {
  const { U, K, Tin, P, mdot, temp, baselineDays } = sim;
  const tb = baselineDays * STEPS_PER_DAY;
  const slope = [], icpt = [];
  for (let u = 0; u < U; u++) {
    slope.push([]); icpt.push([]);
    for (let k = 0; k < K; k++) {
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let t = 0; t < tb; t++) {
        const x = P[u][t] / mdot[u][t], y = temp[u][k][t] - Tin[u][t];
        sx += x; sy += y; sxx += x * x; sxy += x * y;
      }
      const b = (tb * sxy - sx * sy) / (tb * sxx - sx * sx);
      slope[u].push(b); icpt[u].push((sy - b * sx) / tb);
    }
  }
  // fleet profile (for display and as a sanity reference) and per-unit scale
  const a = [...Array(K).keys()].map(k => median(slope.map(r => r[k])));
  const s = slope.map(r => median(r.map((b, k) => b / a[k])));
  // each channel keeps its own commissioning slope and offset: local peaking
  // differs a little channel to channel (fuel loading), and the power ascension
  // makes the slope well identified
  return { a, s, b: slope, d: icpt, tb };
}

export function residuals(sim, model) {
  const { U, K, T, Tin, P, mdot, temp } = sim;
  const r = [], c = [], e = [], pred = [];
  for (let u = 0; u < U; u++) {
    const ru = [], pu = [];
    for (let k = 0; k < K; k++) {
      const x = new Float32Array(T), pr = new Float32Array(T);
      for (let t = 0; t < T; t++) {
        pr[t] = Tin[u][t] + model.b[u][k] * P[u][t] / mdot[u][t] + model.d[u][k];
        x[t] = temp[u][k][t] - pr[t];
      }
      ru.push(x); pu.push(pr);
    }
    const cu = new Float32Array(T), qu = new Float32Array(T);
    const tmp = new Float64Array(K);
    const q1 = Math.floor(0.25 * (K - 1)), q3 = Math.ceil(0.75 * (K - 1));
    for (let t = 0; t < T; t++) {
      for (let k = 0; k < K; k++) tmp[k] = ru[k][t];
      tmp.sort();
      cu[t] = K % 2 ? tmp[(K - 1) / 2] : (tmp[K / 2 - 1] + tmp[K / 2]) / 2;
      // consensus shift: only what at least ~3/4 of the channels share counts as
      // unit-wide (two drifting channels must not look like a unit fault)
      qu[t] = tmp[q1] > 0 ? tmp[q1] : tmp[q3] < 0 ? tmp[q3] : 0;
    }
    const eu = ru.map(x => x.map((v, t) => v - cu[t]));
    r.push(ru); c.push(qu); e.push(eu); pred.push(pu);
  }
  return { r, c, e, pred };
}

// Daily means, standardized with baseline scales (per position for e, fleet-wide for c)
export function dailyScores(sim, model, res, opts = {}) {
  const { U, K, D, baselineDays } = sim;
  const tb = model.tb;
  const scaleE = [...Array(K).keys()].map(k => { const v = []; for (let u = 0; u < U; u++) for (let t = 0; t < tb; t++) v.push(res.e[u][k][t]); return mad(v); });
  const vc = []; for (let u = 0; u < U; u++) for (let t = 0; t < tb; t++) vc.push(res.c[u][t]);
  const scaleC = mad(vc);
  const day = (x, d) => { let s = 0; for (let t = d * STEPS_PER_DAY; t < (d + 1) * STEPS_PER_DAY; t++) s += x[t]; return s / STEPS_PER_DAY; };
  // dead band: deviations inside the calibration tolerance carry no evidence
  const tol = opts.tolerance ?? DEFAULTS.tolerance, tolU = opts.unitTolerance ?? DEFAULTS.unitTolerance;
  const band = (v, t) => Math.sign(v) * Math.max(0, Math.abs(v) - t);
  const ze = [], zc = [], me = [], mc = [];
  for (let u = 0; u < U; u++) {
    const mu = [...Array(K).keys()].map(k => Float64Array.from({ length: D }, (_, d) => day(res.e[u][k], d)));
    me.push(mu);
    ze.push(mu.map((x, k) => x.map(v => band(v, tol) / scaleE[k])));
    const cu = Float64Array.from({ length: D }, (_, d) => day(res.c[u], d));
    mc.push(cu);
    zc.push(cu.map(v => band(v, tolU) / scaleC));
  }
  const pDay = [];
  for (let u = 0; u < U; u++) pDay.push(Float64Array.from({ length: D }, (_, d) => day(sim.P[u], d)));
  return { ze, zc, me, mc, scaleE, scaleC, pDay, tol, tolU, firstDay: baselineDays };
}

// Smoothed conformal p-value of |obs| among |refs|
function pval(obs, refs, uRand) {
  let gt = 0, eq = 0;
  const a = Math.abs(obs);
  for (const r of refs) { const b = Math.abs(r); if (b > a) gt++; else if (b === a) eq++; }
  return (gt + uRand * (eq + 1)) / (refs.length + 1);
}

export function detect(sim, scores, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { U, K, D } = sim;
  const { ze, zc, firstDay } = scores;
  let state = 987654321;
  const rnd = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
  const R = Array.from({ length: U }, () => new Float64Array(K));
  const Ru = new Float64Array(U);
  const alarmCh = Array.from({ length: U }, () => new Int32Array(K).fill(-1));
  const alarmU = new Int32Array(U).fill(-1);
  const trace = Array.from({ length: U }, () => Array.from({ length: K }, () => new Float64Array(D)));
  const traceU = Array.from({ length: U }, () => new Float64Array(D));
  const pCh = Array.from({ length: U }, () => Array.from({ length: K }, () => new Float64Array(D).fill(NaN)));
  for (let d = firstDay; d < D; d++) {
    // reference pool: every channel of every unit not quarantined and not in an alarmed unit
    const pool = [];
    for (let u = 0; u < U; u++) {
      if (o.quarantine && alarmU[u] >= 0 && alarmU[u] < d) continue;
      if (scores.pDay[u][d] < o.minPower) continue;
      for (let k = 0; k < K; k++) if (!(o.quarantine && alarmCh[u][k] >= 0 && alarmCh[u][k] < d)) pool.push({ u, k, v: ze[u][k][d] });
    }
    const unitPool = [];
    for (let u = 0; u < U; u++) if (!(o.quarantine && alarmU[u] >= 0 && alarmU[u] < d) && scores.pDay[u][d] >= o.minPower) unitPool.push({ u, v: zc[u][d] });
    const live = u => scores.pDay[u][d] >= o.minPower; // test at power only (outages and low power are skipped)
    for (let u = 0; u < U; u++) {
      if (!live(u)) { for (let k = 0; k < K; k++) trace[u][k][d] = R[u][k]; traceU[u][d] = Ru[u]; continue; }
      for (let k = 0; k < K; k++) {
        const refs = [];
        for (const q of pool) if (q.u !== u) refs.push(q.v);
        const p = pval(ze[u][k][d], refs, rnd());
        pCh[u][k][d] = p;
        R[u][k] = (R[u][k] + 1) * bet(p);
        trace[u][k][d] = R[u][k];
        if (alarmCh[u][k] < 0 && R[u][k] >= o.threshold) alarmCh[u][k] = d;
      }
      const refsU = unitPool.filter(q => q.u !== u).map(q => q.v);
      const pu = pval(zc[u][d], refsU, rnd());
      Ru[u] = (Ru[u] + 1) * bet(pu);
      traceU[u][d] = Ru[u];
      if (alarmU[u] < 0 && Ru[u] >= o.unitThreshold) alarmU[u] = d;
    }
  }
  return { alarmCh, alarmU, trace, traceU, pCh, threshold: o.threshold, unitThreshold: o.unitThreshold };
}

// ---- Baselines -------------------------------------------------------------

// (1) Fixed cross-check limit: a channel alarms when it disagrees with its own
// unit's other channels (after commissioning offsets) by more than `limit` degC.
export function fixedLimit(sim, res, limit = 10) {
  const { U, K, T } = sim;
  const alarm = Array.from({ length: U }, () => new Int32Array(K).fill(-1));
  const t0 = sim.baselineDays * STEPS_PER_DAY;
  for (let u = 0; u < U; u++) for (let k = 0; k < K; k++) {
    for (let t = t0; t < T; t++) if (sim.P[u][t] >= 0.3 && Math.abs(res.e[u][k][t]) > limit) { alarm[u][k] = Math.floor(t / STEPS_PER_DAY); break; }
  }
  return alarm;
}

// (2) Within-unit two-sided CUSUM on the same standardized daily channel residual.
// It sees only the unit's own channels, so it cannot see faults common to a unit.
export function withinUnitCusum(sim, scores, h = 12, kRef = 0.5) {
  const { U, K, D } = sim;
  const alarm = Array.from({ length: U }, () => new Int32Array(K).fill(-1));
  for (let u = 0; u < U; u++) for (let k = 0; k < K; k++) {
    let sp = 0, sn = 0;
    for (let d = scores.firstDay; d < D; d++) {
      if (scores.pDay[u][d] < 0.3) continue;
      const z = scores.ze[u][k][d];
      sp = Math.max(0, sp + z - kRef); sn = Math.max(0, sn - z - kRef);
      if (sp > h || sn > h) { alarm[u][k] = d; break; }
    }
  }
  return alarm;
}

// ---- Scoring against the simulator's fault list ------------------------------

export function score(sim, alarmCh, alarmU = null) {
  const { U, K, D, faults } = sim;
  const faultyCh = new Map(), faultyUnit = new Map();
  for (const f of faults) {
    if (f.k >= 0) faultyCh.set(f.u * K + f.k, f);
    else faultyUnit.set(f.u, f);
  }
  const rows = [];
  for (const f of faults) {
    const startDay = Math.floor(f.start / STEPS_PER_DAY);
    let det = -1;
    if (f.k >= 0) det = alarmCh[f.u][f.k];
    else {
      // a unit-wide fault counts as detected by a unit alarm, or by any channel alarm in that unit
      const cands = [];
      if (alarmU && alarmU[f.u] >= 0) cands.push(alarmU[f.u]);
      for (let k = 0; k < K; k++) if (alarmCh[f.u][k] >= 0) cands.push(alarmCh[f.u][k]);
      det = cands.length ? Math.min(...cands) : -1;
    }
    const ok = det >= startDay;
    rows.push({ ...f, startDay, detDay: ok ? det : -1, delay: ok ? det - startDay : null });
  }
  // false alarms: alarms on healthy channels in healthy units (or before a fault started)
  let falseCh = 0, healthy = 0, falseU = 0;
  for (let u = 0; u < U; u++) {
    const uf = faultyUnit.get(u);
    for (let k = 0; k < K; k++) {
      const f = faultyCh.get(u * K + k) || uf;
      const a = alarmCh[u][k];
      if (!f) { healthy++; if (a >= 0) falseCh++; }
      else if (a >= 0 && a < Math.floor(f.start / STEPS_PER_DAY)) falseCh++;
    }
    if (alarmU && alarmU[u] >= 0) {
      const f = uf;
      // strict: a unit-wide flag is false unless a unit-wide fault had started
      if (!f || alarmU[u] < Math.floor(f.start / STEPS_PER_DAY)) falseU++;
    }
  }
  const detected = rows.filter(r => r.detDay >= 0);
  const delays = detected.map(r => r.delay).sort((a, b) => a - b);
  return {
    rows, detected: detected.length, total: rows.length, falseCh, falseU, healthy,
    medianDelay: delays.length ? delays[Math.floor(delays.length / 2)] : null,
    byType: Object.fromEntries([...new Set(rows.map(r => r.type))].map(t => {
      const rs = rows.filter(r => r.type === t), dd = rs.filter(r => r.detDay >= 0).map(r => r.delay).sort((a, b) => a - b);
      return [t, { n: rs.length, detected: dd.length, medianDelay: dd.length ? dd[Math.floor(dd.length / 2)] : null }];
    })),
  };
}

export function runAll(sim, opts = {}) {
  const model = fitModel(sim);
  const res = residuals(sim, model);
  const scores = dailyScores(sim, model, res, opts);
  const det = detect(sim, scores, opts);
  const fixed = fixedLimit(sim, res, opts.limit ?? 10);
  const cusum = withinUnitCusum(sim, scores, opts.cusumH ?? 40);
  return {
    model, res, scores, det,
    ours: score(sim, det.alarmCh, det.alarmU),
    fixed: score(sim, fixed),
    cusum: score(sim, cusum),
    fixedAlarm: fixed, cusumAlarm: cusum,
  };
}
