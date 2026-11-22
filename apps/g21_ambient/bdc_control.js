'use strict';

// From owner's BDC_G05.uds.json; vehicle effect remains unverified.
// Service 2E, DID DA5E (LIN 1) or E3D1 (LIN 2):
// NAD, ZUSTAND, HELLIGKEIT, HELLIGKEIT_ROT, _GRUEN, _BLAU, ZEIT.
const DID = Object.freeze({1: 0xDA5E, 2: 0xE3D1});
function integer(name, value, min, max) {
    if (!Number.isInteger(value) || value < min || value > max)
        throw new RangeError(name + ' requires ' + min + '..' + max);
    return value;
}
function encodeBdc(bus, nad, color, brightness, seconds) {
    const did = DID[bus];
    if (!did) throw new RangeError('Bus must be LIN 1 or LIN 2');
    // NAD 0 broadcast is deliberately excluded.
    integer('NAD', nad, 1, 26);
    integer('On', color.on, 0, 1);
    if (!Array.isArray(color.rgb) || color.rgb.length !== 3)
        throw new RangeError('RGB requires three channels');
    const rgb = color.rgb.map((v, i) => integer('RGB ' + i, v, 0, 254));
    integer('Brightness', brightness, 0, 100);
    // First tests limited to 10 seconds although PRG allows 254.
    integer('Test duration', seconds, 1, 10);
    return [did >> 8, did & 255, nad, color.on, color.on ? brightness : 0,
        rgb[0], rgb[1], rgb[2], seconds];
}
function discoveredTargets(rows) {
    if (!Array.isArray(rows)) return [];
    const keys = new Set(), targets = [];
    for (const row of rows) {
        if (!row || row.status !== 'Changed' || row.color !== true || !row.from || !row.to) continue;
        const before = row.from, after = row.to;
        if (!before.valid || !after.valid || before.location !== after.location ||
            before.bus !== after.bus || before.nad !== after.nad ||
            !DID[after.bus] || !Number.isInteger(after.nad) || after.nad < 1 || after.nad > 26) continue;
        if (![before, after].every(record => record.rgbw &&
            record.rgbw.slice(0, 3).length === 3 &&
            record.rgbw.slice(0, 3).every(v => Number.isInteger(v) && v >= 0 && v <= 254))) continue;
        const key = after.bus + ':' + after.nad;
        if (!keys.has(key)) { keys.add(key); targets.push({bus: after.bus, nad: after.nad, location: after.location}); }
    }
    return targets.sort((a, b) => a.bus - b.bus || a.nad - b.nad);
}
function accepted(rec, bus) {
    const did = DID[bus];
    return !!(rec && rec.status === 'Success' && rec.rx && rec.rx.length === 3 &&
        rec.rx[0] === 0x6E && rec.rx[1] === (did >> 8) && rec.rx[2] === (did & 255));
}
module.exports = {DID, encodeBdc, discoveredTargets, accepted};
