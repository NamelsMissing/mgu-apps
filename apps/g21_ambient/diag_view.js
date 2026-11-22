'use strict';

const G = require('./kit/gauges');
const {bytes, describe, STATUS} = require('./safe_diag');
const {draw: drawQr} = require('./qr_log');

const VIEWS = [['overview', 'Overview'], ['ram', 'RAM01'], ['lin1', 'LIN 1'], ['lin2', 'LIN 2'],
    ['compare', 'Compare'], ['guided', 'Guided test'], ['plan', 'Menu 11 plan']];
const LOG_BOUNDS = {x: 49, y: 174, w: 1491, h: 301};
const time = at => at ? new Date(at).toISOString().slice(11, 23) + ' UTC' : 'Unknown';
const hex = (n, width) => n.toString(16).toUpperCase().padStart(width || 2, '0');
const tx = record => record && record.sent ? bytes(record.tx) : 'Not sent';

function text(cv, value, x, y, size, color, font) {
    cv.text(String(value), x, y, size, color, {font: font || 'label'});
}
function button(cv, t, control, x, y, w, label, action, key, active) {
    cv.roundRect(x, y, w, 42, 8, active ? '#256275' : '#253342');
    text(cv, label, x + 12, y + 27, 21, t.text);
    if (action) control(x, y, w, 42, key, action);
}
function detail(cv, t, value, x, y, maxWidth, color) {
    if (cv.textWidth(value, 20) > maxWidth) value = 'Full details in Log';
    text(cv, value, x, y, 20, color || t.text);
}
function outcome(rec) {
    if (!rec) return 'Not checked';
    if ([0x11, 0x12, 0x7E, 0x7F].includes(rec.nrc)) return 'Not supported · ' + describe(rec);
    return describe(rec);
}
function timing(rec) { return rec ? rec.ms + ' ms · ' + time(rec.at) : 'Not checked'; }
function reachability(rec, diag) {
    if (!rec) return 'Not checked';
    if (!diag.fresh(rec)) return 'Unknown · stale result';
    if (rec.rx) return 'Reachable';
    return rec.status === STATUS.timeout ? 'No response' : 'Unknown · ' + rec.status;
}

function overview(cv, t, m, control) {
    const d = m.diag, s = d.session, w = d.lastWrite;
    const write = !w ? 'Not checked' : w.acknowledged ? 'ECU acknowledged · physical effect unverified'
        : w.nrc === 0x31 ? 'Failed · Request out of range' : outcome(w);
    const measured = d.comparison && d.fresh(d.comparison) && d.comparisonAttempt.status === STATUS.success ? d.comparison.rows : null;
    const rgbw = measured && measured.filter(row => row.color === true).length;
    const comparable = measured && measured.filter(row => typeof row.color === 'boolean').length;
    const bdcReply = d.bdc.map(b => reachability(b.read, d));
    const left = [
        'TASU · ' + (d.online ? 'Connected' : d.connected === null && !d.lastError ? 'Waiting' : 'Unavailable'),
        'RAM01 · ' + reachability(d.ram, d),
        'Identity · ' + d.ramStatus + (d.ram && !d.fresh(d.ram) ? ' (stale)' : ''),
        'BDC · LIN 1 ' + bdcReply[0] + ' / LIN 2 ' + bdcReply[1],
        'Speed · ' + (d.speed === null ? 'Unknown' : d.speed.toFixed(1) + ' km/h · ' + (d.speedAge / 1000).toFixed(1) + ' s old' + (d.speedFresh ? '' : ' (stale)')),
        'Active test · ' + (d.busy ? 'Diagnostics running' : d.writeReady || (d.verified ? 'Ready for manual confirmation' : 'RAM01 identity check required')),
    ];
    const right = [
        'RAM01 color test · ' + write,
        'BDC reads · ' + d.bdc.map(b => !b.read ? 'Not checked' : !d.fresh(b.read) ? 'Stale' :
            b.read.decoded ? 'Success' : b.read.status === STATUS.success ? 'Unknown layout' : b.read.status).join(' / '),
        'Valid LIN records · ' + d.bdc.map(b => b.valid ? b.valid.data.valid +
            (!d.fresh(b.valid) || !b.read.decoded ? ' (stale)' : '') : 'Unknown').join(' / '),
        'RGBW changes · ' + (!d.comparison ? 'Not checked' : !measured ? 'Stale' : comparable ? rgbw + '/' + comparable + ' compared' : 'Unknown · no matching records'),
        'Visual result (BMW menu) · ' + d.wizard.physical,
        'Last transport error · ' + (d.lastError ? time(d.lastError.at) + ' · ' + d.lastError.text : 'None recorded'),
    ];
    left.forEach((row, i) => detail(cv, t, row, 52, 197 + i * 33, 730));
    right.forEach((row, i) => detail(cv, t, row, 825, 197 + i * 33, 710));
    detail(cv, t, s ? '#' + s.id + ' · ' + s.status + ' · ' + s.stage : 'Waiting for a diagnostic request', 52, 411, 1470, t.accent);
    button(cv, t, control, 52, 444, 250, 'Start Diagnostics', d.busy ? null : () => d.startDiagnostics(), 'diagnostics-start', true);
    if (d.busy) button(cv, t, control, 312, 444, 210, 'Cancel', () => d.abort(), 'diagnostics-cancel');
}

function ram(cv, t, m, control) {
    const d = m.diag, r = d.ram, w = d.lastWrite;
    const lines = [
        'ECU 0x37 · Service 22 · DID F150',
        'TX  ' + tx(r), 'RX  ' + (r && r.rx ? bytes(r.rx) : 'None'),
        'Result · ' + d.ramStatus, 'Response · ' + timing(r),
        'Last positive reply · ' + time(d.lastSuccess[0x37]),
        'Identity age · ' + (r ? d.fresh(r) ? 'Current' : 'Stale' : 'Not checked'),
        'NRC / transport · ' + outcome(r),
        'Last decoded identity · ' + (d.identity ? d.identity + ' · ' + time(d.identityAt) : 'Unknown'),
    ];
    const p = w && w.parameters;
    const write = [
        'ECU 0x37 · Service 2E · DID E311',
        'TX  ' + tx(w), 'RX  ' + (w && w.rx ? bytes(w.rx) : 'None'),
        'Result · ' + (w ? w.text : 'Not checked'), 'Response · ' + timing(w),
        p ? 'NAD ' + p.nad + ' · On ' + p.on + ' · RGB ' + p.rgb.join('/') + ' · Brightness ' + p.brightness + ' · ' + p.seconds + ' s' : 'Parameters · Not checked',
        'Acknowledgment · ' + (w ? (w.acknowledged ? 'Yes' : 'No') : 'Not checked'),
        'Physical effect of RAM command · Unverified',
    ];
    lines.forEach((row, i) => detail(cv, t, row, 52, 179 + i * 30, 720));
    write.forEach((row, i) => detail(cv, t, row, 825, 179 + i * 30, 710));
    button(cv, t, control, 52, 444, 245, 'Read RAM identity', d.busy ? null : () => d.readRam(), 'read-ram');
    if (d.busy) button(cv, t, control, 310, 444, 180, 'Cancel', () => d.abort(), 'ram-cancel');
}

function pageRows(cv, t, m, control, rows, x, y, size, width, rightX) {
    const page = Math.max(0, Math.min(m.page, Math.ceil(rows.length / size) - 1));
    rows.slice(page * size, page * size + size).forEach((row, i) =>
        detail(cv, t, row, x, y + i * 26, width, row.indexOf('Invalid') >= 0 ? t.warn : t.text));
    if (rows.length > size) {
        button(cv, t, control, rightX, 444, 120, 'Previous', page > 0 ? () => m.setPage(page - 1) : null, 'page-prev');
        button(cv, t, control, rightX + 128, 444, 105, 'Next', (page + 1) * size < rows.length ? () => m.setPage(page + 1) : null, 'page-next');
        text(cv, (page + 1) + ' / ' + Math.ceil(rows.length / size), rightX + 249, 472, 21, t.dim);
    }
}

function lin(cv, t, m, control) {
    const d = m.diag, index = m.view === 'lin1' ? 0 : 1, bus = d.bdc[index], r = bus.read, good = bus.valid;
    const data = good && good.data;
    const meta = [
        'ECU 0x40 · Service 22 · DID ' + (index ? 'E3D1' : 'DA5F'),
        'TX  ' + tx(r), 'Result · ' + outcome(r), 'Response · ' + timing(r),
        'Data bytes · ' + (r && r.rx && r.nrc === null ? r.rx.length - 3 : 'Unknown'),
        'Last decoded · ' + time(good && good.at),
        'Layout · ' + (!r ? 'Not checked' : r.decoded ? 'BDC_G05 format matched' : r.status === STATUS.success ? 'Unknown / incomplete' : 'Unavailable'),
        'Valid records · ' + (data ? data.valid + ' · Empty slots ' + data.empty +
            (!d.fresh(good) || !r.decoded ? ' (stale)' : '') : 'Unknown'),
        'Addressing method raw · ' + (data ? '0x' + hex(data.addressingRaw) : 'Unknown'),
    ];
    meta.forEach((row, i) => detail(cv, t, row, 52, 170 + i * 29, 608));
    if (m.raw) {
        const rows = [];
        if (r && r.rx) {
            for (let i = 0; i < r.rx.length; i += 18)
                rows.push(hex(i, 4) + '   ' + bytes(r.rx.slice(i, i + 18)));
        }
        text(cv, 'RX · full UDS response', 675, 167, 23, t.accent);
        if (!rows.length) text(cv, 'No response captured', 675, 210, 21, t.dim);
        pageRows(cv, t, m, control, rows, 675, 199, 9, 847, 1150);
    } else {
        const rows = data ? data.records.map(row => 'LIN ' + row.bus + '   NAD ' + String(row.nad).padStart(2, ' ') +
            '   ' + (row.valid ? row.rgbw.join(' / ') + '     ' + row.brightness + '     Status raw ' + bytes(row.raw.slice(6)) :
                'Invalid location · raw ' + bytes(row.raw))) : [];
        text(cv, 'BUS / NAD       R / G / B / W       Brightness       Status bytes', 675, 167, 21, t.accent);
        if (!rows.length) text(cv, data ? 'No populated records' : 'No decoded records', 675, 211, 21, t.dim);
        pageRows(cv, t, m, control, rows, 675, 199, 9, 847, 1150);
    }
    button(cv, t, control, 52, 444, 197, 'Read LIN ' + (index + 1), d.busy ? null : () => d.readBdc(index), 'read-bdc');
    if (d.busy) button(cv, t, control, 257, 444, 128, 'Cancel', () => d.abort(), 'lin-cancel');
    button(cv, t, control, 675, 444, 220, m.raw ? 'LIN records' : 'Raw response', m.toggleRaw, 'lin-raw');
}

function comparison(cv, t, m, control) {
    const d = m.diag, result = m.guidedResult ? d.wizard.comparison : d.comparison;
    const reference = m.guidedResult ? d.wizard.reference : d.reference;
    const stale = result && (!d.fresh(result) || (!m.guidedResult && d.comparisonAttempt.status !== STATUS.success));
    text(cv, 'Reference · ' + (reference ? time(reference.at) + (d.fresh(reference) ? '' : ' (historical)') : 'Not captured'), 52, 167, 22, t.text);
    const comparisonLabel = result ? time(result.at) + (stale ? ' (stale)' : '') : 'Not checked';
    const attempted = d.comparisonAttempt && !m.guidedResult ? ' · ' + d.comparisonAttempt.status : '';
    detail(cv, t, 'Comparison · ' + comparisonLabel + attempted, 825, 167, 710);
    if (!result) text(cv, 'Capture, change the color in the BMW menu and compare.', 52, 237, 25, t.dim);
    const records = result ? result.rows : [];
    if (result && !records.length) text(cv, 'Both samples contained no populated LIN records.', 52, 237, 24, t.dim);
    const colors = row => row ? 'RGBW ' + row.rgbw.join('/') + ' · B ' + row.brightness : '—';
    const rows = records.map(row => {
        const a = row.to || row.from;
        return 'LIN ' + a.bus + ' · NAD ' + a.nad + ' · ' + row.status + (row.color ? ' · color' : '') +
            (row.brightness ? ' · brightness' : '') + '     ' + colors(row.from) + '  →  ' + colors(row.to);
    });
    pageRows(cv, t, m, control, rows, 52, 209, 8, 1470, 1150);
    if (m.guidedResult) button(cv, t, control, 52, 444, 220, 'Back to guided test', () => m.select('guided'), 'guided-back');
    else {
        button(cv, t, control, 52, 444, 220, 'Capture Reference', d.busy ? null : () => d.captureReference(), 'capture');
        button(cv, t, control, 283, 444, 150, 'Compare', d.busy || !d.reference ? null : () => d.compareReference(), 'compare');
        if (d.busy) button(cv, t, control, 445, 444, 155, 'Cancel', () => d.abort(), 'compare-cancel');
    }
}

function guided(cv, t, m, control) {
    const d = m.diag, w = d.wizard;
    const labels = [
        'Baseline · identify RAM01 and capture both BDC buses',
        'BMW menu · change the ambient color manually, then let the lights settle',
        'Control measurement · compare the new BDC data with the baseline',
        'Visual check · Did the ambient lighting visibly change?',
    ];
    labels.forEach((label, i) => text(cv, (i + 1) + '   ' + label, 52, 184 + i * 47, 25,
        i + 1 === w.step ? t.accent : t.text));
    const info = w.step === 4 ? 'Recorded visual result · ' + w.physical + (w.observedAt ? ' · ' + time(w.observedAt) : '') : d.session ?
        d.session.status + ' · ' + d.session.stage : 'Ready · all requests in this test are read-only';
    detail(cv, t, info, 52, 387, 1440);
    if (d.busy) button(cv, t, control, 52, 444, 200, 'Cancel', () => d.abort(), 'guided-cancel');
    else {
        button(cv, t, control, 52, 444, 203, w.step ? 'Restart test' : 'Start guided test', () => d.startDiagnostics(true), 'guided-start');
        if (w.step === 2 || w.step === 3)
            button(cv, t, control, 267, 444, 276, 'Compare after BMW change', () => d.compareReference(true), 'guided-compare');
        if (w.step === 4) {
            ['Yes', 'No', 'Not checked'].forEach((answer, i) => button(cv, t, control, 280 + i * 162, 444, 150, answer,
                () => d.markPhysical(answer), 'visual-' + i, w.physical === answer));
            button(cv, t, control, 790, 444, 220, 'View comparison', () => m.select('compare', true), 'guided-results');
        }
    }
}

function offline(cv, t, m, control) {
    const plan = m.plan;
    text(cv, 'Menu position 11 · Offline preview', 52, 192, 28, t.accent);
    let summary = 'Select a plan for existing iDrive color position 11.';
    if (plan) summary = plan.codingReady === false
        ? 'Current profile ' + bytes(plan.oldProfile) + ' · requested RGB ' + plan.desiredRGB.join('/') + ' · mapping unverified'
        : 'Factory profile ' + bytes(plan.profile) + ' · Lilac ' + plan.factoryLilacRGB.join('/');
    detail(cv, t, summary, 52, 249, 1400);
    button(cv, t, control, 52, 444, 256, 'Use current color', m.currentPlan, 'current-plan');
    button(cv, t, control, 320, 444, 220, 'Factory values', m.factoryPlan, 'factory-plan');
}

function drawDiagnostics(cv, t, m, control) {
    G.panel(cv, t, 24, 62, 1552, 445, 'Vehicle diagnostics');
    VIEWS.forEach(([key, label], i) => button(cv, t, control, 52 + i * 204, 108, 191, label,
        () => m.select(key), 'diag-' + key, m.view === key));
    ({overview, ram, lin1: lin, lin2: lin, compare: comparison, guided, plan: offline})[m.view](cv, t, m, control);
}

function drawLog(cv, t, m, control) {
    G.panel(cv, t, 24, 62, 1552, 445, m.export ? 'QR diagnostic export' : 'Live console · this app session');
    if (m.export) {
        const report = m.export;
        cv.blit(G.layer('ambient-qr:' + report.id + ':' + report.page, 370, 370,
            layer => drawQr(layer, report.matrix, 0, 0, 370), cv.textScale), 55, 115);
        text(cv, 'Report ' + report.id + ' · ' + report.format.toUpperCase(), 462, 190, 25, t.accent);
        text(cv, 'QR ' + (report.page + 1) + ' / ' + report.pages.length, 462, 249, 38, t.text);
        text(cv, 'Scan each page. Reassemble with tools/ambient_qr_reassemble.py.', 462, 294, 22, t.dim);
        text(cv, 'Offline export · ' + report.size + ' bytes after reconstruction', 462, 328, 21, t.dim);
        button(cv, t, control, 462, 383, 150, 'Previous', report.page > 0 ? () => m.qrPage(-1) : null, 'qr-prev');
        button(cv, t, control, 625, 383, 150, 'Next', report.page + 1 < report.pages.length ? () => m.qrPage(1) : null, 'qr-next');
        button(cv, t, control, 788, 383, 190, 'Back to log', m.closeExport, 'qr-back');
        button(cv, t, control, 991, 383, 185, 'Export text', () => m.openExport('text'), 'qr-text');
        button(cv, t, control, 1188, 383, 190, 'Export JSON', () => m.openExport('json'), 'qr-json');
        return;
    }
    const page = m.log.page();
    text(cv, time(m.log.startedAt) + (m.log.dropped ? ' · ' + m.log.dropped + ' entries evicted' : ''), 55, 148, 20, t.dim);
    button(cv, t, control, 905, 121, 188, 'OLDER', () => m.log.move(-12), 'BTN_LOG_UP');
    button(cv, t, control, 1103, 121, 188, 'NEWER', () => m.log.move(12), 'BTN_LOG_DOWN');
    button(cv, t, control, 1300, 121, 232, 'LATEST', () => m.log.latest(), 'BTN_LOG_LATEST');
    button(cv, t, control, 651, 121, 182, 'Export Log', () => m.openExport('text'), 'log-export');
    button(cv, t, control, 490, 121, 150, 'Clear Log', m.clear, 'log-clear');
    cv.fillRect(49, 174, 1491, 301, '#101823');
    cv.scroll = {id: 'ambient-log', bounds: LOG_BOUNDS, bar: LOG_BOUNDS};
    page.lines.forEach((row, i) => cv.text(row.text, 61, 196 + i * 22, 18,
        row.level === 'error' ? t.crit : row.level === 'warning' ? t.warn : row.level === 'success' ? t.accent : t.text,
        {font: 'num', cellWidth: 12, literal: true}));
    const range = (page.total ? page.start + 1 : 0) + '–' + (page.start + page.lines.length) + ' / ' + page.total + ' lines';
    text(cv, m.error || 'Swipe or use OLDER / NEWER · ' + range, 55, 494, 19, m.error ? t.warn : t.dim);
}

module.exports = {drawDiagnostics, drawLog};
