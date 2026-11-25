'use strict';

const assert = require('assert');
const path = require('path');
const {spawnSync} = require('child_process');
const {RetroGame, mask} = require('../apps/mgu_gamestation/retro_core');
const {validRom, maxRom, byId} = require('../apps/mgu_gamestation/core_registry');
const worker = path.join(__dirname, '../native/gamestation-retro/mgu-gamestation-retro');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixtures() {
    const gba = Buffer.alloc(32768);
    gba.writeUInt32LE(0xea00002e, 0); // Branch past the header.
    gba[0xb2] = 0x96;
    // Clear forced blank, write red to the BG palette and loop.
    [0xe59f0018, 0xe3a01000, 0xe1c010b0, 0xe59f0010, 0xe3a0101f,
        0xe1c010b0, 0xeafffffe, 0, 0x04000000, 0x05000000]
        .forEach((word, i) => gba.writeUInt32LE(word, 0xc0 + 4 * i));

    const a26 = Buffer.alloc(4096, 0xea);
    // Set TIA audio, write a background colour, then generate a scanline loop.
    Buffer.from('78a2ff9aa9048515a9078517a9058519a9428509a9028500850285028502a9008500' +
        'a2ff8502cad0fba2048502cad0fb4c14f0', 'hex').copy(a26);
    Buffer.from('00f000f0', 'hex').copy(a26, a26.length - 4);

    const a78 = Buffer.alloc(128 + 32768);
    a78.write('ATARI7800', 1);
    a78.writeUInt32BE(32768, 49);
    a78.write('ACTUAL CART DATA STARTS HERE', 100);
    Buffer.from('4c0080', 'hex').copy(a78, 128);
    Buffer.from('00800080', 'hex').copy(a78, a78.length - 4);

    const pce = Buffer.alloc(8192, 0xea);
    Buffer.from('4c00e0', 'hex').copy(pce);
    Buffer.from('00e000e000e000e000e0', 'hex').copy(pce, pce.length - 10);

    const vb = Buffer.alloc(65536);
    const ws = Buffer.alloc(65536);
    Buffer.from('ebfe', 'hex').copy(ws, ws.length - 16);
    const ngp = Buffer.alloc(32768);
    ngp.write('COPYRIGHT BY SNK CORPORATION');
    ngp.writeUInt32LE(0x200100, 0x1c);
    Buffer.from('68fe', 'hex').copy(ngp, 0x100);
    return {gba, a26, a78, pce, vb, ws, ngp};
}

function nesBattery(mapper) {
    const rom = Buffer.alloc(16 + 0x8000 + 0x2000);
    rom.write('NES\x1a', 0, 'binary');
    rom[4] = 2; rom[5] = 1;
    rom[6] = (mapper << 4) | 2; rom[8] = 1;
    // Write one SRAM byte, then repeatedly store P1's A bit in the next byte.
    Buffer.from('a9428d0060a9018d1640a9008d1640ad164029018d01604c05e0', 'hex').copy(rom, 16 + 0x6000);
    rom.writeUInt16LE(0xe000, 16 + 0x7ffc);
    return rom;
}

function play(id, bytes, save) {
    let game, run = true, frames = 0, image, sound;
    return new Promise((resolve, reject) => {
        const paint = (pixels, w, h) => { image = {pixels, w, h}; };
        const options = {
            name: 'test.' + id, helper: worker, save, canRun: () => run, pads: () => [{a: true}, {left: true}],
            onError: message => reject(new Error(id + ': ' + message)),
            onFrame: pcm => {
                try {
                    assert.ok(image && image.pixels.length === image.w * image.h * 4);
                    assert.strictEqual(image.pixels[3], 255);
                    assert.ok(pcm && pcm.left.length === pcm.right.length && pcm.left.length > 100);
                    if (pcm.left.some(value => value !== 0)) sound = true;
                    if (++frames === 8) {
                        run = false;
                        game.releaseInput();
                        const last = frames;
                        wait(55).then(() => {
                            assert.strictEqual(frames, last, 'no frames while held');
                            run = true;
                            game.tick();
                        }).catch(reject);
                    }
                    if (frames === 14) resolve({image, sound, battery: game.sram()});
                } catch (err) { reject(err); }
            },
        };
        game = id === 'nes' ? byId.nes.create(bytes, paint, options) : new RetroGame(id, bytes, paint, options);
        assert.ok(game.asynchronous, 'test runs the native backend');
        game.tick();
    }).then(result => { game.stop(); return result; }, error => { game.stop(); throw error; });
}

async function test() {
    assert.strictEqual(maxRom('gba'), 32 * 1024 * 1024);
    assert.strictEqual(maxRom('nes'), 8 * 1024 * 1024);
    assert.ok(mask({a: true}, 'a26') & 1, 'one Atari fire button');
    assert.strictEqual(mask({rRight: true}, 'vb'), 1 << 15);
    assert.strictEqual(mask({rDown: true}, 'ws'), 1 << 12);
    assert.strictEqual(mask({a: true, start: true}, 'ngp'), 9);
    if (process.platform === 'linux' && process.arch === 'x64') {
        for (const mapper of [0, 1, 4]) {
            const bytes = nesBattery(mapper), save = Buffer.alloc(8192);
            save[2] = 0x6a;
            const result = await play('nes', bytes, save);
            assert.deepStrictEqual([result.image.w, result.image.h], [256, 240]);
            assert.strictEqual(result.battery.length, 8192);
            assert.deepStrictEqual(Array.from(result.battery.slice(0, 3)), [0x42, 1, 0x6a],
                'native NES mapper ' + mapper + ' writes battery RAM, receives pad A and reloads untouched legacy bytes');
        }
        const rom = nesBattery(1), init = Buffer.alloc(8);
        init.writeUInt32LE(rom.length, 0);
        init.writeUInt32LE(16, 4);
        const failure = spawnSync(worker, ['nes', 'invalid-save.nes'], {input: Buffer.concat([init, rom, Buffer.alloc(16)])});
        assert.strictEqual(failure.status, 2);
        assert.strictEqual(failure.stdout.length, 0, 'incompatible save is rejected before starting the native game');
        assert.ok(/incompatible battery RAM layout/.test(failure.stderr.toString()));
        console.log('ok: native NES NROM, MMC1 and MMC3, battery RAM, pad input, RGBA, PCM and pause/resume');
    }
    if (process.env.MGU_PS1_TEST_ISO && process.platform === 'linux' && process.arch === 'x64') {
        const ps1 = await play('ps1', process.env.MGU_PS1_TEST_ISO);
        assert.deepStrictEqual([ps1.image.w, ps1.image.h], [320, 240]);
        assert.ok(ps1.image.pixels.some((v, i, p) => i % 4 === 0 && v >= 240 && !p[i + 1] && !p[i + 2]));
        assert.strictEqual(ps1.battery.length, 131072);
        console.log('ok: PlayStation original test ISO, red GPU fill, PCM, memory card and pause/resume');
    }
    const roms = fixtures();
    for (const id of Object.keys(roms)) {
        const bytes = roms[id];
        assert.ok(validRom(id, 'test.' + id, bytes), id);
        assert.ok(!validRom(id, 'test.bin', bytes), id);
        if (process.platform !== 'linux' || process.arch !== 'x64') continue;
        const result = await play(id, bytes);
        if (id === 'gba') {
            assert.strictEqual(result.image.w, 240);
            assert.ok(result.image.pixels.some((v, i) => i % 4 === 0 && v === 255), 'GBA program wrote palette');
            assert.ok(result.battery && result.battery.length === 131072);
        }
        if (id === 'a26') assert.ok(result.sound, 'Atari program wrote TIA sound registers');
        console.log('ok: experimental core ' + id + ', RGBA, PCM, pause/resume');
    }
}

if (require.main === module) test().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = {fixtures, nesBattery, play};
