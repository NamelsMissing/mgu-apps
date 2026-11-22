'use strict';
// Versioned binary DSP snapshot for native consumers (CarPlay live prototype).
// The Node service writes it atomically; a native bridge thread polls and
// validates it outside the audio callback. Layout v1, little endian, 204 bytes:
//   0  char[8] magic "MGEQSNP1"
//   8  u32 layout (1)
//  12  u32 total size (204)
//  16  u32 revision (service revision, low 32 bits)
//  20  u32 flags: bit0 enabled, bit1 autoHeadroom; other bits must be 0
//  24  f64 preampDb
//  32  7 x { f64 frequencyHz, f64 gainDb, f64 q }
// 200  u32 CRC-32 (IEEE) over bytes 0..199
const fs = require('fs');
const path = require('path');
const Core = require('./core');

const MAGIC = 'MGEQSNP1';
const LAYOUT = 1;
const SIZE = 204;
const CRC_OFFSET = 200;
const FILE_NAME = 'carplay.snapshot';

const TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf, start, end) {
    let c = 0xFFFFFFFF;
    for (let i = start; i < end; i++) c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function encode(config, revision) {
    const v = Core.validate(config);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid snapshot revision');
    const b = Buffer.alloc(SIZE);
    b.write(MAGIC, 0, 8, 'latin1');
    b.writeUInt32LE(LAYOUT, 8);
    b.writeUInt32LE(SIZE, 12);
    b.writeUInt32LE(revision % 0x100000000, 16);
    b.writeUInt32LE((v.enabled ? 1 : 0) | (v.autoHeadroom ? 2 : 0), 20);
    b.writeDoubleLE(v.preampDb, 24);
    v.bands.forEach((band, i) => {
        const o = 32 + i * 24;
        b.writeDoubleLE(band.frequencyHz, o);
        b.writeDoubleLE(band.gainDb, o + 8);
        b.writeDoubleLE(band.q, o + 16);
    });
    b.writeUInt32LE(crc32(b, 0, CRC_OFFSET), CRC_OFFSET);
    return b;
}

function decode(b) {
    if (!Buffer.isBuffer(b) || b.length !== SIZE) throw new Error('Invalid snapshot size');
    if (b.toString('latin1', 0, 8) !== MAGIC || b.readUInt32LE(8) !== LAYOUT || b.readUInt32LE(12) !== SIZE) throw new Error('Unsupported snapshot layout');
    if (b.readUInt32LE(CRC_OFFSET) !== crc32(b, 0, CRC_OFFSET)) throw new Error('Snapshot checksum mismatch');
    const flags = b.readUInt32LE(20);
    if (flags & ~3) throw new Error('Unknown snapshot flags');
    const bands = [];
    for (let i = 0; i < 7; i++) {
        const o = 32 + i * 24;
        bands.push({ frequencyHz: b.readDoubleLE(o), gainDb: b.readDoubleLE(o + 8), q: b.readDoubleLE(o + 16) });
    }
    return { revision: b.readUInt32LE(16),
        config: Core.validate({ enabled: !!(flags & 1), autoHeadroom: !!(flags & 2), preampDb: b.readDoubleLE(24), bands }) };
}

// Atomic replace: readers see either the previous or the complete new file.
function write(dir, config, revision) {
    const file = path.join(dir, FILE_NAME), tmp = file + '.tmp', data = encode(config, revision);
    const fd = fs.openSync(tmp, 'w', 0o640);
    try {
        fs.writeFileSync(fd, data);
        fs.fchmodSync(fd, 0o640);
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    return file;
}

module.exports = { MAGIC, LAYOUT, SIZE, FILE_NAME, crc32, encode, decode, write };
