'use strict';
/*
 * Phone status link for iOS Shortcuts.
 *
 * Two personal automations on the iPhone ("App is opened" / "App is closed")
 * call  http://<head unit>:18977/s/<token>/on  and  .../off  over the car's
 * CarPlay Wi-Fi. Nothing else is accepted and nothing is ever sent back but
 * "OK". The link only knows the last event: iOS reports "closed" as soon as
 * the app leaves the foreground, so it does NOT prove whether the app still
 * runs in the background, and it carries no data of the app itself.
 *
 * BMW's firewall drops inbound connections on the Wi-Fi interface. The root
 * tool mgu-cluster-net (native/cluster-net) opens exactly this port, and only
 * while the loopback health endpoint below says the link is listening.
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = 18977;
const NET_STATUS_PORT = 18976;
// The last event stands for one drive; an event from long ago says nothing.
const HOLD_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 5000;

function ipv4OnCarWifi(interfaces) {
    const net = interfaces || os.networkInterfaces();
    // The car's bridge is usually wlan_bridge. Never bind to all interfaces.
    const names = Object.keys(net).filter((n) => /^wlan_bridge$|^wlan\d+$|^wlan\d+_bridge$/.test(n));
    for (const n of names) {
        const a = (net[n] || []).find((x) => x.family === 'IPv4' && !x.internal);
        if (a) return a.address;
    }
    return null;
}

class PhoneBridge {
    constructor(dataDir, log, changed, opts) {
        opts = opts || {};
        this.log = log;
        this.changed = changed || (() => {});
        this.now = opts.now || Date.now;
        this.server = null;
        this.health = null;
        this.host = null;
        this.enabled = false;
        this.mode = 'unknown';
        this.updated = 0;
        this.events = 0;
        this.lastTryAt = 0;
        this.lastNetAt = 0;
        this.net = { known: false, ready: false, error: 'not asked yet' };
        this.port = opts.port || PORT;
        this.healthPort = opts.healthPort === undefined ? this.port : opts.healthPort;
        this.netStatusPort = opts.netStatusPort === undefined ? NET_STATUS_PORT : opts.netStatusPort;
        this.address = opts.address;
        this.resolveAddress = opts.resolveAddress || ipv4OnCarWifi;
        this.tokenFile = path.join(dataDir, 'phone-bridge-token');
        try {
            this.token = fs.readFileSync(this.tokenFile, 'utf8').trim();
            if (!/^[a-f0-9]{32}$/.test(this.token)) throw new Error('invalid token');
        } catch (e) {
            this.token = crypto.randomBytes(16).toString('hex');
            try { fs.writeFileSync(this.tokenFile, this.token + '\n', { mode: 0o600, flag: 'wx' }); }
            catch (writeError) { this.log.warn('phone token could not be saved: ' + writeError); }
        }
    }

    setEnabled(enabled) {
        this.enabled = !!enabled;
        if (!this.enabled) { this.stop(); return; }
        this._startHealth();
        this._start();
    }

    /** Call regularly: the phone's Wi-Fi often comes up after the app. */
    tick() {
        if (!this.enabled) return;
        const now = this.now();
        if (now - this.lastTryAt >= RETRY_MS) {
            this.lastTryAt = now;
            const host = this.address || this.resolveAddress();
            // The Wi-Fi address can change when the phone reconnects.
            if (this.server && host && host !== this.host) this._stopMain();
            if (!this.server) this._start();
            if (!this.health) this._startHealth();
        }
        if (this.netStatusPort && now - this.lastNetAt >= RETRY_MS) { this.lastNetAt = now; this._readNet(); }
    }

    _start() {
        if (this.server) return;
        const host = this.address || this.resolveAddress();
        if (!host) {
            if (!this.warnedNoAddress) this.log.warn('No CarPlay Wi-Fi address yet, phone link waits');
            this.warnedNoAddress = true;
            this.host = null;
            return;
        }
        this.warnedNoAddress = false;
        this.host = host;
        const server = http.createServer((req, res) => this._handle(req, res));
        this.server = server;
        server.on('error', (err) => {
            this.log.warn('phone link: ' + err.message);
            if (this.server === server) { this.server = null; this.host = null; }
            try { server.close(); } catch (e) {}
        });
        server.listen(this.port, host);
    }

    /* Keep the legacy health path and header for installed firewall tools. */
    _startHealth() {
        if (this.health || !this.healthPort) return;
        const health = http.createServer((req, res) => {
            const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
            const listening = !!(this.server && this.server.listening);
            if (req.method !== 'GET' || req.url !== '/.mgu-cluster-health' || remote !== '127.0.0.1' || !listening) {
                res.writeHead(listening ? 404 : 503, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
                return res.end('');
            }
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-MGU-Custom-Cluster': '1' });
            res.end('{"ok":true}');
        });
        this.health = health;
        health.on('error', (err) => {
            this.log.warn('phone link health: ' + err.message);
            if (this.health === health) this.health = null;
            try { health.close(); } catch (e) {}
        });
        health.listen(this.healthPort, '127.0.0.1');
    }

    _readNet() {
        let body = '', done = false;
        const finish = (net) => { if (!done) { done = true; this.net = net; } };
        const req = http.get({ hostname: '127.0.0.1', port: this.netStatusPort, path: '/status' }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return finish({ known: true, ready: false, error: 'firewall tool HTTP ' + res.statusCode }); }
            res.on('data', (part) => { body += part.toString('utf8'); if (body.length > 4096) req.destroy(); });
            res.on('end', () => {
                try {
                    const v = JSON.parse(body);
                    finish({ known: true, ready: v.ready === true, error: String(v.error || '') });
                } catch (e) { finish({ known: true, ready: false, error: 'invalid firewall tool answer' }); }
            });
        });
        req.setTimeout(1500, () => req.destroy(new Error('timeout')));
        req.on('error', () => finish({ known: false, ready: false, error: 'firewall tool mgu-cluster-net not running' }));
    }

    _handle(req, res) {
        const route = '/s/' + this.token + '/';
        const pathname = (req.url || '').split('?')[0];
        // A passworded, same-network, write-only signal; no third-party access.
        if (!this.enabled || req.method !== 'GET' || (pathname !== route + 'on' && pathname !== route + 'off')) {
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end('Not found');
            return;
        }
        this.mode = pathname === route + 'on' ? 'opened' : 'closed';
        this.updated = this.now();
        this.events++;
        this.changed();
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
        res.end('OK');
    }

    /** 'opened' | 'closed' | 'unknown' (no event yet, or the last one is too old). */
    reported() {
        if (!this.updated || this.now() - this.updated > HOLD_MS) return 'unknown';
        return this.mode;
    }
    ageSeconds() { return this.updated ? Math.max(0, Math.round((this.now() - this.updated) / 1000)) : null; }
    listening() { return !!(this.server && this.server.listening && this.host); }
    url(state) {
        if (!this.listening()) return null;
        return 'http://' + this.host + ':' + this.port + '/s/' + this.token + '/' + state;
    }
    _stopMain() {
        if (this.server) { try { this.server.close(); } catch (e) {} }
        this.server = null;
        this.host = null;
    }
    stop() {
        this.enabled = false;
        this._stopMain();
        if (this.health) { try { this.health.close(); } catch (e) {} }
        this.health = null;
        this.mode = 'unknown';
        this.updated = 0;
        this.changed();
    }
}

module.exports = { PhoneBridge, ipv4OnCarWifi, PORT, NET_STATUS_PORT, HOLD_MS };
