'use strict';
// Light Show 0.4 (beta): vehicle scan, every exterior light route the car offers, a show
// library in the style of Bimmerlight, a 3D car on the BMW screen and a phone remote.
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const kitCanvas = require('./kit/canvas');
const Link = require('./link');
const Guard = require('./guard');
const Journal = require('./journal');
const Runner = require('./runner');
const Lamps = require('./lamps');
const Effects = require('./effects');
const Scan = require('./ecu-scan');
const { Names, Observations, statusText } = require('./store');
const { WebServer } = require('./web-server');
const { makeUi, PAGE, LIGHTS_PER_PAGE, W, H } = require('./ui');

const CONFIG_FILE = 'light-show-config.json';
const DEFAULTS = { selection: [], effect: 'chase', stepMs: 500, gapMs: 100, cycles: 3, pwm: 60, allowExperimental: false };
const next = (list, v) => list[(list.indexOf(v) + 1) % list.length];

mgu.run({
    async start(ctx) {
        const log = ctx.log;
        const ui = makeUi(G, kitCanvas);
        const names = new Names(ctx.dataDir);
        const observations = new Observations(ctx.dataDir, log);
        const journal = new Journal(ctx.dataDir);
        let profile = Scan.load(ctx.dataDir);
        let config = Object.assign({}, DEFAULTS);
        try { Object.assign(config, sanitize(JSON.parse(fs.readFileSync(path.join(ctx.dataDir, CONFIG_FILE), 'utf8')))); }
        catch (e) { if (e.code !== 'ENOENT') log.warn('Light Show config: ' + e.message); }

        let page = PAGE.SHOW, lightsPage = 0, unitsPage = 0, selectedLamp = null, lastTested = null;
        let showAll = false, groupFilter = null, notice = null, noticeAt = 0, yaw = 0.8, dirty = true;
        const changed = () => { dirty = true; };
        const say = (text) => { notice = text; noticeAt = Date.now(); changed(); };

        const guard = new Guard(Date.now, changed);
        const link = new Link(ctx.signals, log, changed, { allowExperimental: () => config.allowExperimental });
        const commOff = () => !!(ctx.settings && ctx.settings.get('flmCommOff'));
        const runner = new Runner({ link, guard, journal, log, changed, commOff });
        if (ctx.settings && typeof ctx.settings.onChange === 'function') ctx.settings.onChange(changed);

        function sanitize(v) {
            const out = {};
            if (!v || typeof v !== 'object') return out;
            if (Array.isArray(v.selection)) out.selection = Array.from(new Set(v.selection.filter((id) => Lamps.parse(id)))).slice(0, Effects.MAX_LAMPS);
            if (Effects.EFFECTS.some((e) => e.id === v.effect)) out.effect = v.effect;
            if (Effects.STEP_MS.indexOf(v.stepMs) >= 0) out.stepMs = v.stepMs;
            if (Effects.GAP_MS.indexOf(v.gapMs) >= 0) out.gapMs = v.gapMs;
            if (Effects.CYCLES.indexOf(v.cycles) >= 0) out.cycles = v.cycles;
            if (Effects.PWM.indexOf(v.pwm) >= 0) out.pwm = v.pwm;
            if (typeof v.allowExperimental === 'boolean') out.allowExperimental = v.allowExperimental;
            return out;
        }
        function saveConfig(patch) {
            const n = Object.assign({}, config, sanitize(patch));
            const file = path.join(ctx.dataDir, CONFIG_FILE);
            fs.writeFileSync(file + '.tmp', JSON.stringify(n));
            fs.renameSync(file + '.tmp', file);
            config = n; changed();
            return config;
        }
        /** Catalog with test status; show-eligible = available and confirmed visible. */
        function lamps() {
            return Lamps.catalog(profile, names, { allowExperimental: config.allowExperimental }).map((l) => {
                const index = l.index || (profile && profile.bdc.index);
                const status = observations.status(l.id, index);
                return Object.assign(l, { status, statusText: statusText(status) });
            });
        }
        function byId(list) { const m = {}; list.forEach((l) => { m[l.id] = l; }); return m; }
        function currentPlan(list) {
            if (!config.selection.length) return null;
            const map = byId(list);
            try {
                for (const id of config.selection) {
                    const l = map[id];
                    if (!l || !l.available || l.status !== 'visible')
                        throw new Error((l ? l.label : id) + ' needs a successful test. Test it under Lights or remove it from the show.');
                }
                const plan = Effects.plan(config.selection, list, config);
                plan.bodyIndex = profile.bdc.index;
                return plan;
            } catch (e) { return { error: e.message, notes: [], steps: [], estimateMs: 0 }; }
        }
        function requireIdle() {
            if (runner.status().busy) throw new Error('Another diagnostic operation is running');
        }
        function checkParked() {
            const reason = guard.reason() || (runner.cancel && runner.stopReason);
            if (reason) throw new Error(reason);
        }

        /* ---------- actions (car screen and phone share them) ---------- */
        const actions = {
            start() {
                requireIdle();
                const list = lamps(), plan = currentPlan(list);
                if (!plan) throw new Error('Pick tested lights for the show first');
                if (plan.error) throw new Error(plan.error);
                runner.play(plan, byId(list)).then((r) => { if (r.error) say(r.error); });
                return { ok: true };
            },
            stop() { runner.stop('STOP pressed'); return { ok: true }; },
            test(id, opts) {
                requireIdle();
                const l = byId(lamps())[id];
                if (!l) throw new Error('Unknown light');
                if (!l.available) throw new Error(l.why || 'Light not available');
                const settings = { pwm: config.pwm, commOff: commOff(), moduleIndex: l.index || profile.bdc.index };
                lastTested = null; selectedLamp = id;
                runner.test(l, { pwm: settings.pwm, ms: opts && opts.ms, bodyIndex: profile.bdc.index }).then((r) => {
                    if (r.ok && !r.error && r.sent === 1) {
                        lastTested = { id, settings };
                        say('Test command acknowledged. Confirm what you saw under Lights.');
                    } else if (r.error) say(r.error);
                });
                return { ok: true };
            },
            observe(id, result) {
                requireIdle();
                if (!lastTested || lastTested.id !== id) throw new Error('Complete a test of this light first');
                observations.record(id, result, true, lastTested.settings);
                lastTested = null; changed();
                if (result !== 'visible' && config.selection.indexOf(id) >= 0) saveConfig({ selection: config.selection.filter((x) => x !== id) });
                return { ok: true };
            },
            toggle(id) {
                const sel = config.selection.slice(), i = sel.indexOf(id);
                if (i >= 0) sel.splice(i, 1);
                else {
                    if (!lamps().some((l) => l.id === id && l.available && l.status === 'visible'))
                        throw new Error('Test an available light first: it must light up without noise');
                    if (sel.length >= Effects.MAX_LAMPS) throw new Error('At most ' + Effects.MAX_LAMPS + ' lamps per show');
                    sel.push(id);
                }
                saveConfig({ selection: sel });
                return { ok: true };
            },
            async scan() {
                requireIdle();
                if (runner.status().recoveryPending) throw new Error('Press STOP to release the previous run before scanning');
                const generation = link.generation;
                const check = () => {
                    checkParked();
                    if (!link.available || link.generation !== generation) throw new Error('Diagnostic connection unavailable');
                };
                await runner.exclusive('SCANNING', 'Reading the identity of every control unit', async () => {
                    const p = await Scan.scan(link, log, (text) => runner.update('SCANNING', text), { previous: profile, check });
                    Scan.save(ctx.dataDir, p);
                    profile = p; lastTested = null; lightsPage = 0; unitsPage = 0;
                    runner.update('IDLE', 'Scan finished: ' + p.summary);
                }).catch((e) => { runner.update('ERROR', 'Scan failed: ' + (e.message || e)); throw e; });
                return { ok: true };
            },
            experimental(on) { saveConfig({ allowExperimental: !!on }); return { ok: true }; },
            commOff(on) {
                if (runner.status().busy) throw new Error('Stop the running show first');
                ctx.settings.set('flmCommOff', !!on); changed();
                return { ok: true };
            },
        };

        /* ---------- phone ---------- */
        const server = new WebServer({
            state() {
                const list = lamps(), plan = currentPlan(list), r = runner.status();
                return {
                    version: ctx.spec && ctx.spec.version, guard: { ok: !guard.reason(), reason: guard.reason() || 'Parked' },
                    runner: r, profile, lastTested: lastTested && lastTested.id, allowExperimental: config.allowExperimental, commOff: commOff(),
                    lamps: list.map((l) => ({ id: l.id, label: l.label, short: l.short, route: l.route, group: l.group, side: l.side,
                        hex: l.hex, points: l.points, available: l.available, why: l.why, status: l.status, statusText: l.statusText,
                        experimental: !!l.experimental || l.support === 'experimental', module: l.module })),
                    effects: Effects.EFFECTS, options: { stepMs: Effects.STEP_MS, gapMs: Effects.GAP_MS, cycles: Effects.CYCLES, pwm: Effects.PWM },
                    config: { selection: config.selection, effect: config.effect, stepMs: config.stepMs, gapMs: config.gapMs, cycles: config.cycles, pwm: config.pwm },
                    plan: plan && { error: plan.error || null, steps: plan.steps.length * (plan.cycles || 1), estimateMs: plan.estimateMs, notes: plan.notes },
                };
            },
            save(b) { saveConfig(b); return { ok: true }; },
            show(b) { if (Object.keys(b).length) saveConfig(b); return actions.start(); },
            test(b) { return actions.test(String(b.lamp), { ms: Number(b.ms) || 1000 }); },
            toggle(b) { return actions.toggle(String(b.lamp)); },
            observe(b) { return actions.observe(String(b.lamp), String(b.result)); },
            name(b) { names.set(String(b.lamp), typeof b.name === 'string' ? b.name.trim() : ''); changed(); return { ok: true }; },
            stop() { return actions.stop(); },
            scan() { return actions.scan(); },
            experimental(b) { return actions.experimental(b.on === true); },
            commoff(b) { return actions.commOff(b.on === true); },
        }, log);
        try { server.start(); } catch (e) { log.warn('Light Show phone server: ' + e.message); }

        /* ---------- car screen ---------- */
        const run = (fn) => () => { try { const v = fn(); if (v && v.catch) v.catch((e) => say(String(e.message || e))); } catch (e) { say(String(e.message || e)); } changed(); };
        const visibleList = () => lamps().filter((l) => (showAll || l.available) && (!groupFilter || l.group === groupFilter));
        const a = {
            effect: (id) => run(() => saveConfig({ effect: id }))(),
            nextStep: run(() => saveConfig({ stepMs: next(Effects.STEP_MS, config.stepMs) })),
            nextGap: run(() => saveConfig({ gapMs: next(Effects.GAP_MS, config.gapMs) })),
            nextCycles: run(() => saveConfig({ cycles: next(Effects.CYCLES, config.cycles) })),
            nextPwm: run(() => saveConfig({ pwm: next(Effects.PWM, config.pwm) })),
            start: run(() => actions.start()),
            stop: run(() => actions.stop()),
            pickLamp: (id) => { selectedLamp = id; changed(); },
            test: run(() => actions.test(selectedLamp)),
            observe: (r) => run(() => actions.observe(selectedLamp, r))(),
            toggle: run(() => actions.toggle(selectedLamp)),
            clearSelection: run(() => saveConfig({ selection: [] })),
            rename: run(() => { const n = names.cycle(selectedLamp); say(n ? 'Name: ' + n : 'Default name restored'); }),
            toggleAll: run(() => { showAll = !showAll; lightsPage = 0; }),
            nextGroup: run(() => { groupFilter = next([null, 'front', 'side', 'rear'], groupFilter); lightsPage = 0; }),
            prevLights: run(() => { lightsPage = Math.max(0, lightsPage - 1); }),
            nextLights: run(() => { lightsPage = Math.min(Math.max(0, Math.ceil(visibleList().length / LIGHTS_PER_PAGE) - 1), lightsPage + 1); }),
            nextUnits: run(() => { unitsPage = profile && (unitsPage + 1) * 12 < profile.units.length ? unitsPage + 1 : 0; }),
            scan: run(() => actions.scan()),
            toggleExperimental: run(() => actions.experimental(!config.allowExperimental)),
            toggleCommOff: run(() => actions.commOff(!commOff())),
            acknowledge: run(() => runner.acknowledgeNormalLights()),
        };
        const open = (i) => { page = i; notice = null; changed(); };
        if (typeof ctx.onTab === 'function') ctx.onTab((i) => open(i));
        ctx.ui.onClick('BTN_START', a.start);
        ctx.ui.onClick('BTN_STOP', a.stop);
        ctx.ui.onClick('BTN_PAGE', () => open((page + 1) % 4));

        function viewModel() {
            const list = lamps(), r = runner.status(), why = guard.reason();
            const shown = list.filter((l) => (showAll || l.available) && (!groupFilter || l.group === groupFilter));
            if (selectedLamp && !shown.some((l) => l.id === selectedLamp)) selectedLamp = null;
            if (!selectedLamp && shown.length) selectedLamp = shown[0].id;
            const sel = new Set(config.selection), act = new Set(r.active);
            if (notice && Date.now() - noticeAt > 8000) notice = null;
            return {
                page, yaw, allowed: !why, lockText: why, lock: why && /stationary|P \(Park\)/.test(why) ? 'moving' : 'signal',
                runner: r, config, effects: Effects.EFFECTS, plan: currentPlan(list), profile, notice,
                allowExperimental: config.allowExperimental, supportText: Scan.supportText, commOff: commOff(),
                recoveryUnreadable: journal.pending() && !journal.control(),
                lightList: shown, lightsPage, unitsPage, selectedLamp, lastTested: lastTested && lastTested.id, showAll, groupFilter,
                carLamps: list.filter((l) => l.available && (sel.has(l.id) || act.has(l.id)))
                    .map((l) => ({ points: l.points, hex: l.hex, on: act.has(l.id), dim: !act.has(l.id) })),
                phone: { link: server.url(), ready: server.listening, listening: server.listening, error: server.error,
                    net: server.net, port: server.port, connected: server.phoneConnected() },
            };
        }

        guard.init(ctx.signals, log).catch((e) => log.warn('Light Show vehicle signals: ' + e));
        let linkReady = false;
        link.init().then(() => { linkReady = true; if (journal.pending()) return runner.stop('Releasing a run from before the restart'); })
            .catch((e) => log.warn('Light Show diagnostic init: ' + e));

        // First start: scan the car by itself once it is parked (read-only identities and
        // vehicle order). Later scans only when the user asks for them.
        const auto = { tries: 0, lastTryAt: 0 };
        function autoScan() {
            const st = runner.status();
            if (!Scan.autoScanDue({ hasProfile: !!profile, guardOk: !guard.reason(), linkReady: linkReady && link.available,
                busy: st.busy, recoveryPending: st.recoveryPending, tries: auto.tries, lastTryAt: auto.lastTryAt, now: Date.now() })) return;
            auto.tries++; auto.lastTryAt = Date.now();
            say('First start: scanning the control units (read-only)...');
            actions.scan().then(() => say('Vehicle scanned: ' + profile.summary + '. Test the lights under LIGHTS.'),
                (e) => say('Automatic scan failed (' + (e.message || e) + ')' + (auto.tries < Scan.AUTO_TRIES ? ', trying again in a minute.' : '. Use Scan vehicle on VEHICLE.')));
        }

        setInterval(() => { server.poll(); autoScan(); }, 1000);
        let lastFrame = 0, lastDraw = 0;
        ctx.loop('MAIN', 15, () => {
            const now = Date.now();
            const animate = page === PAGE.SHOW || page === PAGE.LIGHTS;
            if (animate) yaw += (now - (lastFrame || now)) / 1000 * (runner.status().busy ? 0.45 : 0.25);
            lastFrame = now;
            if (!animate && !dirty && now - lastDraw < 1000) return undefined;
            dirty = false; lastDraw = now;
            return ctx.ui.image('MAIN_GFX', ui.draw(ctx.canvas(W, H), ctx.theme(), viewModel(), a));
        });
    },
});
