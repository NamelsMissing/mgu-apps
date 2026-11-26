'use strict';

const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const B = require('./logic');
const { ComfortAuto, START_WINDOW_MS, SEAT_MODULE_MAX_RENEW_AGE_MS } = require('./comfort_auto');
const { SafeDiag, bytes } = require('./safe_diag');
const Log = require('./session_log');
const Cycle = require('./cycle_policy');
const E = require('./ecu_profile');

// Settings is automatically provided as ONE native tab by the renderer.
const TABS = ['Comfort', 'Diagnostics', 'Log'];
const text = (cv, s, x, y, size, color, opts) =>
    cv.text(String(s), x, y, size, color, opts || {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SEAT_MODULE_STOP_MAX_AGE_MS = 110000;
const WHEEL_START_READ_MS = 2000;
const WHEEL_STATUS_READ_MS = 15000;

mgu.run({
    startBeforeScreen: true,
    isSdkDebug: Log.isSdkDebug,
    async start(ctx) {
        ctx.log.info('[WHEELHEAT] all ECU writes require explicit automatic heating opt-in');
        const ctl = new SafeDiag(ctx, B.ECU, B.DID_HEAT);
        const auto = new ComfortAuto();
        const appStartedAt = Date.now();
        const startReason = String(ctx.app && ctx.app.startReason || 'UNKNOWN');
        const offMinutes = () => Cycle.minutes(ctx.settings.get('minVehicleOffMins'));
        // The one-shot test bypasses ONLY the parked-time requirement. A real
        // ignition-ON signal, temperature and ECU guards are still required.
        const testRequested = ctx.settings.get('testNextStartup') === true;
        let testConsumed = false, testError = '';
        if (testRequested) {
            try {
                ctx.settings.set('testNextStartup', false);
                const saved = JSON.parse(fs.readFileSync(ctx.settings.file, 'utf8'));
                testConsumed = saved.testNextStartup === false;
                if (!testConsumed) testError = 'Could not verify one-shot reset in settings.json';
            } catch (e) {
                testError = String(e && (e.code || e.message) || e);
            }
        }
        const cycleFile = path.join(ctx.dataDir, 'vehicle_cycle.json');
        let savedCycle;
        try { savedCycle = JSON.parse(fs.readFileSync(cycleFile, 'utf8')); }
        catch (e) {
            // Corrupt state must never resurrect older parking evidence.
            savedCycle = e.code === 'ENOENT' ? {
                offAt: ctx.settings.get('_vehicleOffAt'), onAt: ctx.settings.get('_vehicleOnAt'),
                usedOnAt: ctx.settings.get('_vehicleCycleUsedOnAt'),
                cancelledOnAt: ctx.settings.get('_vehicleCancelledOnAt'),
            } : {};
        }
        const cycle = new Cycle.VehicleCycle({
            ...savedCycle, lastActivationAt: ctx.settings.get('_autoCycleAt'),
        }, offMinutes(), testConsumed, startReason === 'AUTOSTART');
        let cycleReason = cycle.reason;
        const outside = { value: null, at: 0, raw: null };
        const acknowledged = new Set();
        const deviceStatus = new Map();
        let wheelCheck = null;
        const seatModuleActivations = new Map();
        let vehicleReportsOn = false;
        const pendingStops = new Set();
        const stopAttempts = new Map();
        let firstUiAt = 0, uiOpenCount = 0, cancelGeneration = 0;
        let lastVehicleRaw = '', lastVehicleLogAt = 0;
        let tab = 0, busy = false, statusBusy = false, statusAt = 0;
        let lastAction = 'No heating command has been sent.';
        const eventFile = path.join(ctx.dataDir, 'heating_events.json');
        // Start a fresh log even when the MGU has retained yesterday's app data.
        // A verified ignition OFF also begins a new log session.
        let sessionStartedAt = appStartedAt, sessionReason = 'MGU PROCESS START';
        let events = [], sawVehicleOn = false;
        let consoleOffset = 0, consoleTouchY = null, filter = 0, showAutoStatus = false;
        const filters = ['All', 'AutoHeat', 'Vehicle', 'Cycle', 'Commands', 'ECU', 'Readback', 'SDK debug'];
        let warningCache = [], warningCacheAt = 0;
        const record = (kind, message) => {
            const at = Date.now();
            if (events[0] && events[0].kind === kind &&
                events[0].message === message && at - events[0].at < 15000) return;
            events.unshift({ at, kind, message: String(message).slice(0, 320) });
            events = events.slice(0, 350);
            try {
                // Event log uses the same app-private data dir; no directory creation.
                fs.writeFileSync(eventFile, JSON.stringify(events), 'utf8');
            } catch (_) {}
            ctx.log.info('[HEAT EVENT] ' + kind + ' ' + message);
        };
        const resetSession = reason => {
            sessionStartedAt = Date.now();
            sessionReason = reason;
            events = [];
            consoleOffset = 0;
            warningCache = [];
            warningCacheAt = 0;
            record('SESSION START', reason);
        };
        function persistCycle() {
            const state = cycle.snapshot();
            try {
                const serialized = JSON.stringify(state);
                const temporary = cycleFile + '.' + process.pid + '.tmp';
                fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
                fs.renameSync(temporary, cycleFile);
                if (fs.readFileSync(cycleFile, 'utf8') !== serialized)
                    throw new Error('Cycle journal was not verified');
                return true;
            } catch (e) {
                record('STATE SAVE ERROR', String(e && (e.message || e)));
                return false;
            }
        }
        record('PROCESS START', 'reason=' + startReason + ' pid=' + process.pid +
            ' at=' + new Date(appStartedAt).toISOString() +
            ' (NOT proof the UI was opened)');
        record('BACKGROUND', 'Service running; start reason=' + startReason);
        record('START', 'auto=' + ctx.settings.get('autoEnabled') +
            ' limit=' + ctx.settings.get('belowTemp') + ' C; loaded=' +
            ctx.settings.loadSource + '; data=' + ctx.dataDir);
        if (testRequested)
            record(testConsumed ? 'TEST' : 'TEST BLOCKED',
                testConsumed ?
                    'One-shot test consumed; parking duration bypassed on next verified ignition ON' :
                    'One-shot startup test denied (reset not confirmed): ' + testError);
        record('CYCLE', cycleReason);
        if (typeof ctx.ui.onVisible === 'function') {
            ctx.ui.onVisible((name, shown) => {
                if (name !== 'MAIN' && name !== 'SETTINGS') return;
                if (shown) {
                    uiOpenCount++;
                    if (!firstUiAt) firstUiAt = Date.now();
                }
                record(shown ? 'UI OPEN' : 'UI HIDDEN', 'screen=' + name +
                    ' startReason=' + startReason + ' elapsed=' +
                    Math.round((Date.now() - appStartedAt) / 1000) + 's' +
                    ' firstOpen=' + (firstUiAt ? new Date(firstUiAt).toISOString() : 'never') +
                    ' opens=' + uiOpenCount + ' activationConfirmed=' +
                    Object.values(cycle.channels).includes('confirmed'));
            });
        }
        if (ctx.app && typeof ctx.app.on === 'function')
            ctx.app.on('entryPointExecute', (uuid, reason, name) => {
                record('UI ENTRY', 'name=' + String(name) + ' reason=' + String(reason) +
                    ' processAge=' + Math.round((Date.now() - appStartedAt) / 1000) + 's');
            });
        if (ctx.ui.isVisible('MAIN') || ctx.ui.isVisible('SETTINGS'))
            record('UI ALREADY VISIBLE', 'when app logic initialized; reason=' + startReason);
        let lastPlannerStatus = '';

        let testArmedAt = testConsumed ? Date.now() : 0;
        // Control-unit profile: loaded from settings, verified/detected once
        // TASU is online, stored again for the next start.
        let ecuProfile = E.load(ctx.settings.get(E.PROFILE_KEY));
        let ecuState = ecuProfile ? 'STORED (not yet verified)' : 'NOT DETECTED';
        let ecuBusy = false, ecuDone = false, ecuVerified = false, ecuForce = false;
        let ecuAttemptAt = 0, ecuAttempts = 0;
        let lastRouteNote = '';
        let lastSkipNote = '';
        // Latest read-only snapshot of the seat sources (SMFA/SMBF D714, IHKA D8DB).
        let seatSources = null, mismatchStreak = 0;
        record('ECU PROFILE', ecuProfile ? (ecuProfile.migratedFrom ?
            'migrated 0.5.1 profile, re-detection required: ' : 'loaded: ') + E.summary(ecuProfile) : 'none stored');
        if (ecuProfile && ecuProfile.migratedFrom) ecuState = 'MIGRATED (re-detecting)';
        ctx.settings.onChange((key, value) => {
            // The one-shot test must also work when the app is already running
            // (head unit stays up between ignitions). Consume the switch at
            // once and arm the cycle for the next fresh OFF -> ON edge.
            if (key === 'testNextStartup' && value === true) {
                try {
                    ctx.settings.set('testNextStartup', false);
                    const disk = JSON.parse(fs.readFileSync(ctx.settings.file, 'utf8'));
                    if (disk.testNextStartup !== false) throw new Error('reset not verified on disk');
                    cycle.armTest();
                    testArmedAt = Date.now();
                    record('TEST', 'One-shot test armed: parking time skipped on the next verified ignition ON');
                } catch (e) {
                    record('TEST BLOCKED', 'One-shot test not armed: ' + String(e && (e.message || e)));
                }
            }
            let persisted = false;
            try {
                const disk = JSON.parse(fs.readFileSync(ctx.settings.file, 'utf8'));
                persisted = key === null || disk[key] === value;
            } catch (_) {}
            record('SETTING', String(key) + '=' + String(value) +
                ' file=' + (persisted ? 'OK' : 'FAILED') +
                (ctx.settings.saveError ? ' ' + ctx.settings.saveError : ''));
        });
        const setTab = i => {
            if (Number.isInteger(i) && i >= 0 && i < TABS.length) {
                tab = i;
                if (tab === 1) refreshReadbacks().catch(e => { ctl.info = 'BDC read error: ' + e.message; });
            }
        };

        async function watchVehicleSignal(iface, handlers, pollMs) {
            const pauses = [2000, 5000, 10000, 20000, 30000];
            for (let attempt = 0; ; attempt++) {
                try {
                    const sub = await ctx.signals.watch(iface, '1', handlers, ctx.log, { pollMs });
                    if (!sub.error) {
                        record('VEHICLE SIGNAL', iface + '; provider=' + (sub.available ? 'available' : 'waiting'));
                        return;
                    }
                    if (sub.shutdown) await sub.shutdown();
                    record('VEHICLE SIGNAL ERROR', iface + ': ' + sub.error);
                } catch (e) { record('VEHICLE SIGNAL ERROR', iface + ': ' + e.message); }
                if (attempt === pauses.length) return;
                await wait(pauses[attempt]);
            }
        }

        // Use only a real, fresh MGU outdoor temperature. No test/simulated
        // values can reach the automatic ECU actuator.
        watchVehicleSignal('de.bmw.infrastructure.EnvironmentalInformation', {
            ExteriorTemperature: v => {
                const raw = v && v.temperatureExterior;
                const temp = B.exteriorTemp(raw);
                if (temp !== null && temp >= -40 && temp <= 60) {
                    if (outside.value !== temp || outside.raw !== raw)
                        ctx.log.info('[WHEELHEAT TEMP] raw=' + raw + ' decoded=' +
                            temp + 'C threshold=' + ctx.settings.get('belowTemp'));
                    outside.value = temp;
                    outside.raw = raw;
                    outside.at = Date.now();
                }
            },
        }, 10000);

        // This is BMW's vehicle condition, not engine RPM or vehicle speed:
        // Mild-hybrid engine OFF, Auto Start/Stop and speed=0 are NOT parked
        // ignition OFF. A missing provider prevents a new automatic cycle.
        watchVehicleSignal('de.bmw.infrastructure.VehicleCondition', {
            VehicleCondition: value => {
                const raw = value && value.statusConditionVehicle;
                const before = cycle.mode;
                vehicleReportsOn = Cycle.driveReady(raw);
                if (Cycle.condition(raw) === 'on' && !vehicleReportsOn) return;
                if (Cycle.condition(raw) === 'on' && before !== 'on')
                    cycle.offMinutes = offMinutes();
                const observed = cycle.observe(raw, Date.now());
                if (String(raw) !== lastVehicleRaw || observed.changed ||
                    Date.now() - lastVehicleLogAt > 120000) {
                    ctx.log.info('[WHEELHEAT VEHICLE] raw=' + String(raw) +
                        ' decoded=' + Cycle.condition(raw) + ' previous=' + before +
                        ' transition=' + observed.transition);
                    lastVehicleRaw = String(raw);
                    lastVehicleLogAt = Date.now();
                }
                if (!observed.changed) return;
                if (!persistCycle()) {
                    cycle.eligible = false;
                    cycle.reason = 'VEHICLE STATE STORAGE NOT VERIFIED: automatic start blocked';
                }
                if (observed.transition === 'off' || observed.transition === 'ending') {
                    cancelGeneration++;
                    // Don't issue a BDC OFF write during ignition shutdown.
                    // The automobile owns powerdown; drop app timers instead.
                    const discarded = auto.cancel();
                    pendingStops.clear();
                    stopAttempts.clear();
                    acknowledged.clear();
                    deviceStatus.clear();
                    wheelCheck = null;
                    seatModuleActivations.clear();
                    // Only a real ON -> OFF cycle resets the session log. An
                    // initial OFF observation at process boot is not a new
                    // journey; retain the PROCESS START evidence in that case.
                    if (observed.transition === 'off' && sawVehicleOn) {
                        resetSession('VERIFIED VEHICLE OFF');
                        sawVehicleOn = false;
                    }
                    record(observed.transition === 'off' ? 'VEHICLE OFF' : 'VEHICLE ENDING', observed.reason +
                        '; stopped app timers=' + discarded.join(', ') +
                        '; no ECU write during shutdown');
                } else if (observed.transition === 'on') {
                    sawVehicleOn = true;
                    if (!ecuProfile || !ecuProfile.complete) { ecuDone = false; ecuAttemptAt = 0; }
                    ecuAttempts = 0;
                    if (cycle.canStart()) auto.rearm();
                    record('VEHICLE ON', observed.reason +
                        '; app started via ' + startReason +
                        '; UI shown=' + (firstUiAt ? 'yes' : 'no'));
                }
                cycleReason = cycle.reason;
                lastPlannerStatus = '';
            },
        }, 3000);

        const config = () => ({
            autoEnabled: ctx.settings.get('autoEnabled') === true,
            belowTemp: Number(ctx.settings.get('belowTemp')),
            coldDwell: 15,
            wheelAuto: ctx.settings.get('wheelAuto') === true,
            wheelMins: Number(ctx.settings.get('wheelMins')),
            seatDriver: ctx.settings.get('seatDriver') === true,
            seatPassenger: ctx.settings.get('seatPassenger') === true,
            smfaDriverAuto: ctx.settings.get('smfaDriverAuto') === true,
            smbfPassengerAuto: ctx.settings.get('smbfPassengerAuto') === true,
            seatLevel: Number(ctx.settings.get('seatLevel')),
            seatMins: Number(ctx.settings.get('seatMins')),
        });
        // Guarded control requires the saved automatic-heating switch.
        const permitted = () => ctx.settings.get('autoEnabled') === true;
        const tempReading = now => B.temperatureInput(outside.value, outside.at, false, null, now);
        const viaSeatModule = (cfg, side) => ecuVerified && !ecuForce && E.allowsSeatModule(ecuProfile, cfg, side);

        function stopAutoHeating() {
            cancelGeneration++;
            wheelCheck = null;
            const cancelled = cycle.cancel();
            const active = auto.cancel();
            acknowledged.forEach(name => {
                pendingStops.add(name);
                stopAttempts.set(name, 0);
            });
            if (cycle.mode === 'on' && !persistCycle())
                record('STOP SAVE ERROR', 'Manual cancel not saved; keep app open until vehicle OFF');
            cycleReason = cycle.reason;
            lastPlannerStatus = '';
            record('MANUAL STOP', 'source=app button; ignition=' + cycle.mode +
                '; cancelled=' + cancelled + '; timers=' + active.join(', ') +
                '; ECU OFF queued=' + Array.from(pendingStops).join(', ') +
                ' (only if ECU guards permit)');
        }

        function markChannel(name, state) {
            if (state) cycle.channels[name] = state;
            else delete cycle.channels[name];
            const saved = persistCycle();
            if (!saved) cycle.eligible = false;
            return saved;
        }

        function bdcLevel(did) {
            const entry = ctl.readbacks[did];
            if (!entry || !entry.ok || Date.now() - entry.at > 30000) return null;
            if (did === B.DID_HEAT) {
                const wheel = B.decodeWheelReadback(entry.payload);
                if (!wheel) return null;
                return wheel.on ? 1 : wheel.currentAmps === 0 ? 0 : null;
            }
            const seat = B.decodeSeatReadback(entry.payload);
            if (!seat) return null;
            if (seat.on && seat.level > 0) return seat.level;
            return !seat.on && seat.level === 0 ? 0 : null;
        }

        async function monitorHeaters() {
            if (!vehicleReportsOn || !ctl.online || !cycle.mayContinue()) return;
            const ignition = cycle.onAt;
            for (const [name, active] of auto.active) {
                if (active.pending || !acknowledged.has(name)) continue;
                const now = Date.now(), previous = deviceStatus.get(name);
                if (previous && now < previous.nextRead) continue;
                const side = E.DEVICE_KEY[name], module = active.on.viaSeatModule && E.SEAT_MODULES[side];
                const did = side === 'wheel' ? B.DID_HEAT : E.DID[side];
                let level = null;
                if (module) {
                    try {
                        const reply = E.classify(E.MODULE_DID.seat, await ctl.probe(module.addr, E.MODULE_DID.seat));
                        const seat = reply.state === 'ok' && E.decodeModuleSeat(reply.payload);
                        if (seat && seat.complete) level = seat.level;
                    } catch (e) { record('STATUS ERROR', name + ': ' + e.message); }
                } else {
                    const entry = ctl.readbacks[did];
                    const ackAt = active.deadline - active.duration * 1000;
                    const fresh = entry && entry.at > ackAt && now - entry.at < 1500;
                    if (fresh || await ctl.read(did, { callTimeoutMs: 2300, hardTimeoutMs: 3000 })) level = bdcLevel(did);
                }
                if (!vehicleReportsOn || ignition !== cycle.onAt || !auto.active.has(name)) return;
                const requested = active.on.level || 1;
                const source = module ? module.id + ' D714' : 'BDC ' + did.toString(16).toUpperCase();
                const wheel = side === 'wheel' && decodeWheelEntry(ctl.readbacks[did]);
                const confirmed = level === requested && (side !== 'wheel' || wheel && wheel.currentAmps > 0);
                deviceStatus.set(name, { ...previous, level, source, requested, at: Date.now(),
                    confirmedAt: previous && previous.confirmedAt || (confirmed ? Date.now() : null),
                    nextRead: Date.now() + (confirmed ? 15000 : 5000) });
                if (confirmed && cycle.channels[name] !== 'confirmed') {
                    markChannel(name, 'confirmed');
                    ctx.settings.set('_autoCycleAt', Date.now());
                    record('ACTIVATION CONFIRMED', name + ' via ' + source);
                } else if (level !== null && level !== requested && cycle.channels[name] === 'confirmed') {
                    markChannel(name, 'manual');
                    forgetSeatModuleActivation(name);
                    record('MANUAL OVERRIDE', name + ' changed at ' + source);
                }
            }
        }

        function decodeWheelEntry(entry) {
            return entry && entry.ok ? B.decodeWheelReadback(entry.payload) : null;
        }

        function wheelReportsIdle(state) {
            return state && !state.on && state.led !== true && state.currentAmps === 0 && state.coded === true;
        }

        // Verify the actuator after an ACK even with the Diagnostics tab closed.
        async function checkSteeringWheel() {
            const check = wheelCheck, device = 'Steering wheel';
            if (!check || Date.now() < check.nextReadAt || !auto.active.has(device) ||
                !acknowledged.has(device) || !ctl.online) return;
            const ok = await ctl.read(B.DID_HEAT, { callTimeoutMs: 2300, hardTimeoutMs: 3000 });
            if (wheelCheck !== check) return;
            const entry = ctl.readbacks[B.DID_HEAT];
            const state = ok ? decodeWheelEntry(entry) : null;
            record('WHEEL READBACK', (state ? B.readbackLabel(state, false) : 'Status unavailable') +
                ' | ' + (entry && (entry.raw || entry.error) || ctl.info));

            check.nextReadAt = Date.now() + WHEEL_STATUS_READ_MS;
            if (!check.startIntent || cycle.channels[device] === 'confirmed') return;
            const original = check.startIntent;
            if (Date.now() >= original.startUntil || !wheelReportsIdle(state)) {
                check.startIntent = null;
                return;
            }
            if (++check.offReads < 2) {
                check.nextReadAt = Date.now() + WHEEL_START_READ_MS;
                return;
            }
            // Allow one recovery after two explicit OFF/zero-current readings.
            // The app keeps the original deadline and never retries a timeout.
            check.startIntent = null;
            const seconds = Math.min(original.data.seconds, auto.remaining(device, Date.now()));
            if (seconds <= 0) return;
            record('WHEEL RECOVERY', 'BDC still reports OFF after two readings; one guarded start retry');
            await sendIntent(Object.assign({}, original, { data: { seconds }, wheelRecovery: true }));
        }

        function forgetSeatModuleActivation(name) {
            seatModuleActivations.delete(name);
            auto.active.delete(name);
            acknowledged.delete(name);
            pendingStops.delete(name);
            stopAttempts.delete(name);
        }

        async function sendSeatModuleIntent(intent) {
            const name = intent.device;
            const side = E.DEVICE_KEY[name], module = E.SEAT_MODULES[side];
            const starting = intent.type === 'ON', stopping = intent.type === 'OFF';
            const generation = cancelGeneration, ignition = cycle.onAt;
            const activation = seatModuleActivations.get(name);
            const active = auto.active.get(name);
            intent.retryable = false;
            if (!starting && !activation) return false;
            const level = starting ? intent.data.level : activation.level;

            const allowed = () => {
                const now = Date.now();
                if (!vehicleReportsOn || cycle.mode !== 'on' || cycle.onAt !== ignition) return false;
                const age = activation && seatModuleActivations.get(name) === activation && activation.ignition === ignition ?
                    now - activation.sentAt : Infinity;
                if (stopping) return age >= 0 && age < SEAT_MODULE_STOP_MAX_AGE_MS;
                const c = config();
                if (generation !== cancelGeneration || !cycle.mayContinue() || !permitted() ||
                    !c[module.seatSetting] || c.seatLevel !== level || !viaSeatModule(c, side)) return false;
                if (starting) {
                    const temp = tempReading(now);
                    return now < intent.startUntil && temp.value !== null && temp.value <= c.belowTemp &&
                        temp.at <= now && now - temp.at <= 120000;
                }
                return active && now < active.deadline && age >= 0 && age < SEAT_MODULE_MAX_RENEW_AGE_MS;
            };

            if (stopping && Date.now() - activation.sentAt >= SEAT_MODULE_STOP_MAX_AGE_MS) {
                forgetSeatModuleActivation(name);
                record('STOP UNCONFIRMED', name + ': ' + module.id + ' activation timed out of app tracking');
                return false;
            }
            const remaining = 3000 - (Date.now() - ctl.lastWriteAt);
            if (remaining > 0 && allowed()) await wait(remaining);
            const result = await ctl.autoWriteSeatModule(side, stopping ? 0 : level, starting ? 0 : level, allowed,
                () => !starting || markChannel(name, 'sent'));
            const ok = result.state === 'acknowledged';
            const outcome = module.id + ' ' + (ok ? 'ACK' : result.state.toUpperCase());
            lastAction = outcome + ': ' +
                name + ' ' + intent.type + ' (D714): ' + result.detail;
            record(ok ? 'ECU ACK' : outcome, lastAction);
            if (cycle.mode !== 'on' || cycle.onAt !== ignition) return false;

            if (starting && result.state === 'different') {
                markChannel(name, 'manual');
                deviceStatus.set(name, { level: result.level, source: module.id + ' D714', at: Date.now() });
            }
            if (starting && !ok) {
                const transientNrc = [0x21, 0x22, 0x25].includes(result.nrc);
                if (transientNrc && result.state === 'rejected') markChannel(name, null);
                intent.retryable = allowed() && (transientNrc || result.sentAt == null &&
                    result.nrc == null && ['blocked', 'unreadable'].includes(result.state));
            }
            if (result.state === 'different' || (stopping && ok)) {
                // The current level differs from our own, or our OFF was accepted.
                // In either case the app has no activation left to manage.
                if (activation) forgetSeatModuleActivation(name);
                return ok;
            }
            if (ok) {
                const stopRequested = !allowed();
                seatModuleActivations.set(name, { ignition, level, sentAt: result.sentAt });
                acknowledged.add(name);
                if (starting) record('COMMAND SENT', name + ': acknowledged, awaiting live heater status');
                if (stopRequested) pendingStops.add(name);
            } else if (!starting && activation) {
                pendingStops.add(name);
            }
            return ok;
        }

        // A planner event is not a live heater state. Report an actual request
        // only if its ECU positively acknowledged it. The vehicle's physical
        // response remains unverified until an on-car test.
        async function sendIntent(intent) {
            if (intent.type === 'OFF' && !acknowledged.has(intent.device)) return false;
            if (intent.type === 'EXTEND' && cycle.channels[intent.device] !== 'confirmed') return false;
            if (intent.data.viaSeatModule || (intent.type === 'OFF' &&
                seatModuleActivations.has(intent.device))) return sendSeatModuleIntent(intent);
            // Seat ON/EXTEND only on a verified BDC route (checked again right
            // before the write). OFF of our own acknowledged ON is never blocked.
            const routeOk = () => intent.type === 'OFF' || E.allows(ecuProfile, intent.device);
            if (!routeOk()) {
                intent.retryable = false;
                lastAction = intent.device + ' ' + intent.type + ': NOT sent (route ' +
                    E.routeLabel(ecuProfile, E.DEVICE_KEY[intent.device]) + ').';
                record('BLOCK', lastAction);
                return false;
            }
            const generation = cancelGeneration;
            const ignition = cycle.onAt;
            intent.retryable = false;
            const startAllowed = () => {
                if (intent.type !== 'ON') return true;
                if (intent.wheelRecovery && (!vehicleReportsOn || !ctl.verifiedFor(B.DID_HEAT) ||
                    !wheelReportsIdle(decodeWheelEntry(ctl.readbacks[B.DID_HEAT])))) return false;
                const c = config(), current = tempReading(Date.now());
                const selected = intent.device === 'Steering wheel' ? c.wheelAuto :
                    intent.device === 'Driver seat' ? c.seatDriver : c.seatPassenger;
                return Date.now() < intent.startUntil && selected &&
                    current.value !== null && Number.isFinite(current.value) &&
                    current.value <= c.belowTemp && Date.now() - current.at <= 120000;
            };
            if (!startAllowed()) return false;
            if (cycle.mode !== 'on' ||
                (intent.type !== 'OFF' && !cycle.mayContinue())) {
                record('BLOCK', intent.device + ' ' + intent.type +
                    ': ignition not ON or manually cancelled');
                return false;
            }
            if (!vehicleReportsOn || !permitted() || !ctl.online || !ctl.motionKnown) {
                intent.retryable = permitted() && startAllowed();
                lastAction = intent.device + ': NOT sent (permission / BDC / speed-signal check).';
                ctx.log.warn('[AUTO BLOCKED] ' + lastAction);
                record('BLOCK', lastAction);
                return false;
            }
            const data = intent.device === 'Steering wheel'
                ? B.heating(intent.data.seconds)
                : B.seat(intent.data.side, intent.data.level,
                    intent.type === 'OFF' ? 0 : intent.data.seconds);

            const did = (data[0] << 8) | data[1];
            // Require a positive read of the intended heater, not another heater.
            // The command can run while moving, but stale speed data blocks it.
            const remaining = 3000 - (Date.now() - ctl.lastWriteAt);
            if (remaining > 0) await wait(remaining);
            if (!permitted() || !ctl.motionKnown || !ctl.online || !startAllowed() ||
                cycle.mode !== 'on' || cycle.onAt !== ignition || (intent.type !== 'OFF' &&
                    (generation !== cancelGeneration || !cycle.mayContinue()))) {
                intent.retryable = permitted() && cycle.mode === 'on' && cycle.onAt === ignition &&
                    generation === cancelGeneration && cycle.mayContinue() && startAllowed();
                lastAction = intent.device + ': NOT sent (conditions changed).';
                record('BLOCK', lastAction);
                return false;
            }
            if (!ctl.verifiedFor(did)) await ctl.read(did);
            if (!ctl.verifiedFor(did) || !ctl.motionKnown || !permitted() || !startAllowed() ||
                cycle.mode !== 'on' || cycle.onAt !== ignition || (intent.type !== 'OFF' &&
                    (generation !== cancelGeneration || !cycle.mayContinue()))) {
                intent.retryable = permitted() && cycle.mode === 'on' && cycle.onAt === ignition &&
                    generation === cancelGeneration && cycle.mayContinue() && startAllowed() &&
                    (!ctl.verifiedFor(did) ? ctl.readRetryable :
                        !ctl.motionKnown);
                lastAction = intent.device + ': NOT sent (DID 0x' + did.toString(16).toUpperCase() + ': ' + ctl.info + ').';
                record('BLOCK', lastAction);
                return false;
            }
            const stillAllowed = () => vehicleReportsOn && routeOk() && permitted() && ctl.online && ctl.motionKnown &&
                cycle.mode === 'on' && cycle.onAt === ignition && startAllowed() && (intent.type === 'OFF' ||
                    (generation === cancelGeneration && cycle.mayContinue()));
            const attemptWrite = async attempt => {
                if (!stillAllowed()) return { ok: false, nrc: null, blocked: true };
                if (!ctl.verifiedFor(did)) await ctl.read(did);
                if (!stillAllowed() || !ctl.verifiedFor(did)) {
                    intent.retryable = stillAllowed() && ctl.readRetryable;
                    return { ok: false, nrc: null, blocked: true };
                }
                if (intent.type === 'OFF' && cycle.channels[intent.device] === 'confirmed') {
                    const info = deviceStatus.get(intent.device);
                    const level = bdcLevel(did);
                    if (level === null) return { ok: false };
                    if (info && level > 0 && level !== info.requested) {
                        markChannel(intent.device, 'manual');
                        acknowledged.delete(intent.device);
                        return { ok: false };
                    }
                }
                if (intent.type === 'EXTEND' && bdcLevel(did) !== (intent.data.level || 1)) return { ok: false };
                if (intent.type === 'ON' && !intent.wheelRecovery) {
                    const current = bdcLevel(did);
                    if (current === null) { intent.retryable = true; return { ok: false }; }
                    if (current > 0) {
                        markChannel(intent.device, 'manual');
                        deviceStatus.set(intent.device, { level: current, source: 'BDC ' + did.toString(16).toUpperCase(), at: Date.now() });
                        return { ok: false };
                    }
                }
                const accepted = await ctl.autoWrite(data, intent.device + ' ' + intent.type,
                    () => intent.type !== 'ON' || markChannel(intent.device, 'sent'));
                lastAction = (accepted ? 'BDC ACK' : 'NOT CONFIRMED') + ': ' + intent.device + ' ' +
                    intent.type + ' (2E ' + bytes(data) + ') attempt=' + attempt;
                ctx.log.info('[AUTO LIVE] ' + lastAction);
                record(accepted ? 'ECU ACK' : 'ECU REJECT', lastAction + ' [' + ctl.info + ']');
                const refused = !accepted && intent.type === 'ON' && [0x21, 0x22, 0x25].includes(ctl.lastNrc);
                if (refused && cycle.onAt === ignition && cycle.mode === 'on') markChannel(intent.device, null);
                intent.retryable = !accepted && stillAllowed() &&
                    (refused || (!ctl.lastWriteAttempted &&
                        /busy|cooldown|unavailable|stale|read target bdc/i.test(ctl.info)));
                if (!accepted && ctl.lastWriteAttempted && ctl.lastNrc === null)
                    record('WRITE UNCONFIRMED', intent.device + ': outcome unknown; no blind ON retry');
                return { ok: accepted, nrc: ctl.lastNrc };
            };
            const initialWheelState = intent.device === 'Steering wheel' && intent.type === 'ON' ?
                decodeWheelEntry(ctl.readbacks[B.DID_HEAT]) : null;
            const result = await attemptWrite(intent.attempt || 1);
            const ok = result.ok;
            if (ok && (intent.type === 'ON' || intent.type === 'EXTEND')) acknowledged.add(intent.device);
            if (ok && intent.type === 'OFF') acknowledged.delete(intent.device);
            if (ok && intent.device === 'Steering wheel' && cycle.mode === 'on' && cycle.onAt === ignition &&
                generation === cancelGeneration) {
                const sentAt = Date.now();
                wheelCheck = intent.type === 'OFF' ? null : {
                    sentAt, nextReadAt: sentAt + WHEEL_START_READ_MS, offReads: 0,
                    startIntent: !intent.wheelRecovery && wheelReportsIdle(initialWheelState) ? intent : null,
                };
            }
            // A UI cancellation can occur while a UDS write is awaiting its
            // ACK. In that case queue a guarded OFF at the next control step.
            if (ok && intent.type !== 'OFF' && generation !== cancelGeneration && cycle.mode === 'on')
                pendingStops.add(intent.device);
            if (cycle.mode !== 'on') {
                acknowledged.clear();
                pendingStops.clear();
                stopAttempts.clear();
            }
            if (ok && intent.type === 'ON' && !intent.wheelRecovery) {
                record('COMMAND SENT', intent.device + ': acknowledged, awaiting live heater status');
            }
            // A positive 0x2E ACK does not prove that physical heating began.
            // Read the independent seat status DID after the accepted request
            // so silent non-activation is visible in the session console.
            if (ok && intent.type === 'ON' &&
                (intent.device === 'Driver seat' || intent.device === 'Passenger seat') &&
                cycle.mode === 'on' && ctl.online) {
                const readbackSession = sessionStartedAt;
                await wait(900);
                if (cycle.mode === 'on' && ctl.online && sessionStartedAt === readbackSession) {
                    const did = intent.device === 'Driver seat' ?
                        B.DID_SEAT_DRIVER : B.DID_SEAT_PASSENGER;
                    const readOk = await ctl.read(did);
                    const feedback = ctl.readbacks[did];
                    const decoded = readOk && feedback ? B.decodeSeatReadback(feedback.payload) : null;
                    const detail = readOk && feedback ? feedback.raw :
                        (feedback && feedback.error || ctl.info);
                    const state = decoded ? 'reportedOn=' + decoded.on +
                        ' level=' + decoded.level + ' reduced=' + decoded.consumptionReduced +
                        ' emergency=' + decoded.emergency + ' timedOut=' + decoded.timedOut :
                        'state not decoded';
                    if (sessionStartedAt === readbackSession)
                        record('SEAT READBACK', intent.device + ' DID 0x' + did.toString(16).toUpperCase() +
                            ': ' + state + ' | ' + detail);
                }
            }
            return ok;
        }

        // Read independently of the planner and the last 2E commands.
        // BDC_G05.prg explicitly documents the 22 D074 / E432 / E430
        // result fields and their byte order. Show only valid decoded states.
        async function refreshReadbacks() {
            if (statusBusy || busy || !ctl.online) return;
            statusBusy = true;
            try {
                // D074 always; BDC seat DIDs only where the route can use them
                // (no pointless NRC 0x22 reads on cars with seat modules).
                const dids = [B.DID_HEAT];
                if (E.readsBdcSeat(ecuProfile, 'driver')) dids.push(B.DID_SEAT_DRIVER);
                if (E.readsBdcSeat(ecuProfile, 'passenger')) dids.push(B.DID_SEAT_PASSENGER);
                for (const did of dids) {
                    if (!ctl.online) break;
                    await ctl.read(did);
                    const reply = ctl.readbacks[did];
                    if (reply) {
                        ctx.log.info('[HEATER STATUS SNAPSHOT] DID 0x' +
                            did.toString(16).toUpperCase() + ' ' +
                            (reply.ok ? reply.raw : reply.error));
                        record('READ 0x' + did.toString(16).toUpperCase(),
                            reply.ok ? reply.raw : reply.error);
                    }
                }
                // Installed seat modules / IHKA: read-only D714 per module and
                // ONE shared D8DB snapshot. Never a write gate.
                if (ctl.online && ecuProfile && ['SMFA', 'SMBF', 'IHKA'].some(id =>
                    ecuProfile.ecus[id] && ecuProfile.ecus[id].presence === 'present')) {
                    const snap = await E.readSeatSources((addr, did) => ctl.probe(addr, did), ecuProfile);
                    seatSources = snap;
                    for (const id of ['SMFA', 'SMBF', 'IHKA'])
                        if (snap[id]) record('READ ' + id, E.measurementLine(id, snap[id]).slice(9));
                    mismatchStreak = snap.comparison.verdict === 'differs' ? mismatchStreak + 1 : 0;
                    record('SEAT SOURCES', snap.comparison.verdict + ': ' + snap.comparison.detail +
                        (mismatchStreak >= 2 ? ' (differs in ' + mismatchStreak + ' reads in a row)' : ''));
                }
                statusAt = Date.now();
            } finally { statusBusy = false; }
        }
        setInterval(() => {
            if (tab === 1) refreshReadbacks().catch(e => ctx.log.warn('Readback: ' + e));
        }, 15000);

        // Read-only control-unit detection. Runs once TASU is online: a stored
        // complete profile is reused if the BDC identity (22 F150) still
        // matches; otherwise BDC, seat modules and IHKA are probed again.
        function saveProfile(profile) {
            try {
                ctx.settings.set(E.PROFILE_KEY, E.serialize(profile));
                const disk = JSON.parse(fs.readFileSync(ctx.settings.file, 'utf8'));
                return disk[E.PROFILE_KEY] === E.serialize(profile);
            } catch (e) {
                record('ECU PROFILE SAVE ERROR', String(e && (e.message || e)));
                return false;
            }
        }
        // Retry policy for unresolved routes: at most ECU_ATTEMPTS_PER_IGNITION
        // runs per ignition, >= 30 s apart; afterwards every 10 min. A new
        // verified ignition resets the counter. Confirmed-absent modules are
        // not polled again (see ecu_profile.detect).
        const ECU_RETRY_MS = 30000, ECU_SLOW_RETRY_MS = 600000, ECU_ATTEMPTS_PER_IGNITION = 5;
        async function ensureProfile() {
            if ((ecuDone && !ecuForce) || ecuBusy || busy || statusBusy || !ctl.online) return;
            // The 2nd run confirms silent seat modules (needs >= 20 s gap).
            const spacing = ecuAttempts >= ECU_ATTEMPTS_PER_IGNITION ? ECU_SLOW_RETRY_MS :
                ecuAttempts === 1 ? E.ABSENT_GAP_MS + 500 : ECU_RETRY_MS;
            if (!ecuForce && Date.now() - ecuAttemptAt < spacing) return;
            ecuBusy = statusBusy = true;
            ecuAttemptAt = Date.now();
            ecuAttempts++;
            const forced = ecuForce;
            try {
                let previous = null;
                if (ecuProfile && !forced) {
                    const id = E.classify(E.ID_DID, await ctl.probe(0x40, E.ID_DID));
                    const index = id.state === 'ok' && id.payload.length >= 3 ?
                        id.payload.slice(0, 3).map(n => n.toString(16).toUpperCase().padStart(2, '0')).join('') : null;
                    const decision = E.reuseDecision(ecuProfile, index);
                    if (decision.reuse && decision.verified) {
                        ecuState = 'STORED, VERIFIED';
                        ecuDone = true;
                        ecuVerified = true;
                        record('ECU PROFILE', decision.reason + ': ' + E.summary(ecuProfile));
                        return;
                    }
                    if (decision.merge) previous = ecuProfile;
                    record('ECU PROFILE', 'detecting: ' + decision.reason);
                }
                ecuState = 'DETECTING ...';
                const found = await E.detect((addr, did) => ctl.probe(addr, did),
                    { appVersion: ctx.spec && ctx.spec.version || null, previous });
                ecuForce = false;
                ecuVerified = found.ecus.BDC.state === 'ok' && !!found.ecus.BDC.index;
                if (!found.ecus.BDC.present) {
                    ecuState = ecuProfile ? 'STORED (BDC not reachable)' : 'NOT DETECTED (BDC not reachable)';
                    record('ECU PROFILE', 'BDC 0x40 did not answer; retry later');
                    return;
                }
                ecuProfile = found;
                const saved = saveProfile(found);
                ecuDone = found.complete;
                ecuState = (found.complete ? 'DETECTED' : 'DETECTED, ROUTES UNRESOLVED (will retry)') +
                    (saved ? '' : ' / NOT SAVED');
                record('ECU PROFILE', 'detected (run ' + ecuAttempts + '): ' + E.summary(found) + '; saved=' + saved);
                const note = Object.keys(E.CHANNELS).map(key => E.CHANNELS[key].label + ': ' +
                    found.routes[key].route + ' (' + found.routes[key].reason + ')').join(' | ');
                if (note !== lastRouteNote) {
                    const cfg = config();
                    for (const key of Object.keys(E.CHANNELS))
                        record('ECU ROUTE', E.CHANNELS[key].label + ': ' + found.routes[key].route +
                            (found.routes[key].allowsAuto || viaSeatModule(cfg, key) ?
                                ' [automatic allowed]' : ' [no automatic heating]') +
                            ' (' + found.routes[key].reason + ')');
                    lastRouteNote = note;
                }
            } catch (e) {
                ecuVerified = false;
                ecuState = 'DETECTION ERROR';
                record('ECU PROFILE ERROR', String(e && (e.message || e)));
            } finally { ecuBusy = statusBusy = false; }
        }
        setInterval(() => { ensureProfile().catch(e => ctx.log.warn('ECU profile: ' + e)); }, 3000);
        function redetect() {
            if (ecuBusy) return;
            ecuForce = true;
            ecuDone = false;
            ecuAttempts = 0;
            ecuState = 'DETECTION REQUESTED';
            record('ECU PROFILE', 'manual re-detection requested');
        }

        function seatRoutePending(cfg, side) {
            const r = ecuProfile && ecuProfile.routes[side];
            return !r || r.route === 'unresolved' || r.route === 'unknown' ||
                (!ecuVerified && E.allowsSeatModule(ecuProfile, cfg, side));
        }

        async function autoStep() {
            if (busy || statusBusy) return;
            busy = true;
            try {
                const now = Date.now(), cfg = config(), reading = tempReading(now);
                cfg.seatModuleRoutes = { driver: viaSeatModule(cfg, 'driver'), passenger: viaSeatModule(cfg, 'passenger') };
                cfg.pendingSeatRoutes = {
                    driver: seatRoutePending(cfg, 'driver'), passenger: seatRoutePending(cfg, 'passenger'),
                };
                const skipped = E.applyRoutes(cfg, ecuProfile);
                const skipNote = skipped.join('; ');
                if (skipNote !== lastSkipNote) {
                    if (skipNote) record('SKIP', skipNote + ' -> not planned, no request');
                    lastSkipNote = skipNote;
                }
                // Stop using a seat route as soon as it ceases to be eligible.
                // An OFF request still uses the route of our acknowledged ON.
                for (const name of ['Driver seat', 'Passenger seat']) {
                    const active = auto.active.get(name);
                    if (!active || active.pending) continue;
                    const side = E.DEVICE_KEY[name], module = E.SEAT_MODULES[side];
                    const usesSeatModule = active.on.viaSeatModule;
                    if (usesSeatModule ? cfg.seatModuleRoutes[side] && cfg[module.seatSetting] && vehicleReportsOn &&
                        cfg.seatLevel === active.on.level : E.allows(ecuProfile, name))
                        continue;
                    auto.active.delete(name);
                    if (acknowledged.has(name)) {
                        pendingStops.add(name);
                        stopAttempts.set(name, 0);
                    }
                    record('ROUTE CHANGED', name + ': ' + E.routeLabel(ecuProfile, E.DEVICE_KEY[name]) +
                        '; automatic seat stopped' + (acknowledged.has(name) ?
                            ', ' + (usesSeatModule ? module.id : 'BDC') + ' OFF queued' : ''));
                }
                const ignition = cycle.onAt;
                cfg.startUntil = ignition + START_WINDOW_MS;
                // STOP has priority over any new work. OFF writes are limited
                // to heaters with a positive ACK for our own earlier ON/EXTEND.
                for (const name of Array.from(pendingStops)) {
                    if (cycle.mode !== 'on') { pendingStops.delete(name); continue; }
                    const off = name === 'Steering wheel' ? { seconds: 0 } :
                        { side: name === 'Driver seat' ? 'driver' : 'passenger', level: 0 };
                    const attempts = (stopAttempts.get(name) || 0) + 1;
                    stopAttempts.set(name, attempts);
                    const ok = await sendIntent({ device: name, type: 'OFF', data: off });
                    if (ok || !acknowledged.has(name) || attempts >= 3) {
                        pendingStops.delete(name);
                        stopAttempts.delete(name);
                        if (!ok && acknowledged.has(name)) {
                            record('STOP UNCONFIRMED', name + ': 3 bounded attempts failed; use BMW physical button');
                            if (seatModuleActivations.has(name)) forgetSeatModuleActivation(name);
                        }
                    }
                }
                const canStart = vehicleReportsOn && cfg.autoEnabled && permitted() && cycle.canStart() &&
                    now < cfg.startUntil && ctl.online && ctl.motionKnown;
                // Start, extend or stop a confirmed comfort-heating cycle while
                // moving as long as speed data are fresh and BDC accepts writes.
                const enabledForPlanner = cfg.autoEnabled && cycle.mayContinue() &&
                    (canStart || auto.active.size > 0);
                // Each seat can wait for its route through the normal
                // ignition start window while a verified channel starts.
                const isWaiting = (name, side) => (!auto.fired || auto.active.has(name)) &&
                    cfg[E.SEAT_MODULES[side].seatSetting] && cfg.pendingSeatRoutes[side];
                const awaitingRoutes = enabledForPlanner && now < cfg.startUntil &&
                    (isWaiting('Driver seat', 'driver') || isWaiting('Passenger seat', 'passenger'));
                const plannerStatus = !cfg.autoEnabled ? 'OFF (setting)'
                    : awaitingRoutes ? 'WAITING FOR CONTROL-UNIT DETECTION'
                    : cycle.mode !== 'on' ? 'WAITING FOR VERIFIED VEHICLE ON'
                    : !cycle.mayContinue() ? 'MANUALLY CANCELLED THIS DRIVE'
                    : !auto.fired && !cycle.canStart() ? cycle.reason
                    : reading.value === null ? 'WAITING FOR TEMP'
                    : now - reading.at > 120000 ? 'STALE TEMP'
                    : !ctl.online ? 'NO TASU CONNECTION'
                    : !ctl.motionKnown ? 'NO FRESH SPEED'
                    : Array.from(auto.active.values()).some(s => s.pending) ? 'START RETRY PENDING'
                    : auto.active.size ? 'HEATING COMMANDS UNDER MONITORING'
                    : auto.fired ? 'START PLAN FINISHED FOR THIS DRIVE'
                    : now >= cfg.startUntil ? 'START WINDOW EXPIRED' :
                        reading.value > cfg.belowTemp ? 'ABOVE LIMIT' : 'COLD DWELL / READY';
                if (plannerStatus !== lastPlannerStatus) {
                    record('AUTO', plannerStatus + '; T=' +
                        (reading.value === null ? '--' : reading.value.toFixed(1)) +
                        ' C, limit=' + cfg.belowTemp + ' C, min vehicle OFF=' +
                        offMinutes() + 'm; vehicle=' + cycle.mode);
                    lastPlannerStatus = plannerStatus;
                }
                const pendingBefore = Array.from(auto.active).filter(([, s]) => s.pending).map(([name]) => name);
                const intents = auto.step({ now, tempC: reading.value, tempAt: reading.at,
                    cfg: Object.assign({}, cfg, { autoEnabled: enabledForPlanner }) });
                for (const name of pendingBefore) {
                    if (!auto.active.has(name)) record('START EXPIRED', name + ': retry window ended or settings changed');
                }
                for (const intent of intents)
                    record('PLAN', intent.device + ' ' + intent.type +
                        ' planned (NOT YET ECU CONFIRMED)');
                for (const intent of intents) {
                    if (cycle.onAt !== ignition || cycle.mode !== 'on') break;
                    if (intent.type === 'ON' && cycle.channels[intent.device]) {
                        auto.active.delete(intent.device);
                        continue;
                    }
                    const ok = await sendIntent(intent);
                    if (cycle.onAt !== ignition || cycle.mode !== 'on') break;
                    const at = ok && intent.data.viaSeatModule ?
                        seatModuleActivations.get(intent.device).sentAt : Date.now();
                    auto.acknowledge(intent, ok, at, intent.retryable === true);
                    if (intent.type === 'ON' && cycle.channels[intent.device] !== 'manual') {
                        const prior = deviceStatus.get(intent.device);
                        deviceStatus.set(intent.device, { ...prior, attempts: intent.attempt, error: ok ? null : lastAction });
                    }
                    if (intent.type === 'ON' && !ok) {
                        const pending = auto.active.get(intent.device);
                        record(pending && pending.pending ? 'START RETRY' : 'START FAILED',
                            intent.device + ' attempt=' + intent.attempt +
                            (pending && pending.pending ? '; retry after ' + Math.max(0, pending.nextAttemptAt - Date.now()) + 'ms' :
                                '; no further automatic ON this ignition'));
                    }
                }
                await checkSteeringWheel();
                await monitorHeaters();
            } catch (e) {
                lastAction = 'Automatic heating error: ' + (e.message || String(e));
                ctx.log.warn(lastAction);
                record('ERROR', lastAction);
            } finally { busy = false; }
        }
        setInterval(() => { autoStep().catch(e => ctx.log.error(e)); }, 1000);
        autoStep().catch(e => ctx.log.error(e));

        ctx.ui.onClick('BTN_PAGE', () => setTab((tab + 1) % TABS.length));
        ctx.ui.onClick('BTN_ACTION', () => {
            if (tab === 0) setTab(1);
            else if (tab === 1) refreshReadbacks().catch(e => { ctl.info = 'Read error: ' + e.message; });
        });
        ctx.ui.onClick('BTN_STOP', stopAutoHeating);
        let consoleTotal = 0;
        const consoleMove = delta => {
            consoleOffset = Math.max(0, Math.min(Math.max(0, consoleTotal - 13),
                consoleOffset + delta));
        };
        ctx.ui.onClick('BTN_LOG_UP', () => { if (tab === 2) consoleMove(12); });
        ctx.ui.onClick('BTN_LOG_DOWN', () => { if (tab === 2) consoleMove(-12); });
        ctx.ui.onClick('BTN_LOG_LATEST', () => { if (tab === 2) consoleOffset = 0; });
        ctx.ui.onClick('BTN_DETECT', redetect);
        ctx.ui.onClick('BTN_AUTO_STATUS', () => { if (tab === 1) showAutoStatus = !showAutoStatus; });
        const nextFilter = () => { filter = (filter + 1) % filters.length; consoleOffset = 0; };
        ctx.ui.onClick('BTN_LOG_FILTER', () => { if (tab === 2) nextFilter(); });
        if (typeof ctx.onTap === 'function') ctx.onTap((x, y) => {
            if (tab === 2 && y >= 121 && y <= 169) {
                if (x >= 650 && x < 895) nextFilter();
                else if (x >= 906 && x < 1092) consoleMove(12);
                else if (x >= 1102 && x < 1288) consoleMove(-12);
                else if (x >= 1298 && x < 1537) consoleOffset = 0;
            } else if (tab === 1 && x >= 920 && x < 1210 && y >= 112 && y <= 165) {
                showAutoStatus = !showAutoStatus;
            } else if (tab === 1 && x >= 1236 && x < 1546 && y >= 112 && y <= 165)
                redetect();
        });
        if (typeof ctx.onTouch === 'function') ctx.onTouch((phase, x, y) => {
            if (tab !== 2) { consoleTouchY = null; return; }
            if (phase === 1 && x >= 45 && x <= 1540 && y >= 180 && y <= 475)
                consoleTouchY = y;
            else if (phase === 3 && consoleTouchY !== null) {
                const dy = y - consoleTouchY;
                if (Math.abs(dy) > 18) consoleMove(Math.round(dy / 22));
                consoleTouchY = null;
            }
        });
        if (typeof ctx.onTab === 'function') ctx.onTab(setTab);
        ctl.init().catch(e => { ctl.info = 'TASU unavailable: ' + e; });
        setInterval(() => ctl.retryConnection(), 10000);

        ctx.loop('MAIN', 5, () => {
            const t = ctx.theme(), cv = ctx.canvas(1600, 520).clear(t.bg);
            const now = Date.now(), c = config(), r = tempReading(now);
            const fresh = r.value !== null && now - r.at <= 120000;
            const temp = fresh ? r.value.toFixed(1) + ' °C' : 'unavailable';
            const startReady = c.autoEnabled && permitted() && cycle.canStart() &&
                now < cycle.onAt + START_WINDOW_MS &&
                ctl.online && ctl.motionKnown && fresh;
            const status = !c.autoEnabled ? 'AUTOMATION OFF'
                    : Array.from(auto.active.values()).some(s => s.pending) ? 'WAITING FOR ECU / START RETRY'
                    : auto.active.size ? 'AUTOMATIC CYCLE SCHEDULED'
                    : cycle.mode !== 'on' ? 'WAITING FOR VERIFIED IGNITION ON'
                    : !cycle.mayContinue() ? 'CANCELLED FOR THIS DRIVE'
                    : auto.fired ? 'CYCLE FINISHED FOR THIS DRIVE'
                    : !cycle.canStart() ? 'NOT ELIGIBLE THIS DRIVE'
                    : !fresh ? 'WAITING FOR OUTDOOR TEMPERATURE'
                        : !ctl.online ? 'BDC CONNECTION UNAVAILABLE'
                            : !ctl.motionKnown ? 'WAITING FOR VEHICLE SPEED SIGNAL'
                                : 'READY / WAITING FOR COLD';
            G.frame(cv, t, TABS, tab,
                [{ text: auto.active.size ? 'AUTO SCHEDULED' :
                    startReady ? 'AUTO READY' : 'AUTO NOT READY', color: t.dim }]);
            // configured -> skipped (route) -> pending -> ECU ACK. An ACK is not
            // proof of physical heating.
            const blocked = key => !viaSeatModule(c, key) && !E.allows(ecuProfile, key);
            const planText = (key, on, value) => {
                if (!on) return 'Off';
                if (!blocked(key)) return value;
                return key !== 'wheel' && seatRoutePending(c, key) ?
                    'Waiting for control unit' : 'Skipped: ' + E.routeLabel(ecuProfile, key);
            };
            const confirmText = (device, key, on) => {
                if (!on) return 'Off';
                if (cycle.channels[device] === 'manual') return 'manual control';
                const a = auto.active.get(device);
                if (a && a.pending && key !== 'wheel' && seatRoutePending(c, key))
                    return 'waiting for control unit';
                if (blocked(key)) return 'skipped (' + E.routeLabel(ecuProfile, key) + ')';
                if (key === 'wheel' && acknowledged.has(device)) {
                    const entry = ctl.readbacks[B.DID_HEAT];
                    const fresh = wheelCheck && entry && entry.at > wheelCheck.sentAt && now - entry.at <= 30000;
                    const decoded = fresh ? decodeWheelEntry(entry) : null;
                    return B.readbackLabel(decoded, false) || 'BDC ACK (status unconfirmed)';
                }
                if (acknowledged.has(device))
                    return (seatModuleActivations.has(device) ? E.SEAT_MODULES[key].id : 'BDC') + ' ACK (heat not verified)';
                if (a && a.pending) return 'start pending';
                return 'configured';
            };
            if (tab === 0) {
                G.panel(cv, t, 24, 62, 743, 445, 'Automatic heating');
                text(cv, status, 54, 148, 32, auto.active.size ? t.warn : t.accent, { font: 'bold' });
                text(cv, 'Outdoor ' + temp + '    Start at or below ' + c.belowTemp + ' °C',
                    54, 205, 27, t.text);
                cv.fillRect(54, 226, 667, 2, '#2e4052');
                text(cv, 'Steering wheel', 54, 273, 27, t.text);
                text(cv, planText('wheel', c.wheelAuto, c.wheelMins + ' min'), 693, 273, 26,
                    blocked('wheel') && c.wheelAuto ? t.warn : c.wheelAuto ? t.accent : t.dim, { align: 'right' });
                text(cv, 'Driver seat', 54, 319, 27, t.text);
                text(cv, planText('driver', c.seatDriver, 'Level ' + c.seatLevel + ' / ' + c.seatMins + ' min'),
                    693, 319, 25, blocked('driver') && c.seatDriver ? t.warn : c.seatDriver ? t.accent : t.dim, { align: 'right' });
                text(cv, 'Passenger seat', 54, 365, 27, t.text);
                text(cv, planText('passenger', c.seatPassenger, 'Level ' + c.seatLevel + ' / ' + c.seatMins + ' min'),
                    693, 365, 25, blocked('passenger') && c.seatPassenger ? t.warn : c.seatPassenger ? t.accent : t.dim, { align: 'right' });
                if (cycle.testBypass)
                    text(cv, 'One-shot test armed: next ignition ON skips parking time', 54, 470, 20, t.warn);
                G.panel(cv, t, 788, 62, 788, 445, 'Heating overview');
                text(cv, 'BDC  ' + (ctl.online ? 'CONNECTED' : 'UNAVAILABLE'), 820, 149, 29,
                    ctl.online ? t.accent : t.warn, { font: 'bold' });
                text(cv, ('Steering wheel: ' + confirmText('Steering wheel', 'wheel', c.wheelAuto)).slice(0, 52),
                    820, 219, 24, t.text);
                text(cv, ('Driver seat: ' + confirmText('Driver seat', 'driver', c.seatDriver)).slice(0, 52),
                    820, 276, 24, t.text);
                text(cv, ('Passenger seat: ' + confirmText('Passenger seat', 'passenger', c.seatPassenger)).slice(0, 52),
                    820, 333, 24, t.text);
                cv.fillRect(820, 356, 710, 1, '#2e4052');
                text(cv, 'Remaining scheduled time (STOP button cancels)', 820, 406, 22, t.dim);
                text(cv, 'Wheel ' + auto.remaining('Steering wheel', now) + 's   Seats ' +
                    Math.max(auto.remaining('Driver seat', now),
                        auto.remaining('Passenger seat', now)) + 's', 820, 453, 30, t.accent);
                if (ctx.settings.saveError)
                    text(cv, 'Settings could not be saved; see log', 820, 482, 20, t.warn);
            } else if (tab === 1 && showAutoStatus) {
                G.panel(cv, t, 24, 62, 1552, 445, 'AutoHeat status');
                text(cv, 'STATUS / READBACK', 945, 140, 21, t.accent);
                text(cv, 'Background running | start: ' + startReason + ' | vehicle: ' +
                    (vehicleReportsOn ? 'Drive-ready ON' : cycle.mode.toUpperCase()), 54, 140, 22, t.text);
                text(cv, 'Cycle: ' + cycle.source + ' | minimum OFF: ' + offMinutes() + ' min', 54, 190, 22, t.text);
                text(cv, 'Outside ' + temp + ' | limit ' + c.belowTemp + ' °C | ' +
                    (!fresh ? 'temperature unknown' : r.value <= c.belowTemp ? 'condition met' : 'above limit'), 54, 233, 22, t.text);
                const labels = ['Steering wheel', 'Driver seat', 'Passenger seat'];
                labels.forEach((name, index) => {
                    const active = auto.active.get(name), info = deviceStatus.get(name);
                    const selected = [c.wheelAuto, c.seatDriver, c.seatPassenger][index];
                    const requested = !c.autoEnabled || !selected ? 'OFF' : index === 0 ? 'ON' : 'level ' + c.seatLevel;
                    const state = cycle.channels[name] || (active && active.pending ?
                        active.attempts ? 'retry pending' : 'start pending' : info && info.error ? 'failed' : 'no command');
                    const current = info && now >= info.at && now - info.at <= 30000 ? info.level : null;
                    const line = name + ' | requested ' + requested + ' | actual ' +
                        (current != null ? current === 0 ? 'OFF' : index === 0 ? 'ON' : 'level ' + current : 'unknown') +
                        ' | ' + state + (info && info.source ? ' (' + info.source + ')' : '') +
                        ' | attempts ' + (active ? active.attempts : info && info.attempts || 0) + ' | ' + auto.remaining(name, now) + 's';
                    const y = 282 + 42 * index;
                    text(cv, line, 54, y, 20, t.text);
                    if (info && info.error) text(cv, info.error.slice(0, 120), 54, y + 19, 15, t.warn);
                });
                text(cv, ('Next: ' + lastPlannerStatus + ' | ' + cycle.reason).slice(0, 125), 54, 432, 20, t.dim);
                text(cv, lastAction.slice(0, 125), 54, 474, 20, t.dim);
            } else if (tab === 1) {
                G.panel(cv, t, 24, 62, 1552, 445, 'Actual read-back (read-only)');
                text(cv, 'AUTOHEAT STATUS', 945, 140, 21, t.accent);
                text(cv, 'BDC 0x40 / seat modules / IHKA   Service 22   Unavailable is not OFF',
                    54, 138, 24, t.text);
                text(cv, statusBusy ? 'Reading ...' : 'Last read: ' + (statusAt ?
                    Math.round((now - statusAt) / 1000) + 's ago' : 'not yet'), 1236, 186, 19, t.dim);
                cv.fillRect(1236, 112, 310, 40, '#284354');
                text(cv, ecuBusy ? 'DETECTING ...' : 'RE-DETECT ECUs', 1256, 140, 21, t.text);
                // Seat with an installed seat module: show the module's own
                // D714 value. Never OFF unless a fresh, valid level 0 was read.
                const moduleText = id => {
                    const m = seatSources && seatSources[id];
                    if (!m || now - m.at > 30000) return ['No current ' + id + ' reading', t.warn];
                    if (m.state === 'nrc') return ['Unavailable (' + id + ' NRC ' + m.nrc.toString(16).toUpperCase() + ')', t.warn];
                    if (m.state !== 'ok') return ['No reply from ' + id, t.warn];
                    if (!m.decoded) return [id + ': raw only (' + (m.sgbd || 'unknown variant') + ')', t.warn];
                    const lvl = m.decoded.level;
                    return [(lvl ? 'ON  |  Level ' + lvl : 'OFF') + '  (' + id + ' D714' +
                        (m.decoded.complete ? '' : ', partial') + ')', lvl ? t.accent : t.text];
                };
                const readRow = (label, did, y, seat, key) => {
                    const r = ecuProfile && ecuProfile.routes[key];
                    const mod = r && r.module && ecuProfile.ecus[r.module];
                    if (seat && mod && mod.presence === 'present') {
                        const [value, colour] = moduleText(r.module);
                        text(cv, label, 54, y, 25, t.text);
                        text(cv, value, 665, y, 23, colour);
                        return;
                    }
                    if (seat && !E.readsBdcSeat(ecuProfile, key)) {
                        text(cv, label, 54, y, 25, t.text);
                        text(cv, E.routeLabel(ecuProfile, key), 665, y, 23, t.warn);
                        return;
                    }
                    const entry = ctl.readbacks[did];
                    const stale = !entry || now - entry.at > 30000;
                    const decoded = !stale && entry.ok ? (seat ?
                        B.decodeSeatReadback(entry.payload) :
                        B.decodeWheelReadback(entry.payload)) : null;
                    // Show the latest valid ECU state. A normal manual OFF/ON
                    // transition is not evidence of an unstable readback.
                    const detail = !decoded ? (stale ? 'NOT AVAILABLE' :
                        entry.ok ? 'Unsupported reply format' :
                            entry.nrc === 0x22 ? 'Unavailable (NRC 22: conditions)' :
                            entry.nrc === 0x25 ? 'Unavailable (NRC 25: subnet)' :
                            'ECU read rejected / timeout') :
                        B.readbackLabel(decoded, seat);
                    text(cv, label, 54, y, 25, t.text);
                    text(cv, detail, 665, y, 23, decoded ?
                        decoded.on ? t.accent : t.text : t.warn);
                };
                readRow('Steering wheel', B.DID_HEAT, 207, false, 'wheel');
                readRow('Driver seat', B.DID_SEAT_DRIVER, 267, true, 'driver');
                readRow('Passenger seat', B.DID_SEAT_PASSENGER, 327, true, 'passenger');
                cv.fillRect(54, 354, 1450, 1, '#2e4052');
                text(cv, ('Control units: ' + ecuState + '   ' +
                    (ecuProfile ? E.summary(ecuProfile).split(' || ')[0] : '')).slice(0, 118),
                    54, 400, 21, ecuProfile ? t.text : t.warn);
                const ih = seatSources && seatSources.IHKA && now - seatSources.IHKA.at <= 30000 ? seatSources.IHKA : null;
                const ihText = !ih ? (ecuProfile && ecuProfile.ecus.IHKA && ecuProfile.ecus.IHKA.presence === 'present' ?
                    'IHKA D8DB: no current reading' : 'IHKA: not used') :
                    ih.state !== 'ok' ? 'IHKA D8DB: ' + (ih.state === 'nrc' ? 'NRC ' + ih.nrc.toString(16).toUpperCase() : 'no reply') :
                    !ih.decoded ? 'IHKA D8DB: raw only (' + (ih.sgbd || 'unknown variant') + ')' :
                    'IHKA D8DB seat heat  left ' + (ih.decoded.left === null ? '?' : ih.decoded.left) +
                    '  right ' + (ih.decoded.right === null ? '?' : ih.decoded.right) +
                    '   |   ' + seatSources.comparison.verdict + ': ' + seatSources.comparison.detail;
                text(cv, ihText.slice(0, 120), 54, 448, 21,
                    ih && seatSources.comparison.verdict === 'differs' && mismatchStreak >= 2 ? t.warn : t.dim);
                text(cv, 'Outside sensor: ' + (outside.raw === null ? 'unavailable' :
                    'raw ' + outside.raw + ' -> ' + outside.value.toFixed(1) + ' °C') +
                    '   |   start threshold ' + c.belowTemp + ' °C',
                54, 486, 20, t.dim);
            } else if (tab === 2) {
                G.panel(cv, t, 24, 62, 1552, 445, 'Live console / this vehicle session');
                if (now - warningCacheAt > 2500) {
                    warningCacheAt = now;
                    warningCache = Log.sessionWarnings(ctx, sessionStartedAt, 150);
                }
                const lines = Log.consoleLines(Log.filterEvents(events.concat(warningCache), filters[filter]), [], sessionStartedAt);
                consoleTotal = lines.length;
                consoleOffset = Math.min(consoleOffset, Math.max(0, consoleTotal - 13));
                const start = Math.max(0, lines.length - 13 - consoleOffset);
                const controls = (x, w, label) => {
                    cv.fillRect(x, 125, w, 40, '#284354');
                    text(cv, label, x + 18, 152, 21, t.text);
                };
                text(cv, 'SESSION ' + new Date(sessionStartedAt).toISOString().slice(11, 19) +
                    ' UTC  |  ' + sessionReason, 53, 152, 19, t.dim);
                controls(650, 245, filters[filter].toUpperCase());
                controls(906, 186, 'OLDER');
                controls(1102, 186, 'NEWER');
                controls(1298, 239, 'LATEST');
                cv.fillRect(49, 174, 1491, 301, '#101823');
                for (let i = 0; i < 13; i++) {
                    const entry = lines[start + i];
                    if (!entry) break;
                    text(cv, entry.text, 62, 197 + i * 22, 18,
                        entry.error ? t.warn : /ECU ACK|VEHICLE ON|SESSION START/.test(entry.text) ?
                            t.accent : t.text, { font: 'num' });
                }
                text(cv, 'SWIPE UP/DOWN or use OLDER/NEWER | ' + lines.length +
                    ' lines | ' + (start + 1) + '-' + Math.min(start + 13, lines.length),
                56, 495, 17, t.dim);
            }
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
