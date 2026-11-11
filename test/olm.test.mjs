import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, PROFILE, STEPS_PER_DAY } from '../core/fleet.js';
import { runAll, bet, fitModel, residuals, dailyScores, detect, score } from '../core/olm.js';
import { classify } from '../core/explain.js';

const cache = new Map();
const run = (seed, opts = {}) => {
  const key = seed + JSON.stringify(opts);
  if (!cache.has(key)) { const sim = simulate(seed); cache.set(key, { sim, a: runAll(sim, opts) }); }
  return cache.get(key);
};

test('simulator is deterministic and injects the declared faults', () => {
  const a = simulate(3), b = simulate(3);
  assert.deepEqual(Array.from(a.temp[5][2].slice(0, 40)), Array.from(b.temp[5][2].slice(0, 40)));
  assert.equal(a.faults.length, 27);
  assert.ok(a.faults.every(f => f.start >= (a.baselineDays + 14) * STEPS_PER_DAY), 'no faults during commissioning');
  assert.equal(a.faults.filter(f => f.k < 0).length, 3);
});

test('betting function: integrates to 1 over uniform p and rewards small p', () => {
  // integrate g(p) dp with p = exp(-x) on a log-spaced x grid (the integrand has a 1/(p ln^2 p) spike at 0)
  const n = 200000, X = Math.log(1e6 + 1);
  let s = 0, prevX = 0, prevF = bet(1 - 1e-12);
  for (let i = 1; i <= n; i++) {
    const x = Math.expm1(X * i / n), p = Math.exp(-x), f = p > 1e-300 ? bet(p) * p : 1 / (x * x);
    s += 0.5 * (f + prevF) * (x - prevX); prevX = x; prevF = f;
  }
  assert.ok(Math.abs(s - 1) < 2e-3, String(s));
  assert.ok(bet(0.01) > 4 && bet(0.001) > 20 && bet(0.5) < 1);
});

test('commissioning fit recovers the design profile from the power ascension', () => {
  const sim = simulate(20270104);
  const m = fitModel(sim);
  const ratio = m.a.map((x, k) => x / 400 / PROFILE[k]);
  for (const r of ratio) assert.ok(Math.abs(r - 1) < 0.03, String(r));
});

test('healthy p-values are uniform (the conformal guarantee holds in the simulator)', () => {
  const { sim, a } = run(20270104);
  const faultUnits = new Set(sim.faults.map(f => f.u));
  const h = new Array(10).fill(0); let n = 0;
  for (let u = 0; u < sim.U; u++) {
    if (faultUnits.has(u)) continue;
    for (let k = 0; k < sim.K; k++) for (let d = sim.baselineDays; d < sim.D; d++) {
      const p = a.det.pCh[u][k][d]; if (Number.isNaN(p)) continue; h[Math.min(9, Math.floor(p * 10))]++; n++;
    }
  }
  // chi-square against uniform, 9 df: 99.9% critical value is 27.9
  const chi = h.reduce((s, x) => s + (x - n / 10) ** 2 / (n / 10), 0);
  assert.ok(chi < 27.9, 'chi2 ' + chi.toFixed(1));
});

test('demo seed: every fault caught, no false alarms, beats both baselines', () => {
  const { a } = run(20270104);
  assert.equal(a.ours.detected, a.ours.total);
  assert.equal(a.ours.falseCh + a.ours.falseU, 0);
  assert.ok(a.ours.detected > a.cusum.detected && a.ours.detected > a.fixed.detected);
  // unit-wide faults: invisible to within-reactor checks, caught by the fleet
  for (const t of ['cjc']) {
    assert.equal(a.ours.byType[t].detected, a.ours.byType[t].n);
    assert.equal(a.cusum.byType[t].detected, 0);
    assert.equal(a.fixed.byType[t].detected, 0);
  }
});

test('held-out seeds: >= 95% of faults caught, few false alarms', () => {
  let det = 0, tot = 0, fa = 0, faU = 0;
  for (const seed of [101, 102, 103, 104]) {
    const { a } = run(seed);
    det += a.ours.detected; tot += a.ours.total; fa += a.ours.falseCh; faU += a.ours.falseU;
  }
  assert.ok(det / tot >= 0.95, `${det}/${tot}`);
  assert.ok(fa <= 1, 'channel false alarms ' + fa);
  assert.ok(faU <= 2, 'unit false alarms ' + faU);
});

test('alarms never fire before the fault on faulty channels in the demo run', () => {
  const { sim, a } = run(20270104);
  for (const f of sim.faults) if (f.k >= 0) {
    const al = a.det.alarmCh[f.u][f.k];
    assert.ok(al < 0 || al >= Math.floor(f.start / STEPS_PER_DAY), `${f.type} u${f.u} k${f.k}`);
  }
});

test('explanations match the injected fault type for channel faults', () => {
  const { sim, a } = run(20270104);
  let right = 0, n = 0;
  for (const f of sim.faults) {
    if (f.k < 0) continue;
    const d0 = a.det.alarmCh[f.u][f.k]; if (d0 < 0) continue;
    const c = classify(sim, a, f.u, f.k, Math.min(sim.D - 1, d0 + 7));
    const want = { drift: 'drift', step: 'step', stuck: 'frozen', noisy: 'noisy' }[f.type];
    n++; if (c.kind === want) right++;
  }
  assert.ok(right / n >= 0.75, `${right}/${n}`);
});

test('scoring: an alarm before a fault starts counts as false', () => {
  const sim = simulate(20270104);
  const f = sim.faults.find(x => x.k >= 0);
  const alarms = Array.from({ length: sim.U }, () => new Int32Array(sim.K).fill(-1));
  alarms[f.u][f.k] = Math.floor(f.start / STEPS_PER_DAY) - 1;
  const s = score(sim, alarms);
  assert.equal(s.falseCh, 1);
  assert.equal(s.detected, 0);
});
