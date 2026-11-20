'use strict';

const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const B = require('./logic');
const { ComfortAuto, START_WINDOW_MS, SEAT_MODULE_MAX_RENEW_AGE_MS } = require('./comfort_auto');
const { SafeDiag, bytes } = require('./safe_diag');
const QR = require('./qr_log');
const Cycle = require('./cycle_policy');
const E = require('./ecu_profile');

// Settings is automatically provided as ONE native tab by the renderer.
const TABS = ['Comfort', 'Diagnostics', 'Log', 'QR Log'];
const text = (cv, s, x, y, size, color, opts) =>
    cv.text(String(s), x, y, size, color, opts || {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SEAT_MODULE_STOP_MAX_AGE_MS = 110000;

mgu.run({
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
        const cycle = new Cycle.VehicleCycle({
            offAt: ctx.settings.get('_vehicleOffAt'),
            onAt: ctx.settings.get('_vehicleOnAt'),
            usedOnAt: ctx.settings.get('_vehicleCycleUsedOnAt'),
            cancelledOnAt: ctx.settings.get('_vehicleCancelledOnAt'),
        }, offMinutes(), testConsumed);
        // A process restart during driving is not a new car ignition.
        auto.fired = true;
        let cycleReason = cycle.reason;
        const outside = { value: null, at: 0, raw: null };
        const acknowledged = new Set();
        const seatModuleActivations = new Map();
        let seatModuleVehicleOn = false;
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
        let qrReport = null, qrPage = 0, qrMatrix = null, qrError = '';
        let consoleOffset = 0, consoleTouchY = null;
        let warningCache = [], warningCacheAt = 0;
        let eventWriteError = '';
        const record = (kind, message) => {
            const at = Date.now();
            if (events[0] && events[0].kind === kind &&
                events[0].message === message && at - events[0].at < 15000) return;
            events.unshift({ at, kind, message: String(message).slice(0, 320) });
            events = events.slice(0, 350);
            try {
                // Event log uses the same app-private data dir; no directory creation.
                fs.writeFileSync(eventFile, JSON.stringify(events), 'utf8');
                eventWriteError = '';
            } catch (e) { eventWriteError = String(e.message || e); }
            ctx.log.info('[HEAT EVENT] ' + kind + ' ' + message);
        };
        const resetSession = reason => {
            sessionStartedAt = Date.now();
            sessionReason = reason;
            events = [];
            qrReport = null;
            qrMatrix = null;
            qrPage = 0;
            qrError = '';
            consoleOffset = 0;
            warningCache = [];
            warningCacheAt = 0;
            record('SESSION START', reason + '; previous QR pages discarded');
        };
        function persistCycle() {
            const state = cycle.snapshot();
            const updates = {
                _vehicleOffAt: state.offAt,
                _vehicleOnAt: state.onAt,
                _vehicleCycleUsedOnAt: state.usedOnAt,
                _vehicleCancelledOnAt: state.cancelledOnAt,
            };
            try {
                ctx.settings.setMany(updates);
                const saved = JSON.parse(fs.readFileSync(ctx.settings.file, 'utf8'));
                if (!Object.keys(updates).every(k => saved[k] === updates[k]))
                    throw new Error('Ignition/cancel markers not verified on disk');
                return true;
            } catch (e) {
                record('STATE SAVE ERROR', String(e && (e.message || e)));
                return false;
            }
        }
        record('PROCESS START', 'reason=' + startReason + ' pid=' + process.pid +
            ' at=' + new Date(appStartedAt).toISOString() +
            ' (NOT proof the UI was opened)');
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
                    ' opens=' + uiOpenCount + ' autoAlreadyFired=' + auto.fired);
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

        function buildQrReport() {
            try {
                const now = Date.now();
                const marker = Number(ctx.settings.get('_autoCycleAt'));
                qrReport = QR.createReport(ctx, {
                    events, eventWriteError, sessionStartedAt, sessionReason,
                    seatReads: seatHistory.map(snap => ({ at: snap.at,
                        lines: ['SMFA', 'SMBF', 'IHKA'].filter(id => snap[id])
                            .map(id => E.measurementLine(id, snap[id])),
                        comparison: snap.comparison })),
                    state: {
                        appStartedAt: new Date(appStartedAt).toISOString(),
                        processStartReason: startReason, firstUiAt: firstUiAt ?
                            new Date(firstUiAt).toISOString() : null, uiOpenCount,
                        cycleReason, cycleAlreadyRun: auto.fired,
                        vehicleCycle: cycle.snapshot(), vehicleMode: cycle.mode,
                        vehicleCycleCanStart: cycle.canStart(),
                        minVehicleOffMinutes: offMinutes(),
                        oneShotTestRequestedAtStartup: testRequested,
                        oneShotTestAppliedAtStartup: testConsumed,
                        oneShotTestResetError: testError || null,
                        previousPositiveAckOnAt: Number.isFinite(marker) && marker > 0 ?
                            new Date(marker).toISOString() : null,
                        markerAgeSeconds: Number.isFinite(marker) && marker > 0 ?
                            Math.round((now - marker) / 1000) : null,
                        noRepeatsWithinIgnition: true,
                        manualStopPending: Array.from(pendingStops),
                        coldDwellStart: auto.coldSince,
                        activeHeaters: Array.from(auto.active).map(([name, state]) =>
                            ({ name, deadline: state.deadline, nextRenewAt: state.nextRenewAt })),
                        lastPlannerStatus, lastAction,
                        outsideTemperature: outside,
                        speedKmh: ctl.speed, speedAgeMs: ctl.speedAt ? now - ctl.speedAt : null,
                        bdcOnline: ctl.online, bdcReadVerified: ctl.verified,
                        speedFresh: ctl.motionKnown, bdcMessage: ctl.info,
                        lastBdcWriteAt: ctl.lastBdcWriteAt, bdcReadbacks: ctl.readbacks,
                        seatModuleActivations: Object.fromEntries(seatModuleActivations),
                        oneShotTestArmed: cycle.testBypass,
                        ecuProfileState: ecuState, ecuProfile,
                        seatSourceComparison: seatSources && seatSources.comparison,
                    },
                });
                qrPage = 0;
                qrMatrix = QR.matrix(qrReport.pages[0]);
                qrError = '';
            } catch (e) {
                qrReport = null;
                qrMatrix = null;
                qrError = String(e && e.message || e);
                ctx.log.warn('QR diagnostic export failed: ' + qrError);
            }
        }
        // Include the current measurement: one read-only refresh, then build.
        // If the channel is busy or offline, build from what is there.
        function freshQrReport() {
            if (!ctl.online || statusBusy || busy) { buildQrReport(); return; }
            refreshReadbacks().catch(e => ctx.log.warn('QR refresh: ' + e))
                .then(() => { if (tab === 3) buildQrReport(); });
        }
        function nextQrPage() {
            if (!qrReport) { buildQrReport(); return; }
            try {
                qrPage = (qrPage + 1) % qrReport.pages.length;
                qrMatrix = QR.matrix(qrReport.pages[qrPage]);
                qrError = '';
            } catch (e) {
                qrError = String(e && e.message || e);
                ctx.log.warn('QR page encoding failed: ' + qrError);
            }
        }
        let testArmedAt = testConsumed ? Date.now() : 0;
        // Control-unit profile: loaded from settings, verified/detected once
        // TASU is online, stored again for the next start.
        let ecuProfile = E.load(ctx.settings.get(E.PROFILE_KEY));
        let ecuState = ecuProfile ? 'STORED (not yet verified)' : 'NOT DETECTED';
        let ecuBusy = false, ecuDone = false, ecuVerified = false, ecuForce = false;
        let ecuAttemptAt = 0, ecuAttempts = 0;
        let lastRouteNote = '';
        let lastSkipNote = '';
        // Read-only seat sources (SMFA/SMBF D714, IHKA D8DB): latest snapshot
        // plus a bounded history for the QR export (manual level changes).
        let seatSources = null, mismatchStreak = 0;
        const seatHistory = [];
        const SEAT_HISTORY_MAX = 10;
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
                const enteredQr = tab !== 3 && i === 3;
                tab = i;
                if (enteredQr) freshQrReport();
                if (tab === 1) refreshReadbacks().catch(e => { ctl.info = 'BDC read error: ' + e.message; });
            }
        };

        // Use only a real, fresh MGU outdoor temperature. No test/simulated
        // values can reach the automatic ECU actuator.
        ctx.signals.watch('de.bmw.infrastructure.EnvironmentalInformation', '1', {
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
        }, ctx.log).catch(e => ctx.log.warn('Outdoor temperature: ' + e));

        // This is BMW's vehicle condition, not engine RPM or vehicle speed:
        // Mild-hybrid engine OFF, Auto Start/Stop and speed=0 are NOT parked
        // ignition OFF. A missing provider prevents a new automatic cycle.
        ctx.signals.watch('de.bmw.infrastructure.VehicleCondition', '1', {
            VehicleCondition: value => {
                const raw = value && value.statusConditionVehicle;
                const before = cycle.mode;
                seatModuleVehicleOn = Cycle.condition(raw) === 'on';
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
                    seatModuleActivations.clear();
                    // Only a real ON -> OFF cycle resets the QR log. An
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
        }, ctx.log, { pollMs: 3000 }).then(sub => {
            record('VEHICLE SIGNAL', sub.error ? 'FAILED ' + sub.error :
                'subscription created; provider=' + (sub.available ? 'available' : 'not yet available'));
        }).catch(e => record('VEHICLE SIGNAL ERROR', String(e && (e.message || e))));

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
                if (!seatModuleVehicleOn || cycle.mode !== 'on' || cycle.onAt !== ignition) return false;
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
            const result = await ctl.autoWriteSeatModule(side, stopping ? 0 : level, starting ? 0 : level, allowed);
            const ok = result.state === 'acknowledged';
            const outcome = module.id + ' ' + (ok ? 'ACK' : result.state.toUpperCase());
            lastAction = outcome + ': ' +
                name + ' ' + intent.type + ' (D714): ' + result.detail;
            record(ok ? 'ECU ACK' : outcome, lastAction);
            if (cycle.mode !== 'on' || cycle.onAt !== ignition) return false;

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
                if (starting) ctx.settings.set('_autoCycleAt', result.sentAt);
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
            if (!permitted() || !ctl.online || !ctl.motionKnown) {
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
            const stillAllowed = () => routeOk() && permitted() && ctl.online && ctl.motionKnown &&
                cycle.mode === 'on' && cycle.onAt === ignition && startAllowed() && (intent.type === 'OFF' ||
                    (generation === cancelGeneration && cycle.mayContinue()));
            const attemptWrite = async attempt => {
                if (!stillAllowed()) return { ok: false, nrc: null, blocked: true };
                if (!ctl.verifiedFor(did)) await ctl.read(did);
                if (!stillAllowed() || !ctl.verifiedFor(did)) {
                    intent.retryable = stillAllowed() && ctl.readRetryable;
                    return { ok: false, nrc: null, blocked: true };
                }
                const accepted = await ctl.autoWrite(data, intent.device + ' ' + intent.type);
                lastAction = (accepted ? 'BDC ACK' : 'NOT CONFIRMED') + ': ' + intent.device + ' ' +
                    intent.type + ' (2E ' + bytes(data) + ') attempt=' + attempt;
                ctx.log.info('[AUTO LIVE] ' + lastAction);
                record(accepted ? 'ECU ACK' : 'ECU REJECT', lastAction + ' [' + ctl.info + ']');
                intent.retryable = !accepted && stillAllowed() &&
                    (ctl.lastNrc === 0x21 || (!ctl.lastWriteAttempted &&
                        /busy|cooldown|unavailable|stale|read target bdc/i.test(ctl.info)));
                if (!accepted && ctl.lastWriteAttempted && ctl.lastNrc === null)
                    record('WRITE UNCONFIRMED', intent.device + ': outcome unknown; no blind ON retry');
                return { ok: accepted, nrc: ctl.lastNrc };
            };
            const result = await attemptWrite(intent.attempt || 1);
            const ok = result.ok;
            if (ok && (intent.type === 'ON' || intent.type === 'EXTEND')) acknowledged.add(intent.device);
            if (ok && intent.type === 'OFF') acknowledged.delete(intent.device);
            // A UI cancellation can occur while a UDS write is awaiting its
            // ACK. In that case queue a guarded OFF at the next control step.
            if (ok && intent.type !== 'OFF' && generation !== cancelGeneration && cycle.mode === 'on')
                pendingStops.add(intent.device);
            if (cycle.mode !== 'on') {
                acknowledged.clear();
                pendingStops.clear();
                stopAttempts.clear();
            }
            if (ok && intent.type === 'ON') {
                const acceptedAt = Date.now();
                ctx.settings.set('_autoCycleAt', acceptedAt);
                cycleReason = 'POSITIVE BDC ON ACK: ' + intent.device + ' at ' +
                    new Date(acceptedAt).toISOString() +
                    '; marker file=' + (ctx.settings.saveError ? 'FAILED' : 'OK') +
                    '; no repeat until next ignition after ' + offMinutes() +
                    'm vehicle OFF; physical heating still unverified';
                record('CYCLE', cycleReason);
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
                    seatHistory.push(snap);
                    while (seatHistory.length > SEAT_HISTORY_MAX) seatHistory.shift();
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
                    if (decision.reuse) {
                        ecuState = decision.verified ? 'STORED, VERIFIED' : 'STORED (BDC not reachable)';
                        ecuDone = decision.verified;
                        ecuVerified = decision.verified;
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

        async function autoStep() {
            if (busy || statusBusy) return;
            busy = true;
            try {
                const now = Date.now(), cfg = config(), reading = tempReading(now);
                const wantedSeats = { driver: cfg.seatDriver, passenger: cfg.seatPassenger };
                cfg.seatModuleRoutes = { driver: viaSeatModule(cfg, 'driver'), passenger: viaSeatModule(cfg, 'passenger') };
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
                    if (!active) continue;
                    const side = E.DEVICE_KEY[name], module = E.SEAT_MODULES[side];
                    const usesSeatModule = active.on.viaSeatModule;
                    if (usesSeatModule ? cfg.seatModuleRoutes[side] && cfg[module.seatSetting] && seatModuleVehicleOn &&
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
                const canStart = cfg.autoEnabled && permitted() && cycle.canStart() &&
                    now < cfg.startUntil && ctl.online && ctl.motionKnown;
                // Start, extend or stop a confirmed comfort-heating cycle while
                // moving as long as speed data are fresh and BDC accepts writes.
                const enabledForPlanner = cfg.autoEnabled && cycle.mayContinue() &&
                    (canStart || auto.active.size > 0);
                // First start after install / BDC change: give the read-only
                // detection a short, bounded chance (2 runs, max. 60 s after
                // ignition ON) to settle a selected seat route before the
                // one-shot plan is made. Afterwards plan with what is known.
                const routePending = key => {
                    const r = ecuProfile && ecuProfile.routes[key];
                    return !r || r.route === 'unresolved' || r.route === 'unknown' ||
                        (!ecuVerified && E.allowsSeatModule(ecuProfile, cfg, key));
                };
                const awaitingRoutes = !auto.fired && auto.active.size === 0 && cfg.autoEnabled &&
                    cycle.mode === 'on' && cycle.canStart() && ecuAttempts < 2 &&
                    now < cycle.onAt + 60000 && ctl.online &&
                    ((wantedSeats.driver && routePending('driver')) ||
                        (wantedSeats.passenger && routePending('passenger')));
                const plannerStatus = !cfg.autoEnabled ? 'OFF (setting)'
                    : awaitingRoutes ? 'WAITING FOR CONTROL-UNIT DETECTION'
                    : cycle.mode !== 'on' ? 'WAITING FOR VERIFIED VEHICLE ON'
                    : !cycle.mayContinue() ? 'MANUALLY CANCELLED THIS DRIVE'
                    : !auto.fired && !cycle.canStart() ? 'PARKING TIME NOT MET / SAME DRIVE'
                    : reading.value === null ? 'WAITING FOR TEMP'
                    : now - reading.at > 120000 ? 'STALE TEMP'
                    : !ctl.online ? 'NO TASU CONNECTION'
                    : !ctl.motionKnown ? 'NO FRESH SPEED'
                    : Array.from(auto.active.values()).some(s => s.pending) ? 'START RETRY PENDING'
                    : auto.fired ? 'CYCLE RESERVED / ALREADY ATTEMPTED THIS DRIVE'
                    : now >= cfg.startUntil ? 'START WINDOW EXPIRED' :
                        reading.value > cfg.belowTemp ? 'ABOVE LIMIT' : 'COLD DWELL / READY';
                if (plannerStatus !== lastPlannerStatus) {
                    record('AUTO', plannerStatus + '; T=' +
                        (reading.value === null ? '--' : reading.value.toFixed(1)) +
                        ' C, limit=' + cfg.belowTemp + ' C, min vehicle OFF=' +
                        offMinutes() + 'm; vehicle=' + cycle.mode);
                    lastPlannerStatus = plannerStatus;
                }
                if (awaitingRoutes) return;
                const wasFired = auto.fired;
                const pendingBefore = Array.from(auto.active).filter(([, s]) => s.pending).map(([name]) => name);
                const intents = auto.step({ now, tempC: reading.value, tempAt: reading.at,
                    cfg: Object.assign({}, cfg, { autoEnabled: enabledForPlanner }) });
                for (const name of pendingBefore) {
                    if (!auto.active.has(name)) record('START EXPIRED', name + ': retry window ended or settings changed');
                }
                if (!wasFired && auto.fired) {
                    if (!cycle.consume() || !persistCycle()) {
                        auto.cancel();
                        cycle.eligible = false;
                        record('CYCLE BLOCKED', 'Failed to persist one-cycle marker; no ECU requests sent');
                        return;
                    }
                    cycleReason = 'START WINDOW RESERVED FOR IGNITION ' +
                        new Date(cycle.onAt).toISOString() + '; intents=' + intents.length +
                        '; no ECU confirmation yet; bounded per-device retries only';
                    record('CYCLE', cycleReason);
                }
                for (const intent of intents)
                    record('PLAN', intent.device + ' ' + intent.type +
                        ' planned (NOT YET ECU CONFIRMED)');
                for (const intent of intents) {
                    if (cycle.onAt !== ignition || cycle.mode !== 'on') break;
                    const ok = await sendIntent(intent);
                    if (cycle.onAt !== ignition || cycle.mode !== 'on') break;
                    const at = ok && intent.data.viaSeatModule ?
                        seatModuleActivations.get(intent.device).sentAt : Date.now();
                    auto.acknowledge(intent, ok, at, intent.retryable === true);
                    if (intent.type === 'ON' && !ok) {
                        const pending = auto.active.get(intent.device);
                        record(pending && pending.pending ? 'START RETRY' : 'START FAILED',
                            intent.device + ' attempt=' + intent.attempt +
                            (pending && pending.pending ? '; retry in 8s (fresh guards required)' :
                                '; no further automatic ON this ignition'));
                    }
                }
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
            else if (tab === 3) nextQrPage();
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
        ctx.ui.onClick('BTN_QR_REFRESH', () => { if (tab === 3) freshQrReport(); });
        ctx.ui.onClick('BTN_DETECT', redetect);
        if (typeof ctx.onTap === 'function') ctx.onTap((x, y) => {
            if (tab === 2 && y >= 121 && y <= 169) {
                if (x >= 906 && x < 1092) consoleMove(12);
                else if (x >= 1102 && x < 1288) consoleMove(-12);
                else if (x >= 1298 && x < 1537) consoleOffset = 0;
            } else if (tab === 3 && x >= 1275 && x < 1515 && y >= 112 && y <= 165)
                freshQrReport();
            else if (tab === 1 && x >= 1236 && x < 1546 && y >= 112 && y <= 165)
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
                    : auto.active.size ? 'HEATING SCHEDULE ACTIVE'
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
            const planText = (key, on, value) => !on ? 'Off' : blocked(key) ?
                'Skipped: ' + E.routeLabel(ecuProfile, key) : value;
            const confirmText = (device, key, on) => {
                if (!on) return 'Off';
                if (blocked(key)) return 'skipped (' + E.routeLabel(ecuProfile, key) + ')';
                if (acknowledged.has(device))
                    return (seatModuleActivations.has(device) ? E.SEAT_MODULES[key].id : 'BDC') + ' ACK (heat not verified)';
                const a = auto.active.get(device);
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
            } else if (tab === 1) {
                G.panel(cv, t, 24, 62, 1552, 445, 'Actual read-back (read-only)');
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
                    warningCache = QR.sessionWarnings(ctx, sessionStartedAt, 150);
                }
                const lines = QR.consoleLines(events, warningCache, sessionStartedAt);
                consoleTotal = lines.length;
                consoleOffset = Math.min(consoleOffset, Math.max(0, consoleTotal - 13));
                const start = Math.max(0, lines.length - 13 - consoleOffset);
                const controls = (x, w, label) => {
                    cv.fillRect(x, 125, w, 40, '#284354');
                    text(cv, label, x + 18, 152, 21, t.text);
                };
                text(cv, 'SESSION ' + new Date(sessionStartedAt).toISOString().slice(11, 19) +
                    ' UTC  |  ' + sessionReason, 53, 152, 19, t.dim);
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
            } else {
                G.panel(cv, t, 24, 62, 540, 445, 'QR diagnostic export');
                G.panel(cv, t, 584, 62, 992, 445, 'Compact current-session snapshot');
                cv.fillRect(1275, 125, 240, 39, '#284354');
                text(cv, 'REFRESH QR', 1295, 152, 21, t.text);
                if (qrMatrix && qrReport) {
                    QR.draw(cv, qrMatrix, 91, 107, 390);
                    text(cv, 'REPORT ' + qrReport.id, 620, 197, 26, t.accent, { font: 'bold' });
                    text(cv, 'QR ' + (qrPage + 1) + ' / ' + qrReport.pages.length,
                        620, 249, 39, t.text, { font: 'bold' });
                    text(cv, 'ACTION: next QR page', 620, 296, 27, t.text);
                    text(cv, 'Only this ignition/HU session (' +
                        Math.ceil(qrReport.totalBytes / 1024) + ' KiB).', 620, 352, 23, t.text);
                    text(cv, 'Contains latest ECU replies, errors, current', 620, 391, 22, t.text);
                    text(cv, 'settings and startup / ignition events.', 620, 424, 22, t.text);
                    text(cv, 'Scan all pages; older sessions are automatically excluded.',
                        620, 477, 19, t.warn);
                } else {
                    text(cv, 'QR export unavailable: ' + (qrError || 'no report').slice(0, 110),
                        620, 190, 25, t.warn);
                    text(cv, 'Switch tabs to retry.', 620, 250, 24, t.text);
                }
            }
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
