'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, parent, ...rest) {
    if (request === './kit/diag' && parent && parent.filename.endsWith('/g21_ambient/safe_diag.js'))
        return require.resolve('../kit/runtime/diag');
    return originalResolve.call(this, request, parent, ...rest);
};
const { SafeDiag } = require('../apps/g21_ambient/safe_diag');
Module._resolveFilename = originalResolve;
const { replyTo } = require('../kit/runtime/diag');

const ram01 = [0x62, 0xF1, 0x50, 0x0F, 0x25, 0x90];
const color = { rgb: [32, 100, 254], on: 1 };
const current = () => true;
function harness(respond) {
    const requests = [];
    const ctl = new SafeDiag({ log: { info() {}, warn() {} }, signals: {} });
    ctl.diag.p = {};
    ctl.diag.available = true;
    ctl.diag.physical = async (target, sid, request, timeout, accept, options) => {
        assert.equal(options.maxRetries, 0);
        requests.push([target, sid, ...request]);
        return respond(target, sid, request);
    };
    ctl.updateSpeed(0);
    return { ctl, requests, apply: () => ctl.apply(color, 100, 5, current) };
}

test('only matching diagnostic frames can satisfy the existing transport filter', () => {
    const request = [0xE3, 0x11];
    assert(replyTo(0x22, request)([0x62, 0xE3, 0x11, 0x20]));
    const accept = replyTo(0x2E, request);
    assert(accept([0x6E, 0xE3, 0x11]));
    assert(accept([0x7F, 0x2E, 0x31]));
    assert(!accept([0x6E, 0xD0, 0x74]));
    assert(!accept([0x7F, 0x22, 0x31]));
});

test('first press probes and arms, second sends one global RAM frame and keeps the NRC visible', async () => {
    const { ctl, apply, requests } = harness((_target, sid) => sid === 0x22 ? ram01 : [0x7F, 0x2E, 0x31]);
    await apply();
    assert.deepEqual(requests, [[0x37, 0x22, 0xF1, 0x50]]);
    assert.equal(ctl.confirming, true);
    await apply();
    assert.equal(ctl.confirming, false);
    assert.deepEqual(requests[1], [0x37, 0x2E, 0xE3, 0x11, 0, 1, 100, 32, 100, 254, 5]);
    assert.match(ctl.lastWrite.text, /7F 2E 31.*out of range/);
    assert.equal(ctl.lastWrite.acknowledged, false);
    await ctl.readRam();
    assert.match(ctl.ramStatus, /RAM01 identified/);
    assert.match(ctl.lastWrite.text, /7F 2E 31/);
    await apply();
    assert.equal(requests.filter(req => req[1] === 0x2E).length, 1);
});

test('unknown, malformed, unavailable or mismatched RAM identities block writes', async () => {
    for (const reply of [null, [0x7F, 0x22, 0x31], [0x62, 0xF1, 0x50, 0x0F, 0x25],
        [0x62, 0xF1, 0x50, 0x12, 0x34, 0x56], [0x62, 0xE3, 0x11, 0x0F, 0x25, 0x90],
        [...ram01, 0]]) {
        const { ctl, apply, requests } = harness(() => reply);
        await apply();
        await apply();
        assert.equal(ctl.confirming, false);
        assert.equal(ctl.verified, false);
        assert(requests.every(req => req[1] === 0x22));
    }
});

test('an acknowledgment requires fresh verification before another temporary test', async () => {
    const { ctl, apply, requests } = harness((_target, sid) => sid === 0x22 ? ram01 : [0x6E, 0xE3, 0x11]);
    await apply();
    await apply();
    assert.equal(ctl.lastWrite.acknowledged, true);
    assert.match(ctl.lastWrite.text, /Check the lights/);
    assert.equal(ctl.verified, false);
    ctl.lastWriteAt -= 3000;
    ctl.updateSpeed(0);
    await apply();
    assert.deepEqual(requests.map(req => req[1]), [0x22, 0x2E, 0x22]);
});

test('an expired confirmation, a changed color or stale speed cannot send the previous request', async () => {
    const { ctl, apply, requests } = harness(() => ram01);
    await apply();
    ctl.pending.until = Date.now() - 1;
    await apply();
    assert.equal(ctl.confirming, true);
    await ctl.apply({ rgb: [1, 2, 3], on: 1 }, 100, 5, current);
    assert.equal(ctl.confirming, true);
    ctl.updateSpeed(1);
    await apply();
    assert.match(ctl.info, /standstill/);
    ctl.updateSpeed(0);
    await apply();
    ctl.updateSpeed(65535);
    assert.equal(ctl.confirming, false);
    await apply();
    ctl.updateSpeed(0);
    await apply();
    ctl.speedAt -= 5000;
    assert.equal(ctl.confirming, false);
    await apply();
    assert.equal(ctl.pending, null);
    assert(requests.every(req => req[1] === 0x22));
});

test('editing while the identity probe runs prevents arming the old selection', async () => {
    let finish, edited = false;
    const { ctl, requests } = harness(() => new Promise(resolve => { finish = resolve; }));
    const inFlight = ctl.apply(color, 100, 5, () => !edited);
    edited = true;
    finish(ram01);
    await inFlight;
    assert.equal(ctl.confirming, false);
    assert.equal(requests.length, 1);
});

test('BDC diagnostics retry a busy read once and share the transport lock with RAM', async () => {
    let firstAttempts = 0;
    const { ctl, apply, requests } = harness((target, sid, request) => {
        assert.equal(target, 0x40);
        assert.equal(sid, 0x22);
        if (request[0] === 0xDA && ++firstAttempts === 2) return [0x62, 0xDA, 0x5F, 0xFF];
        if (request[0] === 0xDA) return [0x7F, 0x22, 0x21];
        return [0x7F, 0x22, 0x31];
    });
    const reading = ctl.readBdc();
    await apply();
    await ctl.readRam();
    assert.match(ctl.info, /busy/);
    await reading;
    assert.deepEqual(requests, [[0x40, 0x22, 0xDA, 0x5F], [0x40, 0x22, 0xDA, 0x5F], [0x40, 0x22, 0xE3, 0xD1]]);
    assert.deepEqual(ctl.bdcStatus, ['Positive reply · data length 1', '7F 22 31 · out of range']);
});

function bdcReply(did, records, method = 1) {
    const data = Array(261).fill(0xFF);
    data[260] = method;
    records.forEach((fields, index) => data.splice(index * 10, fields.length, ...fields));
    return [0x62, ...did, ...data];
}

test('BDC compares RGBW and brightness only across matching records from two complete reads', async () => {
    let second = false;
    const { ctl, requests } = harness((_target, _sid, did) => {
        const firstBus = did[0] === 0xDA;
        if (firstBus) {
            const records = [[5, 7, 10, 20, 45, second ? 30 : 0], [27, 1, 2, 3, second ? 60 : 50, 0],
                [second ? 34 : 35, 4, 5, 6, 70, 0], [0, 0, 0, 0, 0, 0]];
            return bdcReply(did, records, second ? 2 : 1);
        }
        const records = [[116, 1, 2, 3, 50, 0, second ? 1 : 0]];
        return bdcReply(did, records);
    });

    await ctl.readBdc();
    assert.equal(ctl.bdcComparison, 'Reference captured for both LIN buses.');
    second = true;
    await ctl.readBdc();
    assert.equal(ctl.bdcComparison, 'RGBW changed: 1/3 · Brightness changed: 1/3');
    await ctl.readBdc();
    assert.equal(ctl.bdcComparison, 'RGBW changed: 0/4 · Brightness changed: 0/4');
    assert(requests.every(req => req[0] === 0x40 && req[1] === 0x22));
});

test('a failed or wrong-size BDC read invalidates the reference for both buses', async () => {
    let reading = 'full';
    const { ctl } = harness((_target, _sid, did) => {
        const reply = bdcReply(did, [[5, 5, 5, 5, 50, 0]]);
        return reading === 'full' || did[0] === 0xDA ? reply : reply.slice(0, -1);
    });
    await ctl.readBdc();
    reading = 'short';
    await ctl.readBdc();
    assert.match(ctl.bdcStatus[1], /data length 260/);
    assert.match(ctl.bdcComparison, /needs 261 data bytes/);
    reading = 'full';
    await ctl.readBdc();
    assert.equal(ctl.bdcComparison, 'Reference captured for both LIN buses.');
});
