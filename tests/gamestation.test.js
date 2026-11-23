'use strict';

// node tests/gamestation.test.js - no car, SDK, copyrighted ROMs or network needed.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const {Pong} = require('../apps/mgu_gamestation/arcade');
const {NesGame} = require('../apps/mgu_gamestation/nes_core');
const {GameBoyGame} = require('../apps/mgu_gamestation/gb_core');
const {SnesGame, mask} = require('../apps/mgu_gamestation/snes_core');
const {Chip8Game} = require('../apps/mgu_gamestation/chip8_core');
const {GenesisGame} = require('../apps/mgu_gamestation/genesis_core');
const {SegaGame} = require('../apps/mgu_gamestation/sega_core');
const {detect} = require('../apps/mgu_gamestation/core_registry');
const {ControllerServer, privateAddress, validRom, ownAddress} = require('../apps/mgu_gamestation/controller_server');
const {IDrivePad, padsForMode} = require('../apps/mgu_gamestation/idrive_pad');

const quiet = {info() {}, warn() {}, error() {}};

function nesRom() {
    const b = Buffer.alloc(16 + 0x4000 + 0x2000);
    b.write('NES\x1a', 0, 'binary'); b[4] = 1; b[5] = 1;
    b[16] = 0x4c; b[17] = 0x00; b[18] = 0x80; // JMP $8000
    b[16 + 0x3ffc] = 0; b[16 + 0x3ffd] = 0x80;
    return b;
}
function snesRom() {
    const b = Buffer.alloc(0x8000);
    b[0] = 0x80; b[1] = 0xfe; // BRA -2 at $8000
    b.write('ORIGINAL SMOKE TEST', 0x7fc0);
    b[0x7fd5] = 0x20;
    b[0x7ffc] = 0; b[0x7ffd] = 0x80;
    return b;
}

function testCores() {
    let count = 0;
    const check = (bytes, Game, length) => {
        const g = new Game(bytes, (rgba, w, h) => {
            assert.strictEqual(rgba.length, length);
            assert.strictEqual(w * h * 4, length);
            count++;
        });
        g.tick([{a: true, start: true}, {b: true}], 1);
        g.getAudioSamples();
        g.tick([{}, {}], 1);
        const pcm = g.getAudioSamples();
        assert.ok(pcm && pcm.left.length >= 450 && pcm.left.length <= 1100 && pcm.left.every(Number.isFinite), Game.name + ' PCM');
        if (g instanceof NesGame) assert.strictEqual(pcm.right, undefined);
        else assert.strictEqual(pcm.left.length, pcm.right.length);
        g.stop();
    };
    check(nesRom(), NesGame, 256 * 240 * 4);
    const gb = Buffer.alloc(0x8000);
    gb[0x100] = 0; gb[0x143] = 0x80; // Color-capable cartridge header
    check(gb, GameBoyGame, 160 * 144 * 4);
    check(snesRom(), SnesGame, 512 * 208 * 4);
    assert.ok(count >= 5, 'expected video frames from all three console engines');
    assert.strictEqual(mask([{a: true}]), 0);
    assert.strictEqual(mask({a: true, up: true, select: true}), 0x2880);
    const pong = new Pong();
    pong.tick([{down: true}, {up: true}], 1);
    assert.ok(pong.left > 225 && pong.right < 225);
    pong.draw({roundRect() {}, fillRect() {}, text() {}, circle() {}}, 0, 0, 900, 450);
    const solo = new Pong({cpuPlayer2: true});
    solo.ballY = 400; solo.vx = 5;
    solo.tick([{}, {}], 1);
    assert.ok(solo.right > 225, 'Pong CPU must move the second paddle');
    console.log('ok: NES, GB/Color, SNES video; SNES two pads; Pong two players');
}

function segaRom(gameGear) {
    const rom = Buffer.alloc(32768);
    // Tone period 32, volume 0, left-only on GG, set VDP backdrop, loop.
    const ops = [
        0x3e, 0x80, 0xd3, 0x7f, 0x3e, 0x02, 0xd3, 0x7f, 0x3e, 0x90, 0xd3, 0x7f,
        0x3e, 0x10, 0xd3, 0x06, 0x3e, 0x0f, 0xd3, 0xbf, 0x3e, 0x87, 0xd3, 0xbf, 0x18, 0xfe,
    ];
    Buffer.from(ops).copy(rom);
    rom.write('TMR SEGA', 0x7ff0);
    rom[0x7fff] = gameGear ? 0x6c : 0x4c;
    return rom;
}

function genesisRom() {
    const rom = Buffer.alloc(0x8000);
    rom.writeUInt32BE(0x00ffff00, 0);
    for (let i = 4; i < 0x100; i += 4) rom.writeUInt32BE(0x200, i);
    rom.write('SEGA MEGA DRIVE ', 0x100);
    rom.write('U', 0x1f0);
    const ops = [
        0x13fc, 0x0080, 0x00c0, 0x0011, // PSG tone period low bits
        0x13fc, 0x0002, 0x00c0, 0x0011, // period 32
        0x13fc, 0x0090, 0x00c0, 0x0011, // max channel volume
        0x1039, 0x00a1, 0x0003,         // MOVE.B controller P1, D0
        0x13c0, 0x00ff, 0x0000,         // MOVE.B D0, work RAM
        0x60f2,                         // loop across controller reads
    ];
    ops.forEach((word, i) => rom.writeUInt16BE(word, 0x200 + 2 * i));
    return rom;
}

function testNewCores() {
    assert.strictEqual(detect('filename.NES'), 'nes');
    assert.strictEqual(detect('filename.bin'), null);
    assert.strictEqual(detect('filename.sc8'), 'chip8');
    assert.strictEqual(detect('filename.sms'), 'sms');
    assert.strictEqual(detect('filename.gg'), 'gg');
    assert.strictEqual(detect('filename.gen'), 'genesis');
    assert.ok(!validRom('genesis', 'wrong.md', segaRom(true)));
    assert.ok(validRom('genesis', 'homebrew.md', genesisRom()));
    assert.ok(validRom('gg', 'tone.gg', segaRom(true)));
    assert.ok(validRom('gg', 'tone.gg', Buffer.concat([Buffer.alloc(512), segaRom(true)])));
    assert.ok(!validRom('sms', 'tone.sms', segaRom(true)));
    assert.ok(!validRom('chip8', 'oversize.ch8', Buffer.alloc(4096)));
    assert.strictEqual(ownAddress({eth0: [{address: '10.0.0.4', family: 'IPv4'}]}), null);
    assert.strictEqual(ownAddress({wlan_bridge: [{address: '192.168.1.4', family: 'IPv4'}]}), '192.168.1.4');

    let frame;
    const paint = (rgba, width, height) => { frame = {rgba, width, height}; };
    // Render a glyph, beep for two ticks, then wait for a fresh hexadecimal key.
    const chip = new Chip8Game(Buffer.from('60036102f129d0156202f218f30a120e', 'hex'), paint, {name: 'key.ch8'});
    chip.tick([{}]);
    assert.strictEqual(frame.width, 64);
    assert.ok(frame.rgba.some((byte, i) => i % 4 === 0 && byte === 238));
    assert.ok(chip.getAudioSamples().left.some(sample => sample !== 0));
    chip.tick([{kf: true}]);
    assert.strictEqual(chip.v[3], 15);
    chip.tick([{}]);
    assert.ok(chip.getAudioSamples().left.every(sample => sample === 0));
    chip.stop();
    const superChip = new Chip8Game(Buffer.from('00ff6001f07500fb00fd', 'hex'), paint, {name: 'hi.sc8'});
    superChip.tick([{}]);
    assert.strictEqual(frame.width, 128);
    const state = superChip.saveState();
    superChip.reset();
    superChip.loadState(state);
    assert.strictEqual(superChip.halted, true);
    assert.strictEqual(superChip.rpl[0], 1);
    assert.throws(() => superChip.loadState(Object.assign({}, state, {ram: 'invalid'})), /Invalid CHIP-8/);
    assert.deepStrictEqual(superChip.saveState(), state, 'a failed load keeps the active state');

    for (const gg of [false, true]) {
        const sega = new SegaGame(segaRom(gg), paint, {name: gg ? 'test.gg' : 'test.sms'});
        sega.tick([{a: true, start: true}, {right: true}]);
        assert.strictEqual(frame.width, gg ? 160 : 256);
        assert.strictEqual(frame.height, gg ? 144 : 192);
        assert.ok(frame.rgba.every((value, i) => i % 4 !== 3 || value === 255));
        const audio = sega.getAudioSamples();
        assert.strictEqual(audio.left.length, 800);
        assert.ok(Math.min.apply(null, audio.left) < 0 && Math.max.apply(null, audio.left) > 0);
        if (gg) {
            assert.ok(audio.right.subarray(10).every(sample => sample === 0), 'GG stereo mask');
            assert.strictEqual(sega.core.bus.cpu_in(0, 255) & 128, 0, 'GG start is active low');
        } else {
            assert.strictEqual(audio.right, null);
            assert.strictEqual(sega.core.bus.read_reg_ioport2(255) & 2, 0, 'SMS port B right');
        }
        assert.strictEqual(sega.core.bus.read_reg_ioport1(255) & 16, 0, 'Sega button 1');
        sega.releaseInput();
        assert.strictEqual(sega.core.bus.read_reg_ioport1(255) & 16, 16);
        sega.stop();
    }
    const genesis = new GenesisGame(genesisRom(), paint);
    genesis.tick([{c: true}, {}]);
    assert.strictEqual(frame.width, 256);
    assert.strictEqual(frame.height, 224);
    assert.ok(frame.rgba.every((value, i) => i % 4 !== 3 || value === 255));
    const mdPcm = genesis.getAudioSamples();
    assert.strictEqual(mdPcm.left.length, mdPcm.right.length);
    assert.ok(mdPcm.left.some(sample => sample !== 0), 'Mega Drive PSG volume and period');
    const ram = new Uint8Array(genesis.memory, genesis.core.md_ram(), 1);
    assert.strictEqual(ram[0] & 32, 0, 'Mega Drive C active low');
    genesis.tick([{}, {}]);
    assert.strictEqual(ram[0] & 32, 32, 'Mega Drive C released');
    genesis.stop();
    console.log('ok: CHIP-8/Super-CHIP states, keypad, graphics and tone; Sega SMS/GG and Mega Drive video, controller and PCM');
}

function testIDrive() {
    let clock = 1000;
    const pad = new IDrivePad({now: () => clock});
    const evt = (counter, push, tilt) => ({frontRotaryEncoderOperation: counter,
        frontRotaryEncoderPushButton: push, frontRotaryEncoderDeflection: tilt});
    pad.raw(evt(65535, 0, 0));
    assert.deepStrictEqual(pad.buttons(), {}, 'no gameplay before explicit enable');
    pad.setEnabled(true);
    clock += 10;
    pad.raw(evt(0, 1, 1)); // counter wrap; short pressed; north tilt
    let keys = pad.buttons();
    assert.ok(keys.up && keys.a && keys.b, 'tilt, centre press and clockwise detent');
    clock += 50;
    pad.raw(evt(0, 0, 0)); // release
    clock += 100;
    pad.raw(evt(65535, 1, 10)); // anticlockwise, double press, west tilt
    keys = pad.buttons();
    assert.ok(keys.left && keys.a && keys.x && keys.start,
        'left tilt, backwards detent and double-press START');
    clock += 700;
    pad.raw(evt(65535, 2, 0)); // physically still held, now long press
    keys = pad.buttons();
    assert.ok(keys.select && !keys.a, 'long press should be SELECT, not held A');
    clock += 1601;
    assert.deepStrictEqual(pad.buttons(), {}, 'stale input must release held buttons');
    pad.setEnabled(false);
    pad.raw(evt(1, 1, 7));
    assert.deepStrictEqual(pad.buttons(), {}, 'disabled controls cannot start a game');

    const phones = [{b: true}, {right: true}];
    const local = {a: true};
    assert.deepStrictEqual(padsForMode('idrive', local, phones), [local, {}]);
    assert.deepStrictEqual(padsForMode('phone', local, phones), [phones[0], {}]);
    assert.deepStrictEqual(padsForMode('phones', local, phones), phones);
    assert.deepStrictEqual(padsForMode('hybrid', local, phones), [local, phones[1]]);

    const wheel = new IDrivePad({now: () => clock});
    wheel.setPong(true); wheel.setEnabled(true);
    wheel.raw(evt(4, 0, 0)); clock += 10; wheel.raw(evt(6, 0, 0));
    assert.ok(wheel.buttons().down && !wheel.buttons().b,
        'Pong rotating clockwise moves paddle down rather than pressing B');
    console.log('ok: iDrive tilt/press/rotation, long/double press, stale release, four controller modes');
}

function testProtocol() {
    assert.ok(privateAddress('172.16.222.97'));
    assert.ok(privateAddress('192.168.12.8'));
    assert.ok(!privateAddress('8.8.8.8'));
    assert.ok(validRom('nes', 'hello.nes', nesRom()));
    assert.ok(!validRom('nes', '../hello.nes', Buffer.alloc(2048)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamestation-test-'));
    try {
        let uploads = 0;
        const server = new ControllerServer(dir, {upload: () => uploads++, address: () => '172.16.222.1'}, quiet);
        const response = () => Object.assign(new EventEmitter(), {
            status: null, body: null,
            writeHead(n) {this.status = n;}, end(b) {this.body = b;},
        });
        const forbidden = response();
        server.request({socket: {remoteAddress: '10.1.2.3'}, url: '/?t=wrong', method: 'GET'}, forbidden);
        assert.strictEqual(forbidden.status, 403);
        const req = new EventEmitter();
        req.socket = {remoteAddress: '192.168.2.5'};
        req.method = 'POST'; req.url = '/rom?t=' + server.token + '&platform=nes&name=hello.nes';
        req.headers = {'content-length': String(nesRom().length)};
        const res = response();
        server.request(req, res);
        req.emit('data', nesRom()); req.emit('end');
        assert.strictEqual(res.status, 201);
        assert.strictEqual(uploads, 1);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'roms/nes/hello.nes')).length, nesRom().length);
        assert.notStrictEqual(server.url(1), server.url(2));
        // Browser-to-BMW WebSockets must use masked frames (RFC6455).
        const pad = {closed: false, lastSeen: Date.now(), keys: {},
            buffered: Buffer.alloc(0), socket: {destroy() {throw Error('Unexpected disconnect');}, write() {}}};
        const payload = Buffer.from(JSON.stringify({type: 'buttons', keys: ['left', 'a', 'start']}));
        const key = Buffer.from([3, 7, 19, 42]);
        const wire = Buffer.alloc(2 + 4 + payload.length);
        wire[0] = 0x81; wire[1] = 0x80 | payload.length;
        key.copy(wire, 2);
        for (let i = 0; i < payload.length; i++) wire[6 + i] = payload[i] ^ key[i & 3];
        server.onData(pad, wire.slice(0, 4));
        server.onData(pad, wire.slice(4));
        assert.deepStrictEqual(Object.keys(pad.keys).sort(), ['a', 'left', 'start']);
        server.players[0] = pad;
        assert.strictEqual(server.pads()[0].a, true);
        assert.deepStrictEqual(server.pads()[1], {});
        pad.lastSeen -= 2000;
        assert.deepStrictEqual(server.pads()[0], {}, 'stale controller input releases');
    } finally {
        const game = path.join(dir, 'roms/nes/hello.nes');
        if (fs.existsSync(game)) fs.unlinkSync(game);
        const nes = path.join(dir, 'roms/nes');
        if (fs.existsSync(nes)) fs.rmdirSync(nes);
        const roms = path.join(dir, 'roms');
        if (fs.existsSync(roms)) fs.rmdirSync(roms);
        fs.rmdirSync(dir);
    }
    console.log('ok: offline controller protocol, authentication and ROM validation');
}

testCores();
testNewCores();
testProtocol();
testIDrive();
