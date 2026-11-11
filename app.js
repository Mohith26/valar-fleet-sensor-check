import { simulate, CHANNELS, STEPS_PER_DAY, START_DATE, FAULT_TYPES } from './core/fleet.js';
import { runAll, score } from './core/olm.js';
import { classify, fleetBand } from './core/explain.js';

const params = new URLSearchParams(location.search);
const SEED = Number(params.get('seed') || 20270104);
const sim = simulate(SEED);
const A = runAll(sim);
const { det } = A;
const K = sim.K, U = sim.U;
const $ = s => document.querySelector(s);
const fmt = (x, d = 1) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d);
const dateOf = d => { const t = new Date(START_DATE + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); };
const log10 = x => Math.log10(Math.max(1, x));
const CH_TH = Math.log10(det.threshold), U_TH = Math.log10(det.unitThreshold);
const sup = n => String(n).split('').map(c => '⁰¹²³⁴⁵⁶⁷⁸⁹'[c]).join('');
const thr = v => { const e = Math.floor(Math.log10(v)), m = Math.round(v / 10 ** e); return (m > 1 ? m + '×' : '') + '10' + sup(e); };

const firstUnitFault = sim.faults.find(f => f.type === 'cjc');
const state = {
  day: Number(params.get('day') || sim.D - 1),
  unit: params.has('unit') ? Number(params.get('unit')) : (firstUnitFault ? firstUnitFault.u : 0),
  ch: params.has('ch') ? Number(params.get('ch')) : -1,
  tab: params.get('tab') || 'dev',
};

const chStatus = (u, k, d) => {
  const a = det.alarmCh[u][k];
  if (a >= 0 && a <= d) return 'a';
  return log10(det.trace[u][k][d]) >= 2 ? 'w' : 'ok';
};
const unitAlarm = (u, d) => det.alarmU[u] >= 0 && det.alarmU[u] <= d;

function scoreAt(d, which) {
  // restrict the run to days <= d: alarms after d do not exist yet, faults after d have not started
  const cut = arr => arr.map(r => Int32Array.from(r, v => (v >= 0 && v <= d ? v : -1)));
  const ach = which === 'ours' ? cut(det.alarmCh) : which === 'cusum' ? cut(A.cusumAlarm) : cut(A.fixedAlarm);
  const au = which === 'ours' ? Int32Array.from(det.alarmU, v => (v >= 0 && v <= d ? v : -1)) : null;
  const s = score({ ...sim, faults: sim.faults.filter(f => Math.floor(f.start / STEPS_PER_DAY) <= d) }, ach, au);
  return s;
}

function renderHeader() {
  $('#clock').textContent = `Day ${state.day} · ${dateOf(state.day)}`;
  $('#lede').innerHTML = `Every unit on a gigasite is built to one design, so each thermocouple can be checked against the same position in ${U - 1} other units every day. A conformal test martingale turns that comparison into an alarm with a bounded false-alarm rate, and it sees faults that hit a whole unit at once, which within-reactor cross-checks cannot.`;
}

function renderKpis() {
  const d = state.day;
  const s = scoreAt(d, 'ours');
  const flaggedCh = det.alarmCh.reduce((n, r) => n + r.filter(v => v >= 0 && v <= d).length, 0);
  const flaggedU = Array.from(det.alarmU).filter(v => v >= 0 && v <= d).length;
  let calib = 0;
  for (let u = 0; u < U; u++) if (!unitAlarm(u, d)) for (let k = 0; k < K; k++) if (det.alarmCh[u][k] >= 0 && det.alarmCh[u][k] <= d) calib++;
  $('#kpis').innerHTML = `
    <div class="kpi gold"><div class="lbl">Faults caught</div><div class="v">${s.detected}<small>of ${s.total}</small></div><div class="s">Injected by the simulator up to day ${d}</div></div>
    <div class="kpi"><div class="lbl">False alarms</div><div class="v">${s.falseCh + s.falseU}<small>on ${s.healthy} healthy channels</small></div><div class="s">Thresholds ${thr(det.threshold)} per channel, ${thr(det.unitThreshold)} per unit (Shiryaev–Roberts)</div></div>
    <div class="kpi"><div class="lbl">Median time to flag</div><div class="v">${s.medianDelay ?? '—'}<small>days</small></div><div class="s">Steps and frozen readings in 3–5 days; slow drifts take longer</div></div>
    <div class="kpi"><div class="lbl">Calibrate at next outage</div><div class="v">${calib}<small>of ${U * K} channels</small></div><div class="s">plus ${flaggedU} unit-level checks (reference junction, flow, power); the rest stay in service</div></div>`;
}

function renderFleet() {
  const d = state.day;
  $('#fleet').innerHTML = sim.units.map(un => {
    const u = un.id;
    const cells = CHANNELS.map((_, k) => `<i class="${chStatus(u, k, d) === 'ok' ? '' : chStatus(u, k, d)}"></i>`).join('');
    const ua = unitAlarm(u, d);
    const off = A.scores.pDay[u][d] < 0.3;
    return `<div class="tile ${u === state.unit ? 'sel' : ''} ${ua ? 'ualarm' : ''} ${off ? 'off' : ''}" data-u="${u}"><div class="tn"><span>${un.name}</span>${ua ? '<b>UNIT</b>' : off ? '<span>OUTAGE</span>' : `<span>${Math.round(100 * A.scores.pDay[u][d])}%</span>`}</div><div class="cells">${cells}</div></div>`;
  }).join('');
  document.querySelectorAll('.tile').forEach(t => t.onclick = () => { state.unit = Number(t.dataset.u); state.ch = -1; renderAll(); });
  $('#daylbl').textContent = `Day ${d} · ${dateOf(d)}`;
}

function ringSVG(u, d) {
  const R = 54, cx = 80, cy = 80;
  const dots = CHANNELS.map((name, k) => {
    const ang = -Math.PI / 2 + k * 2 * Math.PI / K;
    const x = cx + R * Math.cos(ang), y = cy + R * Math.sin(ang);
    const lx = cx + (R + 17) * Math.cos(ang), ly = cy + (R + 17) * Math.sin(ang) + 3;
    const st = chStatus(u, k, d);
    const fill = st === 'a' ? '#e9b709' : st === 'w' ? '#6e5806' : '#3a3a3a';
    return `<g data-k="${k}" style="cursor:pointer"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${k === state.ch ? 7.5 : 6}" fill="${fill}" stroke="${k === state.ch ? '#fff' : '#000'}" stroke-width="1.5"/><text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${name.slice(-3)}</text></g>`;
  }).join('');
  const ua = unitAlarm(u, d);
  return `<svg class="ring" viewBox="0 0 160 160" width="160" height="160"><circle cx="${cx}" cy="${cy}" r="${R - 16}" fill="none" stroke="${ua ? '#e9b709' : '#2b2b2b'}" stroke-width="${ua ? 1.5 : 1}"/><circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#1d1d1d"/>${dots}<text x="${cx}" y="${cy - 2}" text-anchor="middle" style="fill:${ua ? '#e9b709' : '#5d5d5d'}">CORE</text><text x="${cx}" y="${cy + 9}" text-anchor="middle" style="fill:#5d5d5d">OUTLET</text></svg>`;
}

function renderUnit() {
  const u = state.unit, d = state.day, un = sim.units[u];
  const t = d * STEPS_PER_DAY + 3;
  const ua = unitAlarm(u, d);
  const nA = CHANNELS.filter((_, k) => chStatus(u, k, d) === 'a').length;
  const stat = ua ? `<span class="ustat alarm">Unit-wide flag · day ${det.alarmU[u]}</span>` : nA ? `<span class="ustat alarm">${nA} channel flag${nA > 1 ? 's' : ''}</span>` : '<span class="ustat">Nominal</span>';
  const rows = CHANNELS.map((name, k) => {
    const t0 = d * STEPS_PER_DAY, avg = arr => { let x = 0; for (let i = t0; i < t0 + STEPS_PER_DAY; i++) x += arr[i]; return x / STEPS_PER_DAY; };
    const meas = avg(sim.temp[u][k]), pred = avg(A.res.pred[u][k]);
    const ev = log10(det.trace[u][k][d]);
    const st = chStatus(u, k, d);
    return `<tr data-k="${k}" class="${k === state.ch ? 'sel' : ''}"><td>${name}</td><td>${meas.toFixed(1)}</td><td>${pred.toFixed(1)}</td><td>${fmt(meas - pred)}</td><td><span class="ev"><i class="${st === 'ok' ? '' : st}" style="width:${Math.min(100, 100 * ev / CH_TH).toFixed(0)}%"></i></span></td><td><span class="st ${st}">${st === 'a' ? 'Flag' : st === 'w' ? 'Watch' : 'OK'}</span></td></tr>`;
  }).join('');
  let note = '';
  if (ua) {
    const c = classify(sim, A, u, -1, d);
    note = `<div class="unote">All ${K} channels read ${fmt(c.level)}°C against the energy balance (P / ṁ) while still agreeing with each other. ${c.kind === 'trend' ? 'The offset is growing, which points at a flow or power channel.' : 'The offset is steady, which points at a cold-junction or reference fault.'} No within-reactor cross-check can see this; the other ${U - 1} units can.</div>`;
  } else if (state.ch >= 0 && chStatus(u, state.ch, d) === 'a') {
    const c = classify(sim, A, u, state.ch, d);
    note = `<div class="unote">${CHANNELS[state.ch]}: ${c.text}</div>`;
  } else if (nA) {
    const k = CHANNELS.findIndex((_, kk) => chStatus(u, kk, d) === 'a');
    const c = classify(sim, A, u, k, d);
    note = `<div class="unote">${CHANNELS[k]}: ${c.text}</div>`;
  }
  $('#unit').innerHTML = `
    <div class="uh"><div><div class="uname">${un.name}</div><div class="umeta">Power ${Math.round(100 * sim.P[u][t])}% · inlet ${sim.Tin[u][t].toFixed(0)}°C · He flow ${(100 * sim.mdot[u][t]).toFixed(0)}% · day ${d}</div></div>${stat}</div>
    <div class="ubody">${ringSVG(u, d)}
      <table class="ch"><thead><tr><th>Channel</th><th>Day avg °C</th><th>Expected</th><th>Δ</th><th>Evidence</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    </div>${note}`;
  document.querySelectorAll('#unit tr[data-k], #unit g[data-k]').forEach(r => r.onclick = () => { state.ch = Number(r.dataset.k); renderAll(); });
}

function lineChart({ series, bands = [], vlines = [], hlines = [], yLabel, height = 230, x0 }) {
  const W = 760, H = height, L = 46, Rr = 12, T = 12, B = 26;
  const allY = series.flatMap(s => s.y.filter(v => Number.isFinite(v))).concat(bands.flatMap(b => [...b.lo, ...b.hi].filter(Number.isFinite))).concat(hlines.map(h => h.y));
  let ymin = Math.min(...allY), ymax = Math.max(...allY);
  const pad = (ymax - ymin) * 0.08 || 1; ymin -= pad; ymax += pad;
  const n = series[0].y.length;
  const X = i => L + (i - x0) / (n - 1 - x0) * (W - L - Rr), Y = v => T + (ymax - v) / (ymax - ymin) * (H - T - B);
  const ticks = []; const step = Math.pow(10, Math.floor(Math.log10((ymax - ymin) / 4))); const st = (ymax - ymin) / step > 8 ? step * 2 : step;
  for (let v = Math.ceil(ymin / st) * st; v <= ymax; v += st) ticks.push(v);
  const grid = ticks.map(v => `<line x1="${L}" x2="${W - Rr}" y1="${Y(v)}" y2="${Y(v)}" stroke="#191919"/><text x="${L - 6}" y="${Y(v) + 3}" text-anchor="end">${+v.toFixed(2)}</text>`).join('');
  const xt = []; for (let i = Math.ceil(x0 / 30) * 30; i < n; i += 30) xt.push(i);
  const xg = xt.map(i => `<text x="${X(i)}" y="${H - 8}" text-anchor="middle">D${i}</text>`).join('');
  const path = y => { let s = '', pen = false; for (let i = x0; i < n; i++) { if (!Number.isFinite(y[i])) { pen = false; continue; } s += (pen ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(y[i]).toFixed(1); pen = true; } return s; };
  const bandP = b => { let top = '', bot = ''; for (let i = x0; i < n; i++) { if (!Number.isFinite(b.lo[i])) continue; top += (top ? 'L' : 'M') + X(i).toFixed(1) + ',' + Y(b.hi[i]).toFixed(1); } for (let i = n - 1; i >= x0; i--) { if (!Number.isFinite(b.lo[i])) continue; bot += 'L' + X(i).toFixed(1) + ',' + Y(b.lo[i]).toFixed(1); } return top + bot + 'Z'; };
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">${grid}${xg}
    ${bands.map(b => `<path d="${bandP(b)}" fill="${b.fill}"/>`).join('')}
    ${hlines.map(h => `<line x1="${L}" x2="${W - Rr}" y1="${Y(h.y)}" y2="${Y(h.y)}" stroke="${h.color}" stroke-dasharray="${h.dash || ''}"/>${h.label ? `<text x="${W - Rr - 4}" y="${Y(h.y) - 5}" text-anchor="end" style="fill:${h.color}">${h.label}</text>` : ''}`).join('')}
    ${vlines.map(v => `<line x1="${X(v.x)}" x2="${X(v.x)}" y1="${T}" y2="${H - B}" stroke="${v.color}" stroke-dasharray="${v.dash || ''}"/><text x="${X(v.x) + 4}" y="${T + 10 + (v.row || 0) * 12}" style="fill:${v.color}">${v.label}</text>`).join('')}
    ${series.map(s => `<path d="${path(s.y)}" fill="none" stroke="${s.color}" stroke-width="${s.w || 1.6}"/>`).join('')}
    <line x1="${X(state.day)}" x2="${X(state.day)}" y1="${T}" y2="${H - B}" stroke="#444"/>
  </svg>`;
}

function renderChart() {
  const u = state.unit, k = state.ch, d0 = sim.baselineDays;
  const unitView = k < 0;
  const name = unitView ? `${sim.units[u].name} · unit-common deviation` : `${sim.units[u].name} · ${CHANNELS[k]}`;
  const fault = sim.faults.find(f => f.u === u && (unitView ? f.k < 0 : f.k === k));
  const alarm = unitView ? det.alarmU[u] : det.alarmCh[u][k];
  const vlines = [];
  if (fault && Math.floor(fault.start / STEPS_PER_DAY) <= state.day) vlines.push({ x: Math.floor(fault.start / STEPS_PER_DAY), color: '#777', dash: '3 3', label: `Fault injected (sim): ${FAULT_TYPES[fault.type].toLowerCase()}` });
  if (alarm >= 0 && alarm <= state.day) vlines.push({ x: alarm, color: '#e9b709', label: `Flagged day ${alarm}`, row: 1 });
  const y = unitView ? Array.from(A.scores.mc[u]) : Array.from(A.scores.me[u][k]);
  const yy = y.map((v, i) => (A.scores.pDay[u][i] < 0.3 || i > state.day ? NaN : v));
  const band = fleetBand(sim, A, unitView ? -1 : k, u);
  for (let i = state.day + 1; i < sim.D; i++) { band.lo[i] = NaN; band.hi[i] = NaN; }
  const svg1 = lineChart({ series: [{ y: yy, color: '#ffffff' }], bands: [{ lo: band.lo, hi: band.hi, fill: 'rgba(255,255,255,0.08)' }], hlines: [{ y: A.scores.tol, color: '#3a3a3a', dash: '2 3' }, { y: -A.scores.tol, color: '#3a3a3a', dash: '2 3', label: '±1 °C tolerance' }], vlines, x0: d0, height: 210 });
  const tr = unitView ? det.traceU[u] : det.trace[u][k];
  const cap = 2 * (unitView ? U_TH : CH_TH);
  const svg2 = lineChart({ series: [{ y: Array.from(tr, (v, i) => (i > state.day ? NaN : Math.min(cap, log10(v)))), color: '#e9b709' }], hlines: [{ y: unitView ? U_TH : CH_TH, color: '#e9b709', dash: '4 3', label: `alarm threshold ${thr(unitView ? det.unitThreshold : det.threshold)}` }], vlines: vlines.filter(v => v.color === '#e9b709').map(v => ({ ...v, label: '' })), x0: d0, height: 130 });
  $('#chart').innerHTML = `
    <div class="ph"><span class="lbl">${name}</span><span class="lbl">Deviation from expected, °C</span></div>
    <div class="chart">${svg1}</div>
    <div class="ckeys"><span><i style="background:#fff"></i>Daily mean vs energy-balance expectation</span><span><i style="background:rgba(255,255,255,.3);height:8px"></i>Same position, other ${U - 1} units (5–95%)</span><span>Gaps: outage / low power</span></div>
    <div class="ph" style="margin-top:14px"><span class="lbl">Evidence · Shiryaev–Roberts conformal martingale</span><span class="lbl">log₁₀ R (capped at ${cap.toFixed(0)})</span></div>
    <div class="chart">${svg2}</div>
    <div class="ckeys"><span>Under no fault, mean time to a false alarm ≥ the threshold in days; no noise model or tuned limits</span></div>`;
}

function renderCompare() {
  const d = state.day;
  const rows = [['Fleet conformal (this)', scoreAt(d, 'ours'), true], ['Within-reactor CUSUM', scoreAt(d, 'cusum')], ['Fixed ±10 °C cross-check', scoreAt(d, 'fixed')]];
  const types = ['drift', 'step', 'stuck', 'noisy', 'cjc', 'flow'];
  const short = { drift: 'Drift', step: 'Step', stuck: 'Frozen', noisy: 'Noisy', cjc: 'Cold junction', flow: 'Flow meter' };
  const byType = types.map(t => `<tr><td>${short[t]}</td>${rows.map(([, s]) => { const b = s.byType[t]; return `<td>${b ? `${b.detected}/${b.n}` : '—'}</td>`; }).join('')}</tr>`).join('');
  const f = sim.faults.find(x => x.u === state.unit && (state.ch < 0 ? x.k < 0 : x.k === state.ch));
  let thisFault = '';
  if (f) {
    const get = s => s.rows.find(r => r.u === f.u && r.k === f.k && r.type === f.type);
    const cell = r => r && r.detDay >= 0 ? `day +${r.delay}` : 'missed';
    thisFault = `<div class="hint">This fault (${FAULT_TYPES[f.type].toLowerCase()}): fleet ${cell(get(rows[0][1]))}, CUSUM ${cell(get(rows[1][1]))}, fixed limit ${cell(get(rows[2][1]))}.</div>`;
  }
  $('#compare').innerHTML = `
    <div class="ph"><span class="lbl">Same faults, three detectors</span><span class="lbl">to day ${d}</span></div>
    <table class="cmp"><thead><tr><th>Detector</th><th>Caught</th><th>Median days</th><th>False</th></tr></thead>
    <tbody>${rows.map(([n, s, me]) => `<tr class="${me ? 'me' : ''}"><td>${n}</td><td>${s.detected}/${s.total}</td><td>${s.medianDelay ?? '—'}</td><td>${s.falseCh + s.falseU}</td></tr>`).join('')}</tbody></table>
    <table class="cmp" style="margin-top:10px"><thead><tr><th>Fault type</th><th>Fleet</th><th>CUSUM</th><th>Fixed</th></tr></thead><tbody>${byType}</tbody></table>
    ${thisFault}`;
}

function renderAll() { renderHeader(); renderKpis(); renderFleet(); renderUnit(); renderChart(); renderCompare(); }

$('#day').max = sim.D - 1;
$('#day').min = sim.baselineDays;
$('#day').value = state.day;
$('#day').oninput = e => { state.day = Number(e.target.value); renderAll(); };
renderAll();
window.__ready = true;
