'use strict';

const fs = require('fs');
const path = require('path');

const INPUT = {up: 1, down: 2, left: 4, right: 8, b: 16, c: 32, a: 64, start: 128};
const STRIDE = 320;
let moduleCode;

function mask(pad) {
    let bits = 0;
    if (pad) Object.keys(INPUT).forEach(key => { if (pad[key]) bits |= INPUT[key]; });
    return bits;
}

class GenesisGame {
    constructor(bytes, output, options) {
        moduleCode = moduleCode || new WebAssembly.Module(fs.readFileSync(path.join(__dirname, 'mdcore.wasm')));
        this.core = new WebAssembly.Instance(moduleCode, {}).exports;
        this.memory = this.core.memory.buffer;
        this.output = output;
        this.pixels = Buffer.alloc(STRIDE * 240 * 4);
        this.left = new Float32Array(1200);
        this.right = new Float32Array(1200);

        const core = this.core;
        core.md_init(1);
        new Uint8Array(this.memory, core.md_rom_buffer(), bytes.length).set(bytes);
        if (core.md_load(bytes.length, 0) !== 1) throw new Error('Mega Drive core rejected the cartridge');
        this.frameMs = 1000000 / core.md_fps_x1000();
        this.audioRate = core.md_audio_rate_x1000() / 1000;
        const save = options && options.save;
        if (save && save.length === core.md_sram_size())
            new Uint8Array(this.memory, core.md_sram(), save.length).set(save);
        // The core starts just before VBlank; discard its partial startup frame.
        core.md_run_frame();
    }
    tick(pads) {
        const core = this.core;
        core.md_set_input(0, mask(pads[0]));
        core.md_set_input(1, mask(pads[1]));
        core.md_run_frame();
        const width = core.md_width(), height = core.md_height();
        if (width < 1 || width > STRIDE || height < 1 || height > 240) throw new Error('Invalid Mega Drive video frame');
        const stride = STRIDE * 4, rowBytes = width * 4;
        const pixels = Buffer.from(this.memory, core.md_framebuffer(), stride * height);
        if (width === STRIDE) this.output(pixels, width, height);
        else {
            for (let y = 0; y < height; y++) pixels.copy(this.pixels, y * rowBytes, y * stride, y * stride + rowBytes);
            this.output(this.pixels.subarray(0, rowBytes * height), width, height);
        }
    }
    getAudioSamples() {
        const n = this.core.md_audio_frames();
        if (!n || n > this.left.length) return null;
        const samples = new Int16Array(this.memory, this.core.md_audio(), n * 2);
        for (let i = 0; i < n; i++) {
            this.left[i] = samples[2 * i] / 32768;
            this.right[i] = samples[2 * i + 1] / 32768;
        }
        return {rate: this.audioRate, left: this.left.subarray(0, n), right: this.right.subarray(0, n)};
    }
    sram() {
        const n = this.core.md_sram_size();
        return n ? Buffer.from(new Uint8Array(this.memory, this.core.md_sram(), n)) : null;
    }
    releaseInput() { this.core.md_set_input(0, 0); this.core.md_set_input(1, 0); }
    stop() { this.core = null; this.memory = null; }
}

module.exports = {GenesisGame};
