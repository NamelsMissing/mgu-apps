'use strict';
/**
 * Cluster Lyrics 0.1.4 - the lyrics of the song playing on the user's Spotify
 * account, on the iDrive screen and optionally in the instrument cluster's
 * map window (instead of the Waze map).
 *
 * Read-only towards Spotify and the car: one vehicle signal (speed) decides
 * whether the cluster may show text; nothing is written to any control unit.
 * All secondary views live inside MAIN (a second RHMI canvas state can fail
 * silently on this ID7 firmware, see Custom Cluster).
 */
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const G = require('./kit/gauges');
const { setImage } = require('./kit/record');
const font = require('./lyric_font.js');
const lrc = require('./lrc.js');
const { UplinkHttp } = require('./uplink_http.js');
const { Spotify, IMPORT_NAME } = require('./spotify.js');
const { Lyrics } = require('./lrclib.js');
const { KombiLyrics, COLORS } = require('./kombi.js');
const { LyricsEngine } = require('./engine.js');
const { BackgroundStatus } = require('./background_status.js');
const { BootControl } = require('./boot_control.js');

const PAGES = ['NOW', 'SETUP', 'LOG'];
const LYRICS_TEXT = { idle: 'waiting for a song', loading: 'loading...', synced: 'synchronised (LRCLIB)',
    plain: 'only unsynchronised text available', instrumental: 'instrumental', none: 'not found on LRCLIB',
    unreadable: 'in a script this display cannot draw', error: 'could not be loaded' };

const IMG_HEAD = 23411, IMG_LYRICS = 23412;   // pixel image ids, unique within this app
const HEAD_W = 1180, HEAD_H = 74, BOX_W = 1480, BOX_H = 190, BOX_BG = '#0a1018';
const ascii = (text) => String(text).replace(/[^\x20-\x7e]/g, '?');

function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
}

mgu.run({
    async start(ctx) {
        const { settings, log, ui } = ctx;
        const events = [];
        function note(message) {
            events.push(new Date().toISOString().slice(11, 19) + ' ' + message);
            if (events.length > 60) events.shift();
            log.info('lyrics: ' + message);
        }
        const http = new UplinkHttp(ctx.dataDir, log);
        const spotify = new Spotify(ctx.dataDir, http, log);
        const lyrics = new Lyrics(ctx.dataDir, http, log);
        const kombi = new KombiLyrics(log, { trace: (m) => note('KOMBI ' + m) });
        const engine = new LyricsEngine({ spotify, lyrics, kombi, log });
        const car = new Car(ctx, ['speed'], { pollMs: 5000 });
        // Autostart: the process (and with it the KOMBI lyrics) runs without the app window.
        const background = new BackgroundStatus({ dir: ctx.dataDir, file: 'cluster-lyrics-background.json',
            version: (ctx.spec && ctx.spec.version) || '', startReason: ctx.app && ctx.app.startReason });
        const boot = new BootControl(settings);
        note('process started: reason=' + background.startReason +
            ', autostart=' + boot.autostartEnabled() +
            ', cluster at startup=' + boot.startedAutomatically);

        let page = spotify.signedIn() ? 'NOW' : 'SETUP', notice = '', signOutArmedUntil = 0;
        let lastState = '', lastDrawAt = 0, lastDelayMs = null;
        // MAIN's draw loop only runs while the screen is shown: that is the visibility signal
        // (it does not depend on an RHMI visibility event arriving).
        const mainVisible = () => Date.now() - lastDrawAt < 3000;

        function syncSettings() {
            const on = boot.active();
            const delayMs = Number(settings.get('offsetMs')) || 0;
            engine.configure({ kombiOn: on, kombiMode: settings.get('kombiMode') === 'always' ? 'always' : 'parked',
                offsetMs: delayMs });
            if (lastDelayMs !== null && delayMs !== lastDelayMs)
                note('Lyrics delay ' + lastDelayMs + ' -> ' + delayMs + ' ms (' +
                    (delayMs > 0 ? 'later' : delayMs < 0 ? 'earlier' : 'original timing') + ')');
            lastDelayMs = delayMs;
            kombi.configure({ accent: settings.get('accent'), showNext: settings.get('showNext') !== false,
                takeOverBmwMap: !!settings.get('takeOverBmwMap'),
                layoutMode: settings.get('layoutMode') === 'withWaze' ? 'withWaze' : 'exclusive',
                fontSizePct: Number(settings.get('kombiFontPct')) || 75 });
            // Without the switch the app does not even connect to the cluster renderer.
            if (on) kombi.start(); else kombi.close();
            engine.setActive(mainVisible() || on);
            updateButtons();
        }
        function updateButtons() {
            ui.text('BTN_KOMBI', 'KOMBI lyrics: ' + (boot.active() ? 'On' : 'Off'));
            ui.text('BTN_PAGE', page === 'NOW' ? 'Setup' : page === 'SETUP' ? 'Log' : 'Now playing');
            ui.text('BTN_ACTION', page === 'NOW' ? 'Reload lyrics' : page === 'SETUP' ? 'Import from USB' :
                signOutArmedUntil > Date.now() ? 'Confirm sign-out' : 'Sign out');
        }
        function showPage(name) {
            page = name; signOutArmedUntil = 0;
            updateButtons();
        }

        ui.onVisible((name, visible) => {
            if (name === 'MAIN' && visible) { background.seen(); showPage(spotify.signedIn() ? 'NOW' : 'SETUP'); }
        });
        ui.onClick('BTN_KOMBI', () => {
            const on = boot.toggle();
            note('KOMBI lyrics switched ' + (on ? 'on' : 'off') + ' manually (mode ' + settings.get('kombiMode') + ')');
        });
        ui.onClick('BTN_PAGE', () => showPage(PAGES[(PAGES.indexOf(page) + 1) % PAGES.length]));
        ui.onClick('BTN_ACTION', () => {
            if (page === 'NOW') {
                notice = engine.reloadLyrics() ? 'Lyrics requested again.' : 'Nothing is playing.';
            } else if (page === 'SETUP') {
                const r = spotify.importFromUsb();
                notice = r.message;
                note('USB import: ' + r.message);
                if (r.ok) engine.kick();
            } else if (signOutArmedUntil > Date.now()) {
                spotify.signOut();
                const removed = lyrics.clearCache();
                signOutArmedUntil = 0;
                notice = 'Signed out. Stored sign-in and ' + removed + ' cached lyrics removed.';
                note('signed out; cache cleared');
            } else {
                signOutArmedUntil = Date.now() + 5000;
                notice = 'Press again within 5 s to remove the Spotify sign-in from the car.';
            }
            updateButtons();
        });
        settings.onChange((key) => {
            boot.onSettingsChanged(key);
            syncSettings();
        });
        syncSettings();

        const ticker = setInterval(() => {
            try {
                const d = car.data();
                const at = d.receivedAt && d.receivedAt.speed;
                engine.observeVehicle(typeof d.speed === 'number' ? d.speed : null,
                    typeof at === 'number' ? Date.now() - at : null, !!d.demo);
                engine.setActive(mainVisible() || boot.active());
                engine.tick();
                const state = (engine.track ? engine.track.title : '-') + ' | lyrics=' + engine.lyricsState +
                    ' | kombi=' + (engine.kombiReason || 'allowed') + (engine.pollError ? ' | error=' + engine.pollError : '');
                if (state !== lastState) { lastState = state; note(state); }
                // A 15 s heartbeat makes a running background process verifiable
                // even when no music is playing and none of its status values change.
                const renderStatus = kombi.status();
                background.update({ kombiOn: boot.active(),
                    configuredKombiOn: !!settings.get('kombiOn'),
                    autoStartOnBoot: boot.autostartEnabled(),
                    startedAutomatically: boot.startedAutomatically,
                    kombiMode: settings.get('kombiMode'),
                    signedIn: spotify.signedIn(), track: engine.track ? engine.track.title : null,
                    lyrics: engine.lyricsState, kombi: engine.kombiReason || 'allowed',
                    rendererReady: renderStatus.ready, rendererMapState: renderStatus.map.state,
                    pollError: engine.pollError || '', demoSpeed: !!d.demo,
                    heartbeat15s: Math.floor(Date.now() / 15000) });
                if (signOutArmedUntil && Date.now() >= signOutArmedUntil) { signOutArmedUntil = 0; updateButtons(); }
            } catch (e) { log.warn('lyrics tick: ' + (e && e.message || e)); }
        }, 250);
        process.once('exit', () => { clearInterval(ticker); engine.stop(); kombi.close(); });

        const drawnKeys = {};
        const measureBold = (text, size) => font.measure('bold', text, size);
        const measureRegular = (text, size) => font.measure('regular', text, size);
        function pixelText(id, key, w, h, background, paint) {
            if (drawnKeys[id] === key) return;
            const surface = font.surface(w, h, background);
            paint(surface);
            setImage(id, w, h, surface.d);
            drawnKeys[id] = key;
        }
        function header(cv, t, badge) {
            G.frame(cv, t, ['Cluster Lyrics'], 0, [{ text: badge }]);
        }
        function renderNow(cv, t) {
            const track = engine.track;
            header(cv, t, !spotify.signedIn() ? 'NOT SIGNED IN' : track ? (track.playing ? 'PLAYING' : 'PAUSED') : 'IDLE');
            if (!track) {
                cv.text(engine.idleReason || 'Nothing is playing', 48, 150, 34, t.text, { literal: true });
                cv.text(spotify.signedIn() ? 'Start a song in Spotify on your phone.' :
                    'Open Setup to connect your Spotify account.', 48, 200, 22, t.dim, { literal: true });
                if (engine.pollError) cv.text('Last error: ' + engine.pollError.slice(0, 90), 48, 250, 20, t.warn, { literal: true });
            } else {
                // Song text needs umlauts and accents, which the kit's fonts do not have: it is drawn
                // with this app's own font into two pixel images that change only when the text does.
                const title = font.supported(track.title).text, artist = font.supported(track.artist).text;
                pixelText(IMG_HEAD, title + '\n' + artist + '\n' + t.bg, HEAD_W, HEAD_H, t.bg, (s) => {
                    const head = lrc.fit(title, HEAD_W - 8, 1, [34, 30, 26], measureBold);
                    const sub = lrc.fit(artist, HEAD_W - 8, 1, [24], measureRegular);
                    font.draw(s, 'bold', head.lines[0] || '', 0, 34, head.size, t.text);
                    font.draw(s, 'regular', sub.lines[0] || '', 0, 66, 24, t.dim);
                });
                cv.image(IMG_HEAD, 48, 66, HEAD_W, HEAD_H);
                const timing = engine.timing();
                const pos = Math.max(0, timing.trackMs);  // real song position, NOT delayed lyric time
                cv.text('Song ' + clock(pos) + ' / ' + clock(track.durationMs),
                    1552, 98, 22, t.dim, { align: 'right', literal: true });
                const signedDelay = (timing.delayMs > 0 ? '+' : '') + timing.delayMs + ' ms';
                cv.text('Lyrics ' + clock(Math.max(0, timing.lyricMs)) + '  |  Delay ' + signedDelay,
                    1552, 131, 19, timing.delayMs ? t.text : t.dim, { align: 'right', literal: true });
                cv.fillRect(48, 156, 1504, 3, t.track);
                if (track.durationMs) cv.fillRect(48, 156, Math.round(1504 * Math.min(1, pos / track.durationMs)), 3, t.text);
                // The same two lines the cluster shows.
                const f = engine.frame();
                cv.roundRect(48, 180, 1504, 210, 14, BOX_BG);
                if (f) {
                    const accent = COLORS[settings.get('accent')] || COLORS.white;
                    const next = settings.get('showNext') !== false ? f.next : '';
                    pixelText(IMG_LYRICS, (f.gap ? '\u0000' : f.current) + '\n' + next + '\n' + accent, BOX_W, BOX_H, BOX_BG, (s) => {
                        if (f.gap) font.draw(s, 'bold', '\u266A', BOX_W / 2, 96, 44, '#93a1b0', { align: 'center' });
                        else {
                            const cur = lrc.fit(f.current, BOX_W - 40, 1, [46, 40, 34, 28, 24], measureBold);
                            font.draw(s, 'bold', cur.lines[0] || '', BOX_W / 2, 92, cur.size, accent, { align: 'center' });
                        }
                        if (next) {
                            const nx = lrc.fit(next, BOX_W - 40, 1, [26, 22, 18], measureRegular);
                            font.draw(s, 'regular', nx.lines[0] || '', BOX_W / 2, 160, nx.size, '#93a1b0', { align: 'center' });
                        }
                    });
                    cv.image(IMG_LYRICS, 60, 190, BOX_W, BOX_H);
                } else {
                    cv.text('Lyrics: ' + (LYRICS_TEXT[engine.lyricsState] || engine.lyricsState), 800, 292, 26, t.dim,
                        { align: 'center', literal: true });
                }
            }
            const k = kombi.status();
            // "shown" only when the renderer itself reports the map window as shown.
            const shown = k.visible && k.map.state === 'shown';
            const kombiText = !boot.active() ? 'off' : engine.kombiReason ? 'hidden - ' + engine.kombiReason :
                !k.ready ? 'cluster-render not connected' : !k.supported ? 'map window not supported' :
                shown ? 'shown in the map window' : 'requested - map window ' + (k.map.state || '?') +
                    (k.map.holder ? ' (held by ' + k.map.holder + ')' : '');
            cv.text('KOMBI: ' + kombiText, 48, 430, 21, shown ? '#2fd27a' : t.dim, { literal: true });
            cv.text('Mode: ' + settings.display('kombiMode') + '  |  Delay: ' + settings.display('offsetMs') +
                '  |  Internet: ' + http.status(), 48, 464, 19, t.dim, { literal: true });
            if (notice) cv.text(notice.slice(0, 110), 48, 498, 19, t.warn, { literal: true });
        }
        function renderSetup(cv, t) {
            header(cv, t, spotify.signedIn() ? 'SIGNED IN' : 'SETUP');
            const net = http.status(), k = kombi.status();
            const ok = '#2fd27a';
            cv.text('1  Internet (MGU Store uplink): ' + net, 48, 96, 23, net === 'ROUTED' ? ok : t.warn, { literal: true });
            cv.text('Connect the car to your phone hotspot in MGU Store > Settings > Wi-Fi. Reinstall this app after the uplink.',
                80, 126, 18, t.dim, { literal: true });
            const sign = spotify.state === 'ready' ? 'signed in' : spotify.state === 'reauth' ? 'sign-in expired - repeat step 2' : 'not signed in';
            cv.text('2  Spotify: ' + sign, 48, 172, 23, spotify.state === 'ready' ? ok : t.warn, { literal: true });
            cv.text('On a PC run:  python3 tools/spotify_login.py <your client id>   (needs Spotify Premium and your own app', 80, 202, 18, t.dim, { literal: true });
            cv.text('at developer.spotify.com with redirect URI http://127.0.0.1:8898/callback).', 80, 226, 18, t.dim, { literal: true });
            cv.text('Copy ' + IMPORT_NAME + ' to a USB stick, plug it in and press "Import from USB".', 80, 250, 18, t.dim, { literal: true });
            cv.text('3  Lyrics source: LRCLIB (lrclib.net) - synchronised lyrics exist for many, not all songs.', 48, 296, 23, t.text, { literal: true });
            const cluster = !settings.get('kombiOn') ? 'switched off (button "KOMBI lyrics")' : !k.ready ? 'cluster-render not connected' :
                !k.supported ? 'map window ' + JSON.stringify(k.mapSize) + ' not supported' : 'renderer ready, map window ' + (k.map.state || 'idle');
            cv.text('4  Instrument cluster: ' + cluster, 48, 342, 23, settings.get('kombiOn') && k.supported ? ok : t.text, { literal: true });
            cv.text('Default is "Only at a standstill". "Also while driving" is your decision: reading text takes your eyes off the road.',
                80, 372, 18, t.dim, { literal: true });
            if (spotify.lastError || http.lastError) cv.text('Last error: ' + String(spotify.lastError || http.lastError).slice(0, 100), 48, 430, 20, t.warn, { literal: true });
            if (notice) cv.text(notice.slice(0, 110), 48, 480, 21, t.warn, { literal: true });
        }
        function renderLog(cv, t) {
            header(cv, t, 'LOG');
            const k = kombi.status();
            cv.text('Renderer: ' + (k.ready ? 'connected ' + k.backend : 'offline') + '  |  map: ' + (k.map.state || '-') +
                (k.map.holder ? ' holder=' + k.map.holder : '') + '  |  uploaded: ' + k.uploadedKb + ' KB' +
                (k.lastRefused ? '  |  refused: ' + k.lastRefused.slice(0, 40) : ''), 48, 84, 19, t.dim, { literal: true });
            cv.text('Autostart next boot: ' + (boot.autostartEnabled() ? 'On' : 'Off') +
                '  |  This session: ' + (boot.active() ? 'On' : 'Off') +
                '  |  Start reason: ' + ascii(background.startReason).slice(0, 28),
                48, 114, 18, t.dim, { literal: true });
            const lines = events.slice(-12);
            if (!lines.length) cv.text('No events yet.', 48, 160, 21, t.dim, { literal: true });
            lines.forEach((line, i) => {
                cv.text(ascii(line).slice(0, 130), 48, 154 + i * 25, 18,
                    /refused|error|expired/i.test(line) ? t.warn : t.text, { literal: true });
            });
            if (notice) cv.text(notice.slice(0, 110), 48, 506, 19, t.warn, { literal: true });
        }

        updateButtons();
        ctx.loop('MAIN', 4, async () => {
            lastDrawAt = Date.now();
            const t = ctx.theme();
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            try {
                if (page === 'SETUP') renderSetup(cv, t);
                else if (page === 'LOG') renderLog(cv, t);
                else renderNow(cv, t);
            } catch (e) {
                cv.clear(t.bg);
                cv.text('Cluster Lyrics / display error', 48, 100, 30, t.warn, { literal: true });
                cv.text(String(e && e.message || e).slice(0, 100), 48, 150, 21, t.text, { literal: true });
            }
            await ui.image('MAIN_GFX', cv);
        });
    }
});
