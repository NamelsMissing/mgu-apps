'use strict';

const {spawn} = require('child_process');

const HELPER = '/var/opt/mgu-gamestation-retro/current/mgu-gamestation-retro';
const HEADER = 24, MAX_AUDIO = 4096, MAX_SAVE = 256 * 1024;
const INPUT = ['b', 'y', 'select', 'start', 'up', 'down', 'left', 'right', 'a', 'x', 'l', 'r'];

function mask(pad, id) {
    if (!pad) return 0;
    let bits = INPUT.reduce((word, key, i) => word | (pad[key] ? 1 << i : 0), 0);
    if (id === 'a26' && pad.a) bits |= 1;
    if (id === 'ngp') bits = (bits & ~257) | (pad.a ? 1 : 0) | (pad.b ? 256 : 0);
    if (id === 'vb') {
        if (pad.rUp) bits |= 1 << 12;
        if (pad.rLeft) bits |= 1 << 13;
        if (pad.rDown) bits |= 1 << 14;
        if (pad.rRight) bits |= 1 << 15;
    }
    if (id === 'ws') {
        if (pad.rUp) bits |= 1 << 13;
        if (pad.rDown) bits |= 1 << 12;
        if (pad.rLeft) bits |= 1 << 10;
        if (pad.rRight) bits |= 1 << 11;
    }
    return bits;
}

// One isolated libretro process per game. At most one frame request is in flight.
class RetroGame {
    constructor(id, bytes, paint, opts) {
        this.asynchronous = true;
        this.paint = paint;
        this.opts = opts;
        this.id = id;
        this.header = Buffer.allocUnsafe(HEADER);
        this.offset = 0;
        this.body = this.packet = null;
        this.left = new Float32Array(MAX_AUDIO);
        this.right = new Float32Array(MAX_AUDIO);
        this.save = opts.save || null;
        this.started = this.stopped = false;
        this.nextDue = this.sentAt = 0;
        this.inputEpoch = this.sentEpoch = 0;
        this.timer = this.deadline = null;
        this.error = '';
        const child = this.child = spawn(opts.helper || HELPER, [id, opts.name], {stdio: ['pipe', 'pipe', 'pipe']});
        child.on('error', err => this.fail(err.message));
        child.stdin.on('error', err => {
            if (err.code !== 'EPIPE') this.fail(err.message);
        });
        child.stderr.on('data', part => { this.error = (this.error + part).slice(-500); });
        child.stdout.on('data', part => {
            if (this.stopped) return;
            try { this.receive(part); }
            catch (err) { this.fail(err.message); }
        });
        child.once('close', (code, signal) => {
            if (!this.stopped) this.fail(this.error.trim() || 'Native emulator ended (' + (signal || code) + ')');
        });
        const init = Buffer.alloc(8);
        init.writeUInt32LE(bytes.length, 0);
        init.writeUInt32LE(this.save ? this.save.length : 0, 4);
        child.stdin.write(init);
        child.stdin.write(bytes);
        if (this.save) child.stdin.write(this.save);
        this.deadline = setTimeout(() => this.fail('Native emulator did not start'), 5000);
    }
    receive(chunk) {
        for (let i = 0; i < chunk.length;) {
            const target = this.body || this.header;
            const n = Math.min(chunk.length - i, target.length - this.offset);
            chunk.copy(target, this.offset, i, i + n);
            i += n;
            this.offset += n;
            if (this.offset < target.length) continue;
            this.offset = 0;
            if (this.body) {
                const packet = this.packet, bytes = this.body;
                this.packet = this.body = null;
                this.deliver(packet, bytes);
                continue;
            }
            const [type, width, height, samples, save, reserved] = Array.from({length: 6}, (_, j) => this.header.readUInt32LE(j * 4));
            if (reserved) throw new Error('Invalid native emulator packet');
            if (type === 1 && !this.frameMs && width >= 10000 && width <= 100000 &&
                height >= 8000 && height <= 192000 && !samples && !save) {
                clearTimeout(this.deadline);
                this.deadline = null;
                this.frameMs = 1000000 / width;
                this.rate = height;
                this.schedule();
                continue;
            }
            if (type !== 2 || !this.sentAt || width > 768 || height > 512 ||
                (!!width !== !!height) || samples > MAX_AUDIO || save > MAX_SAVE)
                throw new Error('Invalid native emulator frame');
            const pixels = width * height * 4, size = pixels + samples * 4 + save;
            this.packet = {width, height, pixels, samples, save};
            if (size) this.body = Buffer.allocUnsafe(size);
            else this.deliver(this.packet, null);
        }
    }
    deliver(frame, bytes) {
        clearTimeout(this.deadline);
        const spent = Date.now() - this.sentAt;
        this.deadline = null;
        this.sentAt = 0;
        if (frame.save) this.save = Buffer.from(bytes.slice(bytes.length - frame.save));
        if (!this.opts.canRun() || this.sentEpoch !== this.inputEpoch) {
            this.nextDue = 0;
            this.schedule();
            return;
        }
        if (frame.pixels) this.paint(bytes.slice(0, frame.pixels), frame.width, frame.height);
        let audio = null;
        if (frame.samples) {
            for (let i = 0; i < frame.samples; i++) {
                this.left[i] = bytes.readInt16LE(frame.pixels + i * 4) / 32768;
                this.right[i] = bytes.readInt16LE(frame.pixels + i * 4 + 2) / 32768;
            }
            audio = {rate: this.rate, left: this.left.subarray(0, frame.samples), right: this.right.subarray(0, frame.samples)};
        }
        this.opts.onFrame(audio, Math.max(0, spent));
        this.schedule();
    }
    tick() {
        this.started = true;
        this.schedule();
    }
    schedule() {
        if (!this.started || this.stopped || !this.frameMs || this.sentAt || this.timer || !this.opts.canRun()) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            if (this.stopped || !this.opts.canRun()) return;
            const now = Date.now(), pads = this.opts.pads(), input = Buffer.alloc(8);
            this.nextDue = this.nextDue && now - this.nextDue < this.frameMs ?
                this.nextDue + this.frameMs : now + this.frameMs;
            this.sentEpoch = this.inputEpoch;
            input.writeUInt32LE(mask(pads[0], this.id), 0);
            input.writeUInt32LE(mask(pads[1], this.id), 4);
            this.sentAt = now;
            this.deadline = setTimeout(() => this.fail('Native emulator frame timed out'), 750);
            this.child.stdin.write(input);
        }, Math.max(0, this.nextDue - Date.now()));
    }
    releaseInput() {
        this.inputEpoch++;
        clearTimeout(this.timer);
        this.timer = null;
        this.nextDue = 0;
    }
    sram() { return this.save; }
    fail(message) {
        if (this.stopped) return;
        this.stop();
        this.opts.onError(message);
    }
    stop() {
        if (this.stopped) return;
        this.stopped = true;
        this.releaseInput();
        clearTimeout(this.deadline);
        this.child.stdin.destroy();
        this.child.kill('SIGKILL');
    }
}

module.exports = {RetroGame, HELPER, mask};
