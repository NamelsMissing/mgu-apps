'use strict';

// Serverboy.js (GPL-2.0), Game Boy / Game Boy Color, executes on Node 8.
const GameBoy = require('./gb_vendor');
const {quiet} = require('./quiet');
const FRAME_CYCLES = 70224;
const BUTTONS = ['up', 'down', 'left', 'right', 'a', 'b', 'select', 'start'];

class GameBoyGame {
    /** options.save: earlier cartridge RAM (Buffer) for battery-backed cartridges. */
    constructor(bytes, output, options) {
        this.title = 'Game Boy / Color'; this.width = 160; this.height = 144;
        this.gb = new GameBoy();
        quiet(() => this.gb.loadRom(bytes, FRAME_CYCLES));
        this.frameMs = FRAME_CYCLES * 1000 / 4194304;
        this.output = output;
        this.rgba = Buffer.alloc(160 * 144 * 4);
        const save = options && options.save, core = this.core();
        this.audioLeft = new Float32Array(2048);
        this.audioRight = new Float32Array(2048);
        this.pcmEnabled = true;
        this.audioCount = 0;
        this.audioRate = core.clocksPerSecond / core.audioResamplerFirstPassFactor;
        this.dcLeft = this.dcRight = 0;
        core.onAudioSample = (left, right) => {
            if (!this.pcmEnabled) return;
            this.dcLeft += (left - this.dcLeft) * 0.01;
            this.dcRight += (right - this.dcRight) * 0.01;
            if (this.audioCount >= this.audioLeft.length) return;
            this.audioLeft[this.audioCount] = left - this.dcLeft;
            this.audioRight[this.audioCount++] = right - this.dcRight;
        };
        if (core && core.cBATT && save && core.MBCRam && save.length === core.MBCRam.length) core.MBCRam.set(save);
    }
    /** serverboy keeps its GameBoyCore under a per-process private key. */
    core() {
        if (!this.gb) return null;
        const key = Object.keys(this.gb).find(k => this.gb[k] && this.gb[k].gameboy);
        return key ? this.gb[key].gameboy : null;
    }
    tick(pads) {
        this.audioCount = 0;
        const p = pads[0] || {};
        this.gb.pressKeys(BUTTONS.filter(k => !!p[k]));
        const pixels = quiet(() => this.gb.doFrame());
        if (!pixels || pixels.length !== this.rgba.length) throw new Error('Invalid Game Boy video frame');
        for (let i = 0; i < pixels.length; i++) this.rgba[i] = pixels[i];
        this.output(this.rgba, 160, 144);
    }
    setAudioEnabled(on) { this.pcmEnabled = !!on; }
    getAudioSamples() {
        const n = this.audioCount;
        return n ? {rate: this.audioRate, left: this.audioLeft.subarray(0, n), right: this.audioRight.subarray(0, n)} : null;
    }
    /** Battery RAM to keep (a copy), or null when the cartridge has none. */
    sram() {
        const core = this.core();
        if (!core || !core.cBATT || !core.MBCRam || !core.MBCRam.length) return null;
        return Buffer.from(core.MBCRam);
    }
    stop() { this.gb = null; }
}

module.exports = {GameBoyGame};
