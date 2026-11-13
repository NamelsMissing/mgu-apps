'use strict';

/* Root daemon. Node 8 compatible and dependency-free. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const child = require('child_process');
const { makeFirewall } = require('./firewall');

const APP_ID = 'mgu_phone_terminal';
const DEFAULT_LOCAL_PORT = 18891;
const DEFAULT_PUBLIC_PORT = 18890;
const PAIR_MS = 3 * 60 * 1000;
const LIMIT_MS = 15000;
const MAX_OUT = 60000;
const MAX_DOWNLOAD = 256 * 1024 * 1024;
const DOWNLOAD_TICKET_MS = 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 4096;

function token() { return crypto.randomBytes(32).toString('hex'); }
function same(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const aa = Buffer.from(a), bb = Buffer.from(b);
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function send(res, status, body, headers) {
    res.writeHead(status, Object.assign({
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        'Content-Type': 'application/json; charset=utf-8'
    }, headers || {}));
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req, callback) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return callback(new Error('Content-Type must be application/json'));
    let raw = '', done = false;
    req.on('data', (part) => {
        raw += part;
        if (raw.length > MAX_BODY && !done) { done = true; callback(new Error('Request too large')); req.destroy(); }
    });
    req.on('end', () => {
        if (done) return;
        try { callback(null, JSON.parse(raw)); } catch (e) { callback(new Error('Invalid JSON')); }
    });
    req.on('error', () => { if (!done) { done = true; callback(new Error('Request failed')); } });
}
function addresses() {
    let nics;
    try { nics = os.networkInterfaces(); }
    catch (e) { return []; }
    const out = [];
    Object.keys(nics).forEach((name) => (nics[name] || []).forEach((item) => {
        if ((item.family !== 'IPv4' && item.family !== 4) || item.internal || !item.address) return;
        if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(item.address)) return;
        const score = name === 'wlan_bridge' ? -10 : /p2p|wlan|wifi|wlp|ap0/i.test(name) ? 0 : /^eth|enp|usb|rndis|br/i.test(name) ? 1 : 2;
        out.push({ ip: item.address, interface: name, score: score + (item.address.indexOf('169.254.') === 0 ? 10 : 0) });
    }));
    return out.sort((a, b) => a.score - b.score || a.interface.localeCompare(b.interface)).map((x) => ({ ip: x.ip, interface: x.interface }));
}
function findAppData(options) {
    if (options && options.dataDir) {
        const st = fs.statSync(options.dataDir);
        return { dir: options.dataDir, uid: options.appUid === undefined ? st.uid : options.appUid,
            gid: options.appGid === undefined ? st.gid : options.appGid };
    }
    const f = '/var/opt/public/oap/oap_12201/data/apps/' + APP_ID + '.json';
    const reg = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Number.isInteger(+reg.userId) || +reg.userId < 1 || +reg.userId > 999999) throw new Error('Unexpected app userId');
    const dir = '/var/opt/public/oap/oap_' + reg.userId + '/data';
    const st = fs.statSync(dir);
    return { dir: dir, uid: +reg.userId, gid: st.gid };
}
function needsKeyOwnerMigration(foundUid, appUid, dirUid) {
    if (foundUid === appUid) return false;
    if (foundUid !== dirUid && foundUid !== 0) throw new Error('Unexpected bridge key owner');
    return true;
}
function secretFromDataDir(app) {
    const secretPath = path.join(app.dir, 'phone-bridge.key');
    const st = fs.statSync(app.dir);
    if (!st.isDirectory() || !Number.isInteger(app.uid) || app.uid < 1 && app.uid !== 0) throw new Error('Invalid app identity');
    try {
        const fd = fs.openSync(secretPath, 'wx', 0o600);
        try {
            fs.writeSync(fd, token() + '\n');
            fs.fchownSync(fd, app.uid, app.gid);
            fs.fchmodSync(fd, 0o600);
        } finally { fs.closeSync(fd); }
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    // Open a descriptor without following a symlink. The earlier daemon used
    // data-dir ownership, which can be root even when MainApp runs the OAP app
    // as its registered numeric userId. Repair that exact legacy case in place.
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    const fd = fs.openSync(secretPath, flags);
    try {
        const keyFile = fs.fstatSync(fd);
        if (!keyFile.isFile() || keyFile.nlink !== 1 || (keyFile.mode & 0o077) !== 0) throw new Error('Insecure bridge key file');
        if (needsKeyOwnerMigration(keyFile.uid, app.uid, st.uid)) {
            fs.fchownSync(fd, app.uid, app.gid);
            fs.fchmodSync(fd, 0o600);
            console.log('[phone-bridge] corrected legacy key owner to app uid ' + app.uid);
        }
        const key = fs.readFileSync(fd, 'utf8').trim();
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid bridge key format');
        return key;
    } finally { fs.closeSync(fd); }
}

function makeBridge(options) {
    options = options || {};
    const localPort = options.localPort === undefined ? DEFAULT_LOCAL_PORT : options.localPort;
    const publicPort = options.publicPort === undefined ? DEFAULT_PUBLIC_PORT : options.publicPort;
    const firewall = options.firewall === false ? null : options.firewall || makeFirewall({ port: publicPort });
    const now = options.now || Date.now;
    let controlKey = null, pairToken = null, pairUntil = 0;
    let sessionToken = null, running = false, runningProc = null, failureCount = 0, blockUntil = 0;
    let downloadTicket = null;
    const downloads = new Set();
    let localServer, publicServer, keyPoll, firewallPoll, provisionError = 'waiting for app registration';
    let firewallReady = false, firewallError = '', firewallQueue = Promise.resolve(), lastFirewallCheck = 0;

    function syncFirewall() {
        // Serialize nft mutations: revoke/stop must run after an outstanding
        // accept-rule insertion, including when the MGU reloads its ruleset.
        firewallQueue = firewallQueue.then(async () => {
            const needed = !closed();
            if (firewall) {
                if (needed) await firewall.ensure();
                else await firewall.close();
            }
            firewallReady = needed;
            firewallError = '';
        }).catch((error) => {
            firewallReady = false;
            firewallError = error && error.message || String(error);
            console.warn('[phone-bridge] firewall: ' + firewallError);
        });
        return firewallQueue;
    }

    function terminateCommand() {
        if (!runningProc) return;
        try { process.kill(-runningProc.pid, 'SIGKILL'); }
        catch (e) { try { runningProc.kill('SIGKILL'); } catch (ignored) {} }
    }

    function cancelDownloads() {
        downloadTicket = null;
        downloads.forEach((item) => { item.stream.destroy(); item.res.destroy(); });
        downloads.clear();
    }

    function openDownloadFile(file) {
        if (typeof file !== 'string' || !path.isAbsolute(file) || file.length > 2048 || /[\x00-\x1f\x7f]/.test(file)) {
            throw new Error('Enter a valid absolute file path');
        }
        const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
        const fd = fs.openSync(file, flags);
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile()) throw new Error('Only regular files can be downloaded; archive directories first');
            if (stat.size > MAX_DOWNLOAD) throw new Error('File exceeds the 256 MiB download limit');
            return { fd, stat, name: path.basename(file).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'download.bin' };
        } catch (error) {
            fs.closeSync(fd);
            throw error;
        }
    }

    function prepareDownload(res, file) {
        let opened;
        try { opened = openDownloadFile(file); }
        catch (error) {
            const missing = error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'ELOOP';
            return send(res, missing ? 404 : 400, { error: missing ? 'File not found, unreadable or a symbolic link' : error.message });
        }
        fs.closeSync(opened.fd);
        const id = crypto.randomBytes(24).toString('hex');
        downloadTicket = { id, file, until: now() + DOWNLOAD_TICKET_MS };
        return send(res, 200, {
            url: '/api/file/' + id, filename: opened.name, size: opened.stat.size,
            validSeconds: Math.max(0, Math.floor((downloadTicket.until - now()) / 1000))
        });
    }

    function serveDownload(req, res, id) {
        if (!hasSession(req)) return send(res, 401, { error: 'Session ended. Pair again on iDrive.' });
        const ticket = downloadTicket;
        if (!ticket || !same(id, ticket.id) || now() >= ticket.until) {
            return send(res, 404, { error: 'Download link expired or already used. Prepare a new link.' });
        }
        downloadTicket = null; // One-time download URL; never contains the filesystem path.
        let opened;
        try { opened = openDownloadFile(ticket.file); }
        catch (error) { return send(res, 404, { error: 'File is no longer available for download' }); }
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment; filename="' + opened.name + '"',
            'Content-Length': opened.stat.size,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'no-referrer'
        });
        const stream = fs.createReadStream(null, { fd: opened.fd, autoClose: true, highWaterMark: 64 * 1024 });
        const active = { res, stream };
        downloads.add(active);
        res.on('close', () => { downloads.delete(active); stream.destroy(); });
        stream.on('error', () => { downloads.delete(active); res.destroy(); });
        stream.pipe(res);
    }

    function ensureKey() {
        if (controlKey) return controlKey;
        try { controlKey = secretFromDataDir(findAppData(options)); provisionError = ''; }
        catch (e) {
            const reason = e && (e.code || e.message) || 'unknown error';
            if (provisionError !== reason) console.warn('[phone-bridge] key provisioning pending:', reason);
            provisionError = reason;
            return null;
        }
        return controlKey;
    }
    function closed() {
        if (pairToken && now() >= pairUntil) pairToken = null;
        return !pairToken && !sessionToken;
    }
    function revoke() { terminateCommand(); cancelDownloads(); pairToken = null; pairUntil = 0; sessionToken = null; }
    function status() {
        closed();
        return { state: sessionToken ? 'active' : pairToken ? 'pairing' : 'closed', expiresAt: pairToken ? pairUntil : 0,
            addresses: addresses(), port: publicPort, version: '0.1.6',
            firewall: { ready: firewallReady && !!(sessionToken || pairToken), error: firewallError, interface: 'wlan_bridge' } };
    }

    function local(req, res) {
        const key = ensureKey();
        if (!key) return send(res, 503, { error: 'App data/key not available (' + provisionError + ')' });
        if (!same(req.headers['x-bridge-key'], key)) return send(res, 403, { error: 'Forbidden' });
        const route = String(req.url || '').split('?')[0];
        if (req.method === 'GET' && route === '/local/status') return send(res, 200, status());
        if (req.method === 'POST' && route === '/local/stop') { revoke(); syncFirewall(); return send(res, 200, status()); }
        if (req.method === 'POST' && route === '/local/start') {
            revoke();
            pairToken = token();
            pairUntil = now() + PAIR_MS;
            firewallReady = false;
            firewallError = '';
            syncFirewall();
            return send(res, 200, Object.assign(status(), { token: pairToken }));
        }
        send(res, 404, { error: 'Not found' });
    }

    function hasSession(req) {
        closed();
        const cookie = (req.headers.cookie || '').split(';').map((x) => x.trim()).filter((x) => x.indexOf('mgu_session=') === 0)[0] || '';
        return !!sessionToken && same(cookie.slice('mgu_session='.length), sessionToken);
    }
    function originOk(req) {
        const raw = req.headers.origin || '';
        if (!raw || !req.headers.host) return false;
        return raw === 'http://' + req.headers.host && /^\[(?:[\da-f:]+)\]:\d+$|^(?:\d{1,3}\.){3}\d{1,3}:\d+$|^localhost:\d+$/i.test(req.headers.host);
    }
    function command(req, res, cmd) {
        if (running) return send(res, 409, { error: 'Another command is running' });
        if (typeof cmd !== 'string' || !cmd.trim() || cmd.length > 1000 || /\0/.test(cmd)) return send(res, 400, { error: 'Command must be 1–1000 characters' });
        running = true;
        let out = '', err = '', truncated = false, timedOut = false, completed = false;
        const startAt = now();
        const proc = child.spawn('/bin/sh', ['-c', cmd], {
            cwd: '/', detached: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', HOME: '/root' }
        });
        runningProc = proc;
        const kill = terminateCommand;
        const timer = setTimeout(() => { timedOut = true; kill(); }, LIMIT_MS);
        function append(which, buf) {
            const text = buf.toString('utf8');
            const total = out.length + err.length;
            if (total + text.length > MAX_OUT) {
                truncated = true;
                const remaining = Math.max(0, MAX_OUT - total);
                if (which === 'out') out += text.slice(0, remaining); else err += text.slice(0, remaining);
                kill();
            } else if (which === 'out') out += text; else err += text;
        }
        proc.stdout.on('data', (c) => append('out', c));
        proc.stderr.on('data', (c) => append('err', c));
        proc.on('error', (e) => { err += '\nFailed to start: ' + e.message; });
        proc.on('close', (code, signal) => {
            if (completed) return;
            completed = true; clearTimeout(timer); running = false; runningProc = null;
            send(res, 200, { stdout: out, stderr: err, code: code, signal: signal, truncated: truncated, timedOut: timedOut, elapsedMs: now() - startAt });
        });
    }
    function publicAccess(req, res) {
        const route = String(req.url || '').split('?')[0];
        const publicFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/client.js': ['client.js', 'application/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
        if (req.method === 'GET' && publicFiles[route]) {
            const p = publicFiles[route];
            return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, p[0]), 'utf8'), { 'Content-Type': p[1] });
        }
        if (req.method === 'GET' && route === '/api/status') {
            if (!hasSession(req)) return send(res, 401, { error: 'Not paired' });
            return send(res, 200, { authenticated: true, expiresAt: 0, running: running });
        }
        if (req.method === 'GET' && /^\/api\/file\/[a-f0-9]{48}$/.test(route)) {
            return serveDownload(req, res, route.slice('/api/file/'.length));
        }
        if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
        if (!originOk(req) || req.headers['x-terminal-request'] !== '1') return send(res, 403, { error: 'Invalid request origin' });
        if (route === '/api/pair') {
            if (now() < blockUntil) return send(res, 429, { error: 'Too many pairing attempts' });
            return readBody(req, (e, body) => {
                if (e) return send(res, 400, { error: e.message });
                closed();
                if (!pairToken || !body || !same(body.token, pairToken)) {
                    failureCount++;
                    if (failureCount >= 8) { blockUntil = now() + 60000; failureCount = 0; }
                    return send(res, 403, { error: 'Pairing code expired or incorrect' });
                }
                failureCount = 0; pairToken = null; pairUntil = 0;
                sessionToken = token();
                send(res, 200, { authenticated: true, expiresAt: 0 }, {
                    'Set-Cookie': 'mgu_session=' + sessionToken + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000'
                });
            });
        }
        if (!hasSession(req)) return send(res, 401, { error: 'Session ended. Start a new session on iDrive.' });
        if (route === '/api/logout') { revoke(); syncFirewall(); return send(res, 200, { ok: true }, { 'Set-Cookie': 'mgu_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }
        if (route === '/api/exec') return readBody(req, (e, body) => {
            if (e) return send(res, 400, { error: e.message });
            command(req, res, body && body.command);
        });
        if (route === '/api/download') return readBody(req, (e, body) => {
            if (e) return send(res, 400, { error: e.message });
            prepareDownload(res, body && body.path);
        });
        send(res, 404, { error: 'Not found' });
    }

    async function start() {
        // On a car the app may be installed after the service, so absence is not fatal.
        // When its data directory already exists, provision the private control key now.
        ensureKey();
        localServer = http.createServer(local);
        publicServer = http.createServer(publicAccess);
        const listen = (server, port, address) => new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, address, () => { server.removeListener('error', reject); resolve(); });
        });
        await listen(localServer, localPort, '127.0.0.1');
        try { await listen(publicServer, publicPort, options.publicHost || '0.0.0.0'); }
        catch (e) { localServer.close(); throw e; }
        // Remove any tagged rule left by a previous crash/restart. The daemon
        // does not expose the mobile port until a new pairing is requested.
        await syncFirewall();
        firewallPoll = setInterval(() => {
            const needed = !closed();
            if ((!needed && firewallReady) || (needed && (!firewallReady || now() - lastFirewallCheck >= 30000))) {
                lastFirewallCheck = now();
                syncFirewall();
            }
        }, 5000);
        // The Store installs this required tool before the OAP app. Provision
        // its control key as soon as the app directory appears, without needing
        // an unauthenticated HTTP provisioning request.
        if (!controlKey) keyPoll = setInterval(() => { if (ensureKey()) { clearInterval(keyPoll); keyPoll = null; } }, 2000);
        console.log('[phone-bridge] listening on HTTP ' + publicServer.address().port + ' (locked until pairing), local control ' + localServer.address().port);
        return { localPort: localServer.address().port, publicPort: publicServer.address().port };
    }
    async function stop() {
        revoke();
        if (keyPoll) { clearInterval(keyPoll); keyPoll = null; }
        if (firewallPoll) { clearInterval(firewallPoll); firewallPoll = null; }
        await syncFirewall();
        return Promise.all([localServer, publicServer].filter(Boolean).map((server) => new Promise((resolve) => server.close(resolve))));
    }
    return { start, stop, status };
}

module.exports = { makeBridge, start: () => makeBridge().start(), addresses, needsKeyOwnerMigration };
