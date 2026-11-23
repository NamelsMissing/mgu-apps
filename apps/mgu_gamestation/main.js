'use strict';

/**
 * BMW ID7 GameStation: wiring. Drawing lives in ui.js, the running game in session.js,
 * files in library.js, the phone pads in controller_server.js (firewall: native/game-net).
 * All emulation is local to the MGU JavaScript process; phones are input devices only.
 * Emulation is strictly inhibited without a recent, valid speed of <= 0.5 km/h.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const kitCanvas = require('./kit/canvas');
const {setImage} = require('./kit/record');
const {ControllerServer} = require('./controller_server');
const {Library, title} = require('./library');
const {Session} = require('./session');
const crypto = require('crypto');
const {byId} = require('./core_registry');
const {AudioOutput, readFrontSource} = require('./audio');
const {IDrivePad, padsForMode} = require('./idrive_pad');
const {makeUi, PAGE, PAGE_SIZE, PLATFORMS, IMAGE, W, H} = require('./ui');

const NOTICE_MS = {info: 5000, warn: 8000, error: 10000};
const MODE_ORDER = ['phones', 'phone', 'idrive', 'hybrid'];
const SPEED_FRESH_MS = 5000, SPEED_MAX_KMH = 0.5;
const KEY_NAMES = {a: 'A', b: 'B', c: 'C', x: 'X', y: 'Y', l: 'L', r: 'R', start: 'START', select: 'SELECT'};

mgu.run({
    async start(ctx) {
        let events = [], logPage = 0, slot = 1, tone = null, routeAt = 0, routePending = false;
        function record(level, message) {
            ctx.log[level](message);
            if (events.length === 100) events.shift();
            events.push(new Date().toISOString() + ' ' + level.toUpperCase() + ' ' + String(message).slice(0, 200));
        }
        const log = {info: text => record('info', text), warn: text => record('warn', text)};
        const audio = new AudioOutput(ctx.dataDir, {onError: message => log.warn('[GameStation] audio: ' + message)});
        const configureAudio = () => audio.configure(ctx.settings.get('audioEnabled'), ctx.settings.get('audioVolume'));
        const ui = makeUi(G, kitCanvas);
        const library = new Library(ctx.dataDir);
        const idrive = new IDrivePad();

        let page = PAGE.GAMES, platform = 0, deleting = false, armed = null, notice = null;
        const listPage = {};
        let session = null, running = false, grabbed = false, lastInputgateAt = 0;
        let counts = library.counts(), countsAt = Date.now();
        let fps = 0, fpsFrames = 0, fpsAt = Date.now(), lastBroadcast = 0;
        const lastGame = library.last();
        if (lastGame) platform = Math.max(0, PLATFORMS.findIndex(p => p.id === lastGame.kind));

        const mode = () => MODE_ORDER.indexOf(ctx.settings.get('controllerMode')) >= 0 ? ctx.settings.get('controllerMode') : 'phones';
        const useIDrive = () => mode() === 'idrive' || mode() === 'hybrid';
        const singlePlayer = () => mode() === 'idrive' || mode() === 'phone';
        function say(text, level) {
            level = level || 'info';
            notice = text ? {text: String(text), level, until: Date.now() + NOTICE_MS[level]} : null;
        }

        /* ---------------- safety: fresh speed <= 0.5 km/h, fail closed ---------------- */
        let speed = null, speedAt = 0, checkSafety = () => {};
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: v => {
                const raw = v && v.speedVehicleCentreOfGravity;
                if (typeof raw === 'number' && isFinite(raw) && raw >= 0 && raw !== 65535) {
                    speed = raw * 0.015625;
                    speedAt = Date.now();
                } else speed = null;
                checkSafety();
            },
        }, log, {pollMs: 2000}).then(s => {
            if (s && s.error) log.warn('[GameStation] speed subscription: ' + s.error);
        }).catch(e => log.warn('[GameStation] speed subscription: ' + e.message));
        const fresh = () => {
            const age = Date.now() - speedAt;
            return speed !== null && age >= 0 && age < SPEED_FRESH_MS;
        };
        const parked = () => fresh() && speed <= SPEED_MAX_KMH;
        const lock = () => !fresh() ? 'nosignal' : speed > SPEED_MAX_KMH ? 'moving' : 'parked';
        const lockHint = () => lock() === 'nosignal' ? 'Waiting for a valid vehicle-speed signal. Games stay paused.' :
            lock() === 'moving' ? 'The car is moving. Games are paused until it stands still.' : '';

        /* ---------------- iDrive controller ---------------- */
        function configureIDrive() {
            idrive.configure({turnClockwise: ctx.settings.get('idriveClockwise'),
                turnCounterclockwise: ctx.settings.get('idriveCounterclockwise')});
        }
        configureIDrive();
        configureAudio();
        ctx.settings.onChange(key => {
            if (key === 'idriveClockwise' || key === 'idriveCounterclockwise' || key === null) configureIDrive();
            if (key === 'audioEnabled' || key === 'audioVolume' || key === null) { stopTone(); configureAudio(); }
        });
        if (ctx.controller && ctx.controller.onInput) ctx.controller.onInput(v => {
            lastInputgateAt = Date.now();
            idrive.raw(v);
        });
        // Fallback when inputgate is absent: BMW FrontCCU SOME/IP stream.
        // A recent inputgate event wins so a single click is not counted twice.
        ctx.signals.watch('de.bmw.infotainment.controlelements.FrontCCU', '1', {
            statusRotaryEncoderState: v => { if (Date.now() - lastInputgateAt > 1000) idrive.raw(v); },
        }, log).then(s => {
            if (s && s.error) log.warn('[GameStation] FrontCCU signal: ' + s.error);
        }).catch(e => log.warn('[GameStation] FrontCCU signal: ' + e.message));

        /* ---------------- the running game ---------------- */
        const sheetOpen = () => !!(ctx.display && ctx.display.sheet);
        const inFront = () => ctx.ui.isVisible('MAIN') && ctx.ui.hasFocus('MAIN') && !sheetOpen();
        const mayRun = () => !!session && page === PAGE.PLAY && parked() && inFront();
        function syncIDriveCapture() {
            const want = mayRun() && useIDrive() && !session.paused;
            if (want === grabbed) return;
            grabbed = want;
            idrive.setEnabled(want);
            if (ctx.controller) ctx.controller.grab(want);
            log.info('[GameStation] iDrive input ' + (want ? 'captured' : 'released') + ' mode=' + mode());
        }
        function releasePlay() {
            audio.stop();
            if (session && session.game.releaseInput) session.game.releaseInput();
            server.releasePads();
            syncIDriveCapture();
        }
        function stopTone() {
            if (!tone) return;
            clearInterval(tone);
            tone = null;
            audio.stop();
            configureAudio();
        }
        function toggleTone() {
            if (tone) return stopTone();
            if (!parked() || !inFront() || page !== PAGE.DIAG) return;
            const started = Date.now(), samples = new Float32Array(960);
            for (let i = 0; i < samples.length; i++) samples[i] = 0.1 * Math.sin(i * Math.PI / 48);
            audio.configure(true, 15);
            audio.setActive(true);
            tone = setInterval(() => {
                if (!parked() || !inFront() || page !== PAGE.DIAG || Date.now() - started >= 1000) return stopTone();
                audio.write({rate: 48000, left: samples});
            }, 20);
        }
        function quit() {
            stopTone();
            if (!session) return;
            session.stop();
            log.info('[GameStation] stopped ' + session.kind + '/' + session.name);
            session = null; running = false;
            releasePlay();
        }
        function start(kind, name) {
            if (!inFront()) return;
            if (!parked()) { say(lockHint(), 'warn'); return; }
            if (session && session.kind === kind && session.name === name) { open(PAGE.PLAY); return; }
            quit();
            let game = null, next = null;
            try {
                const spec = byId[kind];
                if (!spec) throw new Error('Unknown console');
                const bytes = spec.extensions.length ? library.read(kind, name) : null;
                const save = spec.battery ? library.loadSave(kind, name) : null;
                game = spec.create(bytes, (px, w, h) => { if (next) next.paint(px, w, h); }, {
                    name, save, cpuPlayer2: singlePlayer(), keymap: ctx.settings.get('chip8Mapping'),
                });
                next = new Session(game, kind, name, {store: (k, n, b) => library.store(k, n, b),
                    audio: block => audio.write(block), log});
                if (spec.states) next.romHash = crypto.createHash('sha256').update(bytes).digest('hex');
                if (save) say('In-game save loaded.');
            } catch (e) {
                if (game && game.stop) try { game.stop(); } catch (_) { /* half started */ }
                say('Could not start this game: ' + e.message, 'error');
                log.warn('[GameStation] start ' + kind + '/' + name + ': ' + e.message);
                return;
            }
            session = next;
            session.title = kind === 'arcade' ? 'Pong' : title(name);
            session.hasSave = typeof game.sram === 'function' && !!game.sram();
            idrive.setPong(kind === 'arcade');
            library.remember(kind, name);
            deleting = false; armed = null; fps = 0; fpsFrames = 0; fpsAt = Date.now();
            page = PAGE.PLAY;
            log.info('[GameStation] started ' + kind + '/' + name);
        }
        function togglePause() {
            if (!session) return;
            if (!inFront()) return;
            if (session.paused && !parked()) { say(lockHint(), 'warn'); return; }
            session.toggle();
            if (session.paused) { running = false; releasePlay(); }
        }

        /* ---------------- pages ---------------- */
        function open(next) {
            const leaving = page === PAGE.PLAY && next !== PAGE.PLAY && session;
            if (next !== PAGE.DIAG) stopTone();
            if (leaving) session.save();
            if (next !== page) notice = null;
            if (next !== PAGE.GAMES) { deleting = false; armed = null; }
            page = next;
            if (leaving) { running = false; session.hold(); releasePlay(); }
            if (next === PAGE.GAMES) refreshCounts();
        }
        function refreshCounts() { counts = library.counts(); countsAt = Date.now(); }
        function entries() {
            const spec = PLATFORMS[platform];
            if (spec.id === 'arcade') return [{kind: 'arcade', name: 'pong', title: 'Pong',
                detail: 'Two players, or one against the car'}];
            return library.list(spec.id).map(g => ({kind: g.kind, name: g.name, title: g.title,
                detail: (g.size >= 1048576 ? (g.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(g.size / 1024)) + ' KB') +
                    (g.saved ? '  ·  save kept' : '')}));
        }
        function listOf() {
            const all = entries(), pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
            const index = Math.max(0, Math.min(pages - 1, listPage[platform] || 0));
            listPage[platform] = index;
            return {items: all.slice(index * PAGE_SIZE, index * PAGE_SIZE + PAGE_SIZE), page: index, pages,
                start: index * PAGE_SIZE, total: all.length};
        }
        function remove(item) {
            const key = item.kind + '/' + item.name;
            if (!armed || armed.key !== key || Date.now() - armed.at > 5000) { armed = {key, at: Date.now()}; return; }
            armed = null;
            if (session && session.kind === item.kind && session.name === item.name) quit();
            try {
                library.remove(item.kind, item.name);
                say('Deleted ' + item.title + '.');
                log.info('[GameStation] deleted on the car: ' + key);
            } catch (e) { say('Could not delete: ' + e.message, 'error'); }
            refreshCounts();
            if (!counts[item.kind]) deleting = false;
        }
        function changeState(store) {
            if (!session || !session.romHash || !parked() || !inFront()) return;
            try {
                if (store) library.storeState(session.kind, session.romHash, slot, session.game.saveState());
                else {
                    session.game.loadState(library.loadState(session.kind, session.romHash, slot));
                    session.pause('user');
                    releasePlay();
                }
                say((store ? 'Saved slot ' : 'Loaded slot ') + slot + '.');
            } catch (e) {
                say('Save slot ' + slot + ': ' + e.message, 'warn');
                log.warn('[GameStation] save state: ' + e.message);
            }
        }
        const actions = {
            open,
            platform: i => { platform = i; deleting = false; armed = null; open(PAGE.GAMES); },
            turn: d => { listPage[platform] = (listPage[platform] || 0) + d; },
            play: item => start(item.kind, item.name),
            resumeLast: () => { const l = library.last(); if (l) start(l.kind, l.name); else say('The last game is no longer on the car.', 'warn'); },
            toggleDelete: () => { deleting = !deleting; armed = null; },
            remove,
            togglePause,
            tone: toggleTone,
            nextSlot: () => { slot = slot % 3 + 1; },
            storeState: () => changeState(true),
            loadState: () => changeState(false),
            logScroll: d => { logPage = Math.max(0, Math.min(Math.max(0, Math.ceil(events.length / 7) - 1), logPage + d)); },
            logClear: () => { events = []; logPage = 0; },
            refresh: refreshCounts,
            quit: () => { quit(); open(PAGE.GAMES); },
            nextMode: () => {
                const next = MODE_ORDER[(MODE_ORDER.indexOf(mode()) + 1) % MODE_ORDER.length];
                ctx.settings.set('controllerMode', next);
            },
            drawArcade: (cv, x, y, w, h) => {
                if (!session || !session.arcade) return;
                const k = Math.min(w / session.game.width, h / session.game.height);
                const gw = session.game.width * k, gh = session.game.height * k;
                session.game.draw(cv, x + (w - gw) / 2, y + (h - gh) / 2, gw, gh);
            },
        };

        /* ---------------- phones ---------------- */
        function isPhonePlayer(player) {
            if (player === 1) return !useIDrive();
            return !!session && byId[session.kind].players > 1 && (mode() === 'phones' || mode() === 'hybrid');
        }
        function phoneState() {
            return {title: session ? session.title : '', kind: session ? session.kind : '',
                paused: !!(session && (session.paused || !mayRun())), moving: !parked(),
                lock: lock(), controllerMode: mode(), players: session ? byId[session.kind].players : 2};
        }
        const server = new ControllerServer(ctx.dataDir, {
            upload: (kind, name) => { refreshCounts(); say('Game added from a phone: ' + name); },
            removing: (kind, name) => { if (session && session.kind === kind && session.name === name) quit(); },
            removed: (kind, name) => { refreshCounts(); say('Deleted from a phone: ' + name); },
            command: (player, msg) => {
                if (!session || !isPhonePlayer(player) || !mayRun()) return;
                if (msg.type === 'pause' && !session.paused) togglePause();
                else if (msg.type === 'resume' && session.paused) togglePause();
            },
            state: phoneState,
            acceptsButtons: player => mayRun() && !session.paused && isPhonePlayer(player),
            diagnosticLog: () => events.join('\n'),
        }, log, {library});
        try { server.start(); }
        catch (e) { server.error = e.message; log.warn('[GameStation] phone server: ' + e.message); }

        /* ---------------- the HMI's bar, the header's tabs ---------------- */
        ctx.ui.onClick('BTN_PLATFORM', () => actions.platform((platform + 1) % PLATFORMS.length));
        ctx.ui.onClick('BTN_ACTION', () => {
            if (page === PAGE.PLAY && session) return togglePause();
            const list = listOf();
            if (session) return open(PAGE.PLAY);
            const last = library.last();
            if (last) return start(last.kind, last.name);
            if (list.items[0]) return start(list.items[0].kind, list.items[0].name);
            say('No games yet. Open Controllers to add one from a phone.');
        });
        ctx.ui.onClick('BTN_PAIR', () => open(page === PAGE.PADS ? (session ? PAGE.PLAY : PAGE.GAMES) : PAGE.PADS));
        ctx.ui.onClick('BTN_DIAG', () => open(page === PAGE.DIAG ? (session ? PAGE.PLAY : PAGE.GAMES) : PAGE.DIAG));
        if (typeof ctx.onTab === 'function') ctx.onTab(i => open(i));
        checkSafety = () => {
            if (!parked() || !inFront()) stopTone();
            if (running && !mayRun()) {
                running = false;
                session.hold();
                releasePlay();
                session.save();
            }
            syncIDriveCapture();
        };
        if (ctx.ui.onFocus) ctx.ui.onFocus(checkSafety);
        ctx.ui.onVisible(name => { if (name === 'MAIN') checkSafety(); });
        const safetyTimer = setInterval(checkSafety, 100);
        safetyTimer.unref();

        let exited = false;
        function shutdown() {
            if (exited) return;
            exited = true;
            clearInterval(safetyTimer);
            quit();
            server.stop();
            process.removeListener('exit', shutdown);
        }
        process.on('exit', shutdown);
        if (ctx.onShutdown) ctx.onShutdown(shutdown);

        /* ---------------- what the pages show ---------------- */
        function players() {
            const phone = server.status();
            const live = idrive.live();
            const knob = {label: 'iDrive controller', ok: live, wait: !live, state: live ? 'Ready' : 'Turn or press the knob'};
            const phoneRow = i => ({label: 'Phone (player ' + (i + 1) + ')', ok: phone[i], wait: !phone[i],
                state: phone[i] ? 'Connected' : 'Scan the code in Controllers'});
            const cpu = session && session.arcade ? {label: 'The car (CPU)', ok: true, state: 'Plays the right paddle'} :
                {label: 'Not used', ok: true, state: 'Single player setup'};
            const m = mode();
            if (session && byId[session.kind].players === 1)
                return [useIDrive() ? knob : phoneRow(0), {label: 'Not used', ok: true, state: 'One-player core'}];
            return [m === 'idrive' || m === 'hybrid' ? knob : phoneRow(0), m === 'phones' || m === 'hybrid' ? phoneRow(1) : cpu];
        }
        function help() {
            if (!useIDrive()) return session && session.arcade ? 'Phones: up / down move the paddle.' : '';
            const cw = KEY_NAMES[idrive.turnClockwise] || 'B', ccw = KEY_NAMES[idrive.turnCounterclockwise] || 'X';
            if (session && session.kind === 'chip8') return 'iDrive keypad uses the selected mapping. A phone shows all 16 keys.';
            if (session && (session.kind === 'sms' || session.kind === 'gg'))
                return 'iDrive: push = D-pad, press = 1, turn mapped to B = 2, double press = ' +
                    (session.kind === 'sms' ? 'PAUSE.' : 'START.');
            return session && session.arcade ? 'iDrive: turn or push up / down to move the paddle.' :
                'iDrive: push = D-pad · press = A · hold = SELECT · double press = START · turn right = ' + cw + ' · turn left = ' + ccw + '.';
        }
        function pads() {
            const net = server.net, listening = !!server.listening, m = mode(), phone = server.status();
            const ready = net.ready && listening && !!server.address;
            const blocked = server.error ? 'Phone server: ' + server.error :
                !listening ? 'The phone server is starting.' :
                !net.known ? 'Install "GameStation Phone Port" (mgu-game-net) from MGU Store, or phones cannot reach the car.' :
                !net.ready ? 'Opening the Wi-Fi port for the phones' + (net.error ? ': ' + net.error : '...') :
                !server.address ? 'Could not detect the address of BMW Wi-Fi.' : '';
            const link = i => listening ? server.url(i + 1) : null;
            const idriveP1 = m === 'idrive' || m === 'hybrid', p2Used = m === 'phones' || m === 'hybrid';
            const slots = [
                idriveP1 ? {role: 'iDrive plays. This phone code only adds games.', link: link(0), locked: blocked,
                    ok: idrive.live(), wait: !idrive.live(), state: idrive.live() ? 'iDrive ready' : 'iDrive: turn or press the knob'} :
                    {role: 'Controller and adding games', link: link(0), locked: blocked, ok: phone[0], wait: !phone[0],
                        state: phone[0] ? 'Phone connected' : 'Waiting for a phone'},
                p2Used ? {role: 'Controller and adding games', link: link(1), locked: blocked, ok: phone[1], wait: !phone[1],
                    state: phone[1] ? 'Phone connected' : 'Waiting for a phone'} :
                    {role: 'Not a controller in this setup. Adds games.', link: link(1), locked: blocked, ok: true,
                        state: m === 'idrive' || m === 'phone' ? 'CPU in Pong' : ''},
            ];
            const rows = [
                {name: 'Wi-Fi port', state: net.ready ? 'ok' : net.known ? 'wait' : 'bad',
                    value: net.ready ? 'Open (mgu-game-net)' : net.known ? (net.error || 'Opening...') : 'mgu-game-net not installed'},
                {name: 'Phone server', state: listening ? 'ok' : server.error ? 'bad' : 'wait',
                    value: listening ? (server.address || 'No BMW Wi-Fi address') + ':' + server.port : server.error || 'Starting'},
                {name: 'iDrive', state: !useIDrive() ? 'off' : idrive.live() ? 'ok' : 'wait',
                    value: !useIDrive() ? 'Not used in this setup' : idrive.live() ? 'Knob events received' : 'No knob events yet'},
                {name: 'Vehicle', state: parked() ? 'ok' : lock() === 'moving' ? 'bad' : 'wait',
                    value: parked() ? 'Parked, games allowed' : lockHint()},
                {name: 'Game', state: session ? 'ok' : 'off', value: session ? session.title + (session.paused ? ' (paused)' : '') : 'None running'},
            ];
            return {mode: m, slots, rows, ready, blocked};
        }
        function diagnostics() {
            const d = audio.diagnostics(), memory = process.memoryUsage(), phones = server.status();
            if (!routePending && Date.now() - routeAt > 5000 && typeof ctx.signals.proxy === 'function') {
                routeAt = Date.now();
                routePending = true;
                readFrontSource(ctx.signals).then(route => { audio.route = route; }, e => {
                    audio.route = e.message;
                }).then(() => { routePending = false; });
            }
            const rows = [
                ['GameStation', ctx.spec.version],
                ['Core / ROM', session ? session.kind + ' / ' + session.name : 'None'],
                ['Emulation', session ? session.reason || 'Held / ' + session.average().toFixed(1) + ' ms per frame / ' + fps + ' FPS' : 'Idle'],
                ['Memory', Math.round(memory.rss / 1048576) + ' MB RSS / ' + Math.round(memory.heapUsed / 1048576) + ' MB JS'],
                ['Renderer', ctx.settings.get('renderer') || 'auto'],
                ['Network', server.error || (server.address || 'Wi-Fi address unavailable') + ' / port ' +
                    (server.net.ready ? 'open' : 'closed')],
                ['Controllers', mode() + ' / ' + phones.filter(Boolean).length + ' phone(s) online'],
                ['Storage', session && session.romHash ? 'Save states (3 slots)' : session && session.hasSave ? 'Battery RAM' : 'ROM library'],
                ['PCM backend', d.backend + ' / ' + d.state + ' / ' + (d.device || 'no device selected')],
                ['PCM format', d.rate + ' Hz ' + d.format + ' / ' + d.pending + ' B pending'],
                ['ALSA delay / buffer', d.deviceMs === null ? d.targetMs + ' ms requested' :
                    d.deviceMs.toFixed(1) + ' / ' + d.bufferMs.toFixed(1) + ' ms / period ' + d.periodMs.toFixed(1) + ' ms'],
                ['PCM interruptions', d.underruns + ' underruns / ' + d.overflows + ' dropped blocks / ' + d.droppedFrames + ' dropped samples'],
                ['BMW media source', d.route],
                ['Last audio error', d.error || 'None'],
            ];
            const end = Math.max(0, events.length - logPage * 7);
            return {rows, lines: events.slice(Math.max(0, end - 7), end), slot, states: !!(session && session.romHash),
                tone: !!tone, logPage};
        }
        function viewModel() {
            if (notice && Date.now() > notice.until) notice = null;
            if (armed && Date.now() - armed.at > 5000) armed = null;
            if (Date.now() - countsAt > 10000) refreshCounts();
            const last = library.last();
            const m = {page, allowed: parked(), lock: lock(), lockHint: lockHint(), notice,
                platform, deleting, armed: armed && armed.key,
                running: session ? {kind: session.kind, name: session.name} : null,
                last: last && !(session && session.kind === last.kind && session.name === last.name) ? last : null,
                platforms: PLATFORMS.map(p => Object.assign({count: p.id === 'arcade' ? 1 : counts[p.id] || 0}, p)),
                game: null};
            if (session) {
                const f = session.frame, spec = byId[session.kind];
                m.game = {title: session.title, platform: spec.title.toUpperCase(), paused: session.paused,
                    reason: session.reason, detail: session.detail || '', focus: inFront(), arcade: session.arcade,
                    width: f ? f.width : 0, height: f ? f.height : 0, players: players(), help: help(),
                    saved: !!session.hasSave, states: !!session.romHash, audio: audio.diagnostics().state,
                    scale: ctx.settings.get('videoScale'),
                    fps: running ? fps : undefined};
            }
            if (page === PAGE.GAMES) m.list = listOf();
            if (page === PAGE.PADS) m.pads = pads();
            if (page === PAGE.DIAG) m.diagnostics = diagnostics();
            return m;
        }

        ctx.loop('MAIN', 30, () => {
            if (exited) return;
            const now = Date.now();
            server.poll();
            checkSafety();
            const go = mayRun();
            if (session) {
                running = go && !session.paused;
                if (!tone) audio.setActive(running && !!byId[session.kind].audio);
                if (session.arcade) session.game.cpuPlayer2 = singlePlayer();
                const ran = session.step(padsForMode(mode(), idrive.buttons(), server.pads()), go);
                if (session.paused && running) { running = false; releasePlay(); }
                fpsFrames += ran;
                const pic = session.take();
                if (pic) setImage(IMAGE, pic.width, pic.height, pic.pixels);
            } else running = false;
            if (now - fpsAt >= 1000) { fps = Math.round(fpsFrames * 1000 / (now - fpsAt)); fpsFrames = 0; fpsAt = now; }
            if (now - lastBroadcast >= 1000) { lastBroadcast = now; server.broadcast(phoneState()); }
            const cv = ui.draw(ctx.canvas(W, H), ctx.theme(), viewModel(), actions);
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
