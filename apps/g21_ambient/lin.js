'use strict';

const BUSES = [0xDA5F, 0xE3D1];
const COUNT = 26, STRIDE = 10, SIZE = COUNT * STRIDE + 1;

function decode(bus, data) {
    if (!Array.isArray(data) || data.length !== SIZE || data.some(n => !Number.isInteger(n) || n < 0 || n > 255))
        return null;
    const records = [];
    let empty = 0;
    for (let nad = 1; nad <= COUNT; nad++) {
        const raw = data.slice((nad - 1) * STRIDE, nad * STRIDE);
        const [location, b, g, r, brightness, w] = raw;
        if (location === 255) { empty++; continue; }
        const valid = (location >= 1 && location <= 101) || (location >= 113 && location <= 116);
        records.push({bus, nad, location, rgbw: [r, g, b, w], brightness, valid, raw});
    }
    return {bus, records, empty, valid: records.filter(r => r.valid).length, addressingRaw: data[SIZE - 1]};
}

function compare(before, after) {
    const changes = [];
    const index = records => {
        const byKey = new Map();
        for (const record of records) {
            const key = record.bus + ':' + record.nad;
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(record);
        }
        return byKey;
    };
    const a = index(before), b = index(after);
    for (const key of new Set([...a.keys(), ...b.keys()])) {
        const older = a.get(key) || [], newer = b.get(key) || [];
        const from = older[0], to = newer[0], row = {key, from, to};
        if (older.length > 1 || newer.length > 1) row.status = 'Duplicate';
        else if ((from && !from.valid) || (to && !to.valid)) row.status = 'Invalid';
        else if (!from) row.status = 'Added';
        else if (!to) row.status = 'Missing';
        else if (from.location !== to.location) row.status = 'Replaced';
        else {
            row.color = to.rgbw.some((v, i) => v !== from.rgbw[i]);
            row.brightness = to.brightness !== from.brightness;
            row.status = row.color || row.brightness ? 'Changed' : 'Unchanged';
        }
        changes.push(row);
    }
    return changes.sort((a, b) => {
        const x = a.to || a.from, y = b.to || b.from;
        return x.bus - y.bus || x.nad - y.nad;
    });
}

module.exports = {BUSES, SIZE, decode, compare};
