'use strict';

// nes-js by Takahiro (MIT): executes entirely in the BMW Node 8 OAP app.
const lib = require('./nes_vendor');
const C = lib.Joypad.BUTTONS;
const MAPPING = {
    a: C.A, b: C.B, select: C.SELECT,
    start: C.START, up: C.UP, down: C.DOWN,
    left: C.LEFT, right: C.RIGHT,
};
// Cartridge RAM at CPU $6000-$7FFF; battery-backed on carts with header bit 1 of byte 6.
const SRAM_START = 0x6000, SRAM_SIZE = 0x2000;

class NesGame {
    /**
     * bytes: the .nes file; output(rgba, w, h): called once per finished video frame;
     * options.save: earlier battery RAM (Buffer), loaded before the CPU starts.
     */
    constructor(bytes, output, options) {
        this.title = 'NES'; this.width = 256; this.height = 240;
        this.output = output;
        this.rgba = Buffer.alloc(256 * 240 * 4);
        this.uint32 = new Uint32Array(this.rgba.buffer, this.rgba.byteOffset, 256 * 240);
        this.previous = [{}, {}];
        this.nes = new lib.Nes();
        // nes-js calls renderPixel/updateScreen; this sink is an RGBA frame
        // buffer, so it never touches a DOM canvas or WebAudio API.
        this.nes.setDisplay({
            renderPixel: (x, y, packed) => {
                if (x >= 0 && x < 256 && y >= 0 && y < 240) this.uint32[y * 256 + x] = packed;
            },
            updateScreen: () => output(this.rgba, 256, 240),
        });
        const rom = new lib.Rom(Uint8Array.from(bytes).buffer);
        this.battery = !!rom.header.getBatteryBackedRAM();
        this.nes.setRom(rom);
        const save = options && options.save;
        if (this.battery && save && save.length === SRAM_SIZE) this.nes.cpu.ram.data.set(save, SRAM_START);
        this.audio = new Float32Array(1024);
        this.audioCount = 0;
        this.audioRate = 1789773 / Math.floor(1789773 / 44100);
        this.dc = 0;
        this.nes.setAudio({
            getSampleRate: () => 44100,
            push: sample => {
                this.dc += (sample - this.dc) * 0.003;
                if (this.audioCount < this.audio.length) this.audio[this.audioCount++] = sample - this.dc;
            },
        });
        this.nes.bootup();
    }
    tick(pads) {
        this.audioCount = 0;
        for (let player = 0; player < 2; player++) {
            const next = pads[player] || {}, previous = this.previous[player];
            Object.keys(MAPPING).forEach(key => {
                if (!!previous[key] === !!next[key]) return;
                const joypad = player === 0 ? this.nes.pad1 : this.nes.pad2;
                if (next[key]) joypad.pressButton(MAPPING[key]);
                else joypad.releaseButton(MAPPING[key]);
            });
            this.previous[player] = next;
        }
        // One NTSC video frame = 341 dots * 262 scanlines / 3 PPU dots per CPU clock.
        for (let i = 0; i < 29781; i++) this.nes.runCycle();
    }
    getAudioSamples() {
        return this.audioCount ? {rate: this.audioRate, left: this.audio.subarray(0, this.audioCount)} : null;
    }
    releaseInput() {
        for (let player = 0; player < 2; player++) {
            const joypad = player === 0 ? this.nes.pad1 : this.nes.pad2;
            Object.keys(MAPPING).forEach(key => joypad.releaseButton(MAPPING[key]));
        }
        this.previous = [{}, {}];
    }
    /** Battery RAM to keep (a copy), or null when the cartridge has none. */
    sram() {
        if (!this.battery || !this.nes) return null;
        return Buffer.from(this.nes.cpu.ram.data.subarray(SRAM_START, SRAM_START + SRAM_SIZE));
    }
    stop() { if (this.nes) this.nes.stop(); this.nes = null; }
}

module.exports = {NesGame, SRAM_SIZE};
