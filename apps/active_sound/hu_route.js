'use strict';
/*
 * hu_route.js - a BMW AudioManager route for Active Sound's head-unit output.
 *
 * The head unit plays our PCM only through a media source that AudioManager has connected to the
 * front speakers (MediaSink_Front); the native helper mgu-sound-pcm then writes to that source's
 * SmartX endpoint. Safety rules (as in GameStation's audio_route.js):
 *   - only sources from the candidate list (or hu-route.json), each must exist exactly once and be
 *     reported available; nothing is advertised or re-mapped
 *   - the front media sink must be free: while music or another app plays there, nothing is
 *     connected (the head-unit output would replace the music - the phone route mixes instead)
 *   - only a connection this process created and AudioManager confirmed is ever disconnected;
 *     an unconfirmed connect blocks further attempts until restart
 * discover() only reads (sources, sinks, connections) and probes the endpoint - for the Setup test.
 */
const fs = require('fs');
const path = require('path');

const COMMAND = 'org.genivi.am.commandinterface.CommandControl';
const SINK = 'MediaSink_Front';
const CANDIDATES = ['ActiveSoundMedia', 'GameStationMedia', 'CarLifeMedia'];
const TIMEOUT = 1800;
const ok = (r) => r && (r.amError === 'E_OK' || r.amError === 0);
const id = (n) => Number.isInteger(n) && n > 0 && n <= 65535;
const linkId = (c) => (c.mainConnectionID === undefined ? c.connectionID : c.mainConnectionID);
const connected = (c) => c.connectionState === 'CS_CONNECTED' || c.connectionState === 2;
const live = (c) => c.connectionState !== 'CS_DISCONNECTED' && c.connectionState !== 4;
const available = (row) => {
    const a = row.availability, v = a && typeof a === 'object' ? a.availability : a;
    return v === 'A_AVAILABLE' || v === 1;
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const endpoint = (source) => 'plug:smartx:' + source + '_CF_48_STEREO';

async function list(signals, proxy, method, keys) {
    const reply = await signals.call(proxy, method, {}, TIMEOUT);
    const key = ok(reply) && keys.find((k) => Array.isArray(reply[k]));
    if (!key || reply[key].length > 256 || reply[key].some((row) => !row || typeof row !== 'object'))
        throw new Error('AudioManager: ' + method + ' unavailable');
    return reply[key];
}
const sources = (s, p) => list(s, p, 'getListMainSources', ['listMainSources']);
const sinks = (s, p) => list(s, p, 'getListMainSinks', ['listMainSinks']);
const connections = (s, p) => list(s, p, 'getListMainConnections', ['listConnections', 'listMainConnections']);

/** hu-route.json in the app data folder: { "source": "<AudioManager source>", "device": "[plug:]smartx:<X>_CF_48_STEREO" } */
function readOverride(dir) {
    try {
        const file = path.join(dir, 'hu-route.json');
        if (fs.statSync(file).size > 400) return null;
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!v || !/^[A-Za-z0-9_]{1,64}$/.test(v.source)) return null;
        const device = typeof v.device === 'string' && /^(plug:)?smartx:[A-Za-z0-9_]{1,80}_CF_48_STEREO$/.test(v.device) ? v.device : endpoint(v.source);
        return { source: v.source, device };
    } catch (_) { return null; }
}

class HuRoute {
    /** signals: ctx.signals; options: { dataDir, wait } */
    constructor(signals, options) {
        const o = options || {};
        this.signals = signals; this.dataDir = o.dataDir || '';
        this.wait = o.wait || delay;
        this.proxy = null; this.owner = null; this.uncertain = false;
        this.info = { state: 'Idle' };
    }
    async ensureProxy() {
        if (this.proxy) return this.proxy;
        let timer;
        try {
            this.proxy = await Promise.race([
                Promise.resolve().then(() => this.signals.proxy(COMMAND, '1')),
                new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('AudioManager not reachable')), TIMEOUT); }),
            ]);
        } finally { clearTimeout(timer); }
        return this.proxy;
    }
    candidates() {
        const o = this.dataDir ? readOverride(this.dataDir) : null;
        return o ? [o] : CANDIDATES.map((source) => ({ source, device: endpoint(source) }));
    }
    async links() {
        const links = await connections(this.signals, this.proxy);
        if (links.some((c) => !id(c.sourceID) || !id(c.sinkID) || !id(linkId(c)) || c.connectionState === undefined))
            throw new Error('AudioManager: unrecognized connection record');
        return links;
    }
    matches(c) { return !!this.owner && linkId(c) === this.owner.id && c.sourceID === this.owner.source && c.sinkID === this.owner.sink; }
    /** Read-only look at the head unit: what exists, what is free, which candidate would be used. */
    async discover(probe) {
        await this.ensureProxy();
        const src = await sources(this.signals, this.proxy), snk = await sinks(this.signals, this.proxy), links = await this.links();
        const front = snk.filter((s) => s.name === SINK);
        const name = (sid) => { const s = src.find((x) => x.sourceID === sid); return s ? s.name : String(sid); };
        const report = {
            at: new Date().toISOString(),
            sources: src.map((s) => ({ name: s.name, id: s.sourceID, available: available(s) })),
            frontSink: front.length === 1 ? { id: front[0].sinkID, available: available(front[0]) } : null,
            frontInUse: front.length === 1 ? links.filter((c) => c.sinkID === front[0].sinkID && live(c)).map((c) => name(c.sourceID)) : [],
            candidates: [], chosen: null,
        };
        for (const c of this.candidates()) {
            const rows = src.filter((s) => s.name === c.source);
            const row = { source: c.source, device: c.device, present: rows.length === 1, available: rows.length === 1 && available(rows[0]) };
            if (row.present && row.available && probe) {
                try { await probe(c.device); row.endpoint = 'ok'; } catch (e) { row.endpoint = String(e.message || e).slice(0, 160); }
            }
            report.candidates.push(row);
            if (!report.chosen && row.present && row.available && (!probe || row.endpoint === 'ok')) report.chosen = c.source;
        }
        return report;
    }
    /** Connect the first usable candidate to the front speakers; resolves to its SmartX endpoint. */
    async acquire(allowed, probe) {
        if (this.uncertain) throw new Error('BMW connect unconfirmed; restart the app after checking the media source');
        if (this.owner) return this.owner.device;
        this.info = { state: 'Discovering' };
        await this.ensureProxy();
        if (!allowed()) return null;
        const src = await sources(this.signals, this.proxy), snk = await sinks(this.signals, this.proxy);
        const front = snk.filter((s) => s.name === SINK);
        if (front.length !== 1 || !id(front[0].sinkID)) throw new Error('Front media sink missing or ambiguous');
        const sink = front[0];
        let pick = null;
        for (const c of this.candidates()) {
            const rows = src.filter((s) => s.name === c.source);
            if (rows.length === 1 && id(rows[0].sourceID) && available(rows[0])) { pick = Object.assign({ row: rows[0] }, c); break; }
        }
        if (!pick) throw new Error('No free BMW media source for Active Sound (tried ' + this.candidates().map((c) => c.source).join(', ') + ')');
        Object.assign(this.info, { source: pick.source, sourceID: pick.row.sourceID, sinkID: sink.sinkID, device: pick.device });
        const busy = (links) => links.some((c) => live(c) && !this.matches(c) && (c.sinkID === sink.sinkID || c.sourceID === pick.row.sourceID));
        if (busy(await this.links())) throw new Error('Front speakers busy (music or another app): head-unit sound would replace it - use the phone, or stop the media');
        if (!allowed()) return null;
        this.info.state = 'Checking endpoint';
        await probe(pick.device);
        if (!allowed()) return null;
        const before = await this.links();
        if (busy(before)) throw new Error('Front speakers became busy');
        this.info.state = 'Connecting';
        let reply;
        try { reply = await this.signals.call(this.proxy, 'connect', { sourceID: pick.row.sourceID, sinkID: sink.sinkID }, TIMEOUT); }
        catch (_) { this.uncertain = true; throw new Error('BMW connect unconfirmed; other routes left untouched'); }
        if (!ok(reply) || !id(reply.mainConnectionID) || before.some((c) => linkId(c) === reply.mainConnectionID))
            throw new Error('AudioManager did not confirm a new connection');
        this.owner = { id: reply.mainConnectionID, source: pick.row.sourceID, sink: sink.sinkID, device: pick.device };
        for (let i = 0; i < 4; i++) {
            if (await this.check()) return pick.device;
            if (i < 3) await this.wait(180);
        }
        throw new Error('BMW media connection did not come up');
    }
    async check() {
        const own = (await this.links()).find((c) => this.matches(c));
        this.info.state = own && connected(own) ? 'Connected' : 'Connecting / unavailable';
        return !!own && connected(own);
    }
    async release() {
        if (!this.owner) return;
        this.info.state = 'Releasing';
        const mid = this.owner.id;
        if ((await this.links()).some((c) => this.matches(c) && live(c))) {
            const reply = await this.signals.call(this.proxy, 'disconnect', { mainConnectionID: mid }, TIMEOUT);
            if (!ok(reply)) throw new Error('disconnect refused');
            for (let i = 0; i < 3; i++) {
                if (!(await this.links()).some((c) => this.matches(c) && live(c))) break;
                if (i === 2) throw new Error('release unconfirmed');
                await this.wait(120);
            }
        }
        this.owner = null;
        this.info.state = 'Released';
    }
}

module.exports = { HuRoute, CANDIDATES, SINK, endpoint, readOverride };
