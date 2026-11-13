'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { makeBridge, needsKeyOwnerMigration } = require('../native/phone-bridge/server');
const { localKey } = require('../apps/mgu_phone_terminal/control');

function httpRequest(port, method, endpoint, body, extra) {
    return new Promise((resolve, reject) => {
        const raw = body === null ? null : JSON.stringify(body);
        const req = http.request({ hostname: '127.0.0.1', port, method, path: endpoint,
            headers: Object.assign(raw === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }, extra || {})
        }, (res) => {
            let payload = '';
            res.on('data', (c) => { payload += c; });
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(payload); } catch (e) { parsed = payload; }
                resolve({ status: res.statusCode, body: parsed, headers: res.headers });
            });
        });
        req.on('error', reject);
        req.end(raw || undefined);
    });
}

function fileRequest(port, endpoint, extra) {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: endpoint,
            headers: extra || {} }, (res) => {
            const parts = [];
            res.on('data', (part) => parts.push(part));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: Buffer.concat(parts) }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function test() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-bridge-test-'));
    let testClock = Date.now();
    const bridge = makeBridge({ dataDir: dir, localPort: 0, publicPort: 0, publicHost: '127.0.0.1', firewall: false, now: () => testClock });
    const ports = await bridge.start();
    const controlKey = fs.readFileSync(path.join(dir, 'phone-bridge.key'), 'utf8').trim();
    const local = (method, endpoint, key) => httpRequest(ports.localPort, method, endpoint, null, { 'X-Bridge-Key': key === undefined ? controlKey : key });
    const publicHeaders = { 'X-Terminal-Request': '1', Origin: 'http://127.0.0.1:' + ports.publicPort };
    const pub = (method, endpoint, body, headers) => httpRequest(ports.publicPort, method, endpoint, body, Object.assign({}, publicHeaders, headers || {}));
    try {
        assert.strictEqual((await local('GET', '/local/status', 'wrong')).status, 403);
        assert.strictEqual((await local('GET', '/local/status')).body.state, 'closed');
        assert.strictEqual((await httpRequest(ports.publicPort, 'GET', '/', null)).status, 200);
        assert.strictEqual((await pub('POST', '/api/exec', { command: 'id' })).status, 401);

        const opened = await local('POST', '/local/start');
        assert.strictEqual(opened.status, 200);
        assert.strictEqual(opened.body.token.length, 64);
        assert.strictEqual(opened.body.state, 'pairing');
        assert.strictEqual((await pub('POST', '/api/pair', { token: 'bad' })).status, 403);
        assert.strictEqual((await pub('POST', '/api/pair', { token: opened.body.token }, { Origin: 'http://evil.test' })).status, 403);

        const paired = await pub('POST', '/api/pair', { token: opened.body.token });
        assert.strictEqual(paired.status, 200);
        const cookie = paired.headers['set-cookie'][0].split(';')[0];
        assert.ok(cookie.startsWith('mgu_session='));
        assert.ok(paired.headers['set-cookie'][0].includes('Max-Age=31536000'), 'browser cookie must outlast 15 minutes');
        assert.strictEqual(paired.body.expiresAt, 0, 'no session deadline');
        assert.strictEqual((await pub('POST', '/api/pair', { token: opened.body.token })).status, 403, 'pair token must be one-use');
        assert.strictEqual((await pub('GET', '/api/status', null, { Cookie: cookie })).status, 200);
        testClock += 2 * 24 * 60 * 60 * 1000;
        const stillConnected = await pub('GET', '/api/status', null, { Cookie: cookie });
        assert.strictEqual(stillConnected.status, 200, 'session must survive well beyond 15 minutes');
        assert.strictEqual(stillConnected.body.expiresAt, 0);

        const executed = await pub('POST', '/api/exec', { command: 'printf terminal-test' }, { Cookie: cookie });
        assert.strictEqual(executed.status, 200);
        assert.strictEqual(executed.body.stdout, 'terminal-test');
        assert.strictEqual(executed.body.code, 0);
        assert.strictEqual((await pub('POST', '/api/exec', { command: 'printf should-not-run' })).status, 401);
        assert.strictEqual((await pub('POST', '/api/exec', { command: 'printf blocked' }, { Cookie: cookie, Origin: 'http://evil.test' })).status, 403);

        const archive = path.join(dir, 'carplay-audio-analysis.tgz');
        const binary = Buffer.from([0, 255, 127, 42, 31, 0, 13, 10]);
        fs.writeFileSync(archive, binary);
        const download = (file) => pub('POST', '/api/download', { path: file }, { Cookie: cookie });
        assert.strictEqual((await pub('POST', '/api/download', { path: archive })).status, 401, 'downloads require pairing');
        assert.strictEqual((await pub('POST', '/api/download', { path: archive }, { Cookie: cookie, Origin: 'http://evil.test' })).status, 403);
        assert.strictEqual((await download('relative.tgz')).status, 400, 'downloads require absolute paths');
        assert.strictEqual((await download(dir)).status, 400, 'directories need archives');
        const symlink = path.join(dir, 'link.tgz');
        fs.symlinkSync(archive, symlink);
        assert.strictEqual((await download(symlink)).status, 404, 'do not follow final symlinks');
        fs.unlinkSync(symlink);

        const oversized = path.join(dir, 'oversized.tgz');
        fs.writeFileSync(oversized, '');
        fs.truncateSync(oversized, 256 * 1024 * 1024 + 1);
        assert.strictEqual((await download(oversized)).status, 400, 'bounded file size');
        fs.unlinkSync(oversized);

        const ticket = await download(archive);
        assert.strictEqual(ticket.status, 200);
        assert.ok(/^\/api\/file\/[a-f0-9]{48}$/.test(ticket.body.url), 'ticket does not expose local path');
        assert.strictEqual(ticket.body.filename, 'carplay-audio-analysis.tgz');
        assert.strictEqual(ticket.body.size, binary.length);
        assert.strictEqual((await fileRequest(ports.publicPort, ticket.body.url)).status, 401, 'file URLs also require cookie');
        const fetched = await fileRequest(ports.publicPort, ticket.body.url, { Cookie: cookie });
        assert.strictEqual(fetched.status, 200);
        assert.deepStrictEqual(fetched.data, binary, 'binary download must not be decoded as text');
        assert.ok(fetched.headers['content-disposition'].includes('attachment; filename="carplay-audio-analysis.tgz"'));
        assert.strictEqual((await fileRequest(ports.publicPort, ticket.body.url, { Cookie: cookie })).status, 404, 'download link must be one-use');
        const revokedTicket = await download(archive);
        assert.strictEqual(revokedTicket.status, 200);

        const pending = pub('POST', '/api/exec', { command: 'sleep 5; printf not-allowed' }, { Cookie: cookie });
        await new Promise((r) => setTimeout(r, 80));
        await local('POST', '/local/stop');
        const killed = await pending;
        assert.strictEqual(killed.status, 200);
        assert.ok(killed.body.signal === 'SIGKILL' || killed.body.signal === 'SIGTERM', 'revoke must terminate a running shell');
        assert.ok(!killed.body.stdout.includes('not-allowed'));

        assert.strictEqual((await pub('GET', '/api/status', null, { Cookie: cookie })).status, 401);
        assert.strictEqual((await fileRequest(ports.publicPort, revokedTicket.body.url, { Cookie: cookie })).status, 401, 'revoke invalidates downloads');
        assert.strictEqual((await local('GET', '/local/status')).body.state, 'closed');
        fs.unlinkSync(archive);
        console.log('Bridge tests passed: local key, pairing, command, authenticated one-time file downloads, revoke + kill');
    } finally {
        await bridge.stop();
        fs.unlinkSync(path.join(dir, 'phone-bridge.key'));
        fs.rmdirSync(dir);
    }
}


async function testSessionStopsOnRestart() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-bridge-restart-'));
    let bridge = makeBridge({ dataDir: dir, localPort: 0, publicPort: 0, publicHost: '127.0.0.1', firewall: false });
    try {
        let ports = await bridge.start();
        const key = fs.readFileSync(path.join(dir, 'phone-bridge.key'), 'utf8').trim();
        const started = await httpRequest(ports.localPort, 'POST', '/local/start', null, { 'X-Bridge-Key': key });
        const paired = await httpRequest(ports.publicPort, 'POST', '/api/pair', { token: started.body.token }, {
            Origin: 'http://127.0.0.1:' + ports.publicPort, 'X-Terminal-Request': '1'
        });
        assert.strictEqual(paired.status, 200);
        const cookie = paired.headers['set-cookie'][0].split(';')[0];
        await bridge.stop();
        bridge = makeBridge({ dataDir: dir, localPort: 0, publicPort: 0, publicHost: '127.0.0.1', firewall: false });
        ports = await bridge.start();
        const status = await httpRequest(ports.publicPort, 'GET', '/api/status', null, { Cookie: cookie });
        assert.strictEqual(status.status, 401, 'restarting bridge invalidates all browser cookies');
        console.log('Bridge restart test passed: session not persisted across service restart');
    } finally {
        await bridge.stop();
        fs.unlinkSync(path.join(dir, 'phone-bridge.key'));
        fs.rmdirSync(dir);
    }
}

async function testLateInstall() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-bridge-late-'));
    const dataDir = path.join(parent, 'newly-installed-app');
    const bridge = makeBridge({ dataDir, localPort: 0, publicPort: 0, publicHost: '127.0.0.1', firewall: false });
    await bridge.start();
    try {
        fs.mkdirSync(dataDir);
        const start = Date.now();
        while (!fs.existsSync(path.join(dataDir, 'phone-bridge.key')) && Date.now() - start < 2800) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(fs.existsSync(path.join(dataDir, 'phone-bridge.key')), 'daemon must provision key when app installs later');
        console.log('Late app installation test passed');
    } finally {
        await bridge.stop();
        if (fs.existsSync(path.join(dataDir, 'phone-bridge.key'))) fs.unlinkSync(path.join(dataDir, 'phone-bridge.key'));
        if (fs.existsSync(dataDir)) fs.rmdirSync(dataDir);
        fs.rmdirSync(parent);
    }
}

async function testAppOwnedKey() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-bridge-app-key-'));
    try {
        const firstKey = localKey(dir);
        assert.strictEqual(firstKey.length, 64, 'app should provision its own 256-bit control key');
        assert.strictEqual(localKey(dir), firstKey, 'app should retain the existing key');
        assert.strictEqual(fs.statSync(path.join(dir, 'phone-bridge.key')).mode & 0o077, 0, 'key must not be group/world readable');
        const bridge = makeBridge({ dataDir: dir, localPort: 0, publicPort: 0, publicHost: '127.0.0.1', firewall: false });
        const ports = await bridge.start();
        try {
            const response = await httpRequest(ports.localPort, 'GET', '/local/status', null, { 'X-Bridge-Key': firstKey });
            assert.strictEqual(response.status, 200, 'daemon should accept an app-provisioned key');
        } finally { await bridge.stop(); }
        console.log('App-owned key test passed');
    } finally {
        const keyFile = path.join(dir, 'phone-bridge.key');
        if (fs.existsSync(keyFile)) fs.unlinkSync(keyFile);
        fs.rmdirSync(dir);
    }
}

function testLegacyOwnerPolicy() {
    assert.strictEqual(needsKeyOwnerMigration(12237, 12237, 0), false);
    assert.strictEqual(needsKeyOwnerMigration(0, 12237, 0), true, 'legacy root-owned key must be repaired');
    assert.strictEqual(needsKeyOwnerMigration(0, 12237, 12237), true, 'root-owned key must be repaired even if the folder is app-owned');
    assert.throws(() => needsKeyOwnerMigration(12238, 12237, 0), /Unexpected bridge key owner/, 'a different OAP user must not be trusted');
    console.log('Legacy key owner policy tests passed');
}

testLegacyOwnerPolicy();
test().then(testSessionStopsOnRestart).then(testLateInstall).then(testAppOwnedKey).catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
