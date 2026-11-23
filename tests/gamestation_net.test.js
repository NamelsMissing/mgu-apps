'use strict';

// node tests/gamestation_net.test.js - the root helper mgu-game-net (native/game-net) opens
// TCP 18878 on the car's Wi-Fi only while GameStation's phone server really listens, never
// touches other tools' rules, and the app and tool agree on ports and the health probe.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {makeFirewall, TAG, PORT} = require('../native/game-net/firewall');
const {makeNetwork, probeGameStation, STATUS_PORT} = require('../native/game-net/server');
const {ControllerServer, PORT: APP_PORT, NET_STATUS_PORT} = require('../apps/mgu_gamestation/controller_server');

function fakeNft() {
    let rows = [
        'iifname "wlan_bridge" tcp dport 18890 accept comment "mgu-phone-bridge" # handle 1',
        'iifname "wlan_bridge" tcp dport 18879 accept comment "mgu-video-net" # handle 2',
        'iifname "wlan_bridge" tcp dport 18977 accept comment "mgu-cluster-net" # handle 3',
        'counter drop # handle 4'
    ];
    let handle = 10, inserted = 0;
    async function run(args) {
        if (args[0] === '-a') return 'table ip filter {\nchain input {\n' + rows.join('\n') + '\n}\n}\n';
        if (args[0] === 'insert') { rows.unshift(args.slice(5).join(' ') + ' # handle ' + handle++); inserted++; return ''; }
        if (args[0] === 'delete') { rows = rows.filter(r => !r.endsWith('handle ' + args[6])); return ''; }
        throw new Error('Unexpected nft arguments: ' + args.join(' '));
    }
    return {run, rows: () => rows, inserted: () => inserted, reload: () => { rows = ['counter drop # handle 90']; }};
}

async function checkFirewall() {
    assert.strictEqual(PORT, APP_PORT, 'tool and app agree on the port');
    assert.strictEqual(STATUS_PORT, NET_STATUS_PORT, 'tool and app agree on the status port');
    const nft = fakeNft(), fw = makeFirewall({run: nft.run});
    assert.strictEqual(await fw.ensure(), 'added');
    const own = nft.rows().filter(r => r.indexOf('"' + TAG + '"') >= 0);
    assert.strictEqual(own.length, 1);
    assert.ok(own[0].indexOf('iifname "wlan_bridge" tcp dport 18878 accept') >= 0, 'only this port, only the car Wi-Fi');
    const before = nft.inserted();
    assert.strictEqual(await fw.ensure(), 'kept');
    assert.strictEqual(nft.inserted(), before, 'idempotent');
    await fw.close();
    assert.ok(nft.rows().every(r => r.indexOf('"' + TAG + '"') < 0), 'own rule removed');
    ['mgu-phone-bridge', 'mgu-video-net', 'mgu-cluster-net'].forEach(tag =>
        assert.ok(nft.rows().some(r => r.indexOf(tag) >= 0), 'the rule of ' + tag + ' is never touched'));
    nft.reload();
    assert.strictEqual(await fw.ensure(), 'added', 'recovers after a BMW firewall reload');
    await fw.close();
    const blocked = await makeFirewall({run: async () => { throw Error('nft denied'); }}).ensure().then(
        () => null, error => error);
    assert.ok(blocked && /nft denied/.test(blocked.message));
}

const readStatus = port => new Promise((resolve, reject) => {
    http.get({hostname: '127.0.0.1', port, path: '/status'}, res => {
        let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
});

async function checkService() {
    let healthy = false, open = false, deny = false;
    const fw = {ensure: async () => { if (deny) throw Error('nft denied'); open = true; }, close: async () => { open = false; }};
    const service = makeNetwork({firewall: fw, probe: async () => healthy, statusPort: 0, intervalMs: 100000});
    const port = await service.start();
    try {
        assert.strictEqual((await readStatus(port)).ready, false);
        assert.strictEqual(open, false, 'closed while GameStation does not listen');
        healthy = true; await service.check();
        assert.strictEqual(open, true);
        assert.strictEqual((await readStatus(port)).ready, true);
        healthy = false; await service.check();
        assert.strictEqual(open, false, 'app stopped: port closed again');
        deny = true; healthy = true; await service.check();
        const s = await readStatus(port);
        assert.strictEqual(s.ready, false, 'a failing nft never reports ready');
        assert.ok(s.error.indexOf('nft denied') >= 0);
    } finally {
        await service.stop();
        assert.strictEqual(open, false);
    }
}

// the app's real health endpoint is what the tool probes
async function checkProbe() {
    const port = 39900 + (process.pid % 90);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-net-'));
    const server = new ControllerServer(dir, {}, {info() {}, warn() {}}, {port, netStatusPort: 0});
    try {
        assert.strictEqual(await probeGameStation(port), false, 'nothing running');
        server.start();
        await new Promise(r => setTimeout(r, 80));
        assert.strictEqual(await probeGameStation(port), true, 'GameStation listening');
        server.stop();
        await new Promise(r => setTimeout(r, 80));
        assert.strictEqual(await probeGameStation(port), false, 'GameStation off: port must close');
        const other = http.createServer((q, s) => { s.writeHead(200); s.end('hi'); });
        await new Promise(r => other.listen(port, '127.0.0.1', r));
        assert.strictEqual(await probeGameStation(port), false, 'a foreign service on the port is not GameStation');
        await new Promise(r => other.close(r));
    } finally { fs.rmdirSync(dir); }
}

function checkManifest() {
    const root = path.resolve(__dirname, '..');
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'mgu-repo.json'), 'utf8'));
    const app = JSON.parse(fs.readFileSync(path.join(root, 'apps/mgu_gamestation/app.json'), 'utf8'));
    const tool = JSON.parse(fs.readFileSync(path.join(root, 'native/game-net/component.json'), 'utf8'));
    const toolEntry = catalog.components.find(c => c.id === tool.id);
    const appEntry = catalog.components.find(c => c.id === app.id);
    assert.ok(toolEntry && toolEntry.kind === 'tool' && toolEntry.path === 'native/game-net');
    assert.strictEqual(toolEntry.version, tool.version);
    assert.strictEqual(appEntry.version, app.version);
    assert.strictEqual(appEntry.requires[tool.id], tool.version, 'GameStation installs the firewall tool');
    for (const f of tool.files) assert.ok(fs.existsSync(path.join(root, 'native/game-net', f.path)));
    for (const u of tool.units) {
        const text = fs.readFileSync(path.join(root, 'native/game-net', u.from || u.name), 'utf8');
        assert.ok(text.indexOf('/var/opt/' + tool.id + '/current/') >= 0);
    }
    assert.ok(fs.statSync(path.join(root, 'native/game-net/mgu-game-net')).mode & 0o100, 'launcher is executable');
    const audioRoot = path.join(root, 'native/gamestation-audio');
    const audio = JSON.parse(fs.readFileSync(path.join(audioRoot, 'component.json'), 'utf8'));
    const audioEntry = catalog.components.find(c => c.id === audio.id);
    assert.strictEqual(audioEntry.path, 'native/gamestation-audio');
    assert.strictEqual(audioEntry.version, audio.version);
    assert.strictEqual(appEntry.requires[audio.id], audio.version);
    assert.ok(!audio.units && !audio.enable, 'PCM helper runs as a child only');
    for (const f of audio.files) assert.ok(fs.statSync(path.join(audioRoot, f.path)).isFile());

    const retroPath = path.join(root, 'native/gamestation-retro');
    const retro = JSON.parse(fs.readFileSync(path.join(retroPath, 'component.json'), 'utf8'));
    const retroEntry = catalog.components.find(c => c.id === retro.id);
    assert.strictEqual(appEntry.requires[retro.id], retro.version);
    assert.strictEqual(retroEntry.version, retro.version);
    assert.ok(!retro.units && !retro.enable, 'retro worker is on demand');
    for (const file of retro.files) assert.ok(fs.statSync(path.join(retroPath, file.path)).isFile());

}

checkFirewall().then(checkService).then(checkProbe).then(checkManifest).then(
    () => console.log('ok: GameStation phone port tool: scoped firewall, health probe, manifest'),
    e => { console.error(e.stack || e); process.exitCode = 1; });
