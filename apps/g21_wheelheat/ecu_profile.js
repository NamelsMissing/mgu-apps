'use strict';

const { decodeSeatReadback } = require('./logic');

/**
 * Control-unit detection for Heating Comfort (read-only, UDS service 0x22).
 *
 * Why: the BDC paths 0xE432 / 0xE430 (seat heating) only exist on cars
 * WITHOUT separate seat modules. A G05 with SM2 comfort seats (SMFA 0x6D,
 * SMBF 0x6E) rejects them with NRC 0x22 although the seat heating works,
 * and ISTA labels the BDC branch "seat heating (when no seat module is
 * installed)". A G21 without seat modules uses the BDC path.
 *
 * Rules (0.5.2):
 * - A timeout is NOT proof that a control unit is missing. A seat module
 *   counts as absent only after two separate detection runs with no reply
 *   (>= ABSENT_GAP_MS apart) while the BDC answered in both. Gateway NRC 25
 *   counts as no reply only with readable BDC status for the same seat.
 *   A module that answered directly stays "present" for this BDC identity.
 * - BDC seat heating requires a readable BDC seat DID and a confirmed
 *   absent seat module. Conflicting or unresolved routes stay out of the plan.
 * - Opt-in seat-module control requires the configuration reported in issue #2.
 *   Detection never grants a write. SafeDiag checks the target live.
 *
 * Identification uses the standard BMW DID 0xF150 (three-byte SGBD index),
 * the same request BimmerLink sends. VIN (F190) and serial numbers are
 * never read or stored.
 */

const SCHEMA = 2;
const PROFILE_KEY = '_ecuProfile';
const ID_DID = 0xF150;
const ABSENT_GAP_MS = 20000;
const ABSENT_RUNS = 2;
const MAX_RAW_BYTES = 255;
const DID = { wheel: 0xD074, driver: 0xE432, passenger: 0xE430, seatCoded: 0xE434 };
// Seat modules FAS_G11 / BFS_G11 and IHKA_G05 (docs/sgbd-seat-heating.md).
const MODULE_DID = { seat: 0xD714, coded: 0xD701 };
const SEAT_MODULES = {
    driver: { id: 'SMFA', addr: 0x6D, name: 'Seat module driver', index: '0F21F0',
        sgbd: 'FAS_G11', enableSetting: 'smfaDriverAuto', seatSetting: 'seatDriver' },
    passenger: { id: 'SMBF', addr: 0x6E, name: 'Seat module passenger', index: '0F21F0',
        sgbd: 'BFS_G11', enableSetting: 'smbfPassengerAuto', seatSetting: 'seatPassenger' },
};
const isModuleHeatLevel = level => Number.isInteger(level) && level >= 1 && level <= 3;
const IHKA_DID = { status: 0xD8DB };
const D714_LENGTH = 8;
const D8DB_LENGTH = 28;

// SGBD names for the identities this app reads (from apps/light_show/sgbd-index.js,
// cross-checked with BimmerLink ecu-variants). Layouts are decoded ONLY for
// the variants in DECODES (checked against fas_g11.prg, bfs_g11.prg,
// ihka_g05.prg); every other variant is captured raw.
const SGBD = {
    0x40: { '0F2680': 'BDC_G05', '0F2050': 'BDC_G11', '0F19C0': 'BDC' },
    0x6D: { '0F21F0': 'FAS_G11', '0F2CB0': 'FAS_I20', '0F1960': 'FAS_12', '0F1220': 'FAS_01' },
    0x6E: { '0F21F0': 'BFS_G11', '0F2CB0': 'BFS_I20', '0F1960': 'BFS_12', '0F1220': 'BFS_01' },
    0x78: { '0F2830': 'IHKA_G05', '0F2838': 'IHKA_G09', '0F21B0': 'IHKA_G11' },
};
const DECODES = new Set(['FAS_G11', 'BFS_G11', 'IHKA_G05']);
const sgbdName = (addr, index) => (SGBD[addr] && SGBD[addr][index]) || null;

const CANDIDATES = [
    { id: 'BDC', addr: 0x40, name: 'Body Domain Controller' },
    SEAT_MODULES.driver,
    SEAT_MODULES.passenger,
    { id: 'IHKA', addr: 0x78, name: 'Climate control' },
];

// Channel -> BDC DID and the seat module that takes over when installed.
const CHANNELS = {
    wheel: { label: 'Steering wheel', did: DID.wheel, module: null },
    driver: { label: 'Driver seat', did: DID.driver, module: 'SMFA' },
    passenger: { label: 'Passenger seat', did: DID.passenger, module: 'SMBF' },
};
const DEVICE_KEY = { 'Steering wheel': 'wheel', 'Driver seat': 'driver', 'Passenger seat': 'passenger' };

// Seat routes that are settled (no further detection needed).
const RESOLVED_SEAT = new Set(['bdc', 'seat-module', 'unavailable', 'conflict']);

const hex = (n, w) => Number(n).toString(16).toUpperCase().padStart(w || 2, '0');
const bytes = a => Array.from(a || []).map(n => hex(n)).join(' ');

/** Reduce one raw UDS reply (or null = no answer) to a storable result. */
function classify(did, uds) {
    if (!uds || !uds.length) return { state: 'timeout' };
    const hi = did >> 8, lo = did & 255;
    const all = Array.from(uds);
    if (all[0] === 0x62 && all[1] === hi && all[2] === lo) {
        const payload = all.slice(3);
        return { state: 'ok', payload: payload.slice(0, MAX_RAW_BYTES),
            length: payload.length, truncated: payload.length > MAX_RAW_BYTES };
    }
    if (all[0] === 0x7F && all[1] === 0x22) return { state: 'nrc', nrc: all[2] };
    return { state: 'error', raw: bytes(all.slice(0, 16)) };
}

/** A positive or negative diagnostic reply. NRC 25 is handled separately
 * for seat identification because it can come from the gateway. */
const answered = r => !!r && (r.state === 'ok' || r.state === 'nrc');
const subnetNoReply = r => r.state === 'nrc' && r.nrc === 0x25;
const indexOf = r => r.state === 'ok' && r.payload.length >= 3 ?
    bytes(r.payload.slice(0, 3)).replace(/ /g, '') : null;

async function safeProbe(probe, addr, did) {
    try { return { uds: await probe(addr, did) }; }
    catch (e) { return { error: String(e && e.message || e).slice(0, 60) }; }
}
async function probeClassified(probe, addr, did) {
    const p = await safeProbe(probe, addr, did);
    return p.error ? { state: 'error', raw: p.error } : classify(did, p.uds);
}

/**
 * Probe all candidates. `probe(addr, did)` performs one physical 0x22 read
 * and resolves to the raw UDS reply, or null on timeout.
 * `meta.previous` (same BDC identity) carries presence evidence across runs.
 */
async function detect(probe, meta) {
    const m = meta || {};
    const now = Number.isFinite(m.now) ? m.now : Date.now();
    const prev = m.previous && m.previous.schema === SCHEMA ? m.previous : null;
    const ecus = {};
    const bdc = await probeClassified(probe, 0x40, ID_DID);
    const bdcIndex = indexOf(bdc);
    const sameBdc = !!prev && !!bdcIndex && prev.ecus.BDC.index === bdcIndex;
    ecus.BDC = ecuEntry(CANDIDATES[0], bdc, bdcIndex, answered(bdc) ? 'present' : 'unknown');
    const reads = {};
    if (answered(bdc)) {
        for (const key of ['wheel', 'driver', 'passenger', 'seatCoded'])
            reads[key] = compactRead(await probeClassified(probe, 0x40, DID[key]));
    }
    for (const c of CANDIDATES.slice(1)) {
        const side = c.id === 'SMFA' ? 'driver' : c.id === 'SMBF' ? 'passenger' : null;
        const moduleAnswered = r => answered(r) && !(side && subnetNoReply(r));
        const before = sameBdc ? prev.ecus[c.id] : null;
        if (before && before.presence === 'absent') {
            // Confirmed absent for this BDC identity: no further polling.
            ecus[c.id] = Object.assign({}, before);
            continue;
        }
        let r = await probeClassified(probe, c.addr, ID_DID);
        if (!moduleAnswered(r) && answered(bdc)) {
            const retry = await probeClassified(probe, c.addr, ID_DID);
            if (retry.state !== 'error') r = retry;
        }
        const index = indexOf(r);
        const bdcSeat = reads[side];
        const gatewayWithoutSeatReply = side && subnetNoReply(r) && bdcSeat &&
            bdcSeat.state === 'ok' && decodeSeatReadback(bdcSeat.payload);
        let presence, timeoutRuns = 0, lastTimeoutAt = null;
        if (moduleAnswered(r)) presence = 'present';
        else if (before && before.presence === 'present') {
            presence = 'present'; // seen before: a later timeout is transient
        } else if (answered(bdc) && (r.state === 'timeout' || gatewayWithoutSeatReply)) {
            // Count a missing module reply. Busy, offline and transport errors do not count.
            const prevRuns = before ? before.timeoutRuns || 0 : 0;
            const prevAt = before ? before.lastTimeoutAt : null;
            const counts = !Number.isFinite(prevAt) || now - prevAt >= ABSENT_GAP_MS;
            timeoutRuns = prevRuns + (counts ? 1 : 0);
            lastTimeoutAt = counts ? now : prevAt;
            presence = timeoutRuns >= ABSENT_RUNS ? 'absent' : 'unknown';
        } else {
            presence = 'unknown';
            if (before) { timeoutRuns = before.timeoutRuns || 0; lastTimeoutAt = before.lastTimeoutAt || null; }
        }
        const keepIndex = !index && before && before.presence === 'present' ? before.index : index;
        ecus[c.id] = ecuEntry(c, r, keepIndex, presence);
        ecus[c.id].timeoutRuns = timeoutRuns;
        ecus[c.id].lastTimeoutAt = lastTimeoutAt;
        if (c.id !== 'IHKA') {
            if (presence === 'present' && moduleAnswered(r)) {
                const coded = await probeClassified(probe, c.addr, MODULE_DID.coded);
                ecus[c.id].seatHeatingCoded = coded.state === 'ok' && DECODES.has(ecus[c.id].sgbd) ?
                    codedSeatHeating(coded.payload) : null;
            } else if (before && before.seatHeatingCoded !== undefined) {
                ecus[c.id].seatHeatingCoded = before.seatHeatingCoded;
            }
        }
    }
    return build(ecus, reads, now, m.appVersion);
}

function ecuEntry(c, r, index, presence) {
    return { addr: c.addr, presence, present: presence === 'present', state: r.state, index,
        sgbd: index ? sgbdName(c.addr, index) : null,
        nrc: r.nrc === undefined ? null : r.nrc };
}

// Keep stored readbacks small: state, NRC and at most 16 payload bytes.
function compactRead(r) {
    const out = { state: r.state };
    if (r.nrc !== undefined) out.nrc = r.nrc;
    if (r.payload) out.payload = r.payload.slice(0, 16);
    return out;
}

function build(ecus, reads, now, appVersion) {
    const routes = {};
    for (const [key, ch] of Object.entries(CHANNELS)) routes[key] = route(key, ch, ecus, reads);
    const wheelRead = reads.wheel;
    const complete = !!ecus.BDC && ecus.BDC.present && !!wheelRead &&
        (wheelRead.state === 'ok' || wheelRead.state === 'nrc') &&
        RESOLVED_SEAT.has(routes.driver.route) && RESOLVED_SEAT.has(routes.passenger.route);
    return { schema: SCHEMA, detectedAt: now, appVersion: appVersion || null,
        complete, ecus, reads, routes };
}

function route(key, ch, ecus, reads) {
    const r = reads[key];
    const bdcOk = !!r && r.state === 'ok';
    if (!ecus.BDC || !ecus.BDC.present)
        return { route: 'unknown', allowsAuto: key === 'wheel', reason: 'BDC 0x40 did not answer' };
    if (key === 'wheel') {
        if (bdcOk) return { route: 'bdc', allowsAuto: true, reason: 'BDC 0xD074 readable' };
        if (r && r.state === 'nrc' && r.nrc === 0x31)
            return { route: 'unavailable', allowsAuto: false, reason: 'BDC 0xD074 not supported (NRC 31)' };
        return { route: 'unknown', allowsAuto: true,
            reason: 'BDC 0xD074 ' + describe(r) + '; runtime readback decides' };
    }
    const mod = ecus[ch.module];
    const tag = ch.module + ' 0x' + hex(mod.addr);
    const did = 'BDC 0x' + hex(ch.did, 4);
    if (mod.presence === 'present' && bdcOk)
        return { route: 'conflict', allowsAuto: false, module: ch.module, addr: mod.addr,
            reason: did + ' readable AND ' + tag + ' installed; architecture not confirmed' };
    if (mod.presence === 'present')
        return { route: 'seat-module', allowsAuto: false, module: ch.module, addr: mod.addr,
            reason: tag + ' installed; BDC seat path not used (' + did + ' ' + describe(r) + ')' };
    if (mod.presence === 'unknown')
        return { route: 'unresolved', allowsAuto: false, module: ch.module, addr: mod.addr,
            reason: tag + ' not identified yet (no reply is not proof of absence); ' + did + ' ' + describe(r) };
    // Seat module confirmed absent.
    if (bdcOk) return { route: 'bdc', allowsAuto: true, reason: did + ' readable; ' + tag + ' absent' };
    if (r && r.state === 'nrc' && r.nrc === 0x31)
        return { route: 'unavailable', allowsAuto: false, reason: did + ' not supported (NRC 31); ' + tag + ' absent' };
    return { route: 'unresolved', allowsAuto: false,
        reason: did + ' ' + describe(r) + '; ' + tag + ' absent; BDC path not verified' };
}

function describe(r) {
    if (!r) return 'not read';
    if (r.state === 'ok') return 'readable';
    if (r.state === 'nrc') return 'NRC ' + hex(r.nrc);
    return r.state === 'timeout' ? 'no reply' : 'read error';
}

/** FAS_G11/BFS_G11 RES_0xD701_D byte 15: 0 not coded, 1/2 one/two circuits. */
function codedSeatHeating(payload) {
    const v = Array.isArray(payload) && payload.length > 15 ? payload[15] : null;
    return v === 0 ? 'not coded' : v === 1 ? '1-circuit' : v === 2 ? '2-circuit' : null;
}

/**
 * FAS_G11/BFS_G11 RES_0xD714_D (8 bytes): level 0..3 (255 invalid),
 * cushion/back temperature int8 -40..127 (-128 invalid), PWM 0..100 (255 invalid).
 * Returns null if the level itself is unusable. `complete` is true only
 * for a full-length reply whose fields are all valid.
 */
function decodeModuleSeat(payload) {
    if (!Array.isArray(payload) || payload.length < 1 || ![0, 1, 2, 3].includes(payload[0])) return null;
    const issues = [];
    const temp = (n, name) => {
        if (n === undefined) { issues.push(name + ' missing'); return null; }
        const v = n > 127 ? n - 256 : n;
        if (v === -128) { issues.push(name + ' invalid'); return null; }
        if (v < -40) { issues.push(name + ' implausible'); return null; }
        return v;
    };
    const pwm = (n, name) => {
        if (n === undefined) { issues.push(name + ' missing'); return null; }
        if (n === 255) { issues.push(name + ' invalid'); return null; }
        if (n > 100) { issues.push(name + ' implausible'); return null; }
        return n;
    };
    const out = { level: payload[0], cushionC: temp(payload[1], 'cushion temp'),
        cushionPwm: pwm(payload[2], 'cushion PWM'), backC: temp(payload[3], 'back temp'),
        backPwm: pwm(payload[4], 'back PWM') };
    if (payload.length < D714_LENGTH) issues.push('short reply ' + payload.length + '/' + D714_LENGTH + ' bytes');
    out.complete = issues.length === 0;
    out.issues = issues;
    return out;
}

/** IHKA_G05 RES_0xD8DB_D (28 bytes): bytes 19/20 front left/right level. */
function decodeIhkaSeats(payload) {
    if (!Array.isArray(payload) || payload.length < 21) return null;
    const lvl = n => [0, 1, 2, 3].includes(n) ? n : null;
    const issues = [];
    if (payload.length < D8DB_LENGTH) issues.push('short reply ' + payload.length + '/' + D8DB_LENGTH + ' bytes');
    const out = { left: lvl(payload[19]), right: lvl(payload[20]) };
    if (out.left === null) issues.push('left level invalid (' + payload[19] + ')');
    if (out.right === null) issues.push('right level invalid (' + payload[20] + ')');
    if (out.left === null && out.right === null) return null;
    out.complete = issues.length === 0;
    out.issues = issues;
    return out;
}

/** One read-only measurement with the complete UDS answer. */
async function measure(probe, ecu, did, decoder) {
    const at = Date.now();
    const p = await safeProbe(probe, ecu.addr, did);
    const uds = p.uds ? Array.from(p.uds) : null;
    const r = p.error ? { state: 'error' } : classify(did, uds);
    const known = DECODES.has(ecu.sgbd);
    const decoded = r.state === 'ok' && known ? decoder(r.payload) : null;
    const validity = r.state !== 'ok' ? r.state :
        !known ? 'raw-only (layout unknown)' :
        !decoded ? 'invalid' : decoded.complete ? 'valid' : 'partial';
    return { at, addr: ecu.addr, did, index: ecu.index || null, sgbd: ecu.sgbd || null,
        state: r.state, nrc: r.nrc === undefined ? null : r.nrc,
        raw: uds ? bytes(uds.slice(0, MAX_RAW_BYTES + 3)) : (p.error || ''),
        length: r.length === undefined ? null : r.length, truncated: !!r.truncated,
        decoded, validity };
}

/**
 * Read-only diagnostic snapshot of the seat sources: D714 of each installed
 * seat module and ONE shared D8DB of an installed IHKA (any variant; raw if
 * the layout is unknown).
 */
async function readSeatSources(probe, profile) {
    const out = { at: Date.now(), SMFA: null, SMBF: null, IHKA: null };
    if (!profile) return out;
    for (const id of ['SMFA', 'SMBF']) {
        const e = profile.ecus[id];
        if (e && e.presence === 'present') out[id] = await measure(probe, e, MODULE_DID.seat, decodeModuleSeat);
    }
    const ih = profile.ecus.IHKA;
    if (ih && ih.presence === 'present') out.IHKA = await measure(probe, ih, IHKA_DID.status, decodeIhkaSeats);
    out.comparison = compareSources(out);
    return out;
}

const levelOf = m => m && m.state === 'ok' && m.decoded && m.decoded.level !== undefined ? m.decoded.level : null;

/**
 * Compare seat-module levels with IHKA left/right WITHOUT assuming which side
 * the driver sits on. Returns a short verdict string.
 */
function compareSources(s) {
    const drv = levelOf(s.SMFA), pas = levelOf(s.SMBF);
    const ih = s.IHKA && s.IHKA.state === 'ok' && s.IHKA.decoded ? s.IHKA.decoded : null;
    if (!ih || (drv === null && pas === null)) return { verdict: 'not comparable', detail: 'need valid seat-module and IHKA levels' };
    const L = ih.left, R = ih.right;
    const fits = (a, b) => (drv === null || drv === a) && (pas === null || pas === b);
    const lhd = fits(L, R), rhd = fits(R, L);
    if (lhd && rhd) return { verdict: 'consistent', detail: 'levels match IHKA' };
    if (lhd) return { verdict: 'consistent', detail: 'matches IHKA if driver sits left' };
    if (rhd) return { verdict: 'consistent', detail: 'matches IHKA if driver sits right' };
    return { verdict: 'differs', detail: 'SMFA=' + fmt(drv) + ' SMBF=' + fmt(pas) + ' IHKA L=' + fmt(L) + ' R=' + fmt(R) };
}
const fmt = v => v === null || v === undefined ? '?' : String(v);

/** Compact single-line text of one measurement for the log. */
function measurementLine(name, m) {
    if (!m) return name + ' not read';
    const t = new Date(m.at).toISOString().slice(11, 19);
    const head = t + ' ' + name + ' 0x' + hex(m.addr) + ' ' + (m.sgbd || ('idx ' + (m.index || '?'))) +
        ' 22 ' + hex(m.did >> 8) + ' ' + hex(m.did & 255) + ' -> ';
    const body = m.state === 'ok' ? m.raw + (m.truncated ? ' [TRUNCATED, ' + m.length + ' bytes]' : '') :
        m.state === 'nrc' ? m.raw + ' (NRC 0x' + hex(m.nrc) + ')' :
        m.state === 'timeout' ? 'NO REPLY (timeout)' : 'ERROR ' + m.raw;
    let tail = ' [' + m.validity + ']';
    if (m.decoded && m.decoded.level !== undefined) tail += ' level=' + m.decoded.level;
    if (m.decoded && m.decoded.left !== undefined) tail += ' L=' + fmt(m.decoded.left) + ' R=' + fmt(m.decoded.right);
    if (m.decoded && m.decoded.issues && m.decoded.issues.length) tail += ' (' + m.decoded.issues.join(', ') + ')';
    return head + body + tail;
}

/** Parse the stored settings value; migrate 0.5.1 (schema 1) profiles. */
function load(raw) {
    if (typeof raw !== 'string' || !raw) return null;
    let p;
    try { p = JSON.parse(raw); } catch (_) { return null; }
    if (!p || !p.ecus || !p.ecus.BDC || !p.routes) return null;
    if (p.schema === 1) p = migrateV1(p);
    if (p.schema !== SCHEMA) return null;
    for (const key of Object.keys(CHANNELS)) if (!p.routes[key]) return null;
    // Old profiles cached gateway NRC 25 as a seat-module response forever.
    const ecus = Object.assign({}, p.ecus), routes = Object.assign({}, p.routes);
    let needsDetection = false;
    for (const [side, { id }] of Object.entries(SEAT_MODULES)) {
        const ecu = ecus[id];
        if (!ecu || ecu.presence !== 'present' || ecu.index || !subnetNoReply(ecu)) continue;
        ecus[id] = Object.assign({}, ecu, { presence: 'unknown', present: false, timeoutRuns: 0, lastTimeoutAt: null });
        routes[side] = route(side, CHANNELS[side], ecus, p.reads || {});
        needsDetection = true;
    }
    if (needsDetection) return Object.assign({}, p, { ecus, routes, complete: false });
    return p;
}

/**
 * 0.5.1 treated a silent seat module as missing and kept the channel on the
 * BDC. Rebuild the routes with the 0.5.2 rules: a module that answered stays
 * present; a silent one counts as ONE timeout run only, so it must be
 * confirmed again before a seat can use the BDC. Always re-detect.
 */
function migrateV1(p) {
    const ecus = {};
    for (const c of CANDIDATES) {
        const e = p.ecus[c.id] || {};
        const presence = c.id === 'BDC' ? (e.present ? 'present' : 'unknown') :
            e.present ? 'present' : 'unknown';
        ecus[c.id] = { addr: c.addr, presence, present: presence === 'present', state: e.state || 'timeout',
            index: e.index || null, sgbd: e.index ? sgbdName(c.addr, e.index) : null,
            nrc: e.nrc === undefined ? null : e.nrc,
            timeoutRuns: !e.present && e.state === 'timeout' && p.ecus.BDC.present ? 1 : 0,
            lastTimeoutAt: !e.present && e.state === 'timeout' && p.ecus.BDC.present ? p.detectedAt : null };
        if (c.id !== 'BDC' && c.id !== 'IHKA' && e.seatHeatingCoded !== undefined)
            ecus[c.id].seatHeatingCoded = e.seatHeatingCoded;
    }
    const reads = {};
    for (const [key, r] of Object.entries(p.reads || {})) reads[key] = compactRead(r || { state: 'timeout' });
    const out = build(ecus, reads, p.detectedAt, p.appVersion);
    out.complete = false;
    out.migratedFrom = 1;
    return out;
}

const serialize = profile => JSON.stringify(profile);

/**
 * Decide at startup whether the stored profile can be reused.
 * bdcIndex: fresh 22 F150 result of the BDC (e.g. '0F2680'), or null.
 */
function reuseDecision(saved, bdcIndex) {
    if (!saved) return { reuse: false, merge: false, reason: 'no stored profile' };
    if (bdcIndex === null || bdcIndex === undefined)
        return { reuse: true, verified: false, merge: false, reason: 'BDC not reachable; stored profile kept, seats stay as stored' };
    if (saved.ecus.BDC.index !== bdcIndex)
        return { reuse: false, merge: false, reason: 'BDC identity changed (' + saved.ecus.BDC.index + ' -> ' + bdcIndex + ')' };
    if (!saved.complete)
        return { reuse: false, merge: true, reason: 'stored profile has unresolved routes' };
    return { reuse: true, verified: true, merge: false, reason: 'BDC identity matches stored profile' };
}

/** True if automatic heating may use this device under the profile. */
function allows(profile, device) {
    const key = DEVICE_KEY[device] || device;
    if (key === 'wheel') {
        const r = profile && profile.routes.wheel;
        return !r || r.allowsAuto !== false;
    }
    const r = profile && profile.routes[key];
    return !!r && r.allowsAuto === true && r.route === 'bdc';
}

/** Eligibility for this seat's control-unit layout and opt-in setting. */
function allowsSeatModule(profile, cfg, side) {
    const module = SEAT_MODULES[side];
    if (!profile || !module || cfg[module.enableSetting] !== true || !isModuleHeatLevel(cfg.seatLevel))
        return false;
    const ecu = profile.ecus[module.id], bdc = profile.ecus.BDC;
    const read = profile.reads && profile.reads[side];
    return !!bdc && bdc.sgbd === 'BDC_G05' && !!ecu &&
        ecu.presence === 'present' && ecu.index === module.index && ecu.addr === module.addr &&
        ecu.seatHeatingCoded === '2-circuit' && profile.routes[side].route === 'seat-module' &&
        !!read && read.state === 'nrc' && read.nrc === 0x22;
}

/** Remove channels that may not be automated. Returns notes. */
function applyRoutes(cfg, profile) {
    const skipped = [];
    const map = { wheel: 'wheelAuto', driver: 'seatDriver', passenger: 'seatPassenger' };
    for (const [key, setting] of Object.entries(map)) {
        if (!cfg[setting] || allows(profile, key)) continue;
        if ((cfg.seatModuleRoutes && cfg.seatModuleRoutes[key]) ||
            (cfg.pendingSeatRoutes && cfg.pendingSeatRoutes[key])) continue;
        cfg[setting] = false;
        const r = profile && profile.routes[key];
        skipped.push(CHANNELS[key].label + ': ' + (r ? r.route + ' - ' + r.reason : 'control units not detected yet'));
    }
    return skipped;
}

/** Should BDC 0xE432/0xE430 be read in the normal diagnostics refresh? */
function readsBdcSeat(profile, key) {
    const r = profile && profile.routes[key];
    return !r || !['seat-module', 'unavailable'].includes(r.route);
}

/** Short user-facing route text for one channel. */
function routeLabel(profile, key) {
    const r = profile && profile.routes[key];
    if (!r) return 'not detected yet';
    switch (r.route) {
        case 'bdc': return 'BDC';
        case 'seat-module': return 'Seat module ' + r.module + ' (read-only)';
        case 'conflict': return 'BDC and ' + r.module + ' both answer (unconfirmed)';
        case 'unresolved': return 'Route not verified yet';
        case 'unavailable': return 'Not available';
        default: return key === 'wheel' ? 'BDC (runtime check)' : 'Unknown';
    }
}

/** One-line summary for the log and Diagnostics tab. */
function summary(profile) {
    if (!profile) return 'no control-unit profile';
    const ecu = CANDIDATES.map(c => {
        const e = profile.ecus[c.id];
        if (!e) return c.id + ' ?';
        if (e.presence === 'present') return c.id + ' ' + (e.sgbd || e.index || ('NRC ' + hex(e.nrc)));
        return c.id + ' ' + (e.presence === 'absent' ? '-' : '?');
    }).join(' | ');
    return ecu + ' || wheel=' + profile.routes.wheel.route +
        ' driver=' + profile.routes.driver.route +
        ' passenger=' + profile.routes.passenger.route +
        (profile.complete ? '' : ' (incomplete)');
}

module.exports = { SCHEMA, PROFILE_KEY, ID_DID, DID, MODULE_DID, D714_LENGTH, SEAT_MODULES, isModuleHeatLevel,
    IHKA_DID, SGBD, CANDIDATES, CHANNELS, DEVICE_KEY,
    ABSENT_GAP_MS, ABSENT_RUNS, sgbdName, codedSeatHeating, decodeModuleSeat, decodeIhkaSeats,
    readSeatSources, compareSources, measurementLine, classify, detect, build, load, serialize,
    reuseDecision, allows, allowsSeatModule, applyRoutes, readsBdcSeat, routeLabel, summary };
