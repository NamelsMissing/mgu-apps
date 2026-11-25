'use strict';

const {SMSGG, SMSGG_variants, REGION, SMS_present, GG_present} = require('./sega_vendor');

const KEYS = ['up', 'down', 'left', 'right', 'a', 'b'];
const RATE = 48000, SAMPLES = 800, FRAME_CLOCKS = 684 * 262;

class SegaGame {
    constructor(bytes, output, options) {
        this.gg = /\.gg$/i.test(options.name);
        this.output = output;
        this.core = new SMSGG({loaded: false}, this.gg ? SMSGG_variants.GG : SMSGG_variants.SMS2, REGION.NTSC);
        // The normal upstream SMS boot path runs a BIOS. Start the cartridge directly.
        const hasCopierHeader = bytes.length % 8192 === 512;
        const rom = bytes.subarray(hasCopierHeader ? 512 : 0);
        this.core.load_ROM_from_RAM(options.name, Uint8Array.from(rom));
        this.core.bus.mapper.set_bios(false);
        this.core.bus.mapper.enable_cart = 1;
        this.pixels = Buffer.alloc(this.gg ? 160 * 144 * 4 : 256 * 240 * 4);
        this.keys = new Uint8Array(13);
        this.left = new Float32Array(SAMPLES + 1);
        this.right = this.gg ? new Float32Array(SAMPLES + 1) : null;
        this.pcmEnabled = true;
        this.samples = 0;
        this.nextSample = 0;
        this.core.sn76489.stereo = 255;
        this.core.sn76489.capture = psg => {
            psg.output.next_buf_sample = ++this.nextSample * FRAME_CLOCKS / SAMPLES;
            if (!this.pcmEnabled) return;
            if (this.samples >= this.left.length) return;
            this.left[this.samples] = psg.mix_sample(this.gg ? psg.stereo >> 4 : 15) / 32768;
            if (this.right) this.right[this.samples] = psg.mix_sample(psg.stereo & 15) / 32768;
            this.samples++;
        };
    }
    tick(pads) {
        const p1 = pads[0] || {}, p2 = pads[1] || {};
        KEYS.forEach((key, i) => {
            this.keys[i] = Number(!!p1[key]);
            if (!this.gg) this.keys[i + 6] = Number(!!p2[key]);
        });
        this.keys[this.gg ? 6 : 12] = Number(!!(p1.start || !this.gg && p1.select));
        this.core.map_inputs(this.keys);
        this.samples = 0;
        const frame = this.core.run_frame();
        if (!frame) throw new Error('Invalid Sega video frame');
        const buffer = this.core.vdp.output_shared_buffers[frame.buffer_num];
        if (this.gg) {
            GG_present(frame, this.pixels, buffer);
            this.output(this.pixels, 160, 144);
        } else {
            SMS_present(frame, this.pixels, buffer);
            this.output(this.pixels.subarray(0, 256 * frame.bottom_rendered_line * 4), 256, frame.bottom_rendered_line);
        }
    }
    setAudioEnabled(on) { this.pcmEnabled = !!on; }
    getAudioSamples() {
        return this.samples ? {rate: RATE, left: this.left.subarray(0, this.samples),
            right: this.right && this.right.subarray(0, this.samples)} : null;
    }
    releaseInput() { this.keys.fill(0); this.core.map_inputs(this.keys); }
    stop() { this.core.killall(); this.core = null; }
}

module.exports = {SegaGame};
