'use strict';

/**
 * BMW ID7 GameStation: wiring. Drawing lives in ui.js, the running game in session.js,
 * files in library.js, the phone pads in controller_server.js (firewall: native/game-net).
 * Emulation runs locally in JavaScript or the native helper; phones are input devices only.
 * Emulation is strictly inhibited without a recent, valid speed of <= 0.5 km/h.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const kitCanvas = require('./kit/canvas');
const {setImage, imageById} = require('./kit/record');
const {testImage, SIZES} = require('./gpu_test');
const {ControllerServer} = require('./controller_server');
const {Library, title} = require('./library');
const {Session} = require('./session');
const crypto = require('crypto');
const {byId} = require('./core_registry');
const {AudioOutput} = require('./audio');
const {AudioRoute} = require('./audio_route');
const {IDrivePad, padsForMode} = require('./idrive_pad');
const {makeUi, PAGE, PAGE_SIZE, PLATFORMS, IMAGE, W, H} = require('./ui');

const NOTICE_MS = {info: 5000, warn: 8000, error: 10000};
const MODE_ORDER = ['phones', 'phone', 'idrive', 'hybrid'];
const SPEED_FRESH_MS = 5000, SPEED_MAX_KMH = 0.5;
const TEST_IMAGE = 72, METRICS_ROWS = 10;
const KEY_NAMES = {a: 'A', b: 'B', c: 'C', x: 'X', y: 'Y', l: 'L', r: 'R', start: 'START', select: 'SELECT'};

mgu.run({
    async start(ctx) {
        let events = [], logPage = 0, metricsPage = 0, gpuTest = null, slot = 1, tone = null, toneResult = null;
        let audioPage = false, displayMode = 'standard', gameMenu = false;
        function record(level, message) {
            ctx.log[level](message);
            if (events.length === 100) events.shift();
            events.push(new Date().toISOString() + ' ' + level.toUpperCase() + ' ' + String(message).slice(0, 200));
        }
        const log = {info: text => record('info', text), warn: text => record('warn', text)};
        log.info('[GameStation] started');
        const audio = new AudioOutput(ctx.dataDir, {router: new AudioRoute(ctx.signals),
            onError: message => log.warn('[GameStation] audio: ' + message),
            onState: message => log.info('[GameStation] audio: ' + message)});
        const audioOn = () => ctx.settings.get('audioEnabled') === true && ctx.settings.get('audioOutput') !== 'off';
        const configureAudio = () => audio.configure(audioOn(), ctx.settings.get('audioVolume'), ctx.settings.get('audioOutput'));
        const configuredDisplay = () => {
            const mode = ctx.settings.get('gameDisplayMode');
            return mode === 'immersive' || mode === 'fullscreen' ? mode : 'standard';
        };
        const ui = makeUi(G, kitCanvas);
        const library = new Library(ctx.dataDir);
        const idrive = new IDrivePad();

        let page = PAGE.GAMES, platform = 0, deleting = false, armed = null, notice = null;
        const listPage = {};
        let session = null, running = false, grabbed = false, lastInputgateAt = 0;
        let counts = library.counts(), countsAt = Date.now();
        let fps = 0, fpsFrames = 0, fpsAt = Date.now(), lastBroadcast = 0;
        let videoFps = 0, lastSubmitted = 0, lastDeferred = 0, videoBusyUntil = 0, lastGpu = null;
        let outputDue = 0, emulationTimer = null, videoBuffer = null;
        let cpu = process.cpuUsage(), cpuPercent = 0, rendererState = '', lastIssue = '';
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
            if (key === 'audioEnabled' || key === 'audioVolume' || key === 'audioOutput' || key === null) {
                stopTone(); configureAudio();
            }
            if (key === 'gameDisplayMode' || key === null) setDisplayMode(configuredDisplay());
            if (key === 'audioDiagnostics' && ctx.settings.get(key) === true) {
                if (ctx.display && ctx.display.sheet && ctx.display.closeSheet) ctx.display.closeSheet();
                openAudioDiagnostics();
                if (ctx.ui.close && ctx.ui.isVisible('SETTINGS')) ctx.ui.close('SETTINGS');
                ctx.settings.set(key, false);
            }
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
        const inFront = () => ctx.ui.isVisible('MAIN') && ctx.ui.hasFocus('MAIN') && !sheetOpen() &&
            !(gpu() && gpu().native && gpu().front === false);
        const gpu = () => ctx.display && ctx.display.gpu;
        const gpuActive = () => ctx.display && typeof ctx.display.active === 'function' && ctx.display.active('MAIN');
        const videoIssue = () => {
            if (!session || session.arcade || !ctx.display || typeof ctx.display.active !== 'function' ||
                (process.env.MGU_RENDERER || ctx.settings.get('renderer')) === 'software') return null;
            const client = gpu();
            if (!gpuActive()) return {title: 'VIDEO OUTPUT UNAVAILABLE', detail: 'The GPU renderer is not ready for this screen.'};
            const unavailable = client.imageUnavailable();
            if (unavailable) return {title: unavailable, detail: 'Check the renderer version and negotiated pixmap capability.'};
            if (client.imageStats.error) return {title: 'FRAME UPLOAD FAILED', detail: client.imageStats.error};
            return null;
        };
        const mayRun = () => !!session && page === PAGE.PLAY && parked() && inFront() && !videoIssue() && !gameMenu;
        function releaseImage(id) {
            if (gpu()) gpu().dropImage(id);
            imageById.delete(id);
        }
        function stopGpuTest() {
            if (!gpuTest) return;
            releaseImage(TEST_IMAGE);
            gpuTest = null;
        }
        function startGpuTest(index, moving) {
            const [w, h] = SIZES[index];
            gpuTest = {index, w, h, moving, phase: 0, due: 0, pixels: Buffer.alloc(w * h * 4),
                registered: false};
            log.info('[GameStation] GPU test ' + w + 'x' + h + (moving ? ' moving' : ' static'));
        }
        function advanceGame() {
            const go = mayRun();
            if (!session) { running = false; return; }
            running = go && !session.paused;
            if (!tone) audio.setActive(running && !!byId[session.kind].audio);
            if (session.game.setAudioEnabled) session.game.setAudioEnabled(audio.acceptsPcm());
            if (session.arcade) session.game.cpuPlayer2 = singlePlayer();
            const ran = session.step(padsForMode(mode(), idrive.buttons(), server.pads()), go);
            fpsFrames += ran;
            if (session.paused && running) {
                running = false;
                releasePlay();
                log.warn('[GameStation] ' + session.reason + ': ' + session.detail);
            }
            if (!session.arcade && running && emulationTimer === null) {
                const delay = session.game.asynchronous ? 100 : Math.max(1, session.frameMs * (1 - session.carry) -
                    Math.max(0, Date.now() - session.last));
                emulationTimer = setTimeout(() => { emulationTimer = null; checkSafety(); advanceGame(); }, delay);
                emulationTimer.unref();
            }
        }
        function syncIDriveCapture() {
            const want = mayRun() && useIDrive() && !session.paused && !gameMenu;
            if (want === grabbed) return;
            grabbed = want;
            idrive.setEnabled(want);
            if (ctx.controller) ctx.controller.grab(want);
            log.info('[GameStation] iDrive input ' + (want ? 'captured' : 'released') + ' mode=' + mode());
        }
        function releasePlay() {
            audio.stop();
            clearTimeout(emulationTimer);
            emulationTimer = null;
            if (session && session.game.releaseInput) session.game.releaseInput();
            server.releasePads();
            syncIDriveCapture();
        }
        function stopTone() {
            if (!tone) return;
            clearInterval(tone.timer);
            toneResult = audio.diagnostics();
            toneResult.route = Object.assign({}, toneResult.route);
            tone = null;
            audio.stop();
            configureAudio();
        }
        function toggleTone() {
            if (tone) return stopTone();
            if (!parked() || !inFront() || page !== PAGE.DIAG) return;
            if (ctx.settings.get('audioOutput') === 'off') {
                say('Enable a Game Audio output before testing the speakers.', 'warn');
                return;
            }
            audioPage = true;
            metricsPage = 0;
            toneResult = null;
            const started = Date.now(), samples = new Float32Array(960);
            for (let i = 0; i < samples.length; i++) samples[i] = 0.12 * Math.sin(i * Math.PI / 48);
            audio.configure(true, 15, ctx.settings.get('audioOutput'));
            audio.setActive(true);
            tone = {generated: 0, timer: setInterval(() => {
                if (!parked() || !inFront() || page !== PAGE.DIAG || Date.now() - started >= 9000 || tone.generated >= 40) return stopTone();
                audio.setActive(true);
                if (audio.acceptsPcm() && audio.write({rate: 48000, left: samples})) tone.generated++;
            }, 20)};
        }
        function setDisplayMode(mode) {
            displayMode = mode;
            gameMenu = false;
            if (ctx.ui.text) ctx.ui.text('BTN_ACTION', mode === 'standard' || page !== PAGE.PLAY ? 'Play / Back' : 'Game menu');
        }
        function toggleGameMenu() {
            if (page !== PAGE.PLAY || !session || displayMode === 'standard' || !inFront()) return;
            gameMenu = !gameMenu;
            if (gameMenu && running) {
                running = false;
                session.hold();
                releasePlay();
                session.save();
            }
        }
        function openAudioDiagnostics() {
            open(PAGE.DIAG);
            audioPage = true;
            metricsPage = 0;
        }
        function quit() {
            stopTone();
            if (!session) return;
            session.stop();
            releaseImage(IMAGE);
            videoBuffer = null;
            log.info('[GameStation] stopped ' + session.kind + '/' + session.name);
            session = null; running = false;
            releasePlay();
        }
        function start(kind, name, preferJs) {
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
                game = spec.create(bytes, (px, w, h) => {
                    if (!next) return;
                    if (!next.frame) log.info('[GameStation] first emulator image ' + w + 'x' + h);
                    next.paint(px, w, h);
                }, {
                    name, save, preferJs, canAudio: () => mayRun() && audio.acceptsPcm(), cpuPlayer2: singlePlayer(), keymap: ctx.settings.get('chip8Mapping'),
                    canRun: () => !!next && session === next && mayRun() && !next.paused,
                    pads: () => padsForMode(mode(), idrive.buttons(), server.pads()),
                    onFrame: (block, duration) => {
                        if (game.frameMs) next.frameMs = game.frameMs;
                        next.recordFrame(duration);
                        next.hasSave = !!game.sram();
                        fpsFrames++;
                        if (block && !next.paused) audio.write(block);
                        if (next.paused) { running = false; releasePlay(); }
                    },
                    onError: message => {
                        if (!next || session !== next) return;
                        if (kind === 'nes' && !next.frames && mayRun()) {
                            log.warn('[GameStation] native NES startup failed, using nes-js: ' + message);
                            quit();
                            start(kind, name, true);
                            return;
                        }
                        next.pause('error', message);
                        running = false;
                        releasePlay();
                        log.warn('[GameStation] native emulator: ' + message);
                    },
                });
                if (game.setAudioEnabled) game.setAudioEnabled(false);
                next = new Session(game, kind, name, {store: (k, n, b) => library.store(k, n, b),
                    audio: block => audio.write(block), canAudio: () => mayRun() && audio.acceptsPcm(), log});
                if (spec.states) next.romHash = crypto.createHash('sha256').update(bytes).digest('hex');
                if (save) say('In-game save loaded.');
            } catch (e) {
                if (game && game.stop) try { game.stop(); } catch (_) { /* half started */ }
                say('Could not start this game: ' + e.message, 'error');
                log.warn('[GameStation] start ' + kind + '/' + name + ': ' + e.message);
                return;
            }
            stopGpuTest();
            session = next;
            outputDue = 0;
            session.title = game.title || title(name);
            session.hasSave = typeof game.sram === 'function' && !!game.sram();
            idrive.setPong(kind === 'arcade');
            library.remember(kind, name);
            deleting = false; armed = null; fps = 0; fpsFrames = 0; fpsAt = Date.now();
            page = PAGE.PLAY;
            setDisplayMode(ctx.settings.get('startGamesFullscreen') === false ? 'standard' : configuredDisplay());
            log.info('[GameStation] started ' + kind + '/' + name);
        }
        function togglePause() {
            if (!session) return;
            if (!inFront()) return;
            if (session.paused && parked() && session.game.asynchronous && session.game.stopped) {
                const {kind, name, frames} = session;
                quit();
                start(kind, name, kind === 'nes' && !frames);
                return;
            }
            if (!parked()) { say(lockHint(), 'warn'); return; }
            if (videoIssue()) {
                if (gpu() && gpu().imageStats.error) gpu().dropImage(IMAGE);
                return;
            }
            if (gameMenu && !session.paused) {
                gameMenu = false;
                return;
            }
            session.toggle();
            gameMenu = session.paused && displayMode !== 'standard';
            if (session.paused) { running = false; releasePlay(); }
        }

        /* ---------------- pages ---------------- */
        function open(next) {
            const leaving = page === PAGE.PLAY && next !== PAGE.PLAY && session;
            if (next !== PAGE.DIAG) { stopTone(); stopGpuTest(); }
            if (leaving) session.save();
            if (next !== page) notice = null;
            if (next !== PAGE.GAMES) { deleting = false; armed = null; }
            page = next;
            if (next !== PAGE.PLAY) gameMenu = false;
            if (next !== PAGE.DIAG) { audioPage = false; metricsPage = 0; }
            if (ctx.ui.text) ctx.ui.text('BTN_ACTION', next === PAGE.PLAY && displayMode !== 'standard' ? 'Game menu' : 'Play / Back');
            if (leaving) { running = false; session.hold(); releasePlay(); }
            if (next === PAGE.GAMES) refreshCounts();
        }
        function refreshCounts() { counts = library.counts(); countsAt = Date.now(); }
        function entries() {
            const spec = PLATFORMS[platform];
            if (spec.id === 'arcade') return [{kind: 'arcade', name: 'pong', title: 'Pong',
                detail: 'Two players, or one against the car'}];
            if (spec.id === 'mine') return [{kind: 'mine', name: 'mineworks', title: 'Mineworks Tycoon',
                detail: 'Build shafts, hire managers and upgrade transport; auto-save and offline income'}];
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
            gameMenu: toggleGameMenu,
            fullscreen: () => setDisplayMode(displayMode === 'standard' ?
                (configuredDisplay() === 'immersive' ? 'immersive' : 'fullscreen') : 'standard'),
            toggleAudio: () => {
                if (ctx.settings.get('audioOutput') === 'off') {
                    ctx.settings.set('audioOutput', 'auto');
                    ctx.settings.set('audioEnabled', true);
                } else ctx.settings.set('audioEnabled', !audioOn());
                configureAudio();
            },
            volume: delta => {
                ctx.settings.set('audioVolume', Math.max(0, Math.min(100, (Number(ctx.settings.get('audioVolume')) || 0) + delta)));
                configureAudio();
            },
            audioDiagnostics: () => {
                if (audioPage) { stopTone(); audioPage = false; metricsPage = 0; }
                else openAudioDiagnostics();
            },
            tone: toggleTone,
            gpuTest: () => gpuTest ? stopGpuTest() : startGpuTest(0, false),
            gpuMotion: () => { if (gpuTest) startGpuTest(gpuTest.index, !gpuTest.moving); },
            gpuSize: () => { if (gpuTest) startGpuTest((gpuTest.index + 1) % SIZES.length, gpuTest.moving); },
            metricsScroll: d => { metricsPage = Math.max(0, Math.min(audioPage ? 1 : 2, metricsPage + d)); },
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
            drawArcade: (cv, x, y, w, h, fitted) => {
                if (!session || !session.arcade) return;
                const game = session.game;
                if (fitted) return game.draw(cv, x, y, w, h);
                const scale = Math.min(w / game.width, h / game.height);
                const gw = scale * game.width, gh = scale * game.height;
                game.draw(cv, x + (w - gw) / 2, y + (h - gh) / 2, gw, gh);
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
                lock: lock(), gameMenu: page === PAGE.PLAY && displayMode !== 'standard', controllerMode: mode(), players: session ? byId[session.kind].players : 2};
        }
        const server = new ControllerServer(ctx.dataDir, {
            upload: (kind, name) => { refreshCounts(); say('Game added from a phone: ' + name); },
            removing: (kind, name) => { if (session && session.kind === kind && session.name === name) quit(); },
            removed: (kind, name) => { refreshCounts(); say('Deleted from a phone: ' + name); },
            command: (player, msg) => {
                if (!session || !isPhonePlayer(player)) return;
                if (msg.type === 'gameMenu') return toggleGameMenu();
                if (msg.type === 'resume' && gameMenu && parked() && inFront()) return togglePause();
                if (!mayRun()) return;
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
            if (page === PAGE.PLAY && session) return displayMode === 'standard' ? togglePause() : toggleGameMenu();
            const list = listOf();
            if (session) return open(PAGE.PLAY);
            const last = library.last();
            if (last) return start(last.kind, last.name);
            if (list.items[0]) return start(list.items[0].kind, list.items[0].name);
            say('No games yet. Open Controllers to add one from a phone.');
        });
        ctx.ui.onClick('BTN_PAIR', () => open(page === PAGE.PADS ? (session ? PAGE.PLAY : PAGE.GAMES) : PAGE.PADS));
        ctx.ui.onClick('BTN_DIAG', () => open(page === PAGE.DIAG ? (session ? PAGE.PLAY : PAGE.GAMES) : PAGE.DIAG));
        if (ctx.onTap) ctx.onTap((x, y) => { if (x >= 0 && x < W && y >= 52) toggleGameMenu(); });
        if (typeof ctx.onTab === 'function') ctx.onTab(i => open(i));
        checkSafety = () => {
            if (!parked() || !inFront()) { stopTone(); stopGpuTest(); }
            if (running && !mayRun()) {
                if (page === PAGE.PLAY && displayMode !== 'standard' && !inFront()) {
                    gameMenu = true;
                    session.pause('user');
                }
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
            if (exited) return audio.routeJob;
            exited = true;
            clearInterval(safetyTimer);
            clearTimeout(emulationTimer);
            stopGpuTest();
            quit();
            server.stop();
            process.removeListener('exit', shutdown);
            return audio.stop();
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
            if (session && session.kind === 'mine') return 'Mineworks: UP/DOWN choose; A upgrade; B hire manager; START boosts. Touch also works.';
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
            const rows = [
                ['GameStation', ctx.spec.version],
                ['Core / ROM', session ? session.kind + ' / ' + session.name : 'None'],
                ['Core / version', session ? (session.kind === 'nes' && session.game.asynchronous ? 'FCEUmm fb919fb / Native' : byId[session.kind].core) : '-'],
                ['Emulated FPS', session ? fps + ' FPS / ' + Math.round(fps * session.frameMs / 10) + '% speed' : 'Idle'],
                ['Frame time', session ? session.average().toFixed(1) + ' ms avg / ' + session.maximum().toFixed(1) + ' ms max' +
                    (session.game.asynchronous ? ' (helper round trip)' : '') : '-'],
                ['Memory', Math.round(memory.rss / 1048576) + ' MB RSS / ' + Math.round(memory.heapUsed / 1048576) + ' MB JS'],
                ['App CPU', cpuPercent + '% of one CPU (JS process)'],
                ['Frame buffer', session && session.frame ? session.frame.width + 'x' + session.frame.height +
                    ' / ' + (session.frame.pixels.byteLength + (videoBuffer ? videoBuffer.length : 0)) + ' B current + staged' : '-'],
                ['Renderer', gpuActive() ? (gpu().native ? 'GPU / mgu-render/1' : 'GPU / legacy ' + gpu().protocolVersion) : 'HMI'],
                ['Capabilities', gpu() && gpu().info ? Object.keys(gpu().info).filter(k => gpu().info[k] === true).join(', ') : '-'],
                ['Image output', videoFps + ' queued FPS / ' + (gpu() ? gpu().imageStats.submitted : 0) + ' total'],
                ['Discarded images', session && !session.arcade ? session.discarded + ' before staging' : '-'],
                ['Queue pressure', gpu() ? gpu().imageStats.deferred + ' deferred attempts' : '-'],
                ['Upload enqueue', gpu() ? gpu().imageStats.enqueueMs.toFixed(2) + ' ms (client)' : '-'],
                ['Renderer stats', gpu() && gpu().stats ? gpu().stats.fps + ' UI FPS / ' + (gpu().stats.avgUs / 1000).toFixed(2) + ' ms avg' : 'Unavailable'],
                ['Image presentation', 'Unobservable / verify on display'],
                ['Last video error', gpu() && gpu().imageStats.error || (videoIssue() ? videoIssue().title : 'None')],
                ['Network', server.error || (server.address || 'Wi-Fi address unavailable') + ' / port ' +
                    (server.net.ready ? 'open' : 'closed')],
                ['Controllers', mode() + ' / ' + phones.filter(Boolean).length + ' phone(s) online'],
                ['Storage', session && session.romHash ? 'Save states (3 slots)' : session && session.hasSave ? 'Battery RAM' : 'ROM library'],
            ];
            const route = d.route;
            const stream = toneResult || d;
            const audioRows = [
                ['Audio output', d.backend + ' / ' + d.state],
                ['BMW source', route.source ? route.source + ' / ID ' + route.sourceID : 'Dedicated source unconfirmed'],
                ['BMW sink', route.sink ? route.sink + ' / ID ' + route.sinkID : '-'],
                ['Connection', route.state + (route.connectionID ? ' / ID ' + route.connectionID : '')],
                ['ALSA endpoint', d.device || '-'],
                ['Input / output', (d.inputRate || '-') + ' Hz / ' + d.rate + ' Hz ' + d.format],
                ['PCM frames', d.received + ' received / ' + d.queued + ' queued / ' + d.written + ' written'],
                ['PCM blocks', d.blocks + ' queued / ' + d.overflows + ' dropped'],
                ['ALSA queue', d.deviceMs === null ? d.targetMs + ' ms requested' :
                    d.deviceMs.toFixed(1) + ' ms pending / ' + d.bufferMs.toFixed(1) + ' ms buffer / ' + d.periodMs.toFixed(1) + ' ms period'],
                ['PCM interruptions', d.underruns + ' underruns / ' + d.droppedFrames + ' dropped samples'],
                ['Last audio error', d.error || 'None'],
                ['Test signal', tone || toneResult ? '960 samples generated / ' + stream.blocks + ' blocks queued' : 'Not started'],
                ['Test ALSA device', stream.opened ? 'Opened' : 'Unconfirmed'],
                ['Test BMW link', stream.route.state],
                ['Test PCM written', stream.written],
                ['Audible in car', 'Manual confirmation pending'],
            ];
            const shown = audioPage ? audioRows : rows;
            const end = Math.max(0, events.length - logPage * 7);
            return {audioPage, rows: shown.slice(metricsPage * METRICS_ROWS, (metricsPage + 1) * METRICS_ROWS), lines: events.slice(Math.max(0, end - 7), end), slot, states: !!(session && session.romHash),
                tone: !!tone, logPage, gpuTest: gpuTest && {
                    w: gpuTest.w, h: gpuTest.h, moving: gpuTest.moving, id: TEST_IMAGE, displayReady: gpuActive(),
                    status: !gpuTest.registered ? 'Preparing RGBA buffer' : !gpuActive() ? 'Registered / GPU inactive' :
                        gpu().imageUnavailable() || gpu().imageStats.error ||
                        (gpu().sent.image.has(TEST_IMAGE) ? 'Queued to renderer / verify on display' : 'RGBA buffer registered in app'),
                }};
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
                platforms: PLATFORMS.map(p => Object.assign({count: p.builtIn || p.id === 'arcade' ? 1 : counts[p.id] || 0}, p)),
                game: null};
            if (session) {
                const f = session.frame, spec = byId[session.kind];
                m.game = {title: session.title, platform: spec.title.toUpperCase(), paused: session.paused,
                    reason: session.reason, detail: session.detail || '', focus: inFront(), arcade: session.arcade,
                    videoIssue: videoIssue(),
                    width: f ? f.width : 0, height: f ? f.height : 0, players: players(), help: help(),
                    saved: !!session.hasSave, states: !!session.romHash, audio: audio.diagnostics().state,
                    scale: ctx.settings.get('videoScale'), displayMode, gameMenu,
                    audioOn: audioOn(), volume: Number(ctx.settings.get('audioVolume')) || 0,
                    fps: running ? fps : undefined, videoFps};
            }
            if (page === PAGE.GAMES) m.list = listOf();
            if (page === PAGE.PADS) m.pads = pads();
            if (page === PAGE.DIAG) m.diagnostics = diagnostics();
            return m;
        }

        ctx.loop('MAIN', 30, () => {
            if (exited) return;
            const now = Date.now();
            audio.service();
            server.poll();
            checkSafety();
            if (!session || session.arcade || emulationTimer === null) advanceGame();
            if (session && !session.arcade && page === PAGE.PLAY && now + 1 >= outputDue) {
                const selected = Number(ctx.settings.get('videoFpsLimit'));
                const limit = selected === 20 || selected === 30 || selected === 60 ? selected :
                    now < videoBusyUntil || session.average() > session.frameMs ? 20 : 30;
                const pic = session.take();
                if (pic) {
                    // JS cores reuse their output arrays on each tick. Keep the selected version stable.
                    const bytes = pic.width * pic.height * 4;
                    if (!videoBuffer || videoBuffer.length !== bytes) videoBuffer = Buffer.allocUnsafe(bytes);
                    videoBuffer.set(pic.pixels);
                    if (!imageById.has(IMAGE)) log.info('[GameStation] first emulator image registered');
                    setImage(IMAGE, pic.width, pic.height, videoBuffer, false);
                    const period = 1000 / limit;
                    outputDue = Math.max(outputDue + period, now + period - 1);
                }
            }
            if (gpuTest && page === PAGE.DIAG && inFront() && (!gpuTest.due || (gpuTest.moving && now >= gpuTest.due))) {
                testImage(gpuTest.pixels, gpuTest.w, gpuTest.h, gpuTest.phase);
                setImage(TEST_IMAGE, gpuTest.w, gpuTest.h, gpuTest.pixels, true);
                gpuTest.registered = true;
                gpuTest.phase += 3;
                gpuTest.due = now + 67;
            }
            const client = gpu(), video = client && client.imageStats;
            if (session && client && client.sent.image.has(IMAGE) && !session.imageSubmitted) {
                session.imageSubmitted = true;
                log.info('[GameStation] first emulator image queued to renderer');
            }
            if (client !== lastGpu) {
                lastGpu = client;
                lastSubmitted = lastDeferred = 0;
                videoBusyUntil = 0;
            }
            if (now - fpsAt >= 1000) {
                const elapsed = now - fpsAt, usage = process.cpuUsage(cpu);
                const state = gpuActive() ? (client.native ? 'mgu-render/1' : 'upstream') +
                    (client.imageUnavailable() ? ' / pixel transport unavailable' : ' / pixel transport available') : 'HMI';
                if (state !== rendererState) {
                    rendererState = state;
                    log.info('[GameStation] renderer ' + state);
                }
                const issue = videoIssue(), problem = issue ? issue.title + ' / ' + issue.detail : '';
                if (problem !== lastIssue) {
                    lastIssue = problem;
                    if (problem) log.warn('[GameStation] ' + problem);
                }
                fps = Math.round(fpsFrames * 1000 / elapsed);
                fpsFrames = 0;
                fpsAt = now;
                cpu = process.cpuUsage();
                cpuPercent = Math.round((usage.user + usage.system) / (elapsed * 10));
                videoFps = video ? Math.round((video.submitted - lastSubmitted) * 1000 / elapsed) : 0;
                if (video && video.deferred > lastDeferred) videoBusyUntil = now + 3000;
                lastSubmitted = video ? video.submitted : 0;
                lastDeferred = video ? video.deferred : 0;
            }
            if (now - lastBroadcast >= 1000) { lastBroadcast = now; server.broadcast(phoneState()); }
            const cv = ui.draw(ctx.canvas(W, H), ctx.theme(), viewModel(), actions);
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
