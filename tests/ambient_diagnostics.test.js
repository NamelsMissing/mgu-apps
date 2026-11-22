'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const {Diag, hex} = require('../kit/runtime/diag');
const {decode, compare} = require('../apps/g21_ambient/lin');
const {SessionLog, LIMIT, BUDGET, linesFor} = require('../apps/g21_ambient/session_log');
const QR = require('../apps/g21_ambient/qr_log');
const {spawnSync} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const original = Module._load;
Module._load = function(request, parent, ...rest) {
    if (request === './kit/diag' && /g21_ambient[\\/]safe_diag.js$/.test(parent.filename))
        return require('../kit/runtime/diag');
    return original.call(this, request, parent, ...rest);
};
const {SafeDiag} = require('../apps/g21_ambient/safe_diag');
Module._load = original;

const log = {info() {}, warn() {}};
const ram = [0x62, 0xF1, 0x50, 0x0F, 0x25, 0x90];
const turn = () => new Promise(resolve => setImmediate(resolve));
const data = (red = 1, location = 5) => [location, 2, 3, red, 50, 0, 0, 0, 0, 0, ...Array(250).fill(255), 1];

test('LIN format validation, stable bus/NAD keys, additions, removals and duplicates', () => {
    const left = decode(1, data()), right = decode(2, data(2));
    assert.equal(left.valid, 1);
    assert.equal(left.empty, 25);
    assert.equal(left.addressingRaw, 1);
    assert.equal(decode(1, data().slice(1)), null);
    const [a] = left.records, [b] = right.records;
    assert.deepEqual(compare([a, b], [b, a]).map(r => r.status), ['Unchanged', 'Unchanged']);
    const added = Object.assign({}, a, {nad: 4});
    assert.deepEqual(compare([a, b], [a, a, added]).map(r => r.status), ['Duplicate', 'Added', 'Missing']);
    assert.equal(compare([a], decode(1, data(9, 0)).records)[0].status, 'Invalid');
});

function actualHarness() {
    let receive, available;
    const calls = [];
    const signals = {
        watch: async () => ({}), proxy: async () => ({}),
        on: async (_p, _event, handle) => { receive = handle; },
        onAvailable: async (_p, handle) => { available = handle; handle(true); },
        call: async (_p, _method, request) => {
            calls.push([request.targetAddress, request.serviceID, ...request.udsData]);
            return 'NO_ERROR';
        },
    };
    const ctl = new SafeDiag({signals, log, spec: {version: '0.4.4'}});
    const emit = (ecu, payload) => receive({errorCode: 'NO_ERROR', udsResponse: [0, 0, 0, 0, 0, 0, ecu, 0, 0, ...payload]});
    return {ctl, calls, emit, error: errorCode => receive({errorCode}), available: value => available(value)};
}

test('real TASU event path correlates ECU/service/DID and preserves results across disconnect', async () => {
    const {ctl, calls, emit, available} = actualHarness();
    await ctl.init();
    const read = ctl.readRam();
    assert.equal(await ctl.startDiagnostics(), null);
    emit(0x40, ram);
    emit(0x37, [0x62, 0xDA, 0x5F, 0x12]);
    emit(0x37, [0x7F, 0x2E, 0x78]);
    await turn();
    assert.equal(ctl.busy, true);
    emit(0x37, ram);
    assert.equal(await read, 'Success');
    assert.equal(ctl.ram.identity, '0F 25 90');
    assert.equal(calls.length, 1);

    const ongoing = ctl.readBdc();
    available(false);
    emit(0x40, [0x62, 0xDA, 0x5F, ...data()]);
    assert.equal(await ongoing, 'Cancelled');
    assert.equal(ctl.busy, false);
    assert.equal(ctl.fresh(ctl.ram), false);
    assert.equal(ctl.ram.identity, '0F 25 90');
    assert.equal(ctl.bdc[0].valid, null);
    assert.equal(ctl.diag.listenerCount('frame'), 0);
    assert(ctl.log.export().some(e => e.kind === 'TASU DISCONNECTED'));
});

test('TASU transport event is distinguished from a real ECU rejection', async () => {
    const {ctl, error} = actualHarness();
    await ctl.init();
    const reading = ctl.readRam();
    error('APP_REQUEST_TEMPORARILY_NOT_ACCEPTED');
    assert.equal(await reading, 'Transport Error');
    assert.equal(ctl.ram.nrc, null);
    assert.match(ctl.lastError.text, /TEMPORARILY/);
});

const opts = (extra = {}) => Object.assign({onSend() {}, onPending() {}, setCancel() {}, timeoutMs: 15,
    callTimeoutMs: 20, pendingTimeoutMs: 60, hardTimeoutMs: 45}, extra);
test('Untagged BDC timeout is bounded, unrelated NRC 78 is ignored, and late replies have no consumer', async () => {
    const diag = new Diag({call: async () => 'NO_ERROR'}, log);
    diag.p = {}; diag.available = true;
    const waiting = diag.physicalTracked(0x40, 0x22, [0xDA, 0x5F], opts());
    diag.emit('frame', {ecu: 0x40, uds: [0x7F, 0x2E, 0x78]});
    assert.equal(await waiting, null);
    assert.equal(diag.listenerCount('frame'), 0);
    diag.emit('frame', {ecu: 0x40, uds: [0x62, 0xDA, 0x5F, ...data()]});
    const retry = diag.physicalTracked(0x40, 0x22, [0xE3, 0xD1], opts());
    diag.emit('frame', {ecu: 0x40, uds: [0x62, 0xDA, 0x5F, ...data()]});
    diag.emit('frame', {ecu: 0x40, uds: [0x7F, 0x22, 0x31]});
    assert.deepEqual(await retry, [0x7F, 0x22, 0x31]);
});

test('stuck native send times out, detaches listeners and fences later sends until settled', async () => {
    let resolve, calls = 0;
    const diag = new Diag({call: () => { calls++; return new Promise(r => { resolve = r; }); }}, log);
    diag.p = {}; diag.available = true;
    assert.equal(await diag.physicalTracked(0x40, 0x22, [0xDA, 0x5F], opts()), null);
    await assert.rejects(diag.physicalTracked(0x37, 0x22, [0xF1, 0x50], opts()), /has not settled/);
    assert.equal(calls, 1);
    resolve('NO_ERROR');
    await turn();
    assert.equal(diag.trackedSend, null);
    assert.equal(diag.listenerCount('frame'), 0);
});

test('guided test runs only the allowlisted reads, records actual observation and preserves complete RX', async () => {
    const {ctl, calls, emit} = actualHarness();
    await ctl.init();
    const baseline = ctl.startDiagnostics(true);
    emit(0x37, ram);
    await turn();
    emit(0x40, [0x62, 0xDA, 0x5F, ...data()]);
    await turn();
    emit(0x40, [0x62, 0xE3, 0xD1, ...data()]);
    assert.equal(await baseline, 'Success');
    assert.equal(ctl.wizard.step, 2);
    const measuring = ctl.compareReference(true);
    emit(0x40, [0x62, 0xDA, 0x5F, ...data(9)]);
    await turn();
    emit(0x40, [0x62, 0xE3, 0xD1, ...data()]);
    assert.equal(await measuring, 'Success');
    assert.equal(ctl.wizard.step, 4);
    assert.equal(ctl.wizard.physical, 'Not checked');
    ctl.markPhysical('Yes');
    const report = ctl.report('0.4.4');
    assert.equal(report.visual.result, 'Yes');
    assert.equal(report.visual.comparison.rows.filter(row => row.color).length, 1);
    const wanted = [0x62, 0xDA, 0x5F, ...data(9)].map(x => hex(x)).join(' ');
    assert(report.log.some(row => row.kind === 'RX' && row.message.includes(wanted)));
    assert(calls.every(call => call[1] === 0x22));
    assert(report.log.some(row => row.kind === 'PHYSICAL RESULT'));
});

test('log keeps long hex bytes, stays anchored and remains bounded', () => {
    const grouped = Array.from({length: 264}, (_, i) => hex(i & 255));
    const lines = linesFor({at: 0, level: 'success', kind: 'RX', message: grouped.join(' ')});
    assert(lines.length > 4);
    assert.deepEqual(lines.map((r, i) => i ? r.text.trim() : r.text.replace(/^\[[^\]]+\] RX /, ''))
        .join(' ').split(/\s+/), grouped);
    const events = new SessionLog();
    for (let i = 0; i < 50; i++) events.add('RX', 'Entry ' + i);
    events.move(-12);
    const first = events.page().lines[0];
    events.add('RESULT', 'New entry');
    assert.deepEqual(events.page().lines[0], first);
    events.latest();
    assert.match(events.page().lines.at(-1).text, /New entry/);
    for (let i = 0; i < 1000; i++) events.add('RX', 'F'.repeat(500));
    assert(events.entries.length <= LIMIT && events.bytes <= BUDGET);
    assert(events.dropped > 0);
    events.clear();
    assert.equal(events.page().total, 0);
});

test('QR pages reassemble byte-perfectly offline for both formats and reject incomplete input', () => {
    const report = {version: '0.4.4', log: [{at: 0, kind: 'RX', message: 'ÄÖÜ ' + randomBytes(3000).toString('hex')}]};
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-qr-'));
    try {
        for (const format of ['json', 'text']) {
            const result = QR.createReport(report, format);
            assert(result.pages.length > 1);
            result.pages.forEach(page => assert(QR.matrix(page).getModuleCount() > 0));
            const file = path.join(dir, 'scans');
            fs.writeFileSync(file, result.pages.slice().reverse().join('\n'));
            const args = ['tools/ambient_qr_reassemble.py', file];
            const reconstructed = spawnSync('python3', args, {encoding: 'utf8'});
            assert.equal(reconstructed.status, 0, reconstructed.stderr);
            assert.equal(reconstructed.stdout, format === 'json' ? JSON.stringify(report, null, 2) : QR.diagnosticText(report));
            fs.writeFileSync(file, result.pages.slice(1).join('\n'));
            assert.equal(spawnSync('python3', args).status, 1);
        }
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
