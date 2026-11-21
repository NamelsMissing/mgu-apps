'use strict';
// Phone remote: a small HTTP server on the car's Wi-Fi. The phone scans the QR code on the
// BMW screen (address + random pairing token), the page polls /api/state and sends actions.
// Every action goes through the same guard and runner as the buttons on the car screen.
// BMW's firewall drops Wi-Fi connections to this port until the root helper mgu-light-net
// (native/light-net) opens it; the helper probes /.mgu-light-show-health over loopback.
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { URL } = require('url');
const page = require('./web-page');

const PORT = 18880;
const NET_STATUS_PORT = 18980;
const FALLBACK_HOST = '172.16.222.97';
const MAX_BODY = 8192;

function bare(ip) { return String(ip || '').replace(/^::ffff:/, ''); }
function privateAddress(ip) {
    ip = bare(ip);
    if (ip === '::1' || ip === '127.0.0.1') return true;
    const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const n = m.slice(1).map(Number);
    return n.every((x) => x >= 0 && x <= 255) &&
        (n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168));
}
function loopback(ip) { ip = bare(ip); return ip === '127.0.0.1' || ip === '::1'; }
/** The car's Wi-Fi address (172.16.222.x on the BMW hotspot), or another private one. */
function ownAddress() {
    let all;
    try { all = os.networkInterfaces(); } catch (_) { return FALLBACK_HOST; }
    const found = [];
    Object.keys(all).forEach((k) => (all[k] || []).forEach((i) => {
        if (i.family === 'IPv4' && !i.internal && privateAddress(i.address)) found.push(i.address);
    }));
    return found.find((ip) => ip.indexOf('172.16.222.') === 0) || found[0] || FALLBACK_HOST;
}
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'" };
function reply(res, status, body, type) {
    res.writeHead(status, Object.assign({ 'Content-Type': type || 'text/plain; charset=utf-8' }, HEADERS));
    res.end(body);
}
function json(res, status, value) { reply(res, status, JSON.stringify(value), 'application/json; charset=utf-8'); }

class WebServer {
    /** actions: {state(), show(body), save(body), test(body), observe(body), name(body), stop(), scan()} -> value|Promise */
    constructor(actions, log, options) {
        const o = options || {};
        this.actions = actions; this.log = log || console;
        this.token = o.token || crypto.randomBytes(12).toString('hex');
        this.port = o.port === undefined ? PORT : o.port;
        this.netStatusPort = o.netStatusPort === undefined ? NET_STATUS_PORT : o.netStatusPort;
        this.resolveAddress = o.address || ownAddress;
        this.http = null; this.listening = false; this.error = null; this.retryAt = 0;
        this.host = null; this.hostAt = 0; this.lastSeen = 0; this.clients = 0;
        this.net = { known: false, ready: false, error: '' }; this.netAt = 0; this.netBusy = false;
    }
    currentHost() {
        if (!this.hostAt || Date.now() - this.hostAt >= 3000) { this.host = this.resolveAddress(); this.hostAt = Date.now(); }
        return this.host;
    }
    url() { return 'http://' + this.currentHost() + ':' + this.port + '/?t=' + this.token; }
    phoneConnected() { return Date.now() - this.lastSeen < 4000; }
    start() {
        if (this.http) return;
        const server = http.createServer((req, res) => this.request(req, res));
        server.on('listening', () => { if (this.http === server) { this.listening = true; this.error = null; } });
        server.on('error', (err) => {
            this.error = err.message; this.listening = false;
            this.log.warn('[Light Show] phone server: ' + err.message);
            if (this.http === server) { this.http = null; try { server.close(); } catch (_) { /* not listening */ } }
        });
        this.http = server;
        server.listen(this.port, '0.0.0.0');
    }
    /** Called regularly: restart a failed server, ask the firewall helper whether the port is open. */
    poll() {
        const now = Date.now();
        if (!this.http && now - this.retryAt > 5000) { this.retryAt = now; try { this.start(); } catch (e) { this.error = e.message; } }
        if (now - this.netAt > 2500) { this.netAt = now; this.readNet(); }
    }
    readNet() {
        if (this.netBusy) return;
        this.netBusy = true;
        let body = '', done = false;
        const finish = (net) => { if (!done) { done = true; this.netBusy = false; this.net = net; } };
        const req = http.get({ hostname: '127.0.0.1', port: this.netStatusPort, path: '/status' }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return finish({ known: true, ready: false, error: 'helper HTTP ' + res.statusCode }); }
            res.on('data', (part) => { body += part.toString('utf8'); if (body.length > 4096) req.destroy(); });
            res.on('end', () => {
                try { const v = JSON.parse(body); finish({ known: true, ready: v.ready === true, error: String(v.error || '') }); }
                catch (_) { finish({ known: true, ready: false, error: 'invalid helper answer' }); }
            });
        });
        req.setTimeout(1500, () => req.destroy(new Error('timeout')));
        req.on('error', () => finish({ known: false, ready: false, error: 'mgu-light-net is not running' }));
    }
    request(req, res) {
        let q;
        try { q = new URL(req.url, 'http://localhost'); }
        catch (_) { return reply(res, 400, 'Invalid request URL'); }
        if (q.pathname === '/.mgu-light-show-health' && req.method === 'GET' && loopback(req.socket.remoteAddress)) {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-MGU-Light-Show': '1' });
            return res.end('{"ok":true}');
        }
        if (!privateAddress(req.socket.remoteAddress)) return reply(res, 403, 'Local network only');
        const tokens = q.searchParams.getAll('t');
        if (tokens.length !== 1 || tokens[0] !== this.token) return reply(res, 403, 'Invalid link. Scan the QR code on the BMW screen again.');
        this.lastSeen = Date.now();
        if (req.method === 'GET' && q.pathname === '/') return reply(res, 200, page, 'text/html; charset=utf-8');
        if (req.method === 'GET' && q.pathname === '/api/state') return this.answer(res, () => this.actions.state());
        const routes = { '/api/show': 'show', '/api/save': 'save', '/api/test': 'test', '/api/toggle': 'toggle', '/api/observe': 'observe',
            '/api/name': 'name', '/api/stop': 'stop', '/api/scan': 'scan', '/api/experimental': 'experimental', '/api/commoff': 'commoff' };
        const action = routes[q.pathname];
        if (req.method !== 'POST' || !action || typeof this.actions[action] !== 'function') return reply(res, 404, 'Not found');
        const chunks = [];
        let size = 0, over = false;
        req.on('data', (part) => {
            if (over) return;
            size += part.length;
            if (size > MAX_BODY) { over = true; res.setHeader('Connection', 'close'); reply(res, 413, 'Request too large'); return; }
            chunks.push(part);
        });
        req.on('end', () => {
            if (over) return;
            let value = {};
            if (size) { try { value = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch (_) { return json(res, 400, { ok: false, error: 'Invalid JSON' }); } }
            if (!value || typeof value !== 'object' || Array.isArray(value)) return json(res, 400, { ok: false, error: 'Invalid request' });
            this.answer(res, () => this.actions[action](value));
        });
    }
    answer(res, fn) {
        Promise.resolve().then(fn).then((v) => json(res, 200, v === undefined ? { ok: true } : v),
            (e) => json(res, 400, { ok: false, error: String(e && e.message || e) }));
    }
    stop() {
        if (this.http) { try { this.http.close(); } catch (_) { /* not listening */ } }
        this.http = null; this.listening = false;
    }
}

module.exports = { WebServer, privateAddress, ownAddress, PORT, NET_STATUS_PORT };
