'use strict';
/*
 * Ties the parts together: asks Spotify what is playing, gets the lyrics for
 * it, works out the line for the current position and decides whether the
 * instrument cluster may show it. No kit or HMI code here, so it runs in
 * unit tests as it does in the car.
 */
const lrc = require('./lrc.js');
const font = require('./lyric_font.js');
const { positionAt } = require('./spotify.js');

const POLL_PLAYING_MS = 4000, POLL_IDLE_MS = 8000, POLL_NO_UPLINK_MS = 10000;
const STALE_MS = 20000, PAUSE_HIDE_MS = 5000;
const STAND_MS = 1500, STAND_KMH = 1, MOVE_KMH = 3, SPEED_FRESH_MS = 3000;
const READABLE_SHARE = 0.8;

/** Lines the cluster font can draw; null when too much of the text is in another script. */
function displayable(lines) {
    let withText = 0, readable = 0;
    const out = lines.map(line => {
        if (!line.text) return { t: line.t, text: '' };
        withText++;
        const s = font.supported(line.text);
        if (s.readable) readable++;
        return { t: line.t, text: s.readable ? s.text : '' };
    });
    return withText && readable / withText >= READABLE_SHARE ? out : null;
}

class LyricsEngine {
    constructor(parts) {
        this.spotify = parts.spotify;
        this.lyrics = parts.lyrics;
        this.kombi = parts.kombi;
        this.log = parts.log || console;
        this.now = parts.now || Date.now;
        this.setTimer = parts.setTimer || setTimeout;
        this.clearTimer = parts.clearTimer || clearTimeout;
        this.options = { kombiOn: false, kombiMode: 'parked', offsetMs: 0 };
        this.track = null;            // last 'track' answer
        this.idleReason = 'Waiting for Spotify';
        this.lastPollOkAt = 0;
        this.pausedSince = 0;
        this.pollError = '';
        this.errorCount = 0;
        this.lyricsFor = null;        // track key the lyrics belong to
        this.lyricsState = 'idle';    // idle | loading | synced | plain | instrumental | none | unreadable | error
        this.lines = [];
        this.timer = null;
        this.polling = false;
        this.active = false;
        this.vehicle = { speed: null, at: 0, demo: false };
        this.standingSince = 0;
        this.parked = false;
        this.kombiReason = 'switched off';
        this.nextPollAt = 0;
    }
    configure(options) { this.options = Object.assign({}, this.options, options); }

    /** Polling runs only while someone can see the result. */
    setActive(active) {
        active = !!active;
        if (active === this.active) return;
        this.active = active;
        if (active) this._schedule(0);
        else if (this.timer) { this.clearTimer(this.timer); this.timer = null; }
    }
    stop() { this.active = false; if (this.timer) this.clearTimer(this.timer); this.timer = null; }
    kick() { if (this.active) this._schedule(0); }

    _schedule(ms) {
        if (this.timer) this.clearTimer(this.timer);
        this.nextPollAt = this.now() + ms;
        this.timer = this.setTimer(() => { this.timer = null; this.pollOnce().then(() => {}, () => {}); }, ms);
    }
    _key(track) { return track.id || (track.title + '\n' + track.artist + '\n' + track.durationMs); }

    /** One request to Spotify; schedules the next one itself. */
    pollOnce() {
        if (this.polling) return Promise.resolve();
        if (!this.spotify.signedIn()) {
            this.track = null;
            this.idleReason = this.spotify.state === 'reauth' ? 'Spotify sign-in expired' : 'Not signed in to Spotify';
            return Promise.resolve();   // no timer: importing a sign-in kicks the engine
        }
        this.polling = true;
        return this.spotify.nowPlaying().then(answer => {
            this.polling = false;
            this.pollError = ''; this.errorCount = 0;
            this.lastPollOkAt = this.now();
            let wait = POLL_IDLE_MS;
            if (answer.kind === 'track') {
                const changed = !this.track || this._key(this.track) !== this._key(answer);
                this.track = answer;
                if (answer.playing) {
                    this.pausedSince = 0;
                    const left = answer.durationMs ? answer.durationMs - answer.progressMs : POLL_PLAYING_MS;
                    wait = Math.max(1000, Math.min(POLL_PLAYING_MS, left + 700));
                } else if (!this.pausedSince) this.pausedSince = this.now();
                if (changed) this._loadLyrics(answer);
            } else {
                this.track = null; this.idleReason = answer.reason || 'Nothing is playing';
            }
            if (this.active) this._schedule(wait);
        }, error => {
            this.polling = false;
            const code = error && error.code;
            this.pollError = String(error && (error.message || code) || error);
            this.errorCount++;
            let wait = Math.min(60000, 5000 * Math.pow(2, Math.min(4, this.errorCount - 1)));
            if (code === 'RATE_LIMIT') wait = error.retryAfterMs || 5000;
            else if (code === 'NO_UPLINK') wait = POLL_NO_UPLINK_MS;
            else if (code === 'REAUTH' || code === 'SIGNED_OUT') {
                this.track = null; this.idleReason = 'Spotify sign-in expired';
                return;   // nothing to retry until a new sign-in is imported
            }
            if (this.active) this._schedule(wait);
        });
    }
    _loadLyrics(track) {
        const key = this._key(track);
        this.lyricsFor = key; this.lyricsState = 'loading'; this.lines = [];
        this.lyrics.get(track).then(res => {
            if (this.lyricsFor !== key) return;   // the song changed meanwhile
            if (res.status === 'synced') {
                const lines = displayable(res.lines);
                if (lines) { this.lines = lines; this.lyricsState = 'synced'; }
                else this.lyricsState = 'unreadable';
            } else this.lyricsState = res.status;
        }, error => {
            if (this.lyricsFor !== key) return;
            this.lyricsState = 'error';
            this.lyricsError = String(error && (error.message || error.code) || error);
        });
    }
    reloadLyrics() {
        if (!this.track) return false;
        if (this.lyrics.memory) this.lyrics.memory.delete(this._key(this.track));
        this._loadLyrics(this.track);
        return true;
    }

    /** speedKmh: number or null; ageMs: age of the sample; demo: emulator data. */
    observeVehicle(speedKmh, ageMs, demo) {
        const now = this.now();
        const fresh = !demo && typeof speedKmh === 'number' && Number.isFinite(speedKmh) &&
            typeof ageMs === 'number' && ageMs >= 0 && ageMs <= SPEED_FRESH_MS;
        this.vehicle = { speed: fresh ? speedKmh : null, at: now, demo: !!demo };
        if (!fresh || speedKmh >= MOVE_KMH) { this.standingSince = 0; this.parked = false; return; }
        if (speedKmh < STAND_KMH) {
            if (!this.standingSince) this.standingSince = now;
            if (now - this.standingSince >= STAND_MS) this.parked = true;
        }
        // Between the two thresholds the last decision stands.
    }

    /** Spotify playback position before lyric offset (used for the song progress bar). */
    rawPosition() { return this.track ? positionAt(this.track, this.now()) : 0; }
    /** Inspect the exact lyric clock without accidentally cancelling the delay. */
    timing() {
        const trackMs = this.rawPosition();
        const delayMs = Number(this.options.offsetMs) || 0;
        return { trackMs, lyricMs: trackMs - delayMs, delayMs };
    }
    /** Positive delay = display a lyric later; negative delay = earlier. */
    position() { return this.timing().lyricMs; }
    /** { index, current, next, gap } for now, or null without synced lyrics. */
    frame() {
        if (!this.track || this.lyricsState !== 'synced' || this.lyricsFor !== this._key(this.track)) return null;
        return lrc.frame(this.lines, this.position());
    }
    /** No usable timed lyrics: show a note instead of unsynchronised text. */
    _noteOnly() {
        return this.lyricsState === 'none' || this.lyricsState === 'plain' ||
            this.lyricsState === 'instrumental' || this.lyricsState === 'unreadable';
    }
    /** Why the cluster shows nothing, or '' when it may show the lyrics. */
    kombiBlock() {
        const now = this.now();
        if (!this.options.kombiOn) return 'switched off';
        if (!this.spotify.signedIn()) return 'not signed in';
        if (!this.track) return 'nothing playing';
        if (!this.track.playing && this.pausedSince && now - this.pausedSince >= PAUSE_HIDE_MS) return 'paused';
        if (now - this.lastPollOkAt > STALE_MS) return 'Spotify state too old';
        if (this.lyricsFor !== this._key(this.track) || this.lyricsState === 'loading') return 'lyrics loading';
        if (this.lyricsState !== 'synced' && !this._noteOnly()) return 'no synchronised lyrics (' + this.lyricsState + ')';
        if (this.options.kombiMode !== 'always') {
            if (this.vehicle.demo) return 'no live vehicle data';
            if (this.vehicle.speed === null || now - this.vehicle.at > SPEED_FRESH_MS) return 'no fresh speed signal';
            if (!this.parked) return 'vehicle moving';
        }
        return '';
    }
    /** Call a few times a second. */
    tick() {
        const block = this.kombiBlock();
        this.kombiReason = block;
        if (block) {
            if (block === 'switched off') this.kombi.release(block);
            else this.kombi.hide(block);
            return;
        }
        if (this._noteOnly()) {
            this.kombi.show({ title: '', artist: '', current: '', next: '', gap: true, noteOnly: true });
            return;
        }
        const f = this.frame();
        if (!f) { this.kombi.hide('no frame'); return; }
        this.kombi.show({ title: font.supported(this.track.title).text, artist: font.supported(this.track.artist).text,
            current: f.current, next: f.next, gap: f.gap });
    }
}

module.exports = { LyricsEngine, displayable, POLL_PLAYING_MS, POLL_IDLE_MS, STALE_MS, PAUSE_HIDE_MS, STAND_MS };
