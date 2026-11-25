'use strict';

const FONT = Buffer.from(
    'f0909090f02060202070f010f080f0f010f010f09090f01010f080f010f0f080f090f0f010204040' +
    'f090f090f0f090f010f0f090f09090e090e090e0f0808080f0e0909090e0f080f080f0f080f08080', 'hex');
const START = 0x200;
const OPS_PER_FRAME = 12;
const TONE = new Float32Array(800);
for (let i = 0; i < TONE.length; i++) TONE[i] = Math.sin(i * Math.PI / 40) * 0.2;
const SILENCE = new Float32Array(800);
const MAPS = {
    arrows: {up: 2, down: 8, left: 4, right: 6, a: 5, b: 0, x: 1, y: 3, start: 10, select: 15},
    alternate: {up: 5, down: 8, left: 7, right: 9, a: 0, b: 1, x: 2, y: 3, start: 10, select: 15},
};

class Chip8Game {
    constructor(bytes, output, options) {
        if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 4096 - START) throw new Error('Invalid CHIP-8 ROM size');
        const opts = options || {};
        this.superChip = /\.sc8$/i.test(opts.name || '');
        this.keymap = MAPS[opts.keymap] || MAPS.arrows;
        this.output = output;
        this.rom = bytes;
        this.video = Buffer.alloc(128 * 64 * 4);
        this.reset();
    }
    reset() {
        this.ram = Buffer.alloc(4096);
        FONT.copy(this.ram);
        // Super-CHIP large hexadecimal font, expanded vertically and horizontally to 8 x 10.
        for (let pos = 0; pos < FONT.length; pos++) {
            let row = 0;
            for (let bit = 0; bit < 4; bit++) if (FONT[pos] & (0x80 >> bit)) row |= 0xc0 >> (bit * 2);
            this.ram[80 + pos * 2] = this.ram[81 + pos * 2] = row;
        }
        this.rom.copy(this.ram, START);
        this.v = Buffer.alloc(16);
        this.rpl = Buffer.alloc(8);
        this.stack = [];
        this.pc = START;
        this.index = this.delay = this.sound = 0;
        this.waitKey = -1;
        this.random = (Math.random() * 0xffffffff) >>> 0 || 1;
        this.keys = this.pressed = 0;
        this.tone = this.halted = false;
        this.setMode(false);
    }
    setMode(high) {
        this.width = high ? 128 : 64;
        this.height = high ? 64 : 32;
        this.display = Buffer.alloc(this.width * this.height);
        this.dirty = true;
    }
    tick(pads) {
        let keys = 0;
        const pad = pads[0] || {};
        for (const key of Object.keys(pad)) {
            if (!pad[key]) continue;
            if (/^k[0-9a-f]$/.test(key)) keys |= 1 << parseInt(key[1], 16);
            else if (Object.prototype.hasOwnProperty.call(this.keymap, key)) keys |= 1 << this.keymap[key];
        }
        this.pressed = keys & ~this.keys;
        this.keys = keys;
        for (let i = 0; i < OPS_PER_FRAME && !this.halted; i++) {
            if (this.waitKey >= 0) {
                if (!this.pressed) break;
                this.v[this.waitKey] = 31 - Math.clz32(this.pressed & -this.pressed);
                this.waitKey = -1;
                this.pressed = 0;
            }
            this.execute();
        }
        this.tone = !this.halted && this.sound > 0;
        if (this.sound) this.sound--;
        if (this.delay) this.delay--;
        if (this.dirty) this.paint();
    }
    paint() {
        const size = this.display.length;
        for (let i = 0; i < size; i++) {
            const p = i * 4, ink = this.display[i] ? 238 : 16;
            this.video[p] = this.video[p + 1] = this.video[p + 2] = ink;
            this.video[p + 3] = 255;
        }
        this.output(this.video.subarray(0, size * 4), this.width, this.height);
        this.dirty = false;
    }
    getAudioSamples() { return {rate: 48000, left: this.tone ? TONE : SILENCE}; }
    releaseInput() { this.keys = this.pressed = 0; }
    checkMemory(size) {
        if (this.index + size > this.ram.length) throw new Error('CHIP-8 memory access out of bounds');
    }
    scroll(dx, dy) {
        const w = this.width, h = this.height, source = Buffer.from(this.display);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const sx = x - dx, sy = y - dy;
                this.display[y * w + x] = sx >= 0 && sx < w && sy >= 0 && sy < h ? source[sy * w + sx] : 0;
            }
        }
        this.dirty = true;
    }
    sprite(x, y, n) {
        const w = this.width, h = this.height, wide = this.superChip && n === 0;
        const columns = wide ? 16 : 8, rows = wide ? 16 : n;
        this.checkMemory(rows * (wide ? 2 : 1));
        x %= w; y %= h;
        let collision = 0;
        for (let dy = 0; dy < rows && y + dy < h; dy++) {
            const bits = wide ? this.ram.readUInt16BE(this.index + 2 * dy) : this.ram[this.index + dy];
            for (let dx = 0; dx < columns && x + dx < w; dx++) {
                if (!(bits & (1 << (columns - 1 - dx)))) continue;
                const p = (y + dy) * w + x + dx;
                collision |= this.display[p];
                this.display[p] ^= 1;
            }
        }
        this.v[15] = collision;
        this.dirty = true;
    }
    execute() {
        if (this.pc < START || this.pc + 1 >= this.ram.length) throw new Error('CHIP-8 program counter out of bounds');
        const op = this.ram.readUInt16BE(this.pc);
        this.pc += 2;
        const x = (op >> 8) & 15, y = (op >> 4) & 15, n = op & 15, b = op & 255, addr = op & 4095;
        const v = this.v;
        switch (op >> 12) {
        case 0:
            if (op === 0x00e0) { this.display.fill(0); this.dirty = true; return; }
            if (op === 0x00ee && this.stack.length) { this.pc = this.stack.pop(); return; }
            if (this.superChip) {
                if (op === 0x00fe || op === 0x00ff) return this.setMode(op === 0x00ff);
                if ((op & 0xfff0) === 0x00c0) return this.scroll(0, n);
                if (op === 0x00fb || op === 0x00fc) return this.scroll(op === 0x00fb ? 4 : -4, 0);
                if (op === 0x00fd) { this.halted = true; return; }
            }
            break;
        case 1: this.pc = addr; return;
        case 2:
            if (this.stack.length >= 16) throw new Error('CHIP-8 stack overflow');
            this.stack.push(this.pc); this.pc = addr; return;
        case 3: if (v[x] === b) this.pc += 2; return;
        case 4: if (v[x] !== b) this.pc += 2; return;
        case 5: if (n === 0) { if (v[x] === v[y]) this.pc += 2; return; } break;
        case 6: v[x] = b; return;
        case 7: v[x] += b; return;
        case 8: if (this.arithmetic(x, y, n)) return; break;
        case 9: if (n === 0) { if (v[x] !== v[y]) this.pc += 2; return; } break;
        case 10: this.index = addr; return;
        case 11: this.pc = addr + v[this.superChip ? x : 0]; return;
        case 12:
            this.random ^= this.random << 13;
            this.random ^= this.random >>> 17;
            this.random = (this.random ^ (this.random << 5)) >>> 0;
            v[x] = this.random & b;
            return;
        case 13: return this.sprite(v[x], v[y], n);
        case 14:
            if (b === 0x9e || b === 0xa1) {
                const held = v[x] < 16 && (this.keys & (1 << v[x])) !== 0;
                if (held === (b === 0x9e)) this.pc += 2;
                return;
            }
            break;
        case 15: if (this.misc(x, b)) return; break;
        }
        throw new Error('Unsupported CHIP-8 opcode 0x' + op.toString(16));
    }
    arithmetic(x, y, op) {
        const v = this.v, a = v[x], b = v[y], shift = this.superChip ? a : b;
        switch (op) {
        case 0: v[x] = b; return true;
        case 1: v[x] = a | b; break;
        case 2: v[x] = a & b; break;
        case 3: v[x] = a ^ b; break;
        case 4: v[x] = a + b; v[15] = Number(a + b > 255); return true;
        case 5: v[x] = a - b; v[15] = Number(a >= b); return true;
        case 6: v[x] = shift >> 1; v[15] = shift & 1; return true;
        case 7: v[x] = b - a; v[15] = Number(b >= a); return true;
        case 14: v[x] = shift << 1; v[15] = shift >> 7; return true;
        default: return false;
        }
        if (!this.superChip) v[15] = 0;
        return true;
    }
    misc(x, op) {
        const v = this.v;
        switch (op) {
        case 0x07: v[x] = this.delay; break;
        case 0x0a: this.waitKey = x; break;
        case 0x15: this.delay = v[x]; break;
        case 0x18: this.sound = v[x]; break;
        case 0x1e: this.index = (this.index + v[x]) & 4095; break;
        case 0x29: this.index = (v[x] & 15) * 5; break;
        case 0x30: if (!this.superChip) return false; this.index = 80 + (v[x] & 15) * 10; break;
        case 0x33:
            this.checkMemory(3);
            this.ram[this.index] = Math.floor(v[x] / 100);
            this.ram[this.index + 1] = Math.floor(v[x] / 10) % 10;
            this.ram[this.index + 2] = v[x] % 10;
            break;
        case 0x55:
        case 0x65:
            this.checkMemory(x + 1);
            if (op === 0x55) v.copy(this.ram, this.index, 0, x + 1);
            else this.ram.copy(v, 0, this.index, this.index + x + 1);
            if (!this.superChip) this.index = (this.index + x + 1) & 4095;
            break;
        case 0x75:
        case 0x85:
            if (!this.superChip || x >= this.rpl.length) return false;
            if (op === 0x75) v.copy(this.rpl, 0, 0, x + 1);
            else this.rpl.copy(v, 0, 0, x + 1);
            break;
        default: return false;
        }
        return true;
    }
    saveState() {
        return {ram: this.ram.toString('base64'), v: this.v.toString('hex'), rpl: this.rpl.toString('hex'),
            display: this.display.toString('base64'), high: this.width === 128, stack: this.stack.slice(),
            random: this.random, pc: this.pc, index: this.index, delay: this.delay, sound: this.sound, waitKey: this.waitKey, halted: this.halted};
    }
    loadState(s) {
        const int = (x, min, max) => Number.isInteger(x) && x >= min && x <= max;
        const decode = (text, encoding, length) => {
            if (typeof text !== 'string' || text.length > length * 2 + 4) throw new Error('Invalid CHIP-8 save data');
            const data = Buffer.from(text, encoding);
            if (data.length !== length || data.toString(encoding) !== text) throw new Error('Invalid CHIP-8 save data');
            return data;
        };
        if (!s || typeof s.high !== 'boolean' || typeof s.halted !== 'boolean' || s.high && !this.superChip ||
            !int(s.random, 1, 0xffffffff) || !int(s.pc, START, 4096) || !int(s.index, 0, 4095) || !int(s.delay, 0, 255) ||
            !int(s.sound, 0, 255) || !int(s.waitKey, -1, 15) || !Array.isArray(s.stack) ||
            s.stack.length > 16 || !s.stack.every(x => int(x, START, 4095))) throw new Error('Invalid CHIP-8 save state');
        const ram = decode(s.ram, 'base64', 4096), v = decode(s.v, 'hex', 16), rpl = decode(s.rpl, 'hex', 8);
        const display = decode(s.display, 'base64', s.high ? 8192 : 2048);
        if (display.some(x => x > 1)) throw new Error('Invalid CHIP-8 display');
        this.setMode(s.high);
        Object.assign(this, {ram, v, rpl, display, random: s.random, pc: s.pc, index: s.index, delay: s.delay, sound: s.sound,
            waitKey: s.waitKey, halted: s.halted, stack: s.stack.slice(), tone: false});
        this.releaseInput();
        this.paint();
    }
    stop() { this.halted = true; this.tone = false; }
}

module.exports = {Chip8Game};
