'use strict';

// Optional MGU_RENDER_REPLAY points to the MGU Store renderer's host build.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const {RenderClient} = require('../kit/runtime/renderd');
const {Recorder, setImage, imageById} = require('../kit/runtime/record');
const {Session} = require('../apps/mgu_gamestation/session');
const {testImage} = require('../apps/mgu_gamestation/gpu_test');
const {byId} = require('../apps/mgu_gamestation/core_registry');
const {nesRom, snesRom, segaRom, genesisRom} = require('./gamestation.test');
const {fixtures, nesBattery, play} = require('./gamestation_retro.test');

const NATIVE_READY = 0x4d520101, PIXMAP = 0x4d520003, PIXELS = 0x4d520004, FRAME = 7;
const W = 640, H = 512, ID = 71;
const quiet = {info() {}, warn() {}};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamestation-gpu-'));
const loc = {x: 0, y: 0, w: W, h: H, scale: 1};
const renderer = process.env.MGU_RENDER_REPLAY;

function client(name, native, caps) {
    const file = path.join(dir, name + '.bin');
    const c = new RenderClient('mgu_gamestation', quiet, {file, native}).connect();
    if (native) c._data(c._u32msg(NATIVE_READY, [1, 1, caps]));
    c._data(c._u32msg(101, [4, W, H, 0]));
    c.place(loc);
    c.show(true);
    return {c, file};
}

function messages(file) {
    const b = fs.readFileSync(file), list = [];
    for (let i = 0; i < b.length;) {
        const end = i + 8 + b.readUInt32LE(i + 4);
        assert.ok(end <= b.length);
        list.push({type: b.readUInt32LE(i), payload: b.slice(i + 8, end)});
        i = end;
    }
    return list;
}

function picture() {
    const page = new Recorder(W, H);
    page.image(ID, 0, 0, 128, 96);
    const out = new Recorder(W, H).clear([17, 34, 51, 255]).append(page);
    assert.strictEqual(out.words()[3], ID, 'software and upstream still use id/version first');
    return out;
}

function replay(file) {
    const raw = file + '.rgba';
    const result = cp.spawnSync(renderer, ['--replay', file, '--out', file + '.pam', '--raw', raw],
        {env: Object.assign({}, process.env, {EGL_PLATFORM: 'surfaceless', LIBGL_ALWAYS_SOFTWARE: '1'}), encoding: 'utf8'});
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const bytes = fs.readFileSync(raw);
    assert.ok(bytes.length && bytes.length % (W * H * 4) === 0, 'complete replay frames');
    return bytes;
}

function pixel(bytes, x, y, frame) {
    const start = (frame * W * H + y * W + x) * 4;
    return Array.from(bytes.slice(start, start + 4));
}

async function test() {
    try {
        const pixels = testImage(Buffer.alloc(64 * 48 * 4), 64, 48, 0);
        assert.throws(() => setImage(ID, 64, 48, pixels.slice(4)), /Invalid RGBA/);
        assert.throws(() => setImage(ID, 2049, 1, Buffer.alloc(2049 * 4)), /Invalid RGBA/);
        setImage(ID, 64, 48, pixels, true);

        const missing = client('missing', true, 0);
        assert.strictEqual(missing.c.imageUnavailable(), 'RENDERER DOES NOT SUPPORT PIXEL FRAMES');
        missing.c.frame(picture());
        missing.c.close();
        assert.ok(!messages(missing.file).some(m => m.type === PIXMAP || m.type === PIXELS || m.type === 9));

        const native = client('native', true, 1 | 2 | 4 | 8);
        native.c.claim([{x: 0, y: 0, w: 10, h: 10}]);
        assert.strictEqual(native.c.imageUnavailable(), '');
        native.c.frame(picture());
        native.c.frame(picture());
        setImage(ID, 64, 48, testImage(pixels, 64, 48, 12), true);
        native.c.frame(picture());
        assert.strictEqual(native.c.imageStats.registered, 1);
        assert.strictEqual(native.c.imageStats.submitted, 2);
        const trace = messages(native.file);
        assert.strictEqual(trace.filter(m => m.type === PIXMAP).length, 1);
        const uploads = trace.filter(m => m.type === PIXELS);
        assert.strictEqual(uploads.length, 2);
        assert.strictEqual(uploads[0].payload.length, 24 + 64 * 48 * 4);
        assert.deepStrictEqual(Array.from(uploads[0].payload.slice(24 + 4 * (44 * 64 + 40), 28 + 4 * (44 * 64 + 40))),
            [128, 128, 128, 128], 'premultiplied alpha in RGBA order');
        const op = trace.find(m => m.type === FRAME).payload;
        assert.strictEqual(op.readFloatLE(20), 128);
        assert.strictEqual(op.readUInt32LE(32), ID);
        if (renderer) {
            const images = replay(native.file);
            assert.deepStrictEqual(pixel(images, 20, 20, 0), [255, 0, 0, 255]);
            assert.deepStrictEqual(pixel(images, 100, 20, 0), [0, 255, 0, 255]);
            assert.deepStrictEqual(pixel(images, 20, 60, 0), [0, 0, 255, 255]);
            assert.deepStrictEqual(pixel(images, 100, 60, 0), [255, 255, 255, 255]);
            assert.deepStrictEqual(pixel(images, 20, 90, 0), [17, 34, 51, 255]);
            assert.deepStrictEqual(pixel(images, 100, 90, 0), [136, 145, 153, 255]);
            assert.deepStrictEqual(pixel(images, 30, 30, 2), [0, 255, 0, 255]);
            assert.deepStrictEqual(pixel(replay(missing.file), 20, 20, 0), [17, 34, 51, 255]);
        }
        const queued = [];
        const socket = new RenderClient('mgu_gamestation', quiet, {native: true});
        socket.sock = {bufferSize: 20, write(bytes) { queued.push(bytes); return false; }};
        socket.connected = true;
        socket._data(socket._u32msg(NATIVE_READY, [1, 1, 8]));
        socket._data(socket._u32msg(101, [4, W, H, 1]));
        socket.place(loc);
        assert.strictEqual(socket.frame(picture()), false, 'an already backed-up socket defers the large update');
        assert.strictEqual(socket.imageStats.deferred, 1);
        socket.sock.bufferSize = 0;
        assert.strictEqual(socket.frame(picture()), true, 'write(false) still queues the complete update');
        assert.strictEqual(socket.imageStats.submitted, 1);
        const error = Buffer.from('pixels: no pixmap 71');
        const header = Buffer.alloc(8);
        header.writeUInt32LE(103, 0); header.writeUInt32LE(error.length, 4);
        socket._data(Buffer.concat([header, error]));
        assert.strictEqual(socket.imageStats.error, error.toString());
        assert.ok(queued.some(bytes => bytes.readUInt32LE(0) === PIXELS));

        native.c.dropImage(ID);
        native.c.frame(picture());
        native.c.place(Object.assign({}, loc, {scale: 1.1}));
        native.c.frame(picture());
        native.c.close();
        assert.strictEqual(messages(native.file).filter(m => m.type === 11).length, 1);
        assert.strictEqual(native.c.imageStats.registered, 3);
        const reconnected = client('reconnected', true, 8);
        reconnected.c.frame(picture());
        reconnected.c.close();
        assert.strictEqual(reconnected.c.imageStats.registered, 1, 'resources uploaded on new connection');

        const upstream = client('upstream', false, 0);
        upstream.c.frame(picture());
        upstream.c.close();
        assert.strictEqual(messages(upstream.file).filter(m => m.type === 9).length, 1);
        assert.strictEqual(messages(upstream.file).find(m => m.type === FRAME).payload.readUInt32LE(12), ID);

        for (const [id, rom, width, height] of [['nes', nesRom(), 256, 240], ['sms', segaRom(false), 256, 192]]) {
            let now = 100;
            const g = byId[id].create(rom, (px, w, h) => s.paint(px, w, h), {name: 'fixture.' + id});
            const s = new Session(g, id, 'fixture', {now: () => now});
            const output = client(id, true, 8);
            let expected;
            for (let i = 0; i < 4; i++) {
                now += 17;
                assert.ok(s.step([{right: true}, {}], true));
                const pic = s.take();
                assert.ok(pic, id + ' output');
                assert.deepStrictEqual([pic.width, pic.height], [width, height]);
                assert.ok(pic.pixels.every((v, j) => j % 4 !== 3 || v === 255));
                expected = Array.from(pic.pixels.slice(0, 4));
                setImage(ID, width, height, pic.pixels);
                output.c.frame(new Recorder(W, H).clear([17, 34, 51, 255]).image(ID, 0, 0, width, height));
                s.pause('user');
                assert.strictEqual(s.step([{}, {}], true), 0);
                s.resume();
            }
            s.stop();
            output.c.close();
            assert.strictEqual(output.c.imageStats.submitted, 4);
            if (renderer) assert.deepStrictEqual(pixel(replay(output.file), 0, 0, 3), expected);
        }
        function sendImage(id, pixels, width, height) {
            const output = client(id, true, 8);
            setImage(ID, width, height, pixels);
            const shownW = Math.min(W, width), shownH = Math.min(H, height);
            output.c.frame(new Recorder(W, H).clear([17, 34, 51, 255]).image(ID, 0, 0, shownW, shownH));
            output.c.close();
            assert.strictEqual(output.c.imageStats.submitted, 1);
            if (renderer) assert.deepStrictEqual(pixel(replay(output.file), 0, 0, 0), Array.from(pixels.slice(0, 4)), id);
        }

        const js = [
            ['snes', snesRom(), 'sfc', 512, 208], ['gb', Buffer.alloc(0x8000), 'gbc', 160, 144],
            ['gg', segaRom(true), 'gg', 160, 144], ['genesis', genesisRom(), 'gen', 256, 224],
            ['chip8', Buffer.from('60036102f129d0151200', 'hex'), 'ch8', 64, 32],
            ['chip8', Buffer.from('00ff6001f07500fd', 'hex'), 'sc8', 128, 64],
        ];
        for (const [id, rom, ext, w, h] of js) {
            let image;
            const core = byId[id].create(rom, (pixels, width, height) => { image = {pixels, width, height}; }, {name: 'fixture.' + ext});
            for (let i = 0; i < 4; i++) core.tick([{a: true}, {}]);
            assert.deepStrictEqual([image.width, image.height], [w, h], ext);
            sendImage(ext, image.pixels, w, h);
            core.stop();
        }

        if (process.platform === 'linux' && process.arch === 'x64' && renderer) {
            const roms = Object.assign({nes: nesBattery(1)}, fixtures());
            if (process.env.MGU_PS1_TEST_ISO) roms.ps1 = process.env.MGU_PS1_TEST_ISO;
            for (const id of Object.keys(roms)) {
                const {image} = await play(id, roms[id]);
                sendImage('native-' + id, image.pixels, image.w, image.h);
            }
        }
        const pong = byId.arcade.create(null, null, {});
        const output = client('pong', true, 8);
        const pongFrame = new Recorder(W, H).clear([17, 34, 51, 255]);
        pong.tick([{down: true}, {up: true}], 1);
        pong.draw(pongFrame, 0, 0, W, H);
        output.c.frame(pongFrame);
        output.c.close();
        assert.strictEqual(output.c.imageStats.submitted, 0);
        if (renderer) assert.notDeepStrictEqual(pixel(replay(output.file), W / 2, H / 2, 0), [17, 34, 51, 255]);
        console.log('ok: native pixmap capability, RGBA, updates, release and legacy protocol; NES and Master System' +
            (renderer ? ', plus MGU renderer offscreen replay' : ' (wire only)'));
    } finally {
        imageById.delete(ID);
        for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
        fs.rmdirSync(dir);
    }
}
test().catch(error => { console.error(error); process.exitCode = 1; });
