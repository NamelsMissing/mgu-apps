'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { Readable } = require('stream');
const Core = require('../native/equalizer-dsp/core');
const { Service } = require('../native/equalizer-dsp/server');
const Client = require('../kit/runtime/dsp-client');
let tests = 0;
async function test(name, fn) { await fn(); console.log('PASS ' + name); tests++; }
function sine(rate, hz, amplitude, seconds, right) {
    const n = Math.round(rate * seconds), b = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) { const v = Math.round(32768 * amplitude * Math.sin(2 * Math.PI * hz * i / rate)); b.writeInt16LE(v, i * 4); b.writeInt16LE(right === false ? 0 : v, i * 4 + 2); }
    return b;
}
function processAudio(proc, input, block) {
    const out = [];
    for (let i = 0; i < input.length; i += block || 4096) out.push(proc.process(input.slice(i, i + (block || 4096))));
    return Buffer.concat(out);
}
function rms(b, offset, channel) {
    let sum = 0, n = 0;
    for (let i = offset || 0; i < b.length; i += 4) { const v = b.readInt16LE(i + (channel || 0) * 2); sum += v * v; n++; }
    return Math.sqrt(sum / n);
}
async function filtered(input, opts, chunks) {
    const filter = new Client.PcmFilter(opts), out = [];
    const result = new Promise((resolve, reject) => { filter.on('data', (b) => out.push(b)); filter.on('end', () => resolve(Buffer.concat(out))); filter.on('error', reject); });
    const source = new Readable({ read() {} }); source.pipe(filter);
    if (chunks) { let start = 0; for (const n of chunks) { source.push(input.slice(start, start + n)); start += n; } source.push(input.slice(start)); }
    else source.push(input);
    source.push(null); return result;
}
async function main() {
    await test('configuration validation rejects invalid numbers, bands and limits', () => {
        for (const value of [NaN, Infinity, -13, 13]) { const v = Core.defaults(); v.bands[0].gainDb = value; assert.throws(() => Core.validate(v)); }
        for (const value of [0, -1, 7]) { const v = Core.defaults(); v.bands[0].q = value; assert.throws(() => Core.validate(v)); }
        const v = Core.defaults(); v.bands.pop(); assert.throws(() => Core.validate(v));
        assert.throws(() => new Core.Processor(22050, 2)); assert.throws(() => new Core.Processor(48000, 6));
    });
    await test('bypass is bit-exact, including full-scale stereo samples', () => {
        const input = Buffer.alloc(4096); for (let i = 0; i < input.length; i += 2) input.writeInt16LE(i % 8 ? 32767 : -32768, i);
        assert.deepStrictEqual(new Core.Processor(48000, 2).process(input), input);
    });
    await test('all seven filters produce the requested +6 and -6 dB at their centre', () => {
        for (const rate of [44100, 48000]) for (let band = 0; band < 7; band++) for (const gain of [-6, 6]) {
            const v = Core.defaults(); v.enabled = true; v.autoHeadroom = false; v.bands[band].gainDb = gain;
            const input = sine(rate, v.bands[band].frequencyHz, 0.06, 0.7), output = processAudio(new Core.Processor(rate, 2, v), input);
            const db = 20 * Math.log10(rms(output, Math.round(rate * 0.3) * 4) / rms(input, Math.round(rate * 0.3) * 4));
            assert(Math.abs(db - gain) < 0.035, 'rate=' + rate + ' band=' + band + ' dB=' + db);
        }
    });
    await test('analytic response and pole stability agree at range extremes', () => {
        for (const rate of [44100, 48000, 88200, 96000]) for (const hz of [20, 100, 1000, 20000]) for (const q of [0.3, 1, 6]) for (const gain of [-12, 0, 12]) {
            const c = Core.peaking(rate, hz, gain, q), disc = c.a1 * c.a1 - 4 * c.a2;
            const maxPole = disc < 0 ? Math.sqrt(c.a2) : Math.max(Math.abs((-c.a1 + Math.sqrt(disc)) / 2), Math.abs((-c.a1 - Math.sqrt(disc)) / 2));
            assert(maxPole < 1, 'unstable pole');
            assert(Math.abs(20 * Math.log10(Core.magnitude(c, rate, hz)) - gain) < 1e-5);
        }
    });
    await test('stereo channels and filter state never leak into each other', () => {
        const v = Core.defaults(); v.enabled = true; v.autoHeadroom = false; v.bands[3].gainDb = 12;
        const b = processAudio(new Core.Processor(48000, 2, v), sine(48000, 1000, 0.05, 0.2, false));
        assert.strictEqual(rms(b, 0, 1), 0);
    });
    await test('stream block boundaries do not change DSP output', () => {
        const v = Core.defaults(); v.enabled = true; v.bands[2].gainDb = 7.5;
        const b = sine(44100, 411, 0.2, 0.2);
        assert.deepStrictEqual(processAudio(new Core.Processor(44100, 2, v), b, 4096), processAudio(new Core.Processor(44100, 2, v), b, 100));
    });
    await test('headroom is applied and overload saturation is counted', () => {
        const v = Core.defaults(); v.enabled = true; v.bands[3].gainDb = 12;
        const safe = new Core.Processor(48000, 2, v); processAudio(safe, sine(48000, 1000, 0.7, 0.3));
        assert.equal(Core.headroom(v), -12); assert.equal(safe.clipped, 0);
        v.autoHeadroom = false; const loud = new Core.Processor(48000, 2, v); processAudio(loud, sine(48000, 1000, 0.7, 0.3)); assert(loud.clipped > 0);
    });
    await test('live updates crossfade finite samples and preserve byte count', () => {
        const p = new Core.Processor(48000, 2), v = Core.defaults(); v.enabled = true; v.bands[0].gainDb = 12;
        const b = sine(48000, 100, 0.1, 0.1); processAudio(p, b); p.configure(v);
        assert.equal(processAudio(p, b).length, b.length); assert.equal(p.previous, null);
    });
    await test('rapid filter edits preserve the current crossfade and apply only the latest queued settings', () => {
        const rate = 48000;
        const start = Core.defaults();
        const changed = Core.defaults(); changed.enabled = true; changed.bands[0].gainDb = 12;
        const discarded = Core.defaults(); discarded.enabled = true; discarded.bands[0].gainDb = -12;
        const input = sine(rate, 100, 0.1, 0.02, false);
        const processor = new Core.Processor(rate, 2, start);
        const reference = new Core.Processor(rate, 2, start);
        for (const p of [processor, reference]) { p.process(input); p.configure(changed); p.process(input.slice(0, 2000)); }
        processor.configure(discarded);
        processor.configure(start);
        // Both outputs must remain identical until transition one is complete.
        assert.deepStrictEqual(processor.process(input.slice(0, 2800)), reference.process(input.slice(0, 2800)));
        assert.strictEqual(processor.current.enabled, false);
        assert.strictEqual(processor.previous.enabled, true);
        processor.process(Buffer.alloc(rate * 0.025 * 4));
        assert.deepStrictEqual(processor.process(input), input);
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mgu-dsp-')), runtime = path.join(root, 'run'), stateFile = path.join(root, 'settings.json');
    const service = new Service({ runtime, stateFile });
    try {
        try { await service.start(); }
        catch (e) {
            if (e.code !== 'EPERM' || process.env.CI) throw e;
            console.log('SKIP Unix-socket integration: this execution environment forbids listen(). GitHub CI runs these tests without this exception.');
            console.log(tests + ' DSP core tests passed; socket tests pending CI'); return;
        }
        await test('real Unix control socket supports revisions and persistent configuration', async () => {
            let s = await Client.request({ op: 'status' }, { runtime }); assert.equal(s.config.enabled, false);
            const v = Core.defaults(); v.enabled = true; v.autoHeadroom = false; v.bands[3].gainDb = 6;
            s = await Client.request({ op: 'set', config: v, expectedRevision: s.revision }, { runtime });
            assert.equal(s.revision, 1); assert.equal(s.saved, true);
            await assert.rejects(Client.request({ op: 'set', config: v, expectedRevision: 0 }, { runtime }), /changed/);
            assert.equal(new Service({ runtime, stateFile }).config.bands[3].gainDb, 6);
        });
        await test('PCM client routes actual samples through the daemon with arbitrary chunking', async () => {
            const input = sine(48000, 1000, 0.05, 0.8);
            const output = await filtered(input, { runtime, sampleRate: 48000, channels: 2, source: 'test' }, [1, 3, 7, 111, 10001]);
            assert.equal(output.length, input.length);
            const db = 20 * Math.log10(rms(output, 48000 * 4 * 0.3) / rms(input, 48000 * 4 * 0.3)); assert(Math.abs(db - 6) < 0.035, db);
            const s = await Client.request({ op: 'status' }, { runtime }); assert(s.frames >= input.length / 4); assert.equal(s.stockCarPlayRouted, false);
        });
        await test('missing daemon passes the original PCM bytes exactly once', async () => {
            const input = sine(44100, 1000, 0.1, 0.1); let failures = 0;
            const output = await filtered(input, { runtime: path.join(root, 'missing'), onFallback: () => failures++ }, [3, 13, 41]);
            assert.deepStrictEqual(output, input); assert.equal(failures, 1);
        });
        await test('broken/late daemon responses fail open without hangs or duplicated blocks', async () => {
            const fake = path.join(root, 'fake'); fs.mkdirSync(fake);
            const server = net.createServer((socket) => { socket.on('error', () => {}); socket.once('data', () => socket.write('{"ok":true,"protocol":1}\n')); });
            await new Promise((resolve) => server.listen(path.join(fake, 'pcm.sock'), resolve));
            try {
                const input = sine(44100, 1000, 0.1, 0.1), output = await filtered(input, { runtime: fake, timeout: 40 });
                assert.deepStrictEqual(output, input);
            } finally { await new Promise((resolve) => server.close(resolve)); }
        });
        await test('corrupt persisted state restores the previous valid configuration', () => {
            const v = Core.defaults(); service.set(v, service.revision);
            fs.writeFileSync(stateFile, 'broken'); const recovered = new Service({ runtime, stateFile });
            assert.equal(recovered.config.bands[3].gainDb, 6); assert(recovered.configError);
        });
        await test('format changes across connections preserve each negotiated rate and reject unsupported formats', async () => {
            const cfg = Core.defaults();
            service.set(cfg, service.revision);
            for (const [sampleRate, channels] of [[44100, 1], [48000, 2], [88200, 1], [96000, 2]]) {
                const pcm = Buffer.alloc(80, 91);
                const out = await filtered(pcm, { runtime, sampleRate, channels, source: 'format_change' });
                assert.deepStrictEqual(out, pcm);
            }
            let fallback = 0;
            assert.deepStrictEqual(await filtered(Buffer.alloc(80, 119), { runtime, sampleRate: 32000, channels: 2,
                onFallback: () => fallback++ }), Buffer.alloc(80, 119));
            assert.strictEqual(fallback, 1);
            await new Promise((resolve, reject) => {
                const socket = net.connect(path.join(runtime, 'pcm.sock'), () => {
                    socket.write(JSON.stringify({ protocol: 1, format: 's24le', sampleRate: 48000, channels: 2, source: 'format_change' }) + '\n');
                });
                socket.on('data', () => reject(new Error('Unexpected PCM format accepted')));
                socket.on('error', reject);
                socket.on('close', resolve);
            });
        });
    } finally { await service.stop(); fs.rmSync(root, { recursive: true, force: true }); }
    console.log(tests + ' DSP tests passed');
}
main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
