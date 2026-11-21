'use strict';
// Light Show 0.4 (beta): vehicle scan, lamp catalog, effects, runner safety, phone server.
// PC only, no car: the diagnostic link is a fake that records every request.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const APP = path.join(__dirname, '../apps/light_show');
const Scan = require(APP + '/ecu-scan');
const Lamps = require(APP + '/lamps');
const Effects = require(APP + '/effects');
const { Names, Observations, migrateKey } = require(APP + '/store');
const Journal = require(APP + '/journal');
const Runner = require(APP + '/runner');
const F = require(APP + '/flm-control');
const Guard = require(APP + '/guard');
const Link = require(APP + '/link');
const { Diag } = require(APP + '/tasu');
const Car3D = require(APP + '/car3d');
const { WebServer, privateAddress } = require(APP + '/web-server');
const page = require(APP + '/web-page');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'light-show-'));
const ids = (pairs) => new Map(pairs);

/* ---------- vehicle scan ---------- */
{
    const g21 = Scan.profile(ids([[0x40, '0F2680'], [0x43, '0F26C0'], [0x44, '0F26D0'], [0x60, null]]), 'test');
    assert.deepStrictEqual(g21.routes, { flm: { left: 'verified', right: 'verified' }, fn: 'verified', out: 'experimental', rlm: [] });
    assert.strictEqual(g21.bdc.name, 'BDC_G05');
    assert.strictEqual(g21.flm.left.name, 'FLM02_L');
    const laser = Scan.profile(ids([[0x40, '0F2680'], [0x43, '0F26C8'], [0x44, '0F26D8']]), 'test');
    assert.deepStrictEqual(laser.routes.flm, { left: 'prg', right: 'prg' }, 'FLM02X uses the same FLM_KANAL routine (PRG)');
    const g11 = Scan.profile(ids([[0x40, '0F2050'], [0x43, '0F26C0']]), 'test');
    assert.strictEqual(g11.routes.fn, 'prg'); assert.strictEqual(g11.routes.out, 'unsupported');
    assert.ok(g11.bdc.functions.indexOf('grille') >= 0 && g21.bdc.functions.indexOf('grille') < 0);
    const other = Scan.profile(ids([[0x40, '0F1234'], [0x43, '0F26C0']]), 'test');
    assert.strictEqual(other.bdc.support, 'unsupported');
    assert.strictEqual(other.routes.flm.left, 'blocked', 'no FLM route without BDC_G05');
    assert.strictEqual(other.routes.flm.right, 'absent');
    assert.strictEqual(other.routes.fn, 'unsupported');
    const due = (o) => Scan.autoScanDue(Object.assign({ hasProfile: false, guardOk: true, linkReady: true, busy: false,
        recoveryPending: false, tries: 0, lastTryAt: 0, now: 100000 }, o));
    assert.ok(due({}), 'first start, parked: scan');
    assert.ok(!due({ hasProfile: true }), 'saved result: no automatic scan');
    assert.ok(!due({ guardOk: false }) && !due({ linkReady: false }) && !due({ busy: true }) && !due({ recoveryPending: true }));
    assert.ok(!due({ tries: 1, lastTryAt: 90000 }) && due({ tries: 1, lastTryAt: 30000 }), '60 s between tries');
    assert.ok(!due({ tries: 3, lastTryAt: 1 }), 'at most 3 tries');
    console.log('ok: scan profiles (G21 verified, FLM02X and BDC_G11 from PRG, unknown BDC blocked)');
}

/* ---------- BimmerLight-style detection: rear modules, gateway, vehicle order ---------- */
{
    const VO = require(APP + '/vehicle-order');
    const p = Scan.profile(ids([[0x10, '0F1310'], [0x17, '0F2C10'], [0x1A, '0F2C20'], [0x40, '0F2680'], [0x43, '0F26CC'], [0x44, '0F26DC']]), 't');
    assert.deepStrictEqual(p.rear, ['RLM2_1L', 'RLM2_1R']);
    assert.strictEqual(p.units.find((u) => u.address === 0x17).supportText, 'From BMW data');
    assert.strictEqual(p.units.find((u) => u.address === 0x10).support, 'gateway');
    const fa = VO.decode(VO.encode('6L31G0210321066 EHATA080', ['494', '5AC', '5AZ', '552']));
    assert.deepStrictEqual(fa.codes, ['494', '5AC', '5AZ', '552']);
    assert.deepStrictEqual(fa.blocks.slice(0, 3), ['6L31', 'G021', '0321']);
    assert.ok(fa.hints.some((h) => /Laserlight/.test(h)));
    assert.throws(() => VO.decode([0x7F, 0x22, 0x31]), /No vehicle order/);
    const Link = require(APP + '/link');
    const l = new Link({}, { warn() {}, info() {} });
    l.available = true; l.diag.physical = () => Promise.resolve([0x62, 0xF1, 0x50, 0x0F, 0x2C, 0x10]);
    l.readIdentity(0x17).then((x) => assert.strictEqual(x, '0F2C10'));
    assert.rejects(l.request(0x2F, [0x45, 0x01, 0x03, 0x01, 0x01], false, 0x17), /not allowed/);
    assert.rejects(l.request(0x10, [0x03], false, 0x10), /Only identity/);
    assert.rejects(l.request(0x2E, [0xA8, 0x3B, 0x02, 0x01], false, 0x17), /not identified/, 'no light telegram before identity');
    const R = require(APP + '/rlm-control');
    assert.deepStrictEqual(R.telegram('fn', 2, 1500), [0xA8, 0x3B, 0x02, 0x02]);
    assert.deepStrictEqual(R.telegram('fn', 2, 0), [0xA8, 0x3B, 0x02, 0x00]);
    assert.deepStrictEqual(R.telegram('ch', 3, 500, 40), [0xD6, 0xDA, 0x03, 0x01, 0x28]);
    assert.throws(() => R.telegram('fn', 0x07, 500), /Unknown/);
    assert.ok(!R.permitted([0xA8, 0x3B, 0x02, 0xFF]), 'never permanent on');
    assert.deepStrictEqual(R.groupStart(1, 800, 100), [0x01, 0xA5, 0x56, 0x60, 0x64, 0x00, 0x64, 0x01], 'group 1, 100 %, 100 mA, 1 s');
    assert.deepStrictEqual(R.groupStart(0, 2500, 60).slice(3, 4), [0x70], 'all channels');
    assert.ok(R.permittedRoutine(R.groupStop()) && R.permittedRoutine(R.groupStart(16, 500, 40)));
    assert.ok(!R.permittedRoutine([0x01, 0xA5, 0x56, 0x05, 0x64, 0x00, 0x64, 0x01]), 'single RLM2 channels are not used');
    assert.ok(!R.permittedRoutine([0x01, 0xA5, 0x56, 0x60, 0x64, 0x01, 0x2C, 0x01]), 'only 100 mA');
    const F2 = require(APP + '/flm-control');
    assert.deepStrictEqual(F2.start(0, 60, 1), [0x01, 0xA5, 0x4B, 0x00, 0x3C, 0x01], 'FLM channel 0 = all LEDs');
    const P = require(APP + '/protocol');
    assert.deepStrictEqual(P.timedControl('brake', 500), [0xD5, 0x42, 0x00, 0x0C, 0x00, 0x32]);
    console.log('ok: gateway, rear light modules and vehicle order are read; light telegrams match the PRGs');
}

/* ---------- catalog ---------- */
{
    const g21 = Scan.profile(ids([[0x40, '0F2680'], [0x43, '0F26C0'], [0x44, '0F26D0']]), 'test');
    const all = Lamps.catalog(g21, null, {});
    assert.strictEqual(all.filter((l) => l.route === 'flm').length, 32, '15 channels + all per side');
    assert.ok(all.some((l) => l.id === 'flm:left:0' && /all LEDs/.test(l.label)));
    assert.strictEqual(all.filter((l) => l.route === 'fn').length, 19, 'all exterior D542 functions of BDC_G05');
    assert.ok(all.some((l) => l.id === 'fn:indLeft' && l.side === 'left'));
    assert.ok(all.filter((l) => l.route === 'out').length >= 30, 'all BDC exterior outputs listed');
    assert.ok(all.every((l) => l.available));
    assert.ok(all.some((l) => l.group === 'rear' && l.color === 'red'));
    all.forEach((l) => assert.deepStrictEqual(Lamps.parse(l.id) && Lamps.parse(l.id).route, l.route));
    const laser = Scan.profile(ids([[0x40, '0F2680'], [0x43, '0F26C8'], [0x44, '0F26D8']]), 'test');
    const lf = Lamps.catalog(laser, null, {}).filter((l) => l.route === 'flm');
    assert.strictEqual(lf.length, 36, 'FLM02X has 17 channels + all per side'); assert.ok(lf.every((l) => l.available));
    const rear = Scan.profile(ids([[0x40, '0F2680'], [0x17, '0F2C10'], [0x1A, '0F23D0']]), 'test');
    const rl = Lamps.catalog(rear, null, {}).filter((l) => l.route === 'rlm');
    assert.strictEqual(rl.filter((l) => l.kind === 'fn').length, 9, 'RLM2: 9 light functions');
    assert.strictEqual(rl.filter((l) => l.kind === 'grp').length, 17, 'RLM2: 16 segment groups + all');
    assert.strictEqual(rl.filter((l) => l.kind === 'ch').length, 8, 'RLM_1: 8 channels');
    rl.forEach((l) => assert.deepStrictEqual(Lamps.parse(l.id).route, 'rlm'));
    assert.ok(Lamps.catalog(null, null, {}).every((l) => !l.available), 'nothing before the first scan');
    assert.strictEqual(Lamps.parse('flm:left:18'), null);
    assert.strictEqual(Lamps.parse('rlm:18:f2'), null);
    assert.strictEqual(Lamps.parse('out:999'), null);
    console.log('ok: lamp catalog follows the scan and the experimental switch');
}

/* ---------- effects ---------- */
const g21Lamps = Lamps.catalog(Scan.profile(ids([[0x40, '0F2680'], [0x43, '0F26C0'], [0x44, '0F26D0']]), 't'), null, {});
const base = { stepMs: 500, gapMs: 100, cycles: 2, pwm: 60 };
{
    for (const e of Effects.EFFECTS) {
        const sel = ['flm:left:1', 'flm:right:1', 'flm:left:5', 'flm:right:5', 'out:24', 'out:25'];
        const p = Effects.plan(sel, g21Lamps, Object.assign({ effect: e.id }, base));
        const byId = {}; g21Lamps.forEach((l) => { byId[l.id] = l; });
        p.steps.forEach((s) => {
            const sides = s.on.map((id) => byId[id]).filter((l) => l.route === 'flm').map((l) => l.side);
            assert.strictEqual(new Set(sides).size, sides.length, e.id + ': one channel per headlamp module per step');
        });
        assert.ok(p.estimateMs > 0 && p.estimateMs <= 180000);
    }
    const ww = Effects.plan(['flm:left:1', 'flm:right:1'], g21Lamps, Object.assign({ effect: 'wigwag' }, base));
    assert.deepStrictEqual(ww.steps.map((s) => s.on), [['flm:left:1'], ['flm:right:1']]);
    assert.throws(() => Effects.plan(['flm:left:1'], g21Lamps, Object.assign({ effect: 'wigwag' }, base)), /left and on the right/);
    assert.throws(() => Effects.plan(['flm:left:1'], g21Lamps, Object.assign({ effect: 'chase' }, base, { stepMs: 123 })), /step time/);
    assert.throws(() => Effects.plan([], g21Lamps, Object.assign({ effect: 'chase' }, base)), /at least one/);
    console.log('ok: every effect respects the one-channel-per-module rule and the limits');
}

/* ---------- names / observations / journal migration ---------- */
{
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'light-show-channel-names.json'), JSON.stringify({ names: { 'left:3': 'Low beam', 'right:20': 'x' } }));
    fs.writeFileSync(path.join(dir, 'light-show-observations.json'), JSON.stringify([
        { route: 'flm', side: 'left', channel: 3, result: 'visible, no unusual noise', cleanupConfirmed: true },
        { route: 'flm', side: 'left', channel: 4, result: 'visible, no unusual noise', cleanupConfirmed: false },
        { route: 'flm', side: 'right', channel: 2, result: 'visible, no unusual noise', cleanupConfirmed: true },
        { route: 'flm', side: 'right', channel: 2, result: 'visible and unusual noise', cleanupConfirmed: true },
    ]));
    const names = new Names(dir), obs = new Observations(dir);
    assert.strictEqual(names.name('flm:left:3'), 'Low beam');
    assert.strictEqual(obs.status('flm:left:3'), 'visible');
    assert.strictEqual(obs.status('flm:left:4'), 'untested', 'unconfirmed release never counts as visible');
    assert.strictEqual(obs.status('flm:right:2'), 'noise', 'noise wins');
    obs.record('flm:left:3', 'none', true);
    assert.strictEqual(obs.status('flm:left:3'), 'not-visible', 'a newer no-effect report supersedes a visible one');
    obs.record('flm:left:3', 'visible', true, { moduleIndex: '0F26C0' });
    assert.strictEqual(obs.status('flm:left:3', '0F26C0'), 'visible');
    assert.strictEqual(obs.status('flm:left:3', '0F26C8'), 'not-visible');
    names.set('fn:high', 'Fernlicht');
    assert.strictEqual(new Names(dir).name('fn:high'), 'Fernlicht');
    assert.throws(() => names.set('fn:high', '<script>'), /Name must/);
    assert.strictEqual(migrateKey('left:15'), 'flm:left:15');
    assert.deepStrictEqual(Journal.migrate({ route: 'flm_show', sides: ['left', 'right'] }), { flmSides: ['left', 'right'] });
    assert.deepStrictEqual(Journal.migrate({ route: 'single', outputId: 24 }), { outputs: [24], bdcSession: true });
    const j = new Journal(dir);
    assert.throws(() => j.mark('0F1234', { flmSides: ['left'] }), /body controller/);
    j.mark('0F2680', { flmSides: ['left'], outputs: [24], rlm: [{ address: 0x17, kind: 'fn', items: [2] }] });
    assert.deepStrictEqual(new Journal(dir).control(), { flmSides: ['left'], fns: [], outputs: [24], bdcSession: true, rlm: [{ address: 0x17, kind: 'fn', items: [2] }], commOff: [] });
    assert.throws(() => Journal.clean({ flmSides: ['left'], commOff: ['right'] }), /communication/);
    fs.writeFileSync(path.join(dir, 'light-show-recovery.json'), '{broken');
    assert.strictEqual(new Journal(dir).control(), null, 'unreadable marker needs the manual light check');
    console.log('ok: 0.3.x names, observations and recovery markers are taken over safely');
}

{
    const guard = new Guard(() => 10000);
    guard.speedSub = guard.gearSub = { available: true };
    guard.feedSpeed({ speedVehicleCentreOfGravity: 0 });
    guard.feedSelection({ statusGearSelectionDrive: 'P' });
    assert.strictEqual(guard.reason(), null);
    guard.feedStage({ statusActualStageDrive: 'D' });
    guard.feedSelection({ statusGearSelectionDrive: 'P' });
    assert.match(guard.reason(), /Park/);
    guard.feedStage({ statusActualStageDrive: 'P' });
    assert.strictEqual(guard.reason(), null);
    guard.feedSelection({ statusGearSelectionDrive: 'NP' });
    assert.match(guard.reason(), /Park/);
}

/* ---------- runner ---------- */
class FakeLink {
    constructor(o) { this.o = o || {}; this.log = []; this.index = null; }
    rec(x) { this.log.push(x); if (this.o.failOn === x) throw new Error('NRC 22 on ' + x); return Promise.resolve([0x00]); }
    identify() { this.index = this.o.bdc || '0F2680'; if (this.index !== '0F2680') return Promise.reject(new Error('BDC variant')); return this.rec('id:bdc'); }
    identifyFlm(side) { if (!F.usable(side, this.o.flm || F.MODULES[side].index, this.o.exp)) return Promise.reject(new Error('FLM variant unsupported')); return this.rec('id:' + side); }
    session() { return this.rec('bdc:03'); }
    defaultSession() { return this.rec('bdc:01'); }
    keepalive() { return this.rec('bdc:3E'); }
    flmSession(s) { return this.rec(s + ':03'); }
    flmDefaultSession(s) { return this.rec(s + ':01'); }
    flmKeepalive(s) { return this.rec(s + ':3E'); }
    flmStart(s, c, pwm, sec) { F.start(c, pwm, sec); return this.rec(s + ':start' + c); }
    flmStop(s) { return this.rec(s + ':stop'); }
    flmCommunication(s, on) { return this.rec(s + (on ? ':28 00 03' : ':28 02 01')); }
    timed(k, ms) { return this.rec('fn:' + k + ':' + ms); }
    identifyRlm(a) { return this.rec('id:rlm' + a.toString(16)).then(() => ({ name: 'RLM2_1L', kinds: ['fn', 'grp'] })); }
    rlmSession(a) { return this.rec('rlm' + a.toString(16) + ':03'); }
    rlmDefaultSession(a) { return this.rec('rlm' + a.toString(16) + ':01'); }
    rlmKeepalive(a) { return this.rec('rlm' + a.toString(16) + ':3E'); }
    rlmSet(a, kind, item, ms) { return this.rec('rlm' + a.toString(16) + ':' + kind + item + ':' + (ms ? 'on' : 'off')); }
    set(id, on) { return this.rec('out:' + id + ':' + on); }
}
function runnerWith(link, guardReason, commOff) {
    const dir = tmp(), journal = new Journal(dir);
    let reason = guardReason || null;
    const guard = { reason: () => (typeof reason === 'function' ? reason() : reason) };
    const r = new Runner({ link, guard, journal, log: { warn() {}, info() {} }, sleep: () => Promise.resolve(), commOff: () => !!commOff });
    return { r, journal, setReason: (x) => { reason = x; } };
}
const byId = {}; g21Lamps.forEach((l) => { byId[l.id] = l; });
(async () => {
    {
        const log = { warn() {}, info() {} };
        const diag = new Diag({}, log);
        diag.send = async () => {
            diag.emit('frame', { ecu: 0x43, uds: [0x7F, 0x22, 0x78] });
            diag.emit('frame', { ecu: 0x40, uds: [0x62, 0xF1, 0x50, 0x0F, 0x26, 0x80] });
            diag.emit('frame', { ecu: 0x40, uds: [0x62, 0xF1, 0x90, 0x01, 0x02, 0x03] });
            diag.emit('frame', { ecu: 0x40, uds: [0x7F, 0x22, 0x31] });
            setTimeout(() => diag.emit('frame', { ecu: 0x43, uds: [0x62, 0xF1, 0x50, 0x0F, 0x26, 0xC8] }), 30);
            return 'NO_ERROR';
        };
        const replies = await diag.functional(0x22, [0xF1, 0x50], { idleMs: 10, pendingMs: 300, maxMs: 500 });
        assert.deepStrictEqual(Array.from(replies), [
            [0x40, [0x62, 0xF1, 0x50, 0x0F, 0x26, 0x80]], [0x43, [0x62, 0xF1, 0x50, 0x0F, 0x26, 0xC8]],
        ]);
        assert.strictEqual(diag.listenerCount('frame'), 0);
        const previous = Scan.profile(ids([[0x40, '0F2680'], [0x17, '0F2C10'], [0x43, '0F26C0']]), 'old');
        const attempts = [];
        const link = {
            scan: async () => ids([[0x40, '0F2680']]),
            readIdentity: async (address) => {
                const retried = attempts.indexOf(address) >= 0;
                attempts.push(address);
                if (retried && address === 0x43) return '0F26C8';
                throw new Error('No reply');
            },
        };
        const scan = await Scan.scan(link, log, null, { previous });
        assert.deepStrictEqual(scan.unconfirmed, [0x17]);
        assert.strictEqual(scan.rlm[0].index, '0F2C10');
        assert.strictEqual(scan.units.find((u) => u.address === 0x17).supportText, 'Last seen');
        assert.strictEqual(scan.flm.left.index, '0F26C8');
        assert.strictEqual(attempts.filter((a) => a === 0x43).length, 2);
        const dir = tmp();
        Scan.save(dir, scan);
        assert.deepStrictEqual(Scan.load(dir).unconfirmed, [0x17]);
        Scan.save(dir, Scan.profile(ids([[0x10, '0F1310']]), 'empty'));
        assert.strictEqual(Scan.load(dir), null, 'an old empty scan cannot suppress automatic discovery');
        link.scan = async () => ids([[0x10, '0F1310']]);
        link.readIdentity = async () => { throw new Error('No reply'); };
        await assert.rejects(Scan.scan(link, log, null, { previous }), /No exterior light module/);
        let checks = 0;
        await assert.rejects(Scan.scan(link, log, null, { check() { if (++checks > 1) throw new Error('Park'); } }), /Park/);
        const live = new Link({}, log);
        live.available = true;
        live.diag.physical = async (address, sid, data, timeout) => {
            assert.ok(timeout >= 1000, 'identity reads have a separate timeout');
            return [0x62, 0xF1, 0x50, 0x0F, 0x26, 0xC8];
        };
        await assert.rejects(live.identifyFlm('left', '0F26C0'), /changed.*Scan the vehicle/);
        await assert.rejects(live.flmStart('left', 3), /not identified/);
        console.log('ok: pending identity, scan retry, incomplete scans and module changes');
    }
    {
        const link = new FakeLink(), { r, journal } = runnerWith(link);
        const plan = Effects.plan(['flm:left:1', 'flm:right:1', 'fn:high', 'out:24'], g21Lamps, Object.assign({ effect: 'chase' }, base, { cycles: 1 }));
        const res = await r.play(plan, byId);
        assert.ok(res.ok, JSON.stringify(res));
        const l = link.log;
        assert.deepStrictEqual(l.slice(0, 3), ['id:bdc', 'id:left', 'id:right'], 'identities before anything else');
        assert.ok(l.indexOf('left:start1') > l.indexOf('left:03'), 'session before control');
        assert.ok(l.indexOf('left:stop') > l.indexOf('left:start1'));
        assert.ok(l.indexOf('out:24:0') > l.indexOf('out:24:1'));
        assert.deepStrictEqual(l.slice(-3), ['left:01', 'right:01', 'bdc:01'], 'default sessions after confirmed OFF commands');
        assert.strictEqual(l.filter((x) => x === 'left:stop').length, 1, 'no second STOP on an idle routine');
        assert.ok(!journal.pending());
        assert.strictEqual(r.status().state, 'IDLE');
        console.log('ok: a mixed show identifies, controls, switches off and releases every unit');
    }
    {
        const link = new FakeLink(), { r, journal } = runnerWith(link, 'Select P (Park)');
        const res = await r.test(byId['flm:left:1'], {});
        assert.ok(!res.ok); assert.deepStrictEqual(link.log, [], 'nothing sent when not parked');
        assert.ok(!journal.pending());
    }
    {
        let n = 0;
        const link = new FakeLink(), { r, journal } = runnerWith(link, () => (++n > 12 ? 'Vehicle must be stationary' : null));
        const plan = Effects.plan(['flm:left:1', 'flm:right:1'], g21Lamps, Object.assign({ effect: 'wigwag' }, base, { cycles: 10 }));
        const res = await r.play(plan, byId);
        assert.ok(res.ok && /stationary/.test(res.error), 'guard loss ends the show');
        assert.deepStrictEqual(link.log.slice(-2), ['left:01', 'right:01']);
        assert.ok(!journal.pending());
        console.log('ok: leaving P stops the show and still releases everything');
    }
    {
        const link = new FakeLink({ failOn: 'left:01' }), { r, journal } = runnerWith(link);
        await r.test(byId['flm:left:1'], {});
        assert.ok(journal.pending(), 'unconfirmed release keeps the marker');
        assert.strictEqual(r.status().state, 'ERROR');
        link.o.failOn = null;
        await r.stop();
        assert.ok(!journal.pending(), 'STOP releases what is left');
        console.log('ok: a failed release keeps the recovery marker until STOP succeeds');
    }
    {
        const link = new FakeLink(), { r, journal } = runnerWith(link);
        journal.mark('0F2680', { flmSides: ['left'], rlm: [{ address: 0x17, kind: 'grp', items: [1] }] });
        link.o.failOn = 'id:rlm17';
        await r.stop();
        assert.ok(link.log.includes('left:01'), 'release a reachable module even when another module has no identity');
        assert.ok(!link.log.includes('rlm17:grp0:off') && journal.pending());
        assert.match(r.status().note, /rear light 0x17 identity/);
    }
    {
        const link = new FakeLink(), w = runnerWith(link);
        link.flmSession = async () => {
            await link.rec('left:03');
            w.setReason('Vehicle must be stationary');
        };
        const plan = Effects.plan(['flm:left:1', 'flm:right:1'], g21Lamps, Object.assign({ effect: 'wigwag' }, base));
        const res = await w.r.play(plan, byId);
        assert.match(res.error, /stationary/);
        assert.ok(!link.log.includes('right:03') && !link.log.includes('left:start1'));
        assert.ok(link.log.includes('left:01') && !w.journal.pending());
    }
    {
        const link = new FakeLink({ flm: '0F2E30' }), { r, journal } = runnerWith(link);
        const res = await r.test(Object.assign({}, byId['flm:left:1']), {});
        assert.ok(!res.ok && /unsupported/.test(res.error));
        assert.ok(!journal.pending()); assert.ok(link.log.every((x) => x.indexOf('id:') === 0));
        console.log('ok: unsupported headlamp module (FLM03) refused, nothing switched');
    }
    {
        const rp = Scan.profile(ids([[0x40, '0F2680'], [0x43, '0F26C0'], [0x44, '0F26D0'], [0x17, '0F2C10'], [0x1A, '0F2C20']]), 't');
        const cat = Lamps.catalog(rp, null, {}), m = {}; cat.forEach((l) => { m[l.id] = l; });
        const link = new FakeLink(), { r, journal } = runnerWith(link);
        const plan = Effects.plan(['rlm:17:f2', 'rlm:1a:f2', 'fn:indLeft', 'fn:indRight'], cat, Object.assign({ effect: 'wigwag' }, base, { cycles: 1 }));
        const res = await r.play(plan, m);
        assert.ok(res.ok, JSON.stringify(res));
        const l = link.log;
        assert.ok(l.indexOf('id:rlm17') < l.indexOf('rlm17:03') && l.indexOf('rlm17:03') < l.indexOf('rlm17:fn2:on'));
        assert.deepStrictEqual(l.slice(-3), ['rlm17:01', 'rlm1a:01', 'bdc:01']);
        assert.ok(l.indexOf('rlm17:fn2:off') > l.indexOf('rlm17:fn2:on'));
        assert.strictEqual(l.filter((x) => x === 'rlm17:fn2:off').length, 1);
        assert.ok(!journal.pending());
        console.log('ok: rear light modules and BDC indicator functions play and are released');
        const link2 = new FakeLink(), w = runnerWith(link2);
        const seq = Effects.plan(['rlm:17:g1', 'rlm:17:g2', 'rlm:17:f2'], cat, Object.assign({ effect: 'strobe' }, base, { cycles: 1 }));
        assert.ok(seq.steps.every((st) => st.on.filter((id) => /:g/.test(id)).length <= 1), 'one segment group per module and step');
        const res2 = await w.r.play(seq, m);
        assert.ok(res2.ok, JSON.stringify(res2));
        assert.ok(link2.log.indexOf('rlm17:grp1:off') > 0 && link2.log.filter((x) => x === 'rlm17:01').length === 1);
        assert.ok(link2.log.indexOf('rlm17:grp0:off') < 0);
        console.log('ok: RLM2 segment groups play one per module with no redundant final stop');
    }
    {
        const link = new FakeLink(), { r, journal } = runnerWith(link, null, true);
        await r.test(byId['flm:left:3'], {});
        const l = link.log;
        assert.ok(l.indexOf('left:03') < l.indexOf('left:28 02 01') && l.indexOf('left:28 02 01') < l.indexOf('left:start3'), 'silenced after session, before the channel');
        assert.deepStrictEqual(l.slice(-3), ['left:stop', 'left:28 00 03', 'left:01'], 'communication back on before the default session');
        assert.ok(!journal.pending());
        const quiet = new FakeLink(), w = runnerWith(quiet, null, false);
        await w.r.test(byId['flm:left:3'], {});
        assert.ok(quiet.log.every((x) => x.indexOf(':28') < 0), 'option off: no communication control');
        const refused = new FakeLink({ failOn: 'left:28 00 03' }), w2 = runnerWith(refused, null, true);
        await w2.r.test(byId['flm:left:3'], {});
        assert.ok(!w2.journal.pending(), 'refused "on" is fine when the default session was confirmed');
        const both = new FakeLink({ failOn: 'left:01' }), w3 = runnerWith(both, null, true);
        await w3.r.test(byId['flm:left:3'], {});
        assert.ok(w3.journal.pending() && w3.journal.control().commOff[0] === 'left', 'marker keeps the silenced side');
        both.o.failOn = null; await w3.r.stop();
        assert.ok(both.log.slice(-2)[0] === 'left:28 00 03' && !w3.journal.pending(), 'STOP turns communication back on');
        const Link = require(APP + '/link');
        const ln = new Link({}, { warn() {}, info() {} });
        ln.available = true; ln.verifiedFlm[0x43] = '0F26C0';
        const sent = [];
        ln.diag.physical = (a, sid, d) => { sent.push(sid.toString(16) + ' ' + d.join(' ')); return Promise.resolve([sid + 0x40, d[0]]); };
        await ln.flmCommunication('left', false); await ln.flmCommunication('left', true);
        assert.deepStrictEqual(sent, ['28 2 1', '28 0 3']);
        await assert.rejects(ln.request(0x28, [0x03, 0x03], false, 0x43), /Unsupported FLM/);
        await assert.rejects(ln.request(0x28, [0x02, 0x01], false, 0x17), /not allowed/);
        console.log('ok: test option silences only the used headlamp modules and always turns them back on');
    }

    /* ---------- car3d ---------- */
    let polys = 0, dots = 0;
    Car3D.render({ poly: (p) => { polys++; assert.ok(p.length >= 3); }, dot: () => dots++ },
        { x: 0, y: 0, w: 600, h: 300, yaw: 0.8, pitch: -0.3 }, [{ points: [[0.6, 0.74, 2.3]], hex: '#ffffff', on: true }]);
    assert.ok(polys > 10 && dots >= 3);
    assert.ok(page.indexOf('Car3D') > 0 && page.indexOf('/api/state') > 0);
    const htmlIds = Array.from(page.matchAll(/\bid="([a-z-]+)"/g), (m) => m[1]);
    assert.strictEqual(htmlIds.length, new Set(htmlIds).size, 'car preview and Car tab need distinct DOM ids');
    console.log('ok: 3D car renders and the phone page embeds it');

    /* ---------- phone server ---------- */
    assert.ok(privateAddress('172.16.222.5') && privateAddress('192.168.1.2') && !privateAddress('8.8.8.8'));
    let shown = 0;
    const srv = new WebServer({ state: () => ({ hello: 1 }), stop: () => ({ ok: true }), show: (b) => { shown = b.effect; return { ok: true }; } },
        { warn() {} }, { port: 0, token: 'abc', address: () => '127.0.0.1' });
    srv.start();
    await new Promise((res) => srv.http.on('listening', res));
    const port = srv.http.address().port;
    const get = (p, opts) => new Promise((res, rej) => {
        const req = http.request(Object.assign({ host: '127.0.0.1', port, path: p }, opts || {}), (r) => {
            let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => res({ status: r.statusCode, body: b, headers: r.headers }));
        });
        req.on('error', rej);
        if (opts && opts.body) req.write(opts.body);
        req.end();
    });
    assert.strictEqual((await get('/?t=wrong')).status, 403);
    assert.strictEqual((await get('/?t=abc')).status, 200);
    assert.deepStrictEqual(JSON.parse((await get('/api/state?t=abc')).body), { hello: 1 });
    const h = await get('/.mgu-light-show-health');
    assert.strictEqual(h.status, 200); assert.strictEqual(h.headers['x-mgu-light-show'], '1');
    const posted = await get('/api/show?t=abc', { method: 'POST', body: JSON.stringify({ effect: 'chase' }), headers: { 'Content-Type': 'application/json' } });
    assert.strictEqual(posted.status, 200); assert.strictEqual(shown, 'chase');
    assert.strictEqual((await get('/api/scan?t=abc', { method: 'POST', body: '{}' })).status, 404, 'unknown action refused');
    assert.strictEqual((await get('/api/show?t=abc', { method: 'POST', body: 'x'.repeat(9000) })).status, 413);
    assert.ok(/:18880\/\?t=/.test(new WebServer({}, null, { token: 't', address: () => '172.16.222.97' }).url()));
    srv.stop();
    console.log('ok: phone server needs the pairing token, answers the helper probe, limits requests');
})().catch((e) => { console.error(e); process.exit(1); });
