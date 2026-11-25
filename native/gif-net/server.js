'use strict';

const http = require('http');
const {makeFirewall, PORT, IFACE} = require('./firewall');
const STATUS_PORT = 18983;

function probeGifHome(port) {
    port = port || PORT;
    return new Promise(resolve => {
        let done = false;
        function finish(ready) {
            if (done) return;
            done = true;
            resolve(!!ready);
        }
        const req = http.get({hostname:'127.0.0.1', port, path:'/.mgu-gif-health'}, res => {
            const valid = res.statusCode === 200 && res.headers['x-mgu-gif-home'] === '1';
            res.resume();
            res.on('end', () => finish(valid));
            res.on('error', () => finish(false));
        });
        req.setTimeout(1200, () => req.destroy(new Error('probe timeout')));
        req.on('error', () => finish(false));
    });
}

function makeNetwork(options) {
    options = options || {};
    const firewall = options.firewall || makeFirewall();
    const probe = options.probe || probeGifHome;
    const intervalMs = options.intervalMs || 2500;
    const statusPort = options.statusPort === undefined ? STATUS_PORT : options.statusPort;
    let server = null, timer = null, working = null, stopping = false;
    let ready = false, listening = false, cleanupPending = true, error = '', checkedAt = 0, lastCleanup = 0;

    function status() {
        return {ready:ready && listening, listening, interface:IFACE, port:PORT,
            error, checkedAt};
    }

    function check() {
        if (working || stopping) return working || Promise.resolve();
        working = (async () => {
            try {
                listening = await probe();
                if (listening) {
                    cleanupPending = true;
                    await firewall.ensure();
                    ready = true;
                } else {
                    ready = false;
                    if (cleanupPending || Date.now() - lastCleanup >= 10000) {
                        await firewall.close();
                        cleanupPending = false;
                        lastCleanup = Date.now();
                    }
                }
                error = '';
            } catch (e) {
                ready = false;
                const next = e.message || String(e);
                if (error !== next) console.warn('[mgu-gif-net] firewall: ' + next);
                error = next;
            } finally { checkedAt = Date.now(); }
        })();
        working = working.then(() => { working = null; }, e => {
            working = null;
            error = e.message || String(e);
        });
        return working;
    }

    async function start() {
        if (server) throw new Error('Network helper already started');
        stopping = false;
        // Remove a stale rule left by an unclean previous daemon exit.
        try {
            await firewall.close();
            cleanupPending = false;
            lastCleanup = Date.now();
        } catch (e) { error = e.message || String(e); }
        server = http.createServer((req, res) => {
            if (req.method !== 'GET' || req.url !== '/status') {
                res.writeHead(404, {'Content-Type':'application/json'});
                return res.end('{"error":"not found"}');
            }
            res.writeHead(200, {'Content-Type':'application/json',
                'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
            res.end(JSON.stringify(status()));
        });
        server.setTimeout(2000);
        server.on('clientError', (_, socket) => socket.destroy());
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(statusPort, '127.0.0.1', () => {
                server.removeListener('error', reject);
                resolve();
            });
        });
        await check();
        timer = setInterval(() => { check(); }, intervalMs);
        return server.address().port;
    }

    async function stop() {
        stopping = true;
        if (timer) clearInterval(timer);
        timer = null;
        if (working) await working;
        if (server) await new Promise(resolve => server.close(resolve));
        server = null;
        try { await firewall.close(); }
        finally { ready = false; listening = false; }
    }
    return {start, stop, status, check};
}

module.exports = {makeNetwork, probeGifHome, STATUS_PORT};
