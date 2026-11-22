'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { GifUploadServer, localAddresses, SESSION_MS, MAX_BYTES, PORT } = require('../apps/gif_home/upload');
const { Library } = require('../apps/gif_home/library');
const { makeFirewall, TAG } = require('../native/gif-net/firewall');
const { makeNetwork, probeGifHome } = require('../native/gif-net/server');

const demo = Buffer.from(require('../apps/gif_home/resources/demo.json').base64, 'base64');
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const target = localAddresses()[0] || { interface: 'test', ip: '127.0.0.1', netmask: '255.0.0.0' };
function request(href, body, headers) {
    const u = new URL(href);
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search,
            method: body === undefined ? 'GET' : 'POST', headers: Object.assign({
                'User-Agent': 'Mozilla/5.0 (iPhone) Mobile Safari',
                'Content-Type': Buffer.isBuffer(body) ? 'image/gif' : 'application/json',
                'X-GIF-Home': '1'
            }, headers) }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => {
                const data = Buffer.concat(chunks);
                resolve({ status: res.statusCode, headers: res.headers, data, json: () => JSON.parse(data) });
            });
        });
        req.on('error', reject);
        req.end(body);
    });
}

async function network() {
    const wireless = localAddresses({
        eth0: [{ family: 'IPv4', address: '192.168.1.5', netmask: '255.255.255.0' }],
        p2p0: [{ family: 4, address: '169.254.20.5', netmask: '255.255.0.0' }],
        wlan_bridge: [{ family: 'IPv4', address: '172.16.222.1', netmask: '255.255.255.0' }],
        wwan0: [{ family: 'IPv4', address: '1.1.1.1', netmask: '255.0.0.0' }]
    });
    assert.deepStrictEqual(wireless.map(a => a.ip), ['172.16.222.1', '169.254.20.5', '192.168.1.5']);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-home-http-'));
    const records = [];
    const record = s => records.push(s);
    const lib = new Library(dir, ['demo'], {}, record);
    let now = 1000;
    const server = new GifUploadServer({ port: 0, clock: () => now, record, api: {
        state: () => lib.state, preview: id => lib.read(id), diagnostics: () => records,
        upload: (bytes, name) => lib.add(bytes, name), action: action => lib.change(action, true)
    } });
    let service;
    try {
        await server.start();
        assert(server.listening);
        const collision = new GifUploadServer({ port: server.port });
        let problem;
        try { await collision.start(); } catch (e) { problem = e; }
        assert.strictEqual(problem && problem.code, 'EADDRINUSE');
        assert(!collision.listening);
        assert(collision.serverError.includes('EADDRINUSE'));
        await collision.close();
        assert.strictEqual(await probeGifHome(server.port), false);
        let rows = ['counter drop # handle 1', 'tcp dport 18879 accept comment "mgu-video-net" # handle 2'];
        let handle = 3, present = true;
        const firewall = makeFirewall({ interfacePresent: () => present, run: async args => {
            if (args[0] === '-a') return rows.join('\n');
            if (args[0] === 'insert') rows.unshift(args.slice(5).join(' ') + ' # handle ' + handle++);
            if (args[0] === 'delete') rows = rows.filter(row => !row.endsWith('# handle ' + args[6]));
            return '';
        } });
        service = makeNetwork({ firewall, probe: () => probeGifHome(server.port), statusPort: 0, intervalMs: 60000 });
        const statusPort = await service.start();
        const helper = () => request('http://127.0.0.1:' + statusPort + '/status');
        assert.strictEqual((await helper()).json().ready, false);
        server.begin(Object.assign({}, target, { interface: 'wlan_bridge' }));
        await service.check();
        assert.strictEqual((await helper()).json().ready, true);
        assert.strictEqual(server.phoneAt, null);
        present = false;
        await service.check();
        assert.strictEqual((await helper()).json().ready, false);
        assert((await helper()).json().error.includes('wlan_bridge'));
        present = true;
        await service.check();
        assert.strictEqual((await helper()).json().ready, true);
        assert(rows[0].includes('tcp dport ' + PORT + ' accept comment "' + TAG));
        rows.shift();
        await service.check();
        assert(rows[0].includes(TAG), 'reinstate rule after reload');
        const link = route => server.link(route);
        const token = new URL(link()).searchParams.get('t');
        assert.strictEqual(new URL(link()).host, target.ip + ':' + server.port);
        assert.strictEqual((await request(link().replace(token, 'b'.repeat(48)))).status, 403);
        assert.strictEqual((await request(link(), undefined, { Host: 'invalid.example' })).status, 403);
        const page = await request(link());
        assert.strictEqual(page.status, 200);
        assert(page.data.includes(Buffer.from('GIF library')));
        assert.strictEqual(server.phoneAt, target.ip === '127.0.0.1' ? null : now);
        const upload = name => link('/upload') + '&name=' + encodeURIComponent(name);
        assert.strictEqual((await request(upload('a.gif'), demo, { 'X-GIF-Home': '0' })).status, 403);
        assert.strictEqual((await request(upload('x.gif'), Buffer.alloc(1),
            { 'Content-Length': MAX_BYTES + 1 })).status, 413);
        const partial = new URL(upload('partial.gif'));
        const aborted = http.request({ hostname: partial.hostname, port: partial.port, path: partial.pathname + partial.search,
            method: 'POST', headers: { 'X-GIF-Home': '1', 'Content-Type': 'image/gif', 'Content-Length': demo.length }
        });
        aborted.on('error', () => {});
        aborted.write(demo.slice(0, 10));
        for (let i = 0; i < 30 && !server.busy; i++) await tick(20);
        assert(server.busy);
        aborted.destroy();
        for (let i = 0; i < 30 && server.busy; i++) await tick(20);
        assert(!server.busy);
        assert.strictEqual((await request(upload('a.gif'), demo)).status, 200);
        assert.strictEqual((await request(upload('a.gif'), demo)).status, 200);
        const state = (await request(link('/state'))).json();
        const a = state.files[0], b = state.files[1];
        assert.notStrictEqual(a.id, b.id);
        assert.strictEqual((await request(upload('bad.gif'), Buffer.from('GIF89a'))).status, 422);
        assert.strictEqual((await request(link('/preview') + '&id=..%2Fcustom.gif')).status, 422);
        assert.deepStrictEqual((await request(link('/preview') + '&id=' + a.id)).data, demo);
        const action = values => request(link('/action'), JSON.stringify(Object.assign({ revision: state.revision }, values)));
        assert.strictEqual((await action({ type: 'delete', ids: [a.id] })).status, 422);
        assert.strictEqual((await action({ type: 'delete', ids: [a.id, b.id], confirm: true })).status, 200);
        assert.strictEqual((await action({ type: 'playback', mode: 'all' })).status, 409);
        assert.strictEqual((await request(link('/diagnostics'))).headers['content-disposition'],
            'attachment; filename="gif-home-log.json"');
        now += SESSION_MS - 100;
        assert.strictEqual((await request(link('/renew'), '{}')).status, 200);
        now += 200;
        assert(server.valid(token));
        const stale = link('/state');
        now += SESSION_MS;
        assert.strictEqual(link(), '');
        assert.strictEqual((await request(stale)).status, 403);
        await service.check();
        assert.strictEqual((await helper()).json().ready, false);
        assert(rows.some(r => r.includes('mgu-video-net')));
        assert(rows.every(r => !r.includes(TAG)));
        assert(records.some(r => r === 'Request interrupted'));
        assert(records.every(r => !r.includes(token)));
    } finally {
        await server.close();
        if (service) await service.stop();
        fs.readdirSync(lib.dir).forEach(file => fs.unlinkSync(path.join(lib.dir, file)));
        fs.rmdirSync(lib.dir);
        fs.unlinkSync(lib.file);
        fs.rmdirSync(dir);
    }
}

network().then(() => console.log('GIF Home real HTTP, sessions, status and scoped rule lifecycle passed')).catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
