'use strict';

const mgu = require('./kit/mgu');
const qrcode = require('./qr');
const bridge = require('./control');

const W = 1600, H = 520;
const C = { bg: '#090f1d', panel: '#131d30', blue: '#4ba2ff', white: '#e7f1ff', muted: '#96acc4', green: '#59dfa7', amber: '#ffca70', red: '#ff617c' };

function makeUrl(ip, token) {
    if (!ip || !token) return '';
    return 'http://' + ip + ':18890/#pair=' + encodeURIComponent(token);
}

function drawQR(cv, value, x, y, size) {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount(), quiet = 4;
    const px = Math.floor(size / (count + quiet * 2));
    const total = px * (count + quiet * 2);
    const ox = x + Math.floor((size - total) / 2), oy = y + Math.floor((size - total) / 2);
    cv.roundRect(x - 12, y - 12, size + 24, size + 24, 20, '#ffffff');
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            if (qr.isDark(row, col)) cv.fillRect(ox + (col + quiet) * px, oy + (row + quiet) * px, px, px, '#091225');
        }
    }
}

mgu.run({
    async start(ctx) {
        const { ui, dataDir, log } = ctx;
        let info = null, token = '', candidate = 0, err = '', busy = false, lastCheck = 0;

        function reload() {
            bridge.status(dataDir, (error, data) => {
                if (error) { err = error.message; info = null; }
                else {
                    err = ''; info = data;
                    if (info.addresses && candidate >= info.addresses.length) candidate = 0;
                    if (info.state === 'closed' || (info.expiresAt && Date.now() > info.expiresAt)) token = '';
                }
            });
        }

        function action(kind) {
            if (busy) return;
            busy = true;
            bridge[kind](dataDir, (error, data) => {
                busy = false;
                if (error) { err = error.message; log.warn(kind + ': ' + err); return; }
                err = '';
                if (kind === 'start') { token = data.token; candidate = 0; }
                if (kind === 'stop') token = '';
                reload();
            });
        }

        ui.onClick('BTN_START', () => action('start'));
        ui.onClick('BTN_STOP', () => action('stop'));
        ui.onClick('BTN_ADDRESS', () => { if (info && info.addresses && info.addresses.length) candidate = (candidate + 1) % info.addresses.length; });

        ctx.loop('MAIN', 1, async () => {
            if (Date.now() - lastCheck > 3000) { lastCheck = Date.now(); reload(); }
            const cv = ctx.canvas(W, H);
            cv.clear(C.bg);
            cv.roundRect(22, 20, 1556, 480, 28, C.panel);
            cv.fillRect(22, 20, 8, 480, C.blue);
            cv.text('PHONE TERMINAL', 68, 92, 50, C.white, { font: 'bold' });
            cv.text('MGU / iDrive 7  |  Temporary root console', 70, 132, 24, C.muted);

            const addresses = info && info.addresses || [];
            const selected = addresses[candidate] || null;
            const network = info && info.firewall || null;
            const firewallError = network && network.error || '';
            const bridgeReady = !!(network && network.ready);
            const pairing = info && info.state === 'pairing' && token && info.expiresAt > Date.now();
            const alive = pairing && bridgeReady && selected && selected.interface === 'wlan_bridge';
            const url = alive && selected ? makeUrl(selected.ip, token) : '';
            const stateText = err ? 'BRIDGE ERROR' : firewallError ? 'FIREWALL ERROR'
                : info && !network ? 'BRIDGE UPDATE REQUIRED' : alive ? 'PAIRING READY'
                : pairing ? 'NETWORK NOT READY' : info && info.state === 'active' ? 'PHONE CONNECTED'
                : info ? 'ACCESS DISABLED' : 'BRIDGE NOT AVAILABLE';
            cv.roundRect(70, 156, 680, 54, 12, '#0b172b');
            cv.text(stateText, 92, 194, 27, err || firewallError ? C.red : alive || info && info.state === 'active' ? C.green : C.amber, { font: 'bold' });

            if (err) {
                cv.text(err.slice(0, 48), 70, 254, 23, C.red);
                if (err.length > 48) cv.text(err.slice(48, 95), 70, 286, 22, C.red);
                const hint = /ECONNREFUSED|timeout/i.test(err)
                    ? 'Bridge service offline: update the tool, then restart iDrive.'
                    : /HTTP 503/i.test(err)
                        ? 'Bridge running but app registration/key is not ready.'
                        : /EACCES|EPERM|App key setup|Key access|Key creation/i.test(err)
                            ? 'Key permission issue: update Bridge tool and restart iDrive.'
                            : 'Check the Bridge tool version and restart the app.';
                cv.text(hint, 70, 335, 20, C.muted);
            } else if (firewallError) {
                cv.text(firewallError.slice(0, 54), 70, 254, 22, C.red);
                if (firewallError.length > 54) cv.text(firewallError.slice(54, 106), 70, 285, 21, C.red);
                cv.text('Bridge cannot open TCP 18890 on wlan_bridge.', 70, 333, 20, C.muted);
                cv.text('Check nft firewall support / background tool.', 70, 371, 20, C.muted);
            } else if (info) {
                cv.text('Address: ' + (selected ? selected.ip + ':18890  (' + selected.interface + ')' : 'No reachable IPv4 interface'), 70, 255, 26, C.white);
                cv.text('Firewall: ' + (bridgeReady ? 'OPEN on wlan_bridge' : network ? 'opening / awaiting Wi-Fi' : 'update Bridge tool'), 70, 295, 23, C.muted);
                cv.text('QR: 3 min  |  Session: until revoked / restart', 70, 332, 22, C.muted);
                if (info.state === 'active') cv.text('Paired. Revoke access after use.', 70, 373, 24, C.green);
                else if (alive) cv.text('Scan QR with your phone camera.', 70, 373, 24, C.green);
                else if (pairing) cv.text('Connect via DIRECT-BMW Wi-Fi; QR unlocks when ready.', 70, 373, 20, C.amber);
                else cv.text('Press New session to show your private QR code.', 70, 373, 22, C.amber);
            }

            cv.text('Only use while parked. Root commands can damage the MGU.', 70, 460, 23, C.amber);
            if (url) {
                try { drawQR(cv, url, 1125, 61, 351); }
                catch (e) { cv.text('QR unavailable', 1160, 234, 27, C.red); log.warn('QR: ' + e); }
                cv.text(selected.ip + ':18890', 1301, 468, 22, C.muted, { align: 'center' });
            } else {
                cv.roundRect(1125, 61, 351, 351, 20, '#0b1627');
                cv.text('QR LOCKED', 1300, 238, 34, C.muted, { align: 'center', font: 'bold' });
            }
            return ui.image('MAIN_GFX', cv);
        });
        reload();
    },
});
