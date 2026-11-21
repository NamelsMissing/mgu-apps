'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const {makeFirewall, TAG, PORT} = require('../native/cluster-net/firewall');
const {makeNetwork, probeCluster} = require('../native/cluster-net/server');
const {PhoneBridge, PORT: APP_PORT, NET_STATUS_PORT} = require('../apps/blitzer_status/phone_bridge');
const {STATUS_PORT} = require('../native/cluster-net/server');

function fakeNft() {
    let rows = [
        'iifname "wlan_bridge" tcp dport 18890 accept comment "mgu-phone-bridge" # handle 1',
        'iifname "wlan_bridge" tcp dport 18879 accept comment "mgu-video-net" # handle 2',
        'counter drop # handle 3'
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
    const own = nft.rows().filter(r => r.indexOf(TAG) >= 0);
    assert.strictEqual(own.length, 1);
    assert.ok(own[0].indexOf('iifname "wlan_bridge" tcp dport 18977 accept') >= 0, 'only this port, only the car Wi-Fi');
    const before = nft.inserted();
    assert.strictEqual(await fw.ensure(), 'kept');
    assert.strictEqual(nft.inserted(), before, 'idempotent');
    await fw.close();
    assert.ok(nft.rows().every(r => r.indexOf(TAG) < 0), 'own rule removed');
    assert.ok(nft.rows().some(r => r.indexOf('mgu-phone-bridge') >= 0) && nft.rows().some(r => r.indexOf('mgu-video-net') >= 0),
        'rules of other tools are never touched');
    nft.reload();
    assert.strictEqual(await fw.ensure(), 'added', 'recovers after a BMW firewall reload');
    await fw.close();
    await assert.rejects(makeFirewall({run: async () => { throw Error('nft denied'); }}).ensure(), /nft denied/);
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
        assert.strictEqual(open, false, 'closed while the app does not listen');
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

// the real app health endpoint is what the tool probes
async function checkProbe() {
    const port = 39000 + (process.pid % 900);
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'blitzer-net-'));
    const bridge = new PhoneBridge(dir, {info() {}, warn() {}}, null, {port, address: '127.0.0.2', netStatusPort: 0});
    assert.strictEqual(await probeCluster(port), false, 'nothing running');
    bridge.setEnabled(true);
    await new Promise(r => setTimeout(r, 80));
    assert.strictEqual(await probeCluster(port), true, 'app listening');
    bridge.stop();
    await new Promise(r => setTimeout(r, 80));
    assert.strictEqual(await probeCluster(port), false, 'app off: port must close');
    // a foreign service on the port must not open the firewall
    const other = http.createServer((q, s) => { s.writeHead(200); s.end('hi'); });
    await new Promise(r => other.listen(port, '127.0.0.1', r));
    assert.strictEqual(await probeCluster(port), false, 'foreign service on the port is not the link');
    await new Promise(r => other.close(r));
}

function checkManifest() {
    const root = path.resolve(__dirname, '..');
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'mgu-repo.json'), 'utf8'));
    const app = JSON.parse(fs.readFileSync(path.join(root, 'apps/blitzer_status/app.json'), 'utf8'));
    const tool = JSON.parse(fs.readFileSync(path.join(root, 'native/cluster-net/component.json'), 'utf8'));
    const toolEntry = catalog.components.find(c => c.id === tool.id);
    const appEntry = catalog.components.find(c => c.id === app.id);
    assert.ok(toolEntry && toolEntry.kind === 'tool' && toolEntry.path === 'native/cluster-net');
    assert.strictEqual(toolEntry.version, tool.version);
    assert.strictEqual(appEntry.version, app.version);
    const customCluster = catalog.components.find(c => c.id === 'custom_cluster');
    assert.ok(!Object.prototype.hasOwnProperty.call(customCluster.requires, tool.id));
    assert.strictEqual(appEntry.requires[tool.id], tool.version, 'Blitzer Status installs the firewall tool');
    for (const f of tool.files) assert.ok(fs.existsSync(path.join(root, 'native/cluster-net', f.path)));
    for (const u of tool.units) {
        const text = fs.readFileSync(path.join(root, 'native/cluster-net', u.from || u.name), 'utf8');
        assert.ok(text.indexOf('/var/opt/' + tool.id + '/current/') >= 0);
    }
}

checkFirewall().then(checkService).then(checkProbe).then(checkManifest).then(
    () => console.log('Blitzer Status phone port tool tests passed: scoped firewall, health probe, manifest'),
    e => { console.error(e.stack || e); process.exitCode = 1; });
