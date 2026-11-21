'use strict';
// Read-only vehicle analysis: which control units answer, which of them drive exterior
// lights, and which control route Light Show may use on this particular car.
// Only identity and vehicle order are read; no session change or lamp request.
const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const F = require('./flm-control');
const { INDEX, ECU } = require('./sgbd-index');
const VehicleOrder = require('./vehicle-order');
const R = require('./rlm-control');

const FILE = 'light-show-vehicle.json';
const hex2 = (n) => ('0' + n.toString(16)).slice(-2).toUpperCase();

// Units at these addresses can carry exterior lighting on F/G-series cars.
// (BimmerLight's module set for E/F/G cars, reduced to addresses an MGU car can have.)
const LIGHT_ROLES = Object.freeze({
    0x10: 'Gateway (ZGW / BCP): vehicle order, identity of the car',
    0x17: 'Rear light module 1 left', 0x1A: 'Rear light module 1 right',
    0x1C: 'Rear light module 2 left', 0x1E: 'Rear light module 2 right',
    0x40: 'Body controller: tail, brake, indicators, fog, reverse, plate',
    0x43: 'Headlamp module left', 0x44: 'Headlamp module right',
    0x72: 'Footwell / rear module (older body)',
});
const LIGHT_ADDRESSES = Object.keys(LIGHT_ROLES).map(Number);
// Units Light Show recognises but cannot drive yet (no verified telegrams).
const DETECT_ONLY = Object.freeze([0x10, 0x17, 0x1A, 0x1C, 0x1E, 0x72]);

function unitName(address, index) {
    const key = hex2(address) + ' ' + index;
    return index && Object.prototype.hasOwnProperty.call(INDEX, key) ? INDEX[key] : null;
}

function hasLightIdentity(ids) {
    return LIGHT_ADDRESSES.some((address) => address !== 0x10 && ids.get(address));
}

/**
 * Turn identities (Map address -> index|null) into a profile:
 * { at, method, units[], bdc, flm:{left,right}, routes:{flm:{left,right}, fn, out}, summary }
 */
function profile(ids, method, now) {
    const units = [];
    ids.forEach((index, address) => {
        const name = unitName(address, index);
        units.push({ address, addressHex: '0x' + hex2(address), index: index || null,
            name: name || null, role: ECU[address] || null, light: LIGHT_ROLES[address] || null });
    });
    units.sort((a, b) => a.address - b.address);
    const at = (a) => units.find((u) => u.address === a) || null;
    const bdcUnit = at(0x40);
    const bv = bdcUnit && P.bodyVariant(bdcUnit.index);
    const bdc = {
        present: !!bdcUnit, index: bdcUnit && bdcUnit.index, name: bdcUnit && bdcUnit.name,
        support: bv ? bv.support : bdcUnit ? 'unsupported' : 'absent',
        functions: bv ? bv.functions.slice() : [], outputs: !!(bv && bv.outputs),
    };
    const bodyOk = !!bv;
    const flm = {};
    for (const side of ['left', 'right']) {
        const u = at(F.MODULES[side].address);
        const v = u && u.index ? F.variant(side, u.index) : null;
        flm[side] = { present: !!u, address: F.MODULES[side].address, index: u && u.index,
            name: v ? v.name : u && u.name, support: !u ? 'absent' : v ? v.support : 'unsupported' };
    }
    const flmRoute = (s) => s === 'absent' || s === 'unsupported' || bodyOk ? s : 'blocked';
    const rlm = Object.keys(R.MODULES).map(Number).map((address) => {
        const u = at(address), v = u && u.index ? R.variant(address, u.index) : null;
        return { address, slot: R.MODULES[address].slot, side: R.MODULES[address].side, index: u && u.index,
            name: v ? v.name : u && u.name, kinds: v ? v.kinds : [],
            support: !u ? 'absent' : !v ? 'unsupported' : bodyOk ? 'prg' : 'blocked' };
    }).filter((r) => r.support !== 'absent');
    const routes = {
        // FLM_KANAL also needs the BDC as the app's gateway check before any session.
        flm: { left: flmRoute(flm.left.support), right: flmRoute(flm.right.support) },
        fn: bodyOk ? bv.support : 'unsupported',
        out: bodyOk && bv.outputs ? 'experimental' : 'unsupported',
        rlm: rlm.map((r) => ({ address: r.address, support: r.support, kinds: r.kinds })),
    };
    const lightUnits = units.filter((u) => u.light);
    lightUnits.forEach((u) => {
        u.support = u.address === 0x40 ? bdc.support : u.address === 0x43 ? routes.flm.left : u.address === 0x44 ? routes.flm.right
            : u.address === 0x10 ? 'gateway' : R.MODULES[u.address] ? (rlm.find((r) => r.address === u.address) || {}).support || 'unsupported'
            : DETECT_ONLY.indexOf(u.address) >= 0 && u.name ? 'detected' : 'unsupported';
        u.supportText = supportText(u.support);
    });
    const rear = units.filter((u) => [0x17, 0x1A, 0x1C, 0x1E].indexOf(u.address) >= 0 && u.name);
    return { at: new Date(now || Date.now()).toISOString(), method, units, bdc, flm, rlm, routes, rear: rear.map((u) => u.name),
        summary: units.length + ' control units, ' + lightUnits.filter((u) => u.address !== 0x10).length + ' with exterior lighting' };
}

/**
 * Read all units and recheck missing light addresses individually. If a known module
 * doesn't answer, keep its last identity for display and require a fresh one before control.
 */
async function scan(link, log, progress, { previous, check = () => {} } = {}) {
    const say = progress || (() => {});
    let ids = new Map(), method = 'functional 22 F1 50', note = null;
    check();
    say('Scanning for modules...');
    try { ids = await link.scan(); }
    catch (e) { note = 'Functional scan failed: ' + (e.message || e); method = 'physical 22 F1 50'; if (log) log.warn('Light Show scan: ' + note); }
    const missing = LIGHT_ADDRESSES.filter((address) => !ids.get(address));
    if (missing.length) method += ' + individual checks';
    async function checkAddress(address) {
        check();
        say('Checking 0x' + hex2(address) + '...');
        try {
            const index = await link.readIdentity(address);
            if (index) ids.set(address, index);
        } catch (e) {
            if (log) log.info('Light Show scan 0x' + hex2(address) + ': ' + (e.message || e));
        }
    }
    for (const address of missing) await checkAddress(address);
    const known = new Map((previous ? previous.units : []).filter((u) => u.light && u.index).map((u) => [u.address, u.index]));
    for (const address of missing) {
        if (!ids.get(address) && (address === P.ADDRESS || known.has(address))) await checkAddress(address);
    }
    check();
    if (!hasLightIdentity(ids))
        throw new Error('No exterior light module returned an identity. Scan again while parked.');
    const gatewaySeen = !!ids.get(0x10);
    const unconfirmed = [];
    known.forEach((index, address) => {
        if (ids.get(address)) return;
        ids.set(address, index);
        unconfirmed.push(address);
    });
    const result = profile(ids, method);
    result.unconfirmed = unconfirmed;
    if (note) result.note = note;
    if (gatewaySeen) {
        say('Reading the vehicle order...');
        try { result.order = VehicleOrder.decode(await link.readVehicleOrder()); }
        catch (e) { result.orderError = String(e.message || e); }
    }
    check();
    result.units.forEach((u) => { if (unconfirmed.indexOf(u.address) >= 0) u.supportText = 'Last seen'; });
    return result;
}

/**
 * First-start scan: run by itself when there is no saved result yet, the car is parked
 * (guard clear), the diagnostic link is up, nothing else runs and no release is pending.
 * At most 3 tries per app run, 60 s apart. state: {hasProfile, guardOk, linkReady, busy,
 * recoveryPending, tries, lastTryAt, now}
 */
const AUTO_TRIES = 3, AUTO_GAP_MS = 60000;
function autoScanDue(st) {
    if (st.hasProfile || !st.guardOk || !st.linkReady || st.busy || st.recoveryPending) return false;
    if (st.tries >= AUTO_TRIES) return false;
    return !st.lastTryAt || st.now - st.lastTryAt >= AUTO_GAP_MS;
}

function load(dir) {
    try {
        const v = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8'));
        if (!v || !Array.isArray(v.units)) return null;
        const ids = new Map();
        for (const u of v.units) {
            if (u && Number.isInteger(u.address) && u.address >= 0 && u.address <= 0xFF && /^[0-9A-F]{6}$/.test(u.index))
                ids.set(u.address, u.index);
        }
        if (!hasLightIdentity(ids)) return null;
        const saved = profile(ids, typeof v.method === 'string' ? v.method : 'saved scan', Date.parse(v.at));
        if (v.order && Array.isArray(v.order.hints) && Array.isArray(v.order.codes)) saved.order = v.order;
        if (typeof v.orderError === 'string') saved.orderError = v.orderError;
        saved.unconfirmed = Array.isArray(v.unconfirmed) ? v.unconfirmed.filter((address) => ids.has(address)) : [];
        saved.units.forEach((u) => { if (saved.unconfirmed.indexOf(u.address) >= 0) u.supportText = 'Last seen'; });
        return saved;
    } catch (_) { return null; }
}
function save(dir, value) {
    const file = path.join(dir, FILE);
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 1));
    fs.renameSync(file + '.tmp', file);
}

/** Short human text for a support level. */
function supportText(s) {
    return { verified: 'Supported', experimental: 'Experimental', unsupported: 'Not supported',
        absent: 'No identity', blocked: 'Needs a supported BDC', prg: 'From BMW data', detected: 'Found, not mapped yet', gateway: 'Gateway' }[s] || 'Unknown';
}

module.exports = { autoScanDue, AUTO_TRIES, scan, profile, load, save, supportText, unitName, LIGHT_ROLES, DETECT_ONLY, FILE };
