'use strict';

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { URL } = require('url');
const { LIMIT } = require('./gif');
const { page } = require('./phone_page');

const PORT = 18883, STATUS_PORT = 18983, IFACE = 'wlan_bridge';
const SESSION_MS = 30 * 60 * 1000, MAX_BYTES = LIMIT.bytes;
const octets = address => String(address || '').split('.').map(Number);
function privateAddress(address) {
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address)) return false;
    const p = octets(address);
    return p.every(n => n <= 255) && (p[0] === 10 || p[0] === 127 ||
        (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
        (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254));
}
function localAddresses(interfaces) {
    let all = interfaces;
    if (!all) { try { all = os.networkInterfaces(); } catch (_) { return []; } }
    const list = [];
    Object.keys(all).forEach(name => (all[name] || []).forEach(it => {
        if ((it.family !== 'IPv4' && it.family !== 4) || it.internal || !privateAddress(it.address)) return;
        if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(it.netmask || '') || it.netmask === '0.0.0.0') return;
        const priority = name === IFACE ? (it.address.indexOf('172.16.222.') === 0 ? 0 : 1) :
            /p2p|wlan|wifi|^wl/i.test(name) ? 2 : 3;
        list.push({ interface: name, ip: it.address, netmask: it.netmask, priority });
    }));
    return list.sort((a, b) => a.priority - b.priority).filter((a, i, all) =>
        all.findIndex(other => other.ip === a.ip) === i);
}
function sameSubnet(remote, target) {
    const ip = octets(remote), mask = octets(target.netmask);
    return privateAddress(remote) && privateAddress(target.ip) && octets(target.ip).every((p, i) =>
        (p & mask[i]) === (ip[i] & mask[i]));
}

function bridgeStatus() {
    return new Promise(resolve => {
        const failed = () => resolve({ ready: false, error: 'GIF Home network helper unavailable' });
        const request = http.get({ hostname: '127.0.0.1', port: STATUS_PORT, path: '/status', agent: false }, res => {
            let text = '';
            res.on('data', b => {
                text += b.toString();
                if (text.length > 4096) { request.destroy(); failed(); }
            });
            res.on('error', failed);
            res.on('end', () => {
                try {
                    const s = JSON.parse(text);
                    if (res.statusCode !== 200 || s.interface !== IFACE || s.port !== PORT) return failed();
                    resolve(s);
                } catch (_) { failed(); }
            });
        });
        request.setTimeout(1200, () => { request.destroy(); failed(); });
        request.on('error', failed);
    });
}

class GifUploadServer {
    constructor(options) {
        this.bind = options.bind || '0.0.0.0';
        this.port = options.port === undefined ? PORT : options.port;
        this.api = options.api;
        this.record = options.record || (() => {});
        this.clock = options.clock || Date.now;
        this.target = null;
        this.token = '';
        this.expires = 0;
        this.lastRequest = '';
        this.lastError = '';
        this.phoneAt = null;
        this.serverError = '';
        this.busy = false;
        this.previews = 0;
        this.sockets = new Set();
        this.server = http.createServer((req, res) => this.handle(req, res));
        this.server.maxConnections = 20;
        this.server.setTimeout(15000);
        this.server.on('connection', socket => {
            this.sockets.add(socket);
            socket.on('error', () => {});
            socket.on('close', () => this.sockets.delete(socket));
        });
        this.server.on('error', e => {
            this.serverError = 'HTTP server error (' + (e.code || 'unknown') + ')';
            this.record(this.serverError);
        });
        this.server.on('clientError', (_, socket) => {
            this.lastError = 'Malformed HTTP request';
            this.record(this.lastError);
            socket.destroy();
        });
    }

    get listening() { return this.server.listening; }

    start() {
        if (this.stopping) return this.stopping.then(() => this.start());
        if (this.listening) return Promise.resolve(this.port);
        if (this.starting) return this.starting;
        this.starting = new Promise((resolve, reject) => {
            const failed = err => { this.server.removeListener('listening', ready); reject(err); };
            const ready = () => {
                this.server.removeListener('error', failed);
                this.port = this.server.address().port;
                this.serverError = '';
                this.record('HTTP listening on TCP ' + this.port);
                resolve(this.port);
            };
            this.server.once('error', failed);
            this.server.once('listening', ready);
            this.server.listen(this.port, this.bind);
        }).then(port => { this.starting = null; return port; }, error => {
            this.starting = null;
            throw error;
        });
        return this.starting;
    }

    begin(target) {
        this.target = target;
        this.token = crypto.randomBytes(24).toString('hex');
        this.expires = this.clock() + SESSION_MS;
        this.lastRequest = this.lastError = '';
        this.phoneAt = null;
        this.record('QR session opened on ' + target.interface + ' ' + target.ip);
    }
    end() { this.token = ''; this.target = null; this.expires = 0; this.phoneAt = null; }
    get active() { return !!this.target && this.clock() < this.expires; }
    valid(token) {
        return this.active && typeof token === 'string' && /^[a-f0-9]{48}$/.test(token) &&
            crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.token));
    }
    link(route) {
        return this.active && this.listening ? 'http://' + this.target.ip + ':' + this.port +
            (route || '/') + '?t=' + this.token : '';
    }
    close() {
        this.end();
        this.sockets.forEach(socket => socket.destroy());
        if (!this.stopping) {
            this.stopping = new Promise(resolve => this.server.close(() => resolve()))
                .then(() => { this.stopping = null; });
        }
        return this.stopping;
    }
    statusCode(req, res, code, route, value, mime, extra) {
        const headers = Object.assign({
            'Content-Type': mime || 'application/json; charset=utf-8',
            'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
            'Connection': 'close', 'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
        }, extra);
        const result = mime ? value : JSON.stringify(value);
        headers['Content-Length'] = Buffer.byteLength(result);
        res.writeHead(code, headers);
        res.end(result);
        const message = req.method + ' ' + route + ' HTTP ' + code;
        if (code >= 400) this.lastError = value.error || message;
        if (code < 400) this.lastRequest = new Date(this.clock()).toISOString() + ' ' + message;
        if (route !== 'state' || code >= 400 || this.phoneAt === null) this.record(message + (code >= 400 ? ' ' + this.lastError : ''));
        if (code < 400 && (route === 'library' || route === 'state') &&
            !/^127\./.test(req.socket.remoteAddress || '') && /iPhone|iPad|iPod|Android|Mobile/i.test(req.headers['user-agent'] || ''))
            this.phoneAt = this.clock();
    }

    body(req, limit, done, fail) {
        if (this.busy) { req.resume(); return fail(409, 'Another request is being processed'); }
        const advertised = Number(req.headers['content-length'] || 0);
        if (advertised > limit) { req.resume(); return fail(413, 'Request too large'); }
        this.busy = true;
        let chunks = [], size = 0, complete = false;
        const settle = () => {
            if (complete) return false;
            complete = true;
            clearTimeout(deadline);
            chunks = [];
            this.busy = false;
            return true;
        };
        const abort = () => {
            if (settle()) {
                this.lastError = 'Request interrupted';
                this.record(this.lastError);
            }
        };
        const deadline = setTimeout(() => {
            if (settle() && !req.destroyed) fail(408, 'Request timed out');
        }, 30000);
        req.on('aborted', abort);
        req.on('close', abort);
        req.on('error', abort);
        req.on('data', chunk => {
            if (complete) return;
            size += chunk.length;
            if (size > limit) { settle(); return fail(413, 'Request too large'); }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (complete) return;
            try { done(Buffer.concat(chunks, size)); }
            finally { settle(); }
        });
    }

    handle(req, res) {
        let url;
        const remote = String(req.socket.remoteAddress || '');
        let route = 'unknown';
        const send = (code, value, mime, extra) => this.statusCode(req, res, code, route, value, mime, extra);
        const fail = (code, error) => send(code, { error });
        try { url = new URL(req.url, 'http://localhost'); }
        catch (_) { req.resume(); return fail(400, 'Invalid URL'); }
        if (req.method === 'GET' && url.pathname === '/.mgu-gif-health' && remote === '127.0.0.1') {
            res.writeHead(this.active && (this.target.interface === IFACE || this.target.priority === 2) ? 200 : 503,
                { 'X-MGU-GIF-Home': '1', Connection: 'close', 'Content-Length': '0' });
            return res.end();
        }
        if (!this.valid(url.searchParams.get('t'))) {
            req.resume();
            return fail(403, 'Invalid or expired QR session. Scan a new code.');
        }
        if (req.socket.localAddress !== this.target.ip || !sameSubnet(remote, this.target) ||
            req.headers.host !== this.target.ip + ':' + this.port) {
            req.resume();
            return fail(403, 'Selected local network only');
        }
        if (req.method === 'POST' && req.headers['x-gif-home'] !== '1') {
            req.resume();
            return fail(403, 'Application request header required');
        }
        const routes = { '/': 'library', '/state': 'state', '/action': 'action', '/upload': 'upload',
            '/preview': 'preview', '/diagnostics': 'diagnostics', '/renew': 'renew' };
        route = Object.prototype.hasOwnProperty.call(routes, url.pathname) ? routes[url.pathname] : 'unknown';
        const publicError = e => e.code ? 'Storage operation failed (' + e.code + ')' : e.message;
        if (req.method === 'GET') {
            try {
                if (route === 'library') return send(200, page, 'text/html; charset=utf-8');
                if (route === 'state') return send(200, Object.assign({ expires: this.expires }, this.api.state()));
                if (route === 'preview') {
                    if (this.previews >= 2) return fail(429, 'Too many GIF previews in progress');
                    const bytes = this.api.preview(url.searchParams.get('id'));
                    this.previews++;
                    const release = () => {
                        res.removeListener('close', release);
                        res.removeListener('finish', release);
                        this.previews--;
                    };
                    res.once('close', release);
                    res.once('finish', release);
                    return send(200, bytes, 'image/gif');
                }
                if (route === 'diagnostics') return send(200, JSON.stringify(this.api.diagnostics(), null, 2),
                    'application/json; charset=utf-8', { 'Content-Disposition': 'attachment; filename="gif-home-log.json"' });
            } catch (e) { return fail(422, publicError(e)); }
        }
        if (req.method === 'POST' && ['upload', 'action', 'renew'].includes(route)) {
            const mime = String(req.headers['content-type'] || '').split(';')[0];
            if (mime !== (route === 'upload' ? 'image/gif' : 'application/json')) {
                req.resume();
                return fail(415, 'Unsupported request content type');
            }
            const token = url.searchParams.get('t');
            return this.body(req, route === 'upload' ? MAX_BYTES : 16384, bytes => {
                if (!this.valid(token)) return fail(403, 'Session expired during request');
                try {
                    if (route === 'upload') this.api.upload(bytes, url.searchParams.get('name'));
                    if (route === 'action') this.api.action(JSON.parse(bytes.toString('utf8')));
                    if (route === 'renew') this.expires = this.clock() + SESSION_MS;
                    return send(200, Object.assign({ expires: this.expires }, this.api.state()));
                } catch (e) { return fail(e.status || 422, (route === 'upload' ? 'Upload rejected: ' : '') + publicError(e)); }
            }, fail);
        }
        req.resume();
        return fail(404, 'Page not found');
    }
}

module.exports = { GifUploadServer, localAddresses, bridgeStatus, PORT, IFACE, SESSION_MS, MAX_BYTES };
