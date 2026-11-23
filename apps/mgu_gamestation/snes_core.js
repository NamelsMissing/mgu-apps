'use strict';

// jssnes (MIT), full JavaScript SNES core. On-car performance is unverified.
const SNES = require('./snes_vendor').SNES;
const {quiet} = require('./quiet');
const INPUTS = {
    b: 0x8000, y: 0x4000, select: 0x2000, start: 0x1000,
    up: 0x0800, down: 0x0400, left: 0x0200, right: 0x0100,
    a: 0x0080, x: 0x0040, l: 0x0020, r: 0x0010,
};
// Header chipset byte: low nibble 2 = ROM+RAM+battery, 5 / 6 = with a coprocessor and battery.
const BATTERY_TYPES = [0x2, 0x5, 0x6];

function mask(pad) {
    let bits = 0;
    Object.keys(INPUTS).forEach(key => { if (pad && pad[key]) bits |= INPUTS[key]; });
    return bits;
}

/** Bytes of battery-backed SRAM the cartridge header declares (0: none). */
function sramSize(mmu) {
    const rom = mmu && mmu.rom;
    if (!rom) return 0;
    const base = mmu.isHiRom ? 0xFFC0 : 0x7FC0;
    if (rom.length <= base + 0x18) return 0;
    const type = rom[base + 0x16] & 0x0f, size = rom[base + 0x18];
    if (BATTERY_TYPES.indexOf(type) < 0 || size < 1 || size > 7) return 0;
    return Math.min(1024 << size, mmu.sram.length);
}

class SnesGame {
    /** options.save: earlier SRAM (Buffer) for battery-backed cartridges. */
    constructor(bytes, output, options) {
        this.title = 'Super Nintendo'; this.width = 512; this.height = 208;
        this.snes = quiet(() => {
            const snes = new SNES();
            snes.loadRom(bytes);
            return snes;
        });
        this.output = output;
        this.saveSize = sramSize(this.snes.mmu);
        const save = options && options.save;
        if (this.saveSize && save && save.length === this.saveSize) this.snes.mmu.sram.set(save, 0);
    }
    tick(pads) {
        this.snes.mmu.joy1 = mask(pads[0]);
        this.snes.mmu.joy2 = mask(pads[1]);
        quiet(() => this.snes.frame());
        // Upstream PPU packs 0xAABBGGRR in a Uint32Array; little-endian
        // views yield the RGBA bytes expected by the MGU renderer.
        const pixels = new Uint8Array(this.snes.ppu.frameBuffer.buffer,
            this.snes.ppu.frameBuffer.byteOffset, 512 * 208 * 4);
        this.output(pixels, 512, 208);
    }
    getAudioSamples() {
        const dsp = this.snes.apu.dsp, length = dsp.samplePos;
        dsp.samplePos = 0;
        return length ? {rate: 32000, frameSamples: 800, left: dsp.sampleBufferL.subarray(0, length),
            right: dsp.sampleBufferR.subarray(0, length)} : null;
    }
    releaseInput() { this.snes.mmu.joy1 = this.snes.mmu.joy2 = 0; }
    /** Battery RAM to keep (a copy), or null when the cartridge has none. */
    sram() {
        if (!this.snes || !this.saveSize) return null;
        return Buffer.from(this.snes.mmu.sram.subarray(0, this.saveSize));
    }
    stop() { this.snes = null; }
}

module.exports = {SnesGame, mask, sramSize};
