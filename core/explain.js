// Plain-language explanation of a flag, from the same residuals the detector uses.
import { STEPS_PER_DAY } from './fleet.js';

function fitLine(xs, ys) {
  const n = xs.length; if (n < 2) return { slope: 0, mean: ys[0] || 0 };
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  return { slope: sxx ? sxy / sxx : 0, mean: my };
}

export function classify(sim, A, u, k, d) {
  const series = k < 0 ? A.scores.mc[u] : A.scores.me[u][k];
  const live = [];
  for (let i = Math.max(sim.baselineDays, d - 27); i <= d; i++) if (A.scores.pDay[u][i] >= 0.3) live.push(i);
  const xs = live, ys = live.map(i => series[i]);
  const { slope } = fitLine(xs, ys);
  const recent = live.slice(-7).map(i => series[i]);
  const level = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
  const perMonth = slope * 30;
  if (k < 0) return { kind: Math.abs(perMonth) > 0.8 ? 'trend' : 'steady', level, perMonth };
  // frozen: the raw reading stops moving while the unit's power keeps moving
  const t1 = (d + 1) * STEPS_PER_DAY, t0 = t1 - 3 * STEPS_PER_DAY;
  const raw = Array.from(sim.temp[u][k].slice(t0, t1));
  const pw = Array.from(sim.P[u].slice(t0, t1));
  const sd = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
  if (sd(raw) < 0.05 && sd(pw) > 0.005) return { kind: 'frozen', level, perMonth, text: `the reading has not moved in 3 days while unit power did. Frozen transmitter or open junction; check the channel before the next outage.` };
  // noisy: 4-hour residual spread far above the position's normal spread
  const e = Array.from(A.res.e[u][k].slice(Math.max(0, t1 - 7 * STEPS_PER_DAY), t1));
  const ratio = sd(e) / A.scores.scaleE[k];
  if (ratio > 2.5) return { kind: 'noisy', level, perMonth, text: `intermittent spikes, residual spread ${ratio.toFixed(1)}× the position's normal. Check the connector and extension wire.` };
  if (Math.abs(perMonth) > 0.5 && Math.sign(perMonth) === Math.sign(level)) return { kind: 'drift', level, perMonth, text: `drifting ${perMonth >= 0 ? '+' : '−'}${Math.abs(perMonth).toFixed(1)} °C per month against its unit and the fleet (now ${level >= 0 ? '+' : '−'}${Math.abs(level).toFixed(1)} °C). Calibrate or replace at the next outage.` };
  return { kind: 'step', level, perMonth, text: `stepped to ${level >= 0 ? '+' : '−'}${Math.abs(level).toFixed(1)} °C and stayed there. Likely a termination or junction change; inspect the connection.` };
}

// 5th-95th percentile band of the same position across the other units, per day
export function fleetBand(sim, A, k, exclude) {
  const lo = new Float64Array(sim.D).fill(NaN), hi = new Float64Array(sim.D).fill(NaN);
  for (let d = sim.baselineDays; d < sim.D; d++) {
    const v = [];
    for (let u = 0; u < sim.U; u++) {
      if (u === exclude || A.scores.pDay[u][d] < 0.3) continue;
      v.push(k < 0 ? A.scores.mc[u][d] : A.scores.me[u][k][d]);
    }
    if (v.length < 5) continue;
    v.sort((a, b) => a - b);
    lo[d] = v[Math.floor(0.05 * (v.length - 1))]; hi[d] = v[Math.ceil(0.95 * (v.length - 1))];
  }
  return { lo, hi };
}
