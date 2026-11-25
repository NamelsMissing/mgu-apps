'use strict';

// This profile is reserved for GameStation by the head-unit integrator. A media
// name alone is not a mapping to a PCM device. The helper must also negotiate
// the declared endpoint before it accepts any samples.
const COMMAND = 'org.genivi.am.commandinterface.CommandControl';
const SOURCE = 'GameStationMedia';
const SINK = 'MediaSink_Front';
const DEVICE = 'smartx:GameStationMedia_CF_48_STEREO';
const TIMEOUT = 1800;
const ok = r => r && (r.amError === 'E_OK' || r.amError === 0);
const id = n => Number.isInteger(n) && n > 0 && n <= 65535;
const linkId = c => c.mainConnectionID === undefined ? c.connectionID : c.mainConnectionID;
const connected = c => c.connectionState === 'CS_CONNECTED' || c.connectionState === 2;
const live = c => c.connectionState !== 'CS_DISCONNECTED' && c.connectionState !== 4;
const available = row => {
    const a = row.availability;
    const value = a && typeof a === 'object' ? a.availability : a;
    return value === 'A_AVAILABLE' || value === 1;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function list(signals, proxy, method, keys) {
    const reply = await signals.call(proxy, method, {}, TIMEOUT);
    const key = ok(reply) && keys.find(k => Array.isArray(reply[k]));
    if (!key || reply[key].length > 256 || reply[key].some(row => !row || typeof row !== 'object'))
        throw new Error('AudioManager: ' + method + ' unavailable');
    return reply[key];
}
const sources = (s, p) => list(s, p, 'getListMainSources', ['listMainSources']);
const sinks = (s, p) => list(s, p, 'getListMainSinks', ['listMainSinks']);
const connections = (s, p) => list(s, p, 'getListMainConnections', ['listConnections', 'listMainConnections']);
function unique(rows, name, key) {
    const found = rows.filter(row => row.name === name);
    if (found.length !== 1 || !id(found[0][key]) ||
        rows.filter(row => row[key] === found[0][key]).length !== 1) throw new Error('AudioManager: ' + name + ' missing or ambiguous');
    return found[0];
}

class AudioRoute {
    constructor(signals, options) {
        this.signals = signals;
        this.wait = options && options.wait || delay;
        this.proxy = null;
        this.owner = null;
        this.uncertain = false;
        this.info = {state: 'Idle'};
    }
    async links() {
        const links = await connections(this.signals, this.proxy);
        if (links.some(c => !id(c.sourceID) || !id(c.sinkID) || !id(linkId(c)) || c.connectionState === undefined))
            throw new Error('AudioManager: unrecognized connection record');
        return links;
    }
    matches(c) {
        return !!this.owner && linkId(c) === this.owner.id && c.sourceID === this.owner.source && c.sinkID === this.owner.sink;
    }
    foreign(links) {
        return links.some(c => live(c) && !this.matches(c) &&
            (c.sourceID === this.info.sourceID || c.sinkID === this.info.sinkID));
    }
    async acquire(allowed, probe) {
        if (this.uncertain) throw new Error('BMW connect unconfirmed; restart after checking the front route');
        if (this.owner) throw new Error('Previous GameStation route release unconfirmed');
        this.info = {state: 'Discovering'};
        if (!this.proxy) {
            let timeout;
            try {
                this.proxy = await Promise.race([
                    Promise.resolve().then(() => this.signals.proxy(COMMAND, '1')),
                    new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('AudioManager discovery timed out')), TIMEOUT); }),
                ]);
            } finally { clearTimeout(timeout); }
        }
        if (!allowed()) return null;
        const source = unique(await sources(this.signals, this.proxy), SOURCE, 'sourceID');
        Object.assign(this.info, {source: source.name, sourceID: source.sourceID});
        const sink = unique(await sinks(this.signals, this.proxy), SINK, 'sinkID');
        Object.assign(this.info, {sink: sink.name, sinkID: sink.sinkID});
        if (!available(source) || !available(sink)) throw new Error('Dedicated BMW audio route unavailable');
        // Reject every occupied or transitional state and never restore another app's route.
        if (this.foreign(await this.links())) throw new Error('BMW audio source or front sink occupied');
        if (!allowed()) return null;
        this.info.state = 'Checking ALSA endpoint';
        await probe(DEVICE);
        if (!allowed()) return null;
        const before = await this.links();
        if (this.foreign(before)) throw new Error('BMW audio source or front sink occupied');
        if (!allowed()) return null;
        this.info.state = 'Connecting';
        let response;
        try {
            response = await this.signals.call(this.proxy, 'connect', {sourceID: source.sourceID, sinkID: sink.sinkID}, TIMEOUT);
        } catch (_) {
            this.uncertain = true;
            throw new Error('BMW connect unconfirmed; unknown routes are left untouched');
        }
        if (!ok(response) || !id(response.mainConnectionID) || before.some(c => linkId(c) === response.mainConnectionID))
            throw new Error('AudioManager did not confirm a new GameStation connection');
        this.owner = {id: response.mainConnectionID, source: source.sourceID, sink: sink.sinkID};
        this.info.connectionID = this.owner.id;
        for (let i = 0; i < 4 && allowed(); i++) {
            if (await this.check()) return allowed() ? DEVICE : null;
            if (i < 3) await this.wait(180);
        }
        if (allowed()) throw new Error('BMW GameStation audio connection timed out');
        return null;
    }
    async check() {
        const links = await this.links();
        if (this.foreign(links)) throw new Error('Another BMW audio route is active');
        const own = links.find(c => this.matches(c));
        this.info.state = own && connected(own) ? 'Connected' : 'Connecting / unavailable';
        return !!own && connected(own);
    }
    async release() {
        if (!this.owner) return;
        this.info.state = 'Releasing';
        const {id} = this.owner;
        if ((await this.links()).some(c => this.matches(c) && live(c))) {
            const reply = await this.signals.call(this.proxy, 'disconnect', {mainConnectionID: id}, TIMEOUT);
            if (!ok(reply)) throw new Error('GameStation route disconnect refused');
            for (let i = 0; i < 3; i++) {
                if (!(await this.links()).some(c => this.matches(c) && live(c))) break;
                if (i === 2) throw new Error('GameStation route release unconfirmed');
                await this.wait(120);
            }
        }
        this.owner = null;
        this.info.connectionID = null;
        this.info.state = 'Released';
    }
}

async function readFrontSource(signals) {
    const proxy = await signals.proxy(COMMAND, '1');
    const all = await sources(signals, proxy);
    const front = (await sinks(signals, proxy)).filter(row => row.name === SINK);
    const links = await connections(signals, proxy);
    if (front.length !== 1) return 'Front sink unavailable';
    return links.filter(row => row.sinkID === front[0].sinkID && connected(row))
        .map(row => {
            const source = all.find(s => s.sourceID === row.sourceID);
            return source ? source.name : String(row.sourceID);
        }).join(', ') || 'No active front route';
}

module.exports = {AudioRoute, readFrontSource, DEVICE};
