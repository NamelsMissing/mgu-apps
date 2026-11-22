'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const Core = require('./core');
const Snapshot = require('./snapshot');
const VERSION = '0.2.2';
function mkdir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, 0o770); }
class Service {
    constructor(opts) {
        this.runtime = opts.runtime; this.stateFile = opts.stateFile; this.sockets = new Set(); this.streams = new Set();
        this.config = Core.defaults(); this.revision = 0; this.configError = ''; this.saved = false; this.closedFrames = 0;
        this.snapshot = { file: path.join(this.runtime, Snapshot.FILE_NAME), layout: Snapshot.LAYOUT, revision: null, error: '' };
        for (const f of [this.stateFile, this.stateFile + '.bak']) {
            try {
                const s = JSON.parse(fs.readFileSync(f, 'utf8'));
                if (s.schema !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0) throw new Error('Invalid stored DSP state');
                this.config = Core.validate(s.config); this.revision = s.revision; this.saved = true; break;
            } catch (e) { if (e.code !== 'ENOENT') this.configError = String(e.message || e); }
        }
    }
    status() {
        const streams = Array.from(this.streams).map((s) => Object.assign({ source: s.label, lastFrameAt: s.lastFrameAt, lastFilteredAt: s.lastFilteredAt }, s.processor.stats()));
        return { version: VERSION, revision: this.revision, config: Core.clone(this.config), saved: this.saved, configError: this.configError,
            streams, frames: this.closedFrames + streams.reduce((sum, s) => sum + s.frames, 0),
            routing: 'explicit-pcm-clients', stockCarPlayRouted: false, stockRadioRouted: false,
            effectivePreampDb: Core.headroom(this.config), formats: ['s16le'], sampleRates: [44100, 48000, 88200, 96000],
            nativeSnapshot: Object.assign({}, this.snapshot) };
    }
    // Publish the active configuration for native consumers. Never fatal: the
    // socket clients keep working if /run is unavailable.
    publishSnapshot() {
        try { mkdir(this.runtime); Snapshot.write(this.runtime, this.config, this.revision); this.snapshot.revision = this.revision; this.snapshot.error = ''; }
        catch (e) { this.snapshot.error = String(e.message || e); }
    }
    set(config, expected) {
        if (!Number.isSafeInteger(expected) || expected !== this.revision) throw new Error('DSP settings changed; refresh first');
        const next = Core.validate(config), revision = this.revision + 1;
        const saved = { schema: 1, revision, config: next };
        const dir = path.dirname(this.stateFile); mkdir(dir);
        const fd = fs.openSync(this.stateFile + '.tmp', 'w', 0o600);
        try { fs.writeFileSync(fd, JSON.stringify(saved)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.writeFileSync(this.stateFile + '.bak.tmp', JSON.stringify({ schema: 1, revision: this.revision, config: this.config }), { mode: 0o600 });
        fs.renameSync(this.stateFile + '.bak.tmp', this.stateFile + '.bak');
        fs.renameSync(this.stateFile + '.tmp', this.stateFile);
        // Validation and persistence complete before the live filter banks change.
        for (const s of this.streams) s.processor.configure(next);
        this.config = next; this.revision = revision; this.saved = true; this.configError = '';
        this.publishSnapshot(); return this.status();
    }
    track(socket) {
        this.sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => this.sockets.delete(socket));
    }
    control(socket) {
        this.track(socket); let input = '', done = false;
        socket.setTimeout(3000, () => socket.destroy());
        socket.on('data', (chunk) => {
            if (done) return; input += chunk.toString('utf8');
            if (input.length > 16384) return socket.destroy();
            if (input.indexOf('\n') < 0) return;
            done = true;
            try {
                const q = JSON.parse(input.slice(0, input.indexOf('\n')));
                let data;
                if (q.op === 'status') data = this.status();
                else if (q.op === 'set') data = this.set(q.config, q.expectedRevision);
                else throw new Error('Unknown DSP operation');
                socket.end(JSON.stringify({ ok: true, data }) + '\n');
            } catch (e) { socket.end(JSON.stringify({ ok: false, error: String(e.message || e) }) + '\n'); }
        });
    }
    pcm(socket) {
        this.track(socket);
        if (this.streams.size >= 8) return socket.destroy();
        let pending = Buffer.alloc(0), stream = null, length = null, pumping = false;
        const helloTimer = setTimeout(() => { if (!stream) socket.destroy(); }, 2000);
        socket.on('close', () => {
            clearTimeout(helloTimer);
            if (stream) { this.closedFrames += stream.processor.frames; this.streams.delete(stream); }
        });
        const pump = () => {
            if (pumping || socket.destroyed) return;
            try {
                if (!stream) {
                    const nl = pending.indexOf(10);
                    if (nl < 0) { if (pending.length > 1024) socket.destroy(); return; }
                    if (nl > 1024) throw new Error('Oversized PCM handshake');
                    const h = JSON.parse(pending.slice(0, nl).toString('utf8')); pending = pending.slice(nl + 1);
                    if (this.streams.size >= 8) throw new Error('Too many PCM streams');
                    if (h.protocol !== 1 || h.format !== 's16le' || typeof h.source !== 'string') throw new Error('Invalid PCM handshake');
                    stream = { processor: new Core.Processor(h.sampleRate, h.channels, this.config),
                        label: h.source.replace(/[^a-zA-Z0-9_. -]/g, '_').slice(0, 64), lastFrameAt: null, lastFilteredAt: null };
                    this.streams.add(stream); clearTimeout(helloTimer);
                    socket.write(JSON.stringify({ ok: true, protocol: 1 }) + '\n');
                }
                if (length === null && pending.length >= 4) { length = pending.readUInt32LE(0); pending = pending.slice(4); }
                if (length !== null && (length < 1 || length > 16384 || length % (stream.processor.channels * 2))) throw new Error('Invalid PCM frame size');
                if (length === null || pending.length < length) return;
                const input = pending.slice(0, length); pending = pending.slice(length); length = null;
                const filtered = stream.processor.filteredFrames;
                const output = stream.processor.process(input), header = Buffer.allocUnsafe(4); header.writeUInt32LE(output.length, 0);
                stream.lastFrameAt = Date.now();
                if (stream.processor.filteredFrames > filtered) stream.lastFilteredAt = stream.lastFrameAt;
                pumping = true; socket.pause();
                socket.write(Buffer.concat([header, output]), () => { pumping = false; socket.resume(); pump(); });
            } catch (e) { socket.destroy(); }
        };
        socket.on('data', (chunk) => {
            // One outstanding block per client, bounded even when its output is blocked.
            if (pending.length + chunk.length > 131072) return socket.destroy();
            pending = pending.length ? Buffer.concat([pending, chunk]) : chunk; pump();
        });
    }
    async start() {
        mkdir(this.runtime); this.publishSnapshot();
        this.controlServer = net.createServer((s) => this.control(s)); this.pcmServer = net.createServer((s) => this.pcm(s));
        const listen = (server, name) => new Promise((resolve, reject) => {
            server.once('error', reject); server.listen(path.join(this.runtime, name), () => {
                fs.chmodSync(path.join(this.runtime, name), 0o660); server.removeListener('error', reject); resolve();
            });
        });
        await listen(this.controlServer, 'control.sock');
        try { await listen(this.pcmServer, 'pcm.sock'); } catch (e) { await this.stop(); throw e; }
        return this;
    }
    async stop() {
        for (const s of this.sockets) s.destroy();
        for (const server of [this.controlServer, this.pcmServer]) if (server && server.listening) await new Promise((resolve) => server.close(resolve));
    }
}
if (require.main === module) {
    process.umask(0o007);
    const s = new Service({ runtime: process.env.MGU_DSP_RUNTIME || '/run/mgu-equalizer-dsp',
        stateFile: process.env.MGU_DSP_STATE || '/var/opt/mgu-equalizer-dsp/data/settings.json' });
    s.start().then(() => console.log('MGU Equalizer DSP ' + VERSION + ': explicit PCM clients; stock CarPlay/radio not routed'), (e) => { console.error(e.message); process.exit(1); });
    for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => s.stop().then(() => process.exit(0)));
}
module.exports = { Service };
