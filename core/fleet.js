// Seeded simulator: a block of identical HTGR units on one gigasite, each with
// ten core-outlet thermocouples (named after the TE3401 channels in Valar's
// "Ward 250 By the Numbers" power-ascension plot), a neutron power channel,
// helium mass flow and core inlet temperature. Sampled every 4 hours.
// The simulator knows every fault it injects, so detectors can be scored.

export const CHANNELS = ['TE3401-094', 'TE3401-095', 'TE3401-097', 'TE3401-098', 'TE3401-099',
  'TE3401-100', 'TE3401-101', 'TE3401-103', 'TE3401-104', 'TE3401-105'];
// relative outlet temperature rise at each thermocouple position (design profile)
export const PROFILE = [1.12, 1.08, 1.15, 1.10, 0.96, 1.02, 1.18, 0.90, 0.78, 0.85];
export const STEPS_PER_DAY = 6;
export const START_DATE = '2027-01-04'; // day 0 of the simulated run

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const FAULT_TYPES = {
  drift: 'Calibration drift',
  step: 'Step offset',
  stuck: 'Frozen reading',
  noisy: 'Intermittent noise',
  cjc: 'Cold-junction offset (all channels in a unit)',
  flow: 'Flow meter drift (unit)',
};

export function simulate(seed = 20270104, opts = {}) {
  const rng = mulberry32(seed);
  const U = opts.units ?? 48, K = CHANNELS.length, D = opts.days ?? 180;
  const T = D * STEPS_PER_DAY;
  const baselineDays = opts.baselineDays ?? 21;
  const dT_full = 400, Tin0 = 300; // degC

  // operating profile per unit: steady industrial load with load-following and planned outages
  const P = [], Ptrue = [], mdot = [], mdotTrue = [], Tin = [];
  for (let u = 0; u < U; u++) {
    const base = 0.8 + 0.18 * rng();
    const amp = 0.04 + 0.1 * rng();
    const phase = rng() * 2 * Math.PI;
    const outages = [];
    const nOut = rng() < 0.6 ? 1 : 2;
    for (let i = 0; i < nOut; i++) { const s = Math.floor((baselineDays + 5 + rng() * (D - baselineDays - 10)) * STEPS_PER_DAY); outages.push([s, s + Math.floor((1.5 + rng() * 3) * STEPS_PER_DAY)]); }
    const pScale = 1 + 0.006 * gauss(rng); // static neutron power calibration error
    const p = new Float32Array(T), pt = new Float32Array(T), m = new Float32Array(T), mt = new Float32Array(T), ti = new Float32Array(T);
    let ramp = 0;
    for (let t = 0; t < T; t++) {
      const day = t / STEPS_PER_DAY;
      let level = base + amp * Math.sin(2 * Math.PI * day / 7 + phase) + 0.05 * Math.sin(2 * Math.PI * day + phase);
      // baseline period includes a power ramp test so slopes are identifiable
      // commissioning: power ascension from 10% in steps (like Ward 250's), then steady load
      if (day < baselineDays) level = day < 8 ? 0.1 + 0.15 * Math.floor(day / 1.33) : 0.85 + 0.08 * Math.sin(2 * Math.PI * day / 3);
      let out = false;
      for (const [s, e] of outages) if (t >= s && t < e) out = true;
      ramp = out ? Math.max(0.02, ramp - 0.25) : Math.min(level, ramp + 0.2);
      if (t === 0) ramp = level;
      const pw = Math.max(0.02, Math.min(1.02, ramp));
      pt[t] = pw;
      p[t] = pw * pScale * (1 + 0.002 * gauss(rng));
      const mf = 0.35 + 0.65 * pw;
      mt[t] = mf;
      m[t] = mf * (1 + 0.003 * gauss(rng));
      ti[t] = Tin0 + 12 * (pw - 0.8) + 0.4 * gauss(rng);
    }
    P.push(p); Ptrue.push(pt); mdot.push(m); mdotTrue.push(mt); Tin.push(ti);
  }

  // faults
  const faults = []; // {u, k (or -1 for unit-wide), type, start (step), size}
  const taken = new Set();
  const pickChannel = () => { let u, k; do { u = Math.floor(rng() * U); k = Math.floor(rng() * K); } while (taken.has(u * K + k)); taken.add(u * K + k); return [u, k]; };
  const onset = () => Math.floor((baselineDays + 14 + rng() * (D - baselineDays - 50)) * STEPS_PER_DAY);
  const n = opts.faults ?? { drift: 10, step: 6, stuck: 4, noisy: 4, cjc: 2, flow: 1 };
  for (let i = 0; i < n.drift; i++) { const [u, k] = pickChannel(); faults.push({ u, k, type: 'drift', start: onset(), size: (rng() < 0.5 ? -1 : 1) * (0.6 + 2.4 * rng()) }); } // degC per 30 days
  for (let i = 0; i < n.step; i++) { const [u, k] = pickChannel(); faults.push({ u, k, type: 'step', start: onset(), size: (rng() < 0.5 ? -1 : 1) * (3 + 7 * rng()) }); }
  for (let i = 0; i < n.stuck; i++) { const [u, k] = pickChannel(); faults.push({ u, k, type: 'stuck', start: onset(), size: 0 }); }
  for (let i = 0; i < n.noisy; i++) { const [u, k] = pickChannel(); faults.push({ u, k, type: 'noisy', start: onset(), size: 5 }); }
  const unitTaken = new Set(faults.map(f => f.u));
  const pickUnit = () => { let u; do { u = Math.floor(rng() * U); } while (unitTaken.has(u)); unitTaken.add(u); return u; };
  for (let i = 0; i < n.cjc; i++) faults.push({ u: pickUnit(), k: -1, type: 'cjc', start: onset(), size: (rng() < 0.5 ? -1 : 1) * (3 + 3 * rng()) });
  for (let i = 0; i < n.flow; i++) faults.push({ u: pickUnit(), k: -1, type: 'flow', start: onset(), size: -(0.01 + 0.015 * rng()) }); // fraction per 30 days

  // apply flow-meter faults to the measured flow
  for (const f of faults) if (f.type === 'flow') {
    for (let t = f.start; t < T; t++) mdot[f.u][t] *= 1 + f.size * (t - f.start) / (30 * STEPS_PER_DAY);
  }

  // thermocouple readings
  const temp = []; // temp[u][k] = Float32Array(T)
  for (let u = 0; u < U; u++) {
    const row = [];
    let proc = 0;
    const procNoise = new Float32Array(T);
    for (let t = 0; t < T; t++) { proc = 0.8 * proc + 1.2 * Math.sqrt(1 - 0.64) * gauss(rng); procNoise[t] = proc; }
    for (let k = 0; k < K; k++) {
      const offset = 3.5 * gauss(rng); // installation / fuel-loading variation
      const shape = PROFILE[k] * (1 + 0.02 * gauss(rng));
      const x = new Float32Array(T);
      let ar = 0;
      for (let t = 0; t < T; t++) {
        ar = 0.5 * ar + 0.9 * Math.sqrt(1 - 0.25) * gauss(rng);
        x[t] = Tin[u][t] + shape * dT_full * Ptrue[u][t] / mdotTrue[u][t] + offset + procNoise[t] + ar;
      }
      row.push(x);
    }
    temp.push(row);
  }
  for (const f of faults) {
    const ks = f.k >= 0 ? [f.k] : [...Array(K).keys()];
    if (f.type === 'flow') continue;
    for (const k of ks) {
      const x = temp[f.u][k];
      const frozen = x[f.start];
      for (let t = f.start; t < T; t++) {
        if (f.type === 'drift') x[t] += f.size * (t - f.start) / (30 * STEPS_PER_DAY);
        else if (f.type === 'step' || f.type === 'cjc') x[t] += f.size;
        else if (f.type === 'stuck') x[t] = frozen;
        else if (f.type === 'noisy') x[t] += (rng() < 0.3 ? 1 : 0) * f.size * 2.2 * gauss(rng);
      }
    }
  }
  const units = Array.from({ length: U }, (_, u) => ({ id: u, name: 'U-' + String(u + 1).padStart(3, '0') }));
  return { seed, U, K, D, T, baselineDays, P, mdot, Tin, temp, faults, units };
}
