import { simulate, FAULT_TYPES } from '../core/fleet.js';
import { runAll } from '../core/olm.js';
const seed = Number(process.argv[2] || 20270104);
const opts = JSON.parse(process.argv[3] || '{}');
const t0 = Date.now();
const sim = simulate(seed);
const a = runAll(sim, opts);
console.log('seed', seed, 'units', sim.U, 'channels', sim.U * sim.K, 'days', sim.D, 'ms', Date.now() - t0);
for (const [name, s] of [['fleet conformal', a.ours], ['within-unit CUSUM', a.cusum], ['fixed 10C limit', a.fixed]]) {
  console.log(name.padEnd(18), 'detected', s.detected + '/' + s.total, 'median delay', s.medianDelay, 'false ch', s.falseCh, 'false unit', s.falseU, 'healthy', s.healthy);
  console.log('   ', Object.entries(s.byType).map(([t, v]) => `${t} ${v.detected}/${v.n} d${v.medianDelay}`).join('  '));
}
console.log('profile a', a.model.a.map(x => x.toFixed(1)).join(' '));
for (const r of a.ours.rows) console.log(' ', r.type.padEnd(6), 'u', r.u, 'k', r.k, 'size', r.size.toFixed(3), 'start', r.startDay, 'ours', r.delay, 'cusum', a.cusum.rows.find(x => x.u === r.u && x.k === r.k && x.type === r.type).delay, 'fixed', a.fixed.rows.find(x => x.u === r.u && x.k === r.k && x.type === r.type).delay);
