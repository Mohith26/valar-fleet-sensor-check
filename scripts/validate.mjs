// Fresh simulated half-years (seeds not used for tuning), totals across all runs.
import { simulate } from '../core/fleet.js';
import { runAll } from '../core/olm.js';
const n = Number(process.argv[2] || 20);
const tot = {};
const add = (name, s) => {
  const t = (tot[name] ||= { det: 0, n: 0, fa: 0, faU: 0, delays: [], byType: {} });
  t.det += s.detected; t.n += s.total; t.fa += s.falseCh; t.faU += s.falseU;
  t.delays.push(...s.rows.filter(r => r.detDay >= 0).map(r => r.delay));
  for (const [k, v] of Object.entries(s.byType)) { const b = (t.byType[k] ||= { det: 0, n: 0 }); b.det += v.detected; b.n += v.n; }
};
let healthy = 0;
for (let i = 0; i < n; i++) {
  const sim = simulate(1000 + i);
  const a = runAll(sim);
  add('fleet conformal', a.ours); add('within-unit CUSUM', a.cusum); add('fixed 10C limit', a.fixed);
  healthy += a.ours.healthy;
}
console.log(`${n} simulated 48-unit blocks x 180 days (seeds 1000-${1000 + n - 1}); ${healthy} healthy channel-runs`);
for (const [name, t] of Object.entries(tot)) {
  const d = t.delays.sort((x, y) => x - y);
  console.log(`${name.padEnd(18)} caught ${t.det}/${t.n} (${(100 * t.det / t.n).toFixed(1)}%), median delay ${d[Math.floor(d.length / 2)]} d, false channel alarms ${t.fa}, false unit alarms ${t.faU}`);
  console.log('   ' + Object.entries(t.byType).map(([k, v]) => `${k} ${v.det}/${v.n}`).join('  '));
}
