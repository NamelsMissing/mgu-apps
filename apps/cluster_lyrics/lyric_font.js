'use strict';
/*
 * Text for lyrics: Latin with umlauts and accents, Cyrillic and a few
 * typographic signs, drawn from this app's own alpha atlas
 * (lyric_font_data.js, baked by tools/bake_lyric_font.py). The kit's fonts
 * only carry ASCII.
 *
 * A target is anything with { d: RGBA bytes, w, h }: a kit Canvas for the
 * iDrive preview or a plain buffer for a KOMBI texture.
 */
const zlib = require('zlib');
const DATA = require('./lyric_font_data.js');

const faces = Object.create(null);
function face(name) {
    if (faces[name]) return faces[name];
    const f = DATA[name] || DATA.regular;
    faces[name] = { size: f.size, ascent: f.ascent, descent: f.descent, atlasW: f.atlasW, atlasH: f.atlasH,
        glyphs: f.glyphs, alpha: zlib.inflateSync(Buffer.from(f.alpha, 'base64')) };
    return faces[name];
}
const FOLD = { 0x2010: 0x2D, 0x2011: 0x2D, 0x2012: 0x2013, 0x2015: 0x2014, 0x2032: 0x27, 0x2033: 0x22,
    0x00A0: 0x20, 0x2009: 0x20, 0x200A: 0x20, 0x202F: 0x20, 0x3000: 0x20, 0xFF01: 0x21, 0xFF1F: 0x3F };
/** Characters the atlas can draw; common look-alikes are folded, the rest dropped. */
function supported(text) {
    const f = face('regular');
    let out = '', missing = 0, letters = 0;
    for (const ch of String(text).normalize('NFC')) {
        let cp = ch.codePointAt(0);
        if (cp === 0x200B || cp === 0x200D || cp === 0xFEFF || (cp >= 0xFE00 && cp <= 0xFE0F)) continue;
        if (FOLD[cp]) cp = FOLD[cp];
        if (f.glyphs[cp]) { out += String.fromCodePoint(cp); if (cp > 0x20) letters++; }
        else { missing++; out += ' '; }
    }
    out = out.replace(/\s+/g, ' ').trim();
    return { text: out, missing, letters, readable: letters > 0 && missing <= letters };
}
function measure(name, text, size) {
    const f = face(name), scale = size / f.size;
    let w = 0;
    for (const ch of String(text)) { const g = f.glyphs[ch.codePointAt(0)] || f.glyphs[63]; if (g) w += g[6]; }
    return w * scale;
}
/** Baseline-relative pixel bounds, including the glyphs' antialiasing margin. */
function verticalBounds(name, text, size) {
    const f = face(name), scale = size / f.size;
    let top = Infinity, bottom = -Infinity;
    for (const ch of text) {
        const g = f.glyphs[ch.codePointAt(0)] || f.glyphs[63];
        if (!g || !g[2] || !g[3]) continue;
        top = Math.min(top, g[5] * scale);
        bottom = Math.max(bottom, (g[5] + g[3]) * scale);
    }
    return top === Infinity ? { top: 0, bottom: 0 } :
        { top: Math.floor(top) - 1, bottom: Math.ceil(bottom) + 1 };
}
function parseColor(c) {
    if (Array.isArray(c)) return c;
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(c));
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 255] : [255, 255, 255, 255];
}
function blend(target, x, y, c, cover) {
    const i = (y * target.w + x) * 4, d = target.d;
    const a = cover * (c[3] === undefined ? 255 : c[3]) / 255;
    if (a <= 0) return;
    const da = d[i + 3] / 255, oa = a + da * (1 - a);
    d[i] = Math.round((c[0] * a + d[i] * da * (1 - a)) / oa);
    d[i + 1] = Math.round((c[1] * a + d[i + 1] * da * (1 - a)) / oa);
    d[i + 2] = Math.round((c[2] * a + d[i + 2] * da * (1 - a)) / oa);
    d[i + 3] = Math.round(oa * 255);
}
/**
 * Draw text with its baseline at y. opts.align: 'left' | 'center' | 'right'.
 * Returns the drawn width.
 */
function draw(target, name, text, x, y, size, color, opts) {
    const f = face(name), scale = size / f.size, c = parseColor(color);
    const s = String(text), width = measure(name, s, size);
    const align = opts && opts.align;
    let pen = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
    const A = f.alpha, AW = f.atlasW;
    for (const ch of s) {
        const g = f.glyphs[ch.codePointAt(0)] || f.glyphs[63];
        if (!g) continue;
        const gx = g[0], gy = g[1], gw = g[2], gh = g[3];
        if (gw && gh) {
            const dx = pen + g[4] * scale, dy = y + g[5] * scale;
            const x1 = Math.min(target.w, Math.ceil(dx + gw * scale)), y1 = Math.min(target.h, Math.ceil(dy + gh * scale));
            for (let py = Math.max(0, Math.floor(dy)); py < y1; py++) {
                const sy = (py + 0.5 - dy) / scale - 0.5, iy = Math.floor(sy), fy = sy - iy;
                for (let px = Math.max(0, Math.floor(dx)); px < x1; px++) {
                    const sx = (px + 0.5 - dx) / scale - 0.5, ix = Math.floor(sx), fx = sx - ix;
                    const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= gw || yy >= gh) ? 0 : A[(gy + yy) * AW + gx + xx];
                    const v = at(ix, iy) * (1 - fx) * (1 - fy) + at(ix + 1, iy) * fx * (1 - fy) +
                        at(ix, iy + 1) * (1 - fx) * fy + at(ix + 1, iy + 1) * fx * fy;
                    if (v > 0) blend(target, px, py, c, v / 255);
                }
            }
        }
        pen += g[6] * scale;
    }
    return width;
}
/** A plain RGBA target filled with one colour. */
function surface(w, h, color) {
    const c = parseColor(color || [0, 0, 0, 0]), d = Buffer.alloc(w * h * 4);
    if (c[3] !== 0 || c[0] || c[1] || c[2])
        for (let i = 0; i < d.length; i += 4) { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = c[3] === undefined ? 255 : c[3]; }
    return { d, w, h };
}

module.exports = { draw, measure, supported, surface, face, verticalBounds, parseColor };
