'use strict';

// Minimal, dependency-free RFC6455 server: BMW OAP Node 8 does not bundle ws.
// Serves the phone controller page, two WebSocket pads and the token-protected ROM
// import / list / delete endpoints. BMW's firewall drops Wi-Fi connections to this
// port until the root helper mgu-game-net (native/game-net) opens it; that helper
// probes /.mgu-gamestation-health over loopback and reports on 127.0.0.1:18978.
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const url = require('url');
const page = require('./phone_page');
const {Library, EXTENSIONS, safeName} = require('./library');
const {detect, validRom, maxRom, platforms} = require('./core_registry');

const PORT = 18878;
const NET_STATUS_PORT = 18978;
const MAX_MESSAGE = 1024;
const BUTTONS = new Set([].concat(...platforms.map(p => p.buttons)));
const STALE_MS = 1600;               // phones send their buttons every 400 ms
const TAKEOVER_MS = 2500;            // a silent slot may be taken by a reconnecting phone

function bare(ip) { return String(ip || '').replace(/^::ffff:/, ''); }
function privateAddress(ip) {
    ip = bare(ip);
    if (ip === '::1' || ip === '127.0.0.1') return true;
    const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const n = m.slice(1).map(Number);
    return n.every(x => x >= 0 && x <= 255) &&
        (n[0] === 10 || n[0] === 172 && n[1] >= 16 && n[1] <= 31 || n[0] === 192 && n[1] === 168);
}
function loopback(ip) { ip = bare(ip); return ip === '127.0.0.1' || ip === '::1'; }
/** The car's Wi-Fi address (172.16.222.x on the BMW hotspot), or another private one. */
function ownAddress(interfaces) {
    let all;
    try { all = interfaces || os.networkInterfaces(); }
    catch (_) { return null; } // No interface enumeration inside some OAP sandboxes.
    const valid = i => (i.family === 'IPv4' || i.family === 4) && !i.internal && privateAddress(i.address);
    const bridge = (all.wlan_bridge || []).filter(valid);
    const wifi = [].concat(...Object.keys(all).map(k => all[k] || [])).filter(i => valid(i) &&
        i.address.startsWith('172.16.222.'));
    return bridge.length === 1 ? bridge[0].address : wifi.length === 1 ? wifi[0].address : null;
}
const HEADERS = {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self' 'unsafe-inline' ws:; object-src 'none'; frame-ancestors 'none'"};
function reply(res, status, body, type) {
    const h = Object.assign({'Content-Type': type || 'text/plain; charset=utf-8'}, HEADERS);
    res.writeHead(status, h);
    res.end(body);
}
function json(res, status, value) { reply(res, status, JSON.stringify(value), 'application/json; charset=utf-8'); }
function frame(payload, op) {
    const data = Buffer.from(payload || '');
    const header = data.length < 126 ? 2 : 4;
    const out = Buffer.allocUnsafe(header + data.length);
    out[0] = 0x80 | (op || 1);
    if (header === 2) out[1] = data.length;
    else { out[1] = 126; out.writeUInt16BE(data.length, 2); }
    data.copy(out, header); return out;
}

class ControllerServer {
    /**
     * events: {upload(kind, name), removed(kind, name), command(player, msg), state() -> object,
     *          address() -> host (tests)}
     */
    constructor(dataDir, events, log, options) {
        const o = options || {};
        this.token = crypto.randomBytes(16).toString('hex');
        this.library = o.library || new Library(dataDir);
        this.events = events || {}; this.log = log || console;
        this.players = [null, null]; this.http = null; this.error = null; this.listening = false;
        this.port = o.port === undefined ? PORT : o.port;
        this.netStatusPort = o.netStatusPort === undefined ? NET_STATUS_PORT : o.netStatusPort;
        this.resolveAddress = this.events.address || ownAddress;
        this.host = null; this.hostAt = 0;
        this.net = {known: false, ready: false, error: ''}; this.netAt = 0; this.netBusy = false;
        this.activeUpload = null;
    }
    get address() { return this.currentHost(); }
    /** Re-read the Wi-Fi address now and then: the hotspot may come up after the app. */
    currentHost() {
        if (!this.hostAt || Date.now() - this.hostAt >= 3000) { this.host = this.resolveAddress(); this.hostAt = Date.now(); }
        return this.host;
    }
    url(player) {
        const host = this.currentHost();
        return host ? 'http://' + host + ':' + this.port + '/?p=' + player + '&t=' + this.token : null;
    }
    releasePads() {
        this.players.forEach(p => {
            if (!p) return;
            p.waitForRelease = Object.keys(p.keys).length > 0 || p.waitForRelease;
            p.keys = {};
        });
    }
    connected(p) { return !!(p && !p.closed && Date.now() - p.lastSeen < STALE_MS); }
    status() { return this.players.map(p => this.connected(p)); }
    pads() { return this.players.map(p => this.connected(p) ? p.keys : {}); }

    start() {
        if (this.http) return;
        const server = http.createServer((req, res) => this.request(req, res));
        server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
        server.on('listening', () => { if (this.http === server) { this.listening = true; this.error = null; } });
        server.on('error', err => {
            this.error = err.message; this.listening = false;
            this.log.warn('[GameStation] phone server: ' + err.message);
            if (this.http === server) { this.http = null; try { server.close(); } catch (_) { /* not listening */ } }
        });
        this.http = server;
        server.listen(this.port, '0.0.0.0');
    }
    /** Called regularly by the app: restart a server that failed (port still held), read the firewall helper. */
    poll() {
        const now = Date.now();
        if (!this.http && (!this.retryAt || now - this.retryAt > 5000)) { this.retryAt = now; try { this.start(); } catch (e) { this.error = e.message; } }
        if (now - this.netAt > 2500) { this.netAt = now; this.readNet(); }
    }
    readNet() {
        if (this.netBusy) return;
        this.netBusy = true;
        let body = '', done = false;
        const finish = net => { if (!done) { done = true; this.netBusy = false; this.net = net; } };
        const req = http.get({hostname: '127.0.0.1', port: this.netStatusPort, path: '/status'}, res => {
            if (res.statusCode !== 200) { res.resume(); return finish({known: true, ready: false, error: 'firewall helper HTTP ' + res.statusCode}); }
            res.on('data', part => { body += part.toString('utf8'); if (body.length > 4096) req.destroy(); });
            res.on('end', () => {
                try {
                    const v = JSON.parse(body);
                    finish({known: true, ready: v.ready === true, error: String(v.error || '')});
                } catch (_) { finish({known: true, ready: false, error: 'invalid firewall helper answer'}); }
            });
        });
        req.setTimeout(1500, () => req.destroy(new Error('timeout')));
        req.on('error', () => finish({known: false, ready: false, error: 'mgu-game-net is not running'}));
    }

    request(req, res) {
        const q = url.parse(req.url, true);
        // The root firewall helper checks over loopback that GameStation really listens.
        if (q.pathname === '/.mgu-gamestation-health' && req.method === 'GET' && loopback(req.socket.remoteAddress)) {
            res.writeHead(200, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-MGU-GameStation': '1'});
            return res.end('{"ok":true}');
        }
        if (!privateAddress(req.socket.remoteAddress)) return reply(res, 403, 'Local network only');
        if (q.query.t !== this.token) return reply(res, 403, 'Invalid pairing link. Scan the QR code on the BMW screen again.');
        if (req.method === 'GET' && q.pathname === '/') return reply(res, 200, page, 'text/html; charset=utf-8');
        if (req.method === 'GET' && q.pathname === '/diagnostics' && this.events.diagnosticLog) {
            if (q.query.download === '1') res.setHeader('Content-Disposition', 'attachment; filename="gamestation.log"');
            return reply(res, 200, this.events.diagnosticLog());
        }
        if (req.method === 'GET' && q.pathname === '/roms') return json(res, 200, this.catalog());
        if (req.method === 'POST' && q.pathname === '/rom') return this.upload(req, res, q.query);
        if (req.method === 'POST' && q.pathname === '/delete') return this.remove(res, q.query);
        reply(res, 404, 'Not found');
    }
    catalog() {
        const games = {};
        Object.keys(EXTENSIONS).forEach(kind => {
            games[kind] = this.library.list(kind).map(g => ({name: g.name, title: g.title, size: g.size, saved: g.saved}));
        });
        return {games, state: this.events.state ? this.events.state() : {}};
    }
    upload(req, res, query) {
        const name = safeName(typeof query.name === 'string' ? query.name : '');
        const kind = detect(name), replace = query.replace === '1';
        const declared = Number(req.headers['content-length'] || 0);
        if (!kind || query.platform !== undefined && query.platform !== kind)
            return reply(res, 400, 'Unsupported or ambiguous ROM format');
        const limit = maxRom(kind), tooLarge = 'File too large (max ' + limit / 1048576 + ' MiB)';
        if (declared > limit) return reply(res, 413, tooLarge);
        if (this.activeUpload) return reply(res, 409, 'Another upload is in progress');
        this.activeUpload = req;
        let size = 0, buffers = [], done = false;
        const deadline = setTimeout(() => req.destroy(), 60000);
        const finish = () => {
            clearTimeout(deadline);
            if (this.activeUpload === req) this.activeUpload = null;
            done = true;
            buffers = [];
        };
        req.on('aborted', finish);
        req.on('error', finish);
        res.on('close', finish);
        req.on('data', part => {
            if (done) return;
            size += part.length;
            if (size > limit) {
                finish();
                res.setHeader('Connection', 'close');
                return reply(res, 413, tooLarge);
            }
            buffers.push(part);
        });
        req.on('end', () => {
            if (done) return;
            const bytes = Buffer.concat(buffers, size);
            finish();
            if (!validRom(kind, name, bytes)) return reply(res, 400, 'This is not a valid ' + kind.toUpperCase() + ' game file.');
            try {
                const stored = this.library.add(kind, name, bytes, replace);
                this.log.info('[GameStation] imported ' + kind + '/' + stored + ' (' + bytes.length + ' bytes)');
                if (this.events.upload) this.events.upload(kind, stored);
                reply(res, 201, 'Added ' + stored + '. Pick it on the BMW screen.');
            } catch (e) {
                if (e.code === 'EEXIST') return reply(res, 409, 'A game with this name already exists.');
                reply(res, 500, 'Cannot store the game: ' + e.message);
            }
        });
    }
    remove(res, query) {
        const kind = query.platform, name = String(query.name || '');
        if (!EXTENSIONS[kind]) return reply(res, 400, 'Unknown console');
        try {
            if (this.events.removing) this.events.removing(kind, name);
            if (!this.library.remove(kind, name)) return reply(res, 404, 'Game not found');
            this.log.info('[GameStation] deleted ' + kind + '/' + name);
            if (this.events.removed) this.events.removed(kind, name);
            reply(res, 200, 'Deleted ' + name);
        } catch (e) { reply(res, 500, 'Cannot delete: ' + e.message); }
    }

    upgrade(req, socket, head) {
        const q = url.parse(req.url, true), player = Number(q.query.p) - 1;
        if (!privateAddress(socket.remoteAddress) || q.query.t !== this.token || !(player === 0 || player === 1) ||
            String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' ||
            !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'] || '')) { socket.destroy(); return; }
        // A live phone keeps its slot; a silent one (reloaded page, phone locked) can be replaced.
        const old = this.players[player];
        if (old && !old.closed) {
            if (Date.now() - old.lastSeen < TAKEOVER_MS) { socket.destroy(); return; }
            old.closed = true; try { old.socket.destroy(); } catch (_) { /* gone */ }
        }
        const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
        const p = {socket, keys: {}, lastSeen: Date.now(), closed: false, buffered: Buffer.alloc(0), index: player};
        this.players[player] = p;
        const close = () => { p.closed = true; p.keys = {}; if (this.players[player] === p) this.players[player] = null; };
        socket.on('close', close); socket.on('error', close);
        socket.on('data', d => this.onData(p, d));
        if (head && head.length) this.onData(p, head);
        socket.setNoDelay(true);
        this.send(p, Object.assign({type: 'state'}, this.events.state ? this.events.state() : {}));
    }
    onData(p, part) {
        p.buffered = Buffer.concat([p.buffered, part]);
        if (p.buffered.length > 2048) { p.socket.destroy(); return; }
        while (p.buffered.length >= 2) {
            const b = p.buffered, opcode = b[0] & 15, masked = !!(b[1] & 0x80), size0 = b[1] & 127;
            if (!(b[0] & 0x80) || !masked || size0 === 127) { p.socket.destroy(); return; }
            const prefix = size0 === 126 ? 4 : 2;
            if (b.length < prefix) return;
            const size = size0 === 126 ? b.readUInt16BE(2) : size0;
            if (size > MAX_MESSAGE) { p.socket.destroy(); return; }
            if (b.length < prefix + 4 + size) return;
            const mask = b.slice(prefix, prefix + 4), data = Buffer.from(b.slice(prefix + 4, prefix + 4 + size));
            for (let i = 0; i < size; i++) data[i] ^= mask[i & 3];
            p.buffered = b.slice(prefix + 4 + size);
            if (opcode === 8) { p.closed = true; p.keys = {}; p.socket.end(frame('', 8)); return; }
            if (opcode === 9) { p.socket.write(frame(data, 10)); continue; }
            if (opcode === 10) { p.lastSeen = Date.now(); continue; }
            if (opcode !== 1) { p.socket.destroy(); return; }
            let msg; try { msg = JSON.parse(data.toString('utf8')); } catch (_) { continue; }
            if (!msg || typeof msg !== 'object') continue;
            if (msg.type === 'buttons' && Array.isArray(msg.keys) && msg.keys.length <= BUTTONS.size) {
                const next = {};
                msg.keys.forEach(k => { if (BUTTONS.has(k)) next[k] = true; });
                const mayPress = !this.events.acceptsButtons || this.events.acceptsButtons(p.index + 1);
                if (!Object.keys(next).length) p.waitForRelease = false;
                else if (!mayPress) p.waitForRelease = true;
                p.keys = p.waitForRelease ? {} : next; p.lastSeen = Date.now();
            } else if (msg.type === 'pause' || msg.type === 'resume') {
                p.lastSeen = Date.now();
                if (this.events.command) this.events.command(p.index + 1, {type: msg.type});
            }
        }
    }
    send(p, value) {
        if (!p || p.closed) return;
        try { p.socket.write(frame(JSON.stringify(value), 1)); } catch (_) { /* closing */ }
    }
    /** Tell both phones what the car shows (game, paused, parked). */
    broadcast(value) { this.players.forEach(p => this.send(p, Object.assign({type: 'state'}, value))); }
    stop() {
        if (this.activeUpload) this.activeUpload.destroy();
        this.players.forEach(p => { if (p) { p.closed = true; try { p.socket.destroy(); } catch (_) { /* gone */ } } });
        this.players = [null, null];
        if (this.http) { try { this.http.close(); } catch (_) { /* not listening */ } }
        this.http = null; this.listening = false;
    }
}

module.exports = {ControllerServer, privateAddress, validRom, ownAddress, PORT, NET_STATUS_PORT, STALE_MS};
