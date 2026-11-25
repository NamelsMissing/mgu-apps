'use strict';

const fs = require('fs');
const path = require('path');
const { COMMAND } = require('./audio');
const { exportOriginal, exportComparison, ORIGINAL, PROCESSED } = require('./music_export');
const { RATE, TOTAL_FRAMES } = require('./test_music');
const DURATION = TOTAL_FRAMES * 1000 / RATE;

const PLAYER = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';
const ID = (value) => Number.isInteger(value) && value > 0 && value <= 65535;
const ok = (reply) => reply && (reply.amError === 'E_OK' || reply.amError === 0);
const playerOK = (reply) => reply && (reply.EntError === 'OK' || reply.EntError === 0);
const connected = (link) => link.connectionState === 'CS_CONNECTED' || link.connectionState === 2;
const connectionID = (link) => link.mainConnectionID === undefined ? link.connectionID : link.mainConnectionID;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function list(call, am, method, keys) {
    const reply = await call(am, method);
    const key = ok(reply) && keys.find((k) => Array.isArray(reply[k]));
    if (!key || reply[key].length > 128 || reply[key].some((entry) => !entry || typeof entry !== 'object'))
        throw new Error('AudioManager: ' + method + ' nicht verfügbar.');
    return reply[key];
}
function connections(call, am) {
    return list(call, am, 'getListMainConnections', ['listConnections', 'listMainConnections']);
}
function sources(call, am) {
    return list(call, am, 'getListMainSources', ['listMainSources']);
}
function unique(rows, name, key) {
    const match = rows.filter((entry) => entry.name === name);
    if (match.length !== 1 || !ID(match[0][key])) throw new Error('AudioManager: ' + name + ' nicht eindeutig verfügbar.');
    return match[0][key];
}

class BmwMusic {
    constructor(signals, opts) {
        this.signals = signals;
        this.prepare = opts.prepare || ((dir, filtered) => filtered ? exportComparison(dir, opts.exportOptions) : exportOriginal(dir));
        this.onState = opts.onState;
        this.canRun = opts.canRun;
        this.tmp = opts.tmp || '/tmp';
        this.pause = opts.wait || wait;
        this.active = null;
        this.player = null;
        this.command = null;
    }
    call(proxy, method, args) { return this.signals.call(proxy, method, args || {}, 2200); }
    links(am) { return connections(this.call.bind(this), am); }
    state(status, detail) { this.onState({ status, detail, playing: status === 'playing' }); }
    start(filtered) {
        if (this.active) return this.active.done;
        if (!this.canRun()) {
            this.state('error', 'BMW-Testmusik nur bei bestätigtem Stillstand und sichtbarer App.');
            return Promise.resolve();
        }
        const run = { cancelled: false, owner: null, fileStarted: false, playbackError: false };
        this.active = run;
        run.done = this.play(run, filtered);
        return run.done;
    }
    stop() {
        if (!this.active) return Promise.resolve();
        this.active.cancelled = true;
        return this.active.done;
    }
    async play(run, filtered) {
        let failure, complete = false;
        try {
            this.state('preparing', 'Night Drive A/B wird vorbereitet …');
            run.dir = fs.mkdtempSync(path.join(this.tmp, 'mgu-eq-test-'));
            const pair = await this.prepare(run.dir, filtered);
            const file = filtered ? pair.processed : pair.original;
            if (run.cancelled || !this.canRun()) return;
            // A separately running OEM player needs a traversable path. Only the synthetic track selected for playback is readable.
            fs.chmodSync(file, 0o644);
            fs.chmodSync(run.dir, 0o711);
            this.command = this.command || await this.signals.proxy(COMMAND, '1');
            if (!this.player) {
                const player = await this.signals.proxy(PLAYER, 'OapGenericMedia');
                await this.signals.on(player, 'playbackErrorEvent', () => {
                    if (this.active && this.active.fileStarted) this.active.playbackError = true;
                });
                this.player = player;
            }
            const am = this.command, call = this.call.bind(this);
            const allSources = await sources(call, am);
            const source = unique(allSources, 'OAPGenericMedia', 'sourceID');
            const sink = unique(await list(call, am, 'getListMainSinks', ['listMainSinks']), 'MediaSink_Front', 'sinkID');
            const before = await this.links(am);
            if (before.some((link) => link.sourceID === source)) throw new Error('OAPGenericMedia wird bereits verwendet.');
            const previous = before.filter((link) => link.sinkID === sink);
            if (previous.length > 1 || previous.some((link) => !connected(link)))
                throw new Error('BMW-Medienroute wechselt gerade oder ist mehrdeutig.');
            if (previous.length && !allSources.some((entry) => entry.sourceID === previous[0].sourceID &&
                /^(CarPlayMedia|Radio|BluetoothAudio|USBMedia|DynamicMedia)$/i.test(entry.name)))
                throw new Error('Vorhandene BMW-Medienroute kann nicht eindeutig zugeordnet werden.');
            if (run.cancelled || !this.canRun()) return;
            let response;
            try { response = await call(am, 'connect', { sourceID: source, sinkID: sink }); }
            catch (_) { throw new Error('AudioManager-Verbindungsaufbau unbestätigt · BMW-Medienroute prüfen.'); }
            if (!ok(response) || !ID(response.mainConnectionID) ||
                before.some((link) => connectionID(link) === response.mainConnectionID))
                throw new Error('AudioManager hat keine neue eigene Verbindung bestätigt.');
            run.owner = { id: response.mainConnectionID, source, sink, previous: previous[0] };
            if (run.cancelled || !this.canRun()) return;
            if (!this.routeUsable(await this.links(am), run.owner))
                throw new Error('Eigene AudioManager-Verbindung fehlt.');
            if (run.cancelled || !this.canRun()) return;
            run.fileStarted = true;
            const played = await call(this.player, 'playFile', { path: file, languageCode: 0 });
            if (!playerOK(played)) throw new Error('BMW MediaPlayer hat die WAV-Datei abgelehnt.');
            complete = await this.monitor(run, filtered);
        } catch (e) {
            failure = e.message;
        } finally {
            try { await this.release(run); }
            catch (e) { failure = [failure, e.message].filter(Boolean).join(' · '); }
            this.active = null;
            if (failure) this.state('error', failure);
            else this.state(complete ? 'finished' : 'stopped', complete ? 'BMW-Test beendet · Lautsprecherausgabe unbestätigt' : 'BMW-Test gestoppt');
        }
    }
    owns(link, owner) {
        return connectionID(link) === owner.id && link.sourceID === owner.source && link.sinkID === owner.sink;
    }
    routeUsable(links, owner) {
        return links.some((link) => this.owns(link, owner) &&
            !['CS_DISCONNECTING', 'CS_DISCONNECTED', 'CS_SUSPENDED', 3, 4, 5].includes(link.connectionState)) &&
            !links.some((link) => link.sinkID === owner.sink && !this.owns(link, owner) && connected(link));
    }
    async monitor(run, filtered) {
        let reported = false, last = 0, stalled = 0;
        const deadline = Date.now() + 42000;
        for (let poll = 0; poll < 44 && Date.now() < deadline; poll++) {
            await this.pause(900);
            if (run.cancelled || !this.canRun()) return false;
            if (run.playbackError) throw new Error('BMW MediaPlayer meldet einen Wiedergabefehler.');
            if (!this.routeUsable(await this.links(this.command), run.owner))
                throw new Error('Eigene BMW-Medienroute wurde beendet.');
            if (run.cancelled || !this.canRun()) return false;
            const time = await new Promise((resolve, reject) => setImmediate(() => {
                Promise.resolve().then(() => this.player.getValue('currentItemTime', 1600)).then(resolve, reject);
            }));
            const elapsed = time && time.elapsed;
            if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error('BMW-Wiedergabezeit nicht lesbar.');
            if (elapsed > last) {
                if (!reported) this.state('playing', (filtered ? 'DSP-Version' : 'Original') +
                    ' · BMW-Playerposition läuft · Lautsprecherausgabe unbestätigt');
                reported = true;
                stalled = 0;
            } else if (++stalled >= 5) throw new Error('BMW-Wiedergabeposition läuft nicht.');
            const total = time && time.total;
            if (Number.isFinite(total) && total > 0 && Math.abs(total - DURATION) > 1500)
                throw new Error('BMW-Player meldet eine andere Titeldauer.');
            if (reported && (elapsed >= DURATION - 50 || last >= DURATION - 1000 && elapsed < last)) return true;
            last = elapsed;
        }
        throw new Error('BMW-Test hat sein Zeitlimit erreicht.');
    }
    async release(run) {
        try {
            if (!run.owner) return;
            const owner = run.owner, am = this.command;
            let ownLink = false, exclusiveSource = false, cleanupError;
            try {
                const links = await this.links(am);
                ownLink = links.some((link) => this.owns(link, owner));
                exclusiveSource = !links.some((link) => link.sourceID === owner.source && !this.owns(link, owner));
            } catch (_) { cleanupError = new Error('Eigene BMW-Medienroute nicht überprüfbar.'); }
            if (!ownLink && !cleanupError) return;
            if (run.fileStarted && ownLink && exclusiveSource) {
                for (const action of ['PRESS', 'RELEASE']) {
                    try {
                        if (!playerOK(await this.call(this.player, 'sendButtonEvent', { button: 'STOP', action })))
                            throw new Error('STOP abgelehnt');
                    } catch (_) { cleanupError = new Error('BMW-Player-Stop unbestätigt.'); }
                }
            }
            // Only a positively acknowledged connect grants ownership. Never sweep other IDs.
            for (let attempt = 0; ; attempt++) {
                try {
                    if (ok(await this.call(am, 'disconnect', { mainConnectionID: owner.id }))) break;
                } catch (_) {}
                const remaining = await this.links(am);
                if (!remaining.some((link) => this.owns(link, owner))) break;
                if (attempt >= 1) throw new Error('Eigene BMW-Medienroute konnte nicht freigegeben werden.');
            }
            await this.pause(650);
            let current = await this.links(am);
            if (current.some((link) => this.owns(link, owner))) {
                await this.pause(650);
                current = await this.links(am);
                if (current.some((link) => this.owns(link, owner)))
                    throw new Error('Abbau der eigenen BMW-Medienroute unbestätigt.');
            }
            if (owner.previous) {
                if (!current.some((link) => link.sinkID === owner.sink)) {
                    const reply = await this.call(am, 'connect', {
                        sourceID: owner.previous.sourceID, sinkID: owner.sink
                    });
                    if (!ok(reply) || !(await this.links(am)).some((link) =>
                        link.sourceID === owner.previous.sourceID && link.sinkID === owner.sink))
                        throw new Error('Vorherige BMW-Medienroute konnte nicht bestätigt werden.');
                }
            }
            if (cleanupError) throw cleanupError;
        } finally {
            if (run.dir) {
                for (const name of [ORIGINAL, PROCESSED, ORIGINAL + '.part', PROCESSED + '.part']) {
                    try { fs.unlinkSync(path.join(run.dir, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
                }
                fs.rmdirSync(run.dir);
            }
        }
    }
}
module.exports = { BmwMusic, PLAYER, sources, connections, connected };
