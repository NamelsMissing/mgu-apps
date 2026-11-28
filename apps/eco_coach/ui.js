'use strict';
/**
 * ui.js - Eco Coach's pages, drawn on the kit's 1600 x 520 frame. Every page takes the view main.js
 * prepares (plain data), so drawing never reads the car itself.
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');

const TABS = ['Live', 'Trips', 'Speed map', 'Test', 'Findings'];
const GOOD = '#2fd27a';
const Y0 = 56, PH = 448;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const f = (x, d, u) => (isNum(x) ? x.toFixed(d) + (u ? ' ' + u : '') : '--');
const pct = (x) => (isNum(x) ? (x >= 0 ? '+' : '') + x.toFixed(1) + ' %' : '--');

/** Lines of text that fit width w at size (words kept whole). */
function wrap(cv, text, w, size, font) {
    const out = [];
    let line = '';
    for (const word of String(text).split(/\s+/)) {
        const next = line ? line + ' ' + word : word;
        if (line && cv.textWidth(next, size, { font }) > w) { out.push(line); line = word; } else line = next;
    }
    if (line) out.push(line);
    return out;
}
function para(cv, t, text, x, y, w, size, color, max, font) {
    const lines = wrap(cv, text, w, size, font).slice(0, max || 4);
    lines.forEach((l, i) => cv.text(l, x, y + i * Math.round(size * 1.3), size, color || t.text, { literal: true, font }));
    return lines.length * Math.round(size * 1.3);
}
function scoreColor(t, s) { return !isNum(s) ? t.dim : s >= 75 ? GOOD : s >= 50 ? t.warn : t.crit; }

/* ---------------- Live ---------------- */
function live(cv, t, v) {
    const tr = v.trip;
    G.panel(cv, t, 24, Y0, 496, PH, 'Eco score - this trip');
    const sc = tr && tr.km >= 1 ? tr.score : null;
    G.ring(cv, t, 272, 232, 112, { value: sc, min: 0, max: 100, decimals: 0, color: scoreColor(t, sc), smooth: false });
    if (tr) {
        cv.text(f(tr.km, 1, 'km') + '   ' + (tr.mins || 0) + ' min', 48, 418, 24, t.text);
        cv.text(f(tr.l100, 1, 'l/100 km') + '   ' + (isNum(tr.cost) ? tr.cost.toFixed(2) + ' ' + v.currency : ''), 48, 452, 24, t.text);
        cv.text(isNum(tr.co2) ? tr.co2.toFixed(1) + ' kg CO2' + (tr.coverage < 0.9 ? '   fuel known ' + Math.round(tr.coverage * 100) + ' %' : '') : '', 48, 484, 20, t.dim);
    } else cv.text('Starts with the engine', 48, 440, 24, t.dim);

    G.panel(cv, t, 540, Y0, 520, PH, 'Now');
    const n = v.now;
    if (n.moving) G.readout(cv, t, 564, 116, { label: 'Consumption', value: n.l100, decimals: 1, unit: 'l/100 km', size: 96 });
    else G.readout(cv, t, 564, 116, { label: 'Consumption, standing', value: n.lph, decimals: 2, unit: 'l/h', size: 96 });
    cv.text(f(n.v, 0, 'km/h') + (n.gear ? '   gear ' + n.gear : '') + (n.mode ? '   ' + n.mode : ''), 564, 286, 28, t.text);
    if (isNum(n.typical)) {
        const d = isNum(n.l100) ? (n.l100 - n.typical) / n.typical * 100 : null;
        cv.text('Your usual at ' + Math.round(n.v) + ' km/h: ' + n.typical.toFixed(1) + ' l/100 km', 564, 336, 22, t.dim);
        if (isNum(d) && n.cruise) cv.text(pct(d), 564, 376, 30, d > 8 ? t.warn : d < -3 ? GOOD : t.text, { font: 'bold' });
    } else cv.text('Your speed map fills while you drive', 564, 336, 22, t.dim);
    G.pill(cv, t, 564, 432, 472, 40, v.sourceText, { color: v.sourceOk ? GOOD : t.warn, size: 17, spacing: 0.5 });

    G.panel(cv, t, 1080, Y0, 496, PH, 'Coach');
    let y = 140;
    (v.coach.length ? v.coach : ['Drive: the hints come from your own figures']).slice(0, 4).forEach((line, i) => {
        cv.circle(1108, y - 8, 6, i === 0 && v.coach.length ? t.sel || t.accent : t.dim);
        y += para(cv, t, line, 1126, y, 430, 25, t.text, 3) + 16;
    });
    if (v.sweet) cv.text('Your sweet spot: ' + v.sweet.v + ' km/h', 1104, 484, 22, GOOD, { font: 'bold' });
}

/* ---------------- Trips ---------------- */
function trips(cv, t, v) {
    G.panel(cv, t, 24, Y0, 1010, PH, 'Recent trips');
    const rows = v.trips.slice(0, 7).map((r) => [
        r.when, f(r.km, 1), f(r.l100, 1), isNum(r.cost) ? r.cost.toFixed(2) : '--',
        { text: isNum(r.score) ? String(r.score) : '--', color: scoreColor(t, r.score) }, isNum(r.outside) ? r.outside.toFixed(0) + ' °C' : '--',
    ]);
    G.table(cv, t, 48, Y0 + 62, 960, [
        { label: 'Date', w: 260 }, { label: 'km', w: 120, align: 'right' }, { label: 'l/100 km', w: 160, align: 'right' },
        { label: 'Cost ' + v.currency, w: 160, align: 'right' }, { label: 'Score', w: 120, align: 'right' }, { label: 'Outside', w: 140, align: 'right' },
    ], rows, { empty: 'No finished trip yet: a trip ends 5 min after the engine stops', rowH: 42 });
    if (v.tripTotals) cv.text(v.tripTotals, 48, 488, 20, t.dim);

    G.panel(cv, t, 1054, Y0, 522, PH, 'Last trip');
    const last = v.lastTrip;
    if (!last) { cv.text('--', 1078, 140, 26, t.dim); return; }
    const names = [['accel', 'Acceleration'], ['anticipation', 'Anticipation'], ['gear', 'Gear / rpm'], ['idle', 'Idling'], ['speed', 'Speed']];
    names.forEach(([k, name], i) => {
        const y = Y0 + 84 + i * 40, val = last.parts ? last.parts[k] : null, max = v.partMax[k];
        cv.text(name, 1078, y + 6, 21, t.dim);
        cv.roundRect(1240, y - 10, 220, 14, 7, t.track);
        if (isNum(val)) cv.roundRect(1240, y - 10, Math.max(14, 220 * val / max), 14, 7, val / max >= 0.75 ? GOOD : val / max >= 0.5 ? t.warn : t.crit);
        cv.text(isNum(val) ? Math.round(val) + '/' + max : '--', 1552, y + 6, 20, t.text, { align: 'right' });
    });
    let y = Y0 + 300;
    (last.tips || []).slice(0, 3).forEach((tip) => { y += para(cv, t, '- ' + tip, 1078, y, 480, 20, t.text, 2) + 6; });
}

/* ---------------- Speed map ---------------- */
function speedMap(cv, t, v) {
    G.panel(cv, t, 24, Y0, 1040, PH, 'Consumption by speed (level road, 15 °C, warm engine)');
    const all = [].concat(v.curve, v.bins, v.testPts);
    const yMax = all.length ? Math.max(4, Math.ceil(Math.max.apply(null, all.map((p) => p[1]).filter(isNum)) + 1)) : 12;
    const ch = G.chart(cv, t, 44, Y0 + 66, 1000, PH - 86, {
        xMin: 30, xMax: 160, yMin: 0, yMax, xStep: 10, xUnit: 'km/h', yUnit: 'l/100 km',
        series: [{ pts: v.bins, color: t.dim, dash: true, width: 2 }, { pts: v.curve, color: t.sel || t.accent, fill: 0.12, width: 3 }],
        empty: 'Not enough steady driving yet: drive the test or a few trips',
    });
    for (const p of v.testPts) if (p[0] >= 30 && p[0] <= 160) cv.circle(ch.X(p[0]), ch.Y(Math.min(yMax, p[1])), 6, withAlpha(t.warn, 0.9));
    if (v.sweet) {
        const x = ch.X(v.sweet.v);
        cv.fillRect(x, ch.py, 2, ch.ph, withAlpha(GOOD, 0.8));
        cv.text('Sweet spot ' + v.sweet.v + ' km/h: ' + v.sweet.l100.toFixed(1), x + 8, ch.py + 22, 18, GOOD, { font: 'bold' });
    }
    cv.text('line: your model    dashed: everyday average    dots: test', 1040, Y0 + 42, 16, t.dim, { align: 'right' });

    G.panel(cv, t, 1084, Y0, 492, PH, 'Gear by speed');
    G.table(cv, t, 1104, Y0 + 62, 452, [
        { label: 'Speed', w: 120 }, { label: 'Usual', w: 100, align: 'right' }, { label: 'Best', w: 100, align: 'right' }, { label: 'Saves', w: 132, align: 'right' },
    ], v.gears.slice(0, 7).map((g) => [g.band + ' km/h', String(g.usual), { text: String(g.best), color: g.best !== g.usual ? GOOD : t.text },
        g.best !== g.usual ? g.saving.toFixed(1) + ' %' : '-']), { empty: 'Needs 3 samples per gear', rowH: 40, size: 22 });
    cv.text(v.modelText, 1104, 488, 18, t.dim);
}

/* ---------------- Test ---------------- */
function test(cv, t, v, ctl) {
    const T = v.test;
    G.panel(cv, t, 24, Y0, 760, PH, 'Consumption test');
    if (!T.active) {
        let y = Y0 + 84;
        y += para(cv, t, T.complete ? 'Test complete. The results are on Speed map and Findings; drive it again any time to add more.' :
            'Fills your personal consumption map: steady speeds in two gears, three ways to accelerate, two ways to roll out, ECO PRO against Comfort.', 48, y, 710, 24, t.text, 3) + 12;
        y += para(cv, t, 'Start while parked. Then just drive: the app recognises each part by itself - no touching while driving. Use the cruise control, drive each speed in both directions on a quiet, level road, only where it is legal and safe.', 48, y, 710, 21, t.dim, 4) + 18;
        G.button(cv, t, 48, 430, 300, 54, T.canStart ? 'Start test' : 'Park to start', T.canStart ? ctl.start : null, { primary: T.canStart, key: 'start' });
        if (T.any) G.button(cv, t, 368, 430, 300, 54, 'Clear results', ctl.clear, { confirm: true, key: 'clear' });
    } else {
        cv.text('NEXT', 48, Y0 + 92, 18, t.dim, { font: 'bold', spacing: 2 });
        para(cv, t, T.next || 'All parts measured - stop the test', 48, Y0 + 132, 710, 36, t.text, 2, 'bold');
        const m = T.measuring;
        if (m) {
            cv.text(m.settling ? 'Settling: ' + m.label : 'Measuring: ' + m.label, 48, Y0 + 252, 24, t.sel || t.accent, { font: 'bold' });
            cv.roundRect(48, Y0 + 272, 710, 18, 9, t.track);
            cv.roundRect(48, Y0 + 272, Math.max(18, 710 * Math.min(1, m.progress)), 18, 9, t.sel || t.accent);
        }
        if (T.last) cv.text((T.last.ok ? 'Done: ' : 'Not counted: ') + T.last.text, 48, Y0 + 336, 22, T.last.ok ? GOOD : t.warn);
        cv.text(T.done + ' of ' + T.of + ' parts', 48, Y0 + 376, 24, t.text);
        G.button(cv, t, 48, 430, 300, 54, 'Stop test', ctl.stop, { key: 'stop' });
    }
    G.panel(cv, t, 804, Y0, 772, PH, 'Parts');
    let y = Y0 + 84;
    const pill = (x, label, c) => {
        const ok = c.count >= c.need;
        G.pill(cv, t, x, y - 22, 172, 34, label + '  ' + c.count + '/' + c.need, { color: ok ? GOOD : c.count ? t.warn : t.dim, size: 16, spacing: 0.5, filled: ok ? 0.3 : 0.12 });
    };
    for (const row of T.rows) {
        cv.text(row.name, 828, y, 20, t.dim);
        row.cells.forEach((c, i) => pill(990 + i * 180, c.short, c));
        y += 42;
    }
}

/* ---------------- Findings ---------------- */
function findings(cv, t, v) {
    G.panel(cv, t, 24, Y0, 760, PH, 'What costs fuel - at 100 km/h');
    G.table(cv, t, 48, Y0 + 62, 712, [{ label: 'Factor', w: 420 }, { label: 'Effect', w: 140, align: 'right' }, { label: 'l/100 km', w: 152, align: 'right' }],
        v.effects.map((e) => [e.label, { text: pct(e.pct), color: e.pct > 1 ? t.warn : e.pct < -1 ? GOOD : t.text }, (e.l100 >= 0 ? '+' : '') + e.l100.toFixed(2)]),
        { empty: 'Needs about 20 steady stretches at 3 different speeds', rowH: 42, size: 22 });
    G.panel(cv, t, 804, Y0, 772, PH, 'What your test showed');
    let y = Y0 + 92;
    (v.found.length ? v.found : ['Drive the consumption test (Test page) to compare gears, acceleration and rolling out in your car.']).slice(0, 6).forEach((line) => {
        y += para(cv, t, line, 828, y, 724, 22, t.text, 3) + 14;
    });
}

function draw(cv, t, page, v, ctl) {
    if (page === 0) live(cv, t, v);
    else if (page === 1) trips(cv, t, v);
    else if (page === 2) speedMap(cv, t, v);
    else if (page === 3) test(cv, t, v, ctl);
    else findings(cv, t, v);
    const badges = [];
    if (v.demo) badges.push({ text: 'DEMO', color: t.warn });
    if (v.test.active) badges.push({ text: 'TEST', color: GOOD });
    G.frame(cv, t, TABS, page, badges);
}

module.exports = { TABS, draw, wrap };
