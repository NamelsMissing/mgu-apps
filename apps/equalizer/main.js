'use strict';
require('./glyphs').install();
const mgu = require('./kit/mgu');
const C = require('./controls');
const { Audio } = require('./audio');
const { Storage } = require('./storage');
const { draw } = require('./view');
const DSP = require('./kit/dsp-client');
const { MusicPlayer } = require('./test_music');
const { exportComparison } = require('./music_export');

const TABS = ['DSP', 'BMW-Klang', 'Profile', 'Einrichten', 'Diagnose'];
const PROFILES = [ ['neutral', 'Neutral'], ['bass', 'Bass'], ['voice', 'Stimme'], ['1', 'Eigenes Profil 1'], ['2', 'Eigenes Profil 2'], ['3', 'Eigenes Profil 3'] ];
const signature = (b) => JSON.stringify([b.id, b.low, b.center, b.high, b.direction]);

mgu.run({
    start(ctx) {
        const { ui, log } = ctx, store = new Storage(ctx.dataDir, log), audio = new Audio(ctx.signals, log);
        const s = { page: 0, selected: { eq: 0, tone: 0, setup: 7, profile: 0 }, current: {}, draft: {}, base: {},
            snapshot: null, status: 'Audioverbindung wird aufgebaut …', busy: false, connected: false,
            store, audio, tabs: TABS, profiles: PROFILES, diagnostics: '', targets: [],
            dspOnline: false, dspStatus: null, dspConfig: DSP.defaults(), dspDraft: null, dspBaseRevision: null, dspParameter: 0,
            testMusic: { status: 'idle', detail: 'Night Drive · 32 s · Originalmusik', playing: false } };
        const dspOpts = { runtime: ctx.dspRuntime || process.env.MGU_DSP_RUNTIME || DSP.RUNTIME };
        const dspRequest = ctx.dspRequest || DSP.request;
        let renderLoop, eventTimer = null, lastRefresh = 0;
        const bindings = () => store.state.bindings;
        const controls = () => C.CONTROLS.filter((c) => c.group === (s.page === 1 ? 'tone' : 'eq'));
        const selected = () => s.page === 3 ? C.CONTROLS[s.selected.setup] : controls()[s.selected[s.page === 1 ? 'tone' : 'eq']];
        function message(text) { s.status = text; if (renderLoop) renderLoop.kick(); }
        // Only code paths through applyDsp can change DSP state; BMW tone learning stays separate.
        const testPlayer = new MusicPlayer({ dspRuntime: dspOpts.runtime,
            onState: (info) => {
                s.testMusic = info;
                if (info.status === 'error') s.diagnostics = info.detail;
                message(info.detail);
            } });
        async function run(fn) {
            if (s.busy) return;
            s.busy = true; renderLoop && renderLoop.kick();
            try { return await fn(); } catch (e) { s.diagnostics = String(e.message || e); message(s.diagnostics); log.warn(s.diagnostics); }
            finally { s.busy = false; renderLoop && renderLoop.kick(); }
        }
        async function read() {
            const shot = await audio.snapshot(); s.snapshot = shot; s.connected = shot.points.length > 0;
            const ix = C.index(shot.points); s.current = {};
            Object.keys(bindings()).forEach((id) => {
                const b = bindings()[id], p = ix[b.id];
                if (p && C.normalized(b, p.value) !== null) s.current[id] = p.value;
            });
            lastRefresh = Date.now();
            await readDsp();
            return shot;
        }
        async function readDsp() {
            try {
                s.dspStatus = await dspRequest({ op: 'status' }, dspOpts);
                s.dspConfig = s.dspStatus.config; s.dspOnline = true;
            } catch (e) { s.dspOnline = false; s.diagnostics = 'DSP: ' + String(e.message || e); }
        }
        function editDsp(fn) {
            if (s.busy) return;
            // OEM tone calibration is unrelated to software DSP. Never block DSP editing.
            if (!s.dspDraft) { s.dspDraft = JSON.parse(JSON.stringify(s.dspConfig)); s.dspBaseRevision = s.dspStatus && s.dspStatus.revision; }
            fn(s.dspDraft);
            if (JSON.stringify(s.dspDraft) === JSON.stringify(s.dspConfig)) s.dspDraft = null;
            message(s.dspDraft ? 'DSP-Änderungen vorbereitet · Mit Übernehmen aktivieren' : 'Keine offenen DSP-Änderungen');
        }
        async function applyDsp() {
            if (!s.dspDraft) return message('Keine DSP-Änderungen vorbereitet.');
            if (!s.dspOnline || s.dspBaseRevision === null) throw new Error('DSP-Dienst nicht verbunden. Abhängigkeit im MGU Store installieren und neu lesen.');
            const expected = s.dspBaseRevision;
            const result = await dspRequest({ op: 'set', config: s.dspDraft, expectedRevision: expected }, dspOpts);
            s.dspConfig = result.config; s.dspStatus = result; s.dspDraft = null;
            await readDsp();
            if (!s.dspOnline || s.dspStatus.revision !== result.revision || JSON.stringify(s.dspConfig) !== JSON.stringify(result.config)) throw new Error('DSP-Rücklesen nicht bestätigt. Diagnose prüfen.');
            const live = (s.dspStatus.streams || []).some((x) => x.frames > 0 && x.lastFrameAt && Date.now() - x.lastFrameAt < 3000);
            message(s.dspConfig.enabled ? live ? 'DSP eingeschaltet · PCM-Filterung aktiv' : 'DSP eingeschaltet · keine PCM-Quelle verbunden' : 'Bypass eingeschaltet · PCM-Daten unverändert');
        }
        async function setBypass(enabled) {
            if (!s.dspOnline || !s.dspStatus) throw new Error('DSP-Dienst nicht verbunden. In Diagnose prüfen.');
            // Explicit bypass buttons commit in one step and include any prepared
            // EQ changes: no hidden second click on "DSP übernehmen" is required.
            const next = JSON.parse(JSON.stringify(s.dspDraft || s.dspConfig));
            next.enabled = !!enabled;
            if (!s.dspDraft && s.dspConfig.enabled === !!enabled)
                return message(enabled ? 'DSP ist bereits eingeschaltet' : 'Bypass ist bereits eingeschaltet');
            s.dspDraft = next;
            if (s.dspBaseRevision === null || s.dspBaseRevision === undefined)
                s.dspBaseRevision = s.dspStatus.revision;
            await applyDsp();
        }
        function stage(id, raw) {
            if (s.busy || store.state.learning) return;
            const b = bindings()[id];
            if (!C.validBinding(b) || !C.rawValue(s.current[id])) return message('Diesen Regler zuerst einrichten und lesen.');
            if (!C.rawValue(raw) || raw < b.low || raw > b.high) return;
            if (!(id in s.base)) s.base[id] = s.current[id];
            s.draft[id] = raw;
            if (raw === s.base[id]) { delete s.draft[id]; delete s.base[id]; }
            message(Object.keys(s.draft).length ? 'Änderungen vorbereitet · Mit Übernehmen aktivieren' : 'Keine offenen Änderungen');
        }
        async function applyNative() {
            if (store.state.learning) throw new Error('Einrichtung zuerst abschließen oder abbrechen.');
            if (!Object.keys(s.draft).length) return message('Keine Änderungen vorbereitet.');
            message('Klang wird übernommen und zurückgelesen …');
            try {
                const result = await audio.apply(bindings(), s.draft, s.base);
                s.draft = {}; s.base = {}; await read();
                message(result.count + ' Regler übernommen · Werte bestätigt');
            } catch (e) {
                s.draft = {}; s.base = {};
                try { await read(); } catch (readError) { log.warn(readError); }
                throw e;
            }
        }
        async function apply() { return s.page === 0 || s.page === 2 && s.dspDraft ? applyDsp() : applyNative(); }
        function page(i) {
            const target = (i + TABS.length) % TABS.length;
            if (s.page === 0 && target !== 0) testPlayer.stop();
            s.page = target;
            labels(); renderLoop && renderLoop.kick();
        }
        function next() {
            if (s.busy) return;
            if (s.page === 3 && store.state.learning) return message('Aktuelle Messreihe abschließen oder abbrechen.');
            const key = s.page === 0 ? 'eq' : s.page === 1 ? 'tone' : s.page === 2 ? 'profile' : 'setup';
            const size = s.page === 0 ? 7 : s.page === 1 ? 4 : s.page === 2 ? 6 : 11;
            s.selected[key] = (s.selected[key] + 1) % size;
            renderLoop && renderLoop.kick();
        }
        function adjust(d) {
            if (s.page === 0) {
                return editDsp((v) => {
                    const b = v.bands[s.selected.eq];
                    if (s.dspParameter === 0) b.gainDb = C.clamp(Math.round((b.gainDb + d * 0.5) * 2) / 2, -12, 12);
                    else if (s.dspParameter === 1) b.frequencyHz = C.clamp(b.frequencyHz + d * (b.frequencyHz >= 1000 ? 100 : b.frequencyHz >= 100 ? 10 : 1), 20, 20000);
                    else if (s.dspParameter === 2) b.q = C.clamp(Math.round((b.q + d * 0.1) * 10) / 10, 0.3, 6);
                    else v.preampDb = C.clamp(v.preampDb + d * 0.5, -24, 0);
                });
            }
            const c = selected(), b = bindings()[c.id];
            if (!b) return message('Diesen Regler unter Einrichten zuordnen.');
            const v = c.id in s.draft ? s.draft[c.id] : s.current[c.id];
            if (C.rawValue(v)) stage(c.id, C.clamp(v + d * b.direction, b.low, b.high));
        }
        function loadProfile() {
            const id = PROFILES[s.selected.profile][0];
            const savedDsp = store.state.dspProfiles[id];
            if (!/^[123]$/.test(id) || savedDsp) {
                const config = savedDsp ? JSON.parse(JSON.stringify(savedDsp.config)) : DSP.defaults();
                if (!savedDsp) {
                    config.enabled = true;
                    const gains = id === 'bass' ? [4, 3, 1, 0, 0, 1, 1] : id === 'voice' ? [-3, -2, 1, 3, 3, 1, 0] : [0, 0, 0, 0, 0, 0, 0];
                    config.bands.forEach((b, i) => { b.gainDb = gains[i]; });
                }
                s.draft = {}; s.base = {}; s.dspBaseRevision = s.dspStatus && s.dspStatus.revision;
                s.dspDraft = config;
                return message(PROFILES[s.selected.profile][1] + ' als DSP-Entwurf geladen · Mit Übernehmen aktivieren');
            }
            if (store.state.learning) throw new Error('BMW-Einrichtung zuerst abschließen oder abbrechen.');
            const values = /^[123]$/.test(id) ? (() => {
                const p = store.state.profiles[id];
                if (!p) throw new Error('Dieser Profilplatz ist noch leer.');
                Object.keys(p.values).forEach((key) => {
                    if (!C.validBinding(bindings()[key]) || p.bindingIds[key] !== signature(bindings()[key])) throw new Error('Profil gehört zu einer älteren Reglerzuordnung. Neu speichern.');
                });
                return p.values;
            })() : C.preset(id, bindings());
            if (!Object.keys(values).length) throw new Error('Zuerst mindestens einen Klangregler einrichten.');
            Object.keys(values).forEach((key) => {
                if (!C.rawValue(s.current[key])) throw new Error('Profilregler momentan nicht lesbar.');
                if (C.normalized(bindings()[key], values[key]) === null) throw new Error('Profilwert liegt außerhalb des gelernten Bereichs.');
            });
            // A profile replaces the complete pending edit; previously staged values never leak into it.
            s.draft = {}; s.base = {}; s.dspDraft = null;
            const busy = s.busy; s.busy = false;
            try { Object.keys(values).forEach((key) => stage(key, values[key])); } finally { s.busy = busy; }
            message(PROFILES[s.selected.profile][1] + ' vorbereitet · Übernehmen aktiviert den Klang');
        }
        function saveProfile() {
            // DSP profile save is independent of an OEM tone-control calibration.
            const slot = PROFILES[s.selected.profile][0];
            if (!/^[123]$/.test(slot)) throw new Error('Zum Speichern einen eigenen Profilplatz auswählen.');
            const config = JSON.parse(JSON.stringify(s.dspDraft || s.dspConfig));
            store.update((v) => { v.dspProfiles[slot] = { at: new Date().toISOString(), config }; });
            message('DSP-Profil ' + slot + ' gespeichert');
        }
        function startLearning() {
            if (Object.keys(s.draft).length) throw new Error('Offene BMW-Klangänderungen zuerst übernehmen oder verwerfen.');
            store.update((v) => { v.learning = { control: selected().id, shots: [] }; });
            message('BMW-Klangregler auf Mitte stellen, dann Messung erfassen.'); labels();
        }
        async function capture() {
            if (!store.state.learning) return startLearning();
            message('Klangwerte werden gemessen …');
            const shot = await read(), l = store.state.learning;
            if (!shot.points.length) throw new Error('Keine Klangwerte empfangen. In Diagnose erneut verbinden.');
            const shots = l.shots.concat([shot.points]);
            if (shots.length === 4) {
                const b = C.learn(l.control, shots, bindings());
                store.update((v) => { v.bindings[l.control] = b; v.learning = null; });
                await read(); message('Regler eingerichtet · Änderungen sind jetzt möglich');
            } else {
                store.update((v) => { v.learning.shots = shots; });
                message(shots.length === 1 ? 'Jetzt im BMW-Menü ganz nach links / auf Minimum stellen.'
                    : shots.length === 2 ? 'Jetzt ganz nach rechts / auf Maximum stellen.' : 'Jetzt wieder auf die ursprüngliche Mitte stellen.');
            }
            labels();
        }
        function cancelLearning() {
            store.update((v) => { v.learning = null; });
            message('Einrichtung abgebrochen · BMW-Regler im Klangmenü nach Wunsch einstellen'); labels();
        }
        async function primary() {
            if (s.page === 3) return capture();
            if (s.page === 4) {
                const file = store.export({ bindings: bindings(), learning: store.state.learning, snapshot: s.snapshot, errors: audio.errors,
                    dsp: s.dspStatus, dspOnline: s.dspOnline, testMusic: s.testMusic, lastMessage: s.diagnostics });
                message('Diagnose gespeichert: equalizer-diagnostics.json'); log.info('diagnostic export ' + file); return;
            }
            return apply();
        }
        function labels() {
            const learning = !!store.state.learning;
            [['BTN_NEXT', s.page === 2 ? 'Profil wählen' : 'Regler wählen'],
             ['BTN_DEC', s.page === 2 ? 'Speichern' : s.page === 3 ? learning ? 'Abbrechen' : 'Neu zuordnen' : s.page === 4 ? 'Entwurf verwerfen' : '−'],
             ['BTN_INC', s.page === 2 ? 'Vorschau laden' : s.page === 3 ? 'Messung erfassen' : s.page === 4 ? 'Neu verbinden' : '+'],
             ['BTN_APPLY', s.page === 3 ? learning ? 'Messung erfassen' : 'Einrichten starten' : s.page === 4 ? 'Diagnose exportieren' : 'Übernehmen'],
             ['BTN_PAGE', 'Ansicht wechseln'], ['BTN_REFRESH', 'Werte lesen']].forEach((x) => ui.text(x[0], x[1]));
        }
        const actions = {
            select(id) {
                if (s.busy || store.state.learning && s.page === 3) return;
                const i = C.CONTROLS.findIndex((c) => c.id === id); if (i < 0) return;
                if (s.page === 0) s.selected.eq = i % 7;
                else if (s.page === 3) s.selected.setup = i;
                else if (!bindings()[id]) { s.selected.setup = i; page(3); }
                else s.selected[C.CONTROLS[i].group === 'eq' ? 'eq' : 'tone'] = C.CONTROLS.filter((c) => c.group === C.CONTROLS[i].group).findIndex((c) => c.id === id);
            },
            set(id, n) { if (bindings()[id]) stage(id, C.rawFromNormalized(bindings()[id], n)); },
            gain(i, db) { editDsp((v) => { v.bands[i].gainDb = C.clamp(Math.round(db * 2) / 2, -12, 12); }); },
            parameter() { s.dspParameter = (s.dspParameter + 1) % 4; message('DSP-Regler: ' + ['Gain in dB', 'Frequenz in Hz', 'Q / Bandbreite', 'Vorverstärkung in dB'][s.dspParameter]); },
            toggleDsp() { return run(async () => setBypass(!s.dspConfig.enabled)); },
            dspOn() { return run(async () => setBypass(true)); },
            dspBypass() { return run(async () => setBypass(false)); },
            testMusic() { if (!s.busy && s.page === 0) testPlayer.toggle(); },
            exportWave() {
                return run(async () => {
                    if (s.page !== 0) return;
                    testPlayer.stop();
                    message('WAV-Export wird vorbereitet ...');
                    const result = await exportComparison(ctx.dataDir, {
                        runtime: dspOpts.runtime, request: dspRequest,
                        onProgress: (msg) => message(msg)
                    });
                    await readDsp();
                    message('WAV Export fertig: ' + result.frames + ' PCM-Frames, 2 Dateien fuer USB.');
                });
            },
            headroom() { editDsp((v) => { v.autoHeadroom = !v.autoHeadroom; }); },
            profile(i) { if (!s.busy) s.selected.profile = i; },
            apply: () => run(apply), next, adjust,
            neutral() { if (s.page === 0) return editDsp((v) => { v.bands[s.selected.eq].gainDb = 0; }); const c = selected(); if (bindings()[c.id]) stage(c.id, bindings()[c.id].center); },
            discard() { if (s.busy) return; s.draft = {}; s.base = {}; s.dspDraft = null; message('Vorbereitete Änderungen verworfen'); },
            load: () => run(async () => loadProfile()),
            save: () => run(async () => saveProfile()), capture: () => run(capture),
            cancel: () => run(async () => cancelLearning()),
            setup: () => run(async () => startLearning()), export: () => run(primary),
        };
        ui.onClick('BTN_NEXT', next);
        ui.onClick('BTN_MUSIC', () => actions.testMusic());
        ui.onClick('BTN_MUSIC_EXPORT', () => actions.exportWave());
        ui.onClick('BTN_DSP_ON', () => actions.dspOn());
        ui.onClick('BTN_BYPASS', () => actions.dspBypass());
        ui.onClick('BTN_PARAM', () => { if (s.page === 0 && !s.busy) actions.parameter(); });
        ui.onClick('BTN_DEC', () => run(async () => {
            if (s.page === 2) saveProfile();
            else if (s.page === 3) store.state.learning ? cancelLearning() : startLearning();
            else if (s.page === 4) { s.draft = {}; s.base = {}; s.dspDraft = null; message('Vorbereitete Änderungen verworfen'); }
            else { s.busy = false; adjust(-1); s.busy = true; }
            labels();
        }));
        ui.onClick('BTN_INC', () => run(async () => {
            if (s.page === 2) { loadProfile(); }
            else if (s.page === 3) await capture();
            else if (s.page === 4) { await audio.connect(); await read(); message(s.connected ? 'Audioverbindung bereit' : 'Keine Audioantwort · Diagnose prüfen'); }
            else { s.busy = false; adjust(1); s.busy = true; }
        }));
        ui.onClick('BTN_APPLY', () => run(primary));
        ui.onClick('BTN_PAGE', () => page(s.page + 1));
        ui.onClick('BTN_REFRESH', () => run(async () => { await read(); message(s.page === 0 ? s.dspOnline ? 'DSP-Konfiguration gelesen' : 'DSP-Dienst nicht verfügbar · Abhängigkeit im Store prüfen' : s.connected ? 'Aktuelle BMW-Klangwerte gelesen' : 'Keine BMW-Audioantwort · Diagnose prüfen'); }));
        ctx.onTab((i) => page(i));
        ctx.onTap((x, y) => {
            if (s.busy) return;
            const hit = s.targets.slice().reverse().find((q) => x >= q.x && x <= q.x + q.w && y >= q.y && y <= q.y + q.h);
            if (hit) Promise.resolve().then(() => hit.act(x, y)).catch((e) => message(String(e.message || e)));
        });
        async function render() {
            const cv = ctx.canvas(1600, 520), theme = ctx.theme();
            draw(cv, theme, s, actions); await ui.image('MAIN_GFX', cv);
        }
        renderLoop = ctx.loop('MAIN', 3, render);
        ui.onVisible((name, visible) => {
            if (name !== 'MAIN') return;
            if (!visible) testPlayer.stop();
            else if (Date.now() - lastRefresh > 3000 && !s.busy) run(read);
        });
        process.once('exit', () => testPlayer.stop());
        audio.onChange = () => {
            clearTimeout(eventTimer);
            eventTimer = setTimeout(() => { if (!s.busy && ui.isVisible('MAIN')) run(read); }, 450);
        };
        labels(); render().catch((e) => log.warn(e));
        // Complete OAP initialization before trying audio services that may be absent.
        setImmediate(() => run(async () => {
            await audio.connect(); await read();
            message(s.dspOnline ? 'DSP-Dienst bereit · Filter gelten für verbundene PCM-Apps' : 'DSP-Dienst nicht verfügbar · MGU Store-Abhängigkeit prüfen');
        }));
    },
});
