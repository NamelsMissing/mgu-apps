'use strict';

const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const B = require('./logic');
const { ComfortAuto } = require('./comfort_auto');
const { SafeDiag, bytes } = require('./safe_diag');
const QR = require('./qr_log');
const Cycle = require('./cycle_policy');
const { seatOnWithBusyRetry } = require('./seat_retry');

// Settings is automatically provided as ONE native tab by the renderer.
const TABS = ['Comfort', 'Diagnostics', 'Log', 'QR Log'];
const text = (cv, s, x, y, size, color, opts) =>
    cv.text(String(s), x, y, size, color, opts || {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
                        lastBdcPositiveOnAt: Number.isFinite(marker) && marker > 0 ?
                            new Date(marker).toISOString() : null,
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
                        lastBdcWriteAt: ctl.lastWriteAt, bdcReadbacks: ctl.readbacks,
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
        ctx.settings.onChange((key, value) => {
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
                if (enteredQr) buildQrReport();
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
            seatLevel: Number(ctx.settings.get('seatLevel')),
            seatMins: Number(ctx.settings.get('seatMins')),
        });
        // The one visible automatic-heating switch is explicit consent for
        // guarded control. Preserve its saved value across app updates.
        const permitted = () => ctx.settings.get('autoEnabled') === true;
        const tempReading = now => B.temperatureInput(outside.value, outside.at, false, null, now);

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
                '; BDC OFF queued=' + Array.from(pendingStops).join(', ') +
                ' (only if ECU guards permit)');
        }

        // A planner event is not a live heater state. Report an actual request
        // only if the BDC positively acknowledged it. The vehicle's physical
        // response remains unverified until an on-car test.
        async function sendIntent(intent) {
            if (intent.type === 'OFF' && !acknowledged.has(intent.device)) return false;
            const generation = cancelGeneration;
            if (cycle.mode !== 'on' ||
                (intent.type !== 'OFF' && !cycle.mayContinue())) {
                record('BLOCK', intent.device + ' ' + intent.type +
                    ': ignition not ON or manually cancelled');
                return false;
            }
            if (!permitted() || !ctl.online || !ctl.motionKnown) {
                lastAction = intent.device + ': NOT sent (permission / BDC / speed-signal check).';
                ctx.log.warn('[AUTO BLOCKED] ' + lastAction);
                record('BLOCK', lastAction);
                return false;
            }
            const data = intent.device === 'Steering wheel'
                ? B.heating(intent.data.seconds)
                : B.seat(intent.data.side, intent.data.level,
                    intent.type === 'OFF' ? 0 : intent.data.seconds);

            // BDC is read before each 2E write, with >=3s between requests.
            // The command can run while moving, but stale speed data blocks it.
            const remaining = 3000 - (Date.now() - ctl.lastWriteAt);
            if (remaining > 0) await wait(remaining);
            if (!permitted() || !ctl.motionKnown || !ctl.online ||
                cycle.mode !== 'on' || (intent.type !== 'OFF' &&
                    (generation !== cancelGeneration || !cycle.mayContinue()))) {
                lastAction = intent.device + ': NOT sent (conditions changed).';
                record('BLOCK', lastAction);
                return false;
            }
            if (!ctl.verified) await ctl.read(B.DID_HEAT);
            if (!ctl.verified || !ctl.motionKnown || !permitted() ||
                cycle.mode !== 'on' || (intent.type !== 'OFF' &&
                    (generation !== cancelGeneration || !cycle.mayContinue()))) {
                lastAction = intent.device + ': NOT sent (' + ctl.info + ').';
                record('BLOCK', lastAction);
                return false;
            }
            const stillAllowed = () => permitted() && ctl.online && ctl.motionKnown &&
                cycle.mode === 'on' && (intent.type === 'OFF' ||
                    (generation === cancelGeneration && cycle.mayContinue()));
            const attemptWrite = async attempt => {
                if (!stillAllowed()) return { ok: false, nrc: null, blocked: true };
                if (!ctl.verified) await ctl.read(B.DID_HEAT);
                if (!stillAllowed() || !ctl.verified)
                    return { ok: false, nrc: null, blocked: true };
                const accepted = await ctl.autoWrite(data, intent.device + ' ' + intent.type);
                lastAction = (accepted ? 'BDC ACK' : 'NOT CONFIRMED') + ': ' + intent.device + ' ' +
                    intent.type + ' (2E ' + bytes(data) + ') attempt=' + attempt;
                ctx.log.info('[AUTO LIVE] ' + lastAction);
                record(accepted ? 'ECU ACK' : 'ECU REJECT', lastAction + ' [' + ctl.info + ']');
                return { ok: accepted, nrc: ctl.lastNrc };
            };
            const result = await seatOnWithBusyRetry({
                device: intent.device, type: intent.type, send: attemptWrite,
                allowed: stillAllowed, wait, event: record,
            });
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
                for (const did of [B.DID_HEAT, B.DID_SEAT_DRIVER, B.DID_SEAT_PASSENGER]) {
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
                statusAt = Date.now();
            } finally { statusBusy = false; }
        }
        setInterval(() => {
            if (tab === 1) refreshReadbacks().catch(e => ctx.log.warn('Readback: ' + e));
        }, 15000);

        async function autoStep() {
            if (busy || statusBusy) return;
            busy = true;
            try {
                const now = Date.now(), cfg = config(), reading = tempReading(now);
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
                        if (!ok && acknowledged.has(name))
                            record('STOP UNCONFIRMED', name + ': 3 bounded attempts failed; use BMW physical button');
                    }
                }
                const canStart = cfg.autoEnabled && permitted() && cycle.canStart() &&
                    ctl.online && ctl.motionKnown;
                // Start, extend or stop a confirmed comfort-heating cycle while
                // moving as long as speed data are fresh and BDC accepts writes.
                const enabledForPlanner = cfg.autoEnabled && cycle.mayContinue() &&
                    (canStart || auto.active.size > 0);
                const plannerStatus = !cfg.autoEnabled ? 'OFF (setting)'
                    : cycle.mode !== 'on' ? 'WAITING FOR VERIFIED VEHICLE ON'
                    : !cycle.mayContinue() ? 'MANUALLY CANCELLED THIS DRIVE'
                    : !auto.fired && !cycle.canStart() ? 'PARKING TIME NOT MET / SAME DRIVE'
                    : reading.value === null ? 'WAITING FOR TEMP'
                    : now - reading.at > 120000 ? 'STALE TEMP'
                    : !ctl.online ? 'NO TASU CONNECTION'
                    : !ctl.motionKnown ? 'NO FRESH SPEED'
                    : auto.fired ? 'CYCLE ALREADY RUN THIS DRIVE' :
                        reading.value > cfg.belowTemp ? 'ABOVE LIMIT' : 'COLD DWELL / READY';
                if (plannerStatus !== lastPlannerStatus) {
                    record('AUTO', plannerStatus + '; T=' +
                        (reading.value === null ? '--' : reading.value.toFixed(1)) +
                        ' C, limit=' + cfg.belowTemp + ' C, min vehicle OFF=' +
                        offMinutes() + 'm; vehicle=' + cycle.mode);
                    lastPlannerStatus = plannerStatus;
                }
                const wasFired = auto.fired;
                const intents = auto.step({ now, tempC: reading.value, tempAt: reading.at,
                    cfg: Object.assign({}, cfg, { autoEnabled: enabledForPlanner }) });
                if (!wasFired && auto.fired) {
                    if (!cycle.consume() || !persistCycle()) {
                        auto.cancel();
                        cycle.eligible = false;
                        record('CYCLE BLOCKED', 'Failed to persist one-cycle marker; no ECU requests sent');
                        return;
                    }
                    cycleReason = 'PLANNER FIRED ONCE FOR IGNITION ' +
                        new Date(cycle.onAt).toISOString() + '; intents=' + intents.length +
                        '; no ECU confirmation yet; no repeats during this ignition';
                    record('CYCLE', cycleReason);
                }
                for (const intent of intents)
                    record('PLAN', intent.device + ' ' + intent.type +
                        ' planned (NOT YET ECU CONFIRMED)');
                for (const intent of intents) {
                    const ok = await sendIntent(intent);
                    auto.acknowledge(intent, ok, Date.now());
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
        ctx.ui.onClick('BTN_QR_REFRESH', () => { if (tab === 3) buildQrReport(); });
        if (typeof ctx.onTap === 'function') ctx.onTap((x, y) => {
            if (tab === 2 && y >= 121 && y <= 169) {
                if (x >= 906 && x < 1092) consoleMove(12);
                else if (x >= 1102 && x < 1288) consoleMove(-12);
                else if (x >= 1298 && x < 1537) consoleOffset = 0;
            } else if (tab === 3 && x >= 1275 && x < 1515 && y >= 112 && y <= 165)
                buildQrReport();
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
                ctl.online && ctl.motionKnown && fresh;
            const status = !c.autoEnabled ? 'AUTOMATION OFF'
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
            if (tab === 0) {
                G.panel(cv, t, 24, 62, 743, 445, 'Automatic heating');
                text(cv, status, 54, 148, 32, auto.active.size ? t.warn : t.accent, { font: 'bold' });
                text(cv, 'Outdoor ' + temp + '    Start at or below ' + c.belowTemp + ' °C',
                    54, 205, 27, t.text);
                cv.fillRect(54, 226, 667, 2, '#2e4052');
                text(cv, 'Steering wheel', 54, 273, 27, t.text);
                text(cv, c.wheelAuto ? c.wheelMins + ' min' : 'Off', 693, 273, 26,
                    c.wheelAuto ? t.accent : t.dim, { align: 'right' });
                text(cv, 'Driver seat', 54, 319, 27, t.text);
                text(cv, c.seatDriver ? 'Level ' + c.seatLevel + ' / ' + c.seatMins + ' min' : 'Off',
                    693, 319, 25, c.seatDriver ? t.accent : t.dim, { align: 'right' });
                text(cv, 'Passenger seat', 54, 365, 27, t.text);
                text(cv, c.seatPassenger ? 'Level ' + c.seatLevel + ' / ' + c.seatMins + ' min' : 'Off',
                    693, 365, 25, c.seatPassenger ? t.accent : t.dim, { align: 'right' });
                G.panel(cv, t, 788, 62, 788, 445, 'Heating overview');
                text(cv, 'BDC  ' + (ctl.online ? 'CONNECTED' : 'UNAVAILABLE'), 820, 149, 29,
                    ctl.online ? t.accent : t.warn, { font: 'bold' });
                text(cv, 'Steering wheel: ' + (c.wheelAuto ? c.wheelMins + ' min selected' : 'Off'),
                    820, 219, 26, t.text);
                text(cv, 'Driver seat: ' + (c.seatDriver ? c.seatMins + ' min / level ' + c.seatLevel : 'Off'),
                    820, 276, 26, t.text);
                text(cv, 'Passenger seat: ' + (c.seatPassenger ? c.seatMins + ' min / level ' + c.seatLevel : 'Off'),
                    820, 333, 26, t.text);
                cv.fillRect(820, 356, 710, 1, '#2e4052');
                text(cv, 'Remaining scheduled time (STOP button cancels)', 820, 406, 22, t.dim);
                text(cv, 'Wheel ' + auto.remaining('Steering wheel', now) + 's   Seats ' +
                    Math.max(auto.remaining('Driver seat', now),
                        auto.remaining('Passenger seat', now)) + 's', 820, 453, 30, t.accent);
                if (ctx.settings.saveError)
                    text(cv, 'Settings could not be saved; see log', 820, 482, 20, t.warn);
            } else if (tab === 1) {
                G.panel(cv, t, 24, 62, 1552, 445, 'Actual BDC read-back (read-only)');
                text(cv, 'ECU 0x40    Service 22    Refresh: Diagnostics / Action',
                    54, 138, 26, t.text);
                const readRow = (label, did, y, seat) => {
                    const entry = ctl.readbacks[did];
                    const stale = !entry || now - entry.at > 30000;
                    const decoded = !stale && entry.ok ? (seat ?
                        B.decodeSeatReadback(entry.payload) :
                        B.decodeWheelReadback(entry.payload)) : null;
                    // Show the latest valid ECU state. A normal manual OFF/ON
                    // transition is not evidence of an unstable readback.
                    const detail = !decoded ? (stale ? 'NOT AVAILABLE' :
                        entry.ok ? 'Unsupported reply format' : 'ECU read rejected') :
                        B.readbackLabel(decoded, seat);
                    text(cv, label, 54, y, 25, t.text);
                    text(cv, detail, 665, y, 23, decoded ?
                        decoded.on ? t.accent : t.text : t.warn);
                };
                readRow('Steering wheel', B.DID_HEAT, 207, false);
                readRow('Driver seat', B.DID_SEAT_DRIVER, 267, true);
                readRow('Passenger seat', B.DID_SEAT_PASSENGER, 327, true);
                cv.fillRect(54, 354, 1450, 1, '#2e4052');
                text(cv, 'Latest ECU state shown; raw 0x62 replies are saved in Log.',
                    54, 400, 22, t.warn);
                text(cv, statusBusy ? 'Reading BDC ...' : 'Last ECU read: ' + (statusAt ?
                    Math.round((now - statusAt) / 1000) + 's ago' : 'not yet'), 54, 448, 22, t.dim);
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
