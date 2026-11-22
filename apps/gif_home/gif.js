'use strict';
/**
 * Small dependency-free GIF87a/GIF89a decoder for Node 8 on BMW MGU.
 * Handles LZW, local palettes, interlacing, transparency and disposal 2/3.
 * Limits avoid exhausting the Atom head unit's memory on uploaded files.
 * No network, no native modules, no vehicle control interfaces.
 */
const LIMIT = { bytes: 6 * 1024 * 1024, width: 640, height: 360, frames: 90, pixels: 32 * 1024 * 1024 };

function decodeLzw(data, minBits, count) {
    if (minBits < 2 || minBits > 8) throw new Error('Invalid GIF LZW code size');
    const clear = 1 << minBits, end = clear + 1;
    const prefix = new Uint16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4096);
    const out = new Uint8Array(count);
    let size = minBits + 1, next = end + 1, previous = -1, first = 0;
    let bit = 0, pos = 0;
    while (bit + size <= data.length * 8) {
        const offset = bit >> 3;
        const word = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
        const input = (word >> (bit & 7)) & ((1 << size) - 1);
        bit += size;
        if (input === clear) {
            size = minBits + 1;
            next = end + 1;
            previous = -1;
            continue;
        }
        if (input === end) {
            if (pos !== count) throw new Error('Truncated GIF image');
            return out;
        }
        if (input > next || (input === next && previous < 0)) throw new Error('Corrupt GIF LZW stream');
        let code = input, top = 0;
        if (code === next) { stack[top++] = first; code = previous; }
        while (code >= clear) {
            if (code <= end || code >= next || top >= stack.length - 1) throw new Error('Corrupt GIF LZW dictionary');
            stack[top++] = suffix[code];
            code = prefix[code];
        }
        first = code;
        stack[top++] = first;
        if (pos + top > count) throw new Error('GIF image has excess pixels');
        while (top) out[pos++] = stack[--top];
        if (previous >= 0 && next < 4096) {
            prefix[next] = previous;
            suffix[next++] = first;
            if (next === (1 << size) && size < 12) size++;
        }
        previous = input;
    }
    throw new Error('Missing GIF LZW end code');
}

function decode(buf) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
    if (buf.length > LIMIT.bytes) throw new Error('GIF is too large (max 6 MB)');
    if (buf.length < 13 || !/^GIF8[79]a$/.test(buf.toString('ascii', 0, 6))) throw new Error('Not a GIF87a/GIF89a file');
    let p = 6;
    const u8 = () => { if (p >= buf.length) throw new Error('Truncated GIF'); return buf[p++]; };
    const u16 = () => u8() | (u8() << 8);
    function block(collect) {
        const start = p;
        let len, total = 0;
        while ((len = u8()) !== 0) {
            if (p + len > buf.length) throw new Error('Truncated GIF sub-block');
            p += len;
            total += len;
        }
        if (!collect) return null;
        const out = Buffer.allocUnsafe(total);
        let offset = start, written = 0;
        while ((len = buf[offset++]) !== 0) {
            buf.copy(out, written, offset, offset + len);
            offset += len;
            written += len;
        }
        return out;
    }
    function palette(n) {
        if (p + n * 3 > buf.length) throw new Error('Truncated GIF colour table');
        const value = buf.slice(p, p + n * 3); p += n * 3; return value;
    }
    const width = u16(), height = u16(), packed = u8(), background = u8();
    u8(); // pixel aspect ratio
    if (!width || !height || width > LIMIT.width || height > LIMIT.height) throw new Error('GIF dimensions must be at most 640x360');
    const globalColors = packed & 128 ? palette(1 << ((packed & 7) + 1)) : null;
    const rgba = new Uint8Array(width * height * 4);
    const frames = [];
    let gce = { disposal: 0, transparent: -1, delay: 100 };
    let duration = 0;
    for (;;) {
        const kind = u8();
        if (kind === 0x3b) break;
        if (kind === 0x21) {
            const label = u8();
            if (label === 0xf9) {
                if (u8() !== 4) throw new Error('Invalid GIF graphic-control block');
                const flags = u8(), hundredths = u16(), transparentIndex = u8();
                if (u8() !== 0) throw new Error('Invalid GIF graphic-control terminator');
                gce = { disposal: (flags >> 2) & 7, transparent: (flags & 1) ? transparentIndex : -1,
                    delay: hundredths ? hundredths * 10 : 100 };
            } else block();
            continue;
        }
        if (kind !== 0x2c) throw new Error('Unexpected GIF block');
        const left = u16(), top = u16(), w = u16(), h = u16(), flags = u8();
        if (!w || !h || left + w > width || top + h > height) throw new Error('Invalid GIF frame bounds');
        const colors = flags & 128 ? palette(1 << ((flags & 7) + 1)) : globalColors;
        if (!colors) throw new Error('Missing GIF colour table');
        if (frames.length + 1 > LIMIT.frames || (frames.length + 1) * rgba.length > LIMIT.pixels)
            throw new Error('GIF has too many frames for the MGU');
        const minBits = u8(), indices = decodeLzw(block(true), minBits, w * h);
        const saved = gce.disposal === 3 ? rgba.slice() : null;
        const rows = [];
        if (flags & 64) {
            [[0, 8], [4, 8], [2, 4], [1, 2]].forEach((pass) => {
                for (let y = pass[0]; y < h; y += pass[1]) rows.push(y);
            });
        } else for (let y = 0; y < h; y++) rows.push(y);
        for (let sy = 0; sy < h; sy++) {
            const dstRow = ((top + rows[sy]) * width + left) * 4;
            for (let x = 0; x < w; x++) {
                const idx = indices[sy * w + x];
                if (idx === gce.transparent) continue;
                const ci = idx * 3, di = dstRow + x * 4;
                if (ci + 2 >= colors.length) throw new Error('Invalid GIF colour index');
                rgba[di] = colors[ci]; rgba[di + 1] = colors[ci + 1]; rgba[di + 2] = colors[ci + 2]; rgba[di + 3] = 255;
            }
        }
        frames.push({ data: rgba.slice(), delay: gce.delay });
        duration += gce.delay;
        if (gce.disposal === 2) {
            const bc = globalColors && background * 3 + 2 < globalColors.length ? background * 3 : -1;
            for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) {
                const i = (y * width + x) * 4;
                if (bc >= 0) { rgba[i] = globalColors[bc]; rgba[i + 1] = globalColors[bc + 1]; rgba[i + 2] = globalColors[bc + 2]; rgba[i + 3] = 255; }
                else { rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0; }
            }
        } else if (gce.disposal === 3 && saved) rgba.set(saved);
        gce = { disposal: 0, transparent: -1, delay: 100 };
    }
    if (!frames.length) throw new Error('GIF contains no image');
    return { width, height, frames, duration };
}

module.exports = { decode, LIMIT };
