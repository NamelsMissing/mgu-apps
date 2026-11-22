'use strict';
// Cluster Lyrics: offline tests with a fake uplink, fake Spotify/LRCLIB answers
// and a fake cluster renderer. All lyric lines here are invented test text.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const APP = path.join(__dirname, '..', 'apps', 'cluster_lyrics');
const lrc = require(path.join(APP, 'lrc.js'));
const font = require(path.join(APP, 'lyric_font.js'));
const { UplinkHttp, publicIpv4 } = require(path.join(APP, 'uplink_http.js'));
const { Spotify, positionAt, validImport, IMPORT_NAME } = require(path.join(APP, 'spotify.js'));
const { Lyrics, plainTitle } = require(path.join(APP, 'lrclib.js'));
const K = require(path.join(APP, 'kombi.js'));
const { LyricsEngine, displayable } = require(path.join(APP, 'engine.js'));
const { BootControl } = require(path.join(APP, 'boot_control.js'));

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-lyrics-'));
const LRC = '[ar:Test Artist]\n[00:05.00] First test line\n[00:10.50]Zweite Zeile mit Umlaut ü\n' +
    '[00:15.00]\n[00:20.00][00:40.00] Repeated line\n[00:30.25] Line <00:31.00> with word tags\nno tag here\n';

async function rejects(promise, code) {
    try { await promise; } catch (e) { assert.strictEqual(e.code, code, e.message); return e; }
    assert.fail('expected rejection ' + code);
}

/* ---------- LRC ---------- */
function testLrc() {
    const lines = lrc.parse(LRC);
    assert.deepStrictEqual(lines.map(l => l.t), [5000, 10500, 15000, 20000, 30250, 40000]);
    assert.strictEqual(lines[4].text, 'Line with word tags');
    assert.strictEqual(lines[2].text, '');
    assert.strictEqual(lrc.indexAt(lines, 0), -1);
    assert.strictEqual(lrc.indexAt(lines, 5000), 0);
    assert.strictEqual(lrc.indexAt(lines, 29999), 3);
    assert.strictEqual(lrc.indexAt(lines, 999999), 5);
    assert.deepStrictEqual(lrc.frame(lines, 1000), { index: -1, current: '', next: 'First test line', gap: true });
    assert.deepStrictEqual(lrc.frame(lines, 16000), { index: 2, current: '', next: 'Repeated line', gap: true });
    assert.deepStrictEqual(lrc.frame(lines, 41000), { index: 5, current: 'Repeated line', next: '', gap: false });
    // [offset:+500] shows everything half a second earlier.
    assert.strictEqual(lrc.parse('[offset:+500]\n[00:05.00]x')[0].t, 4500);
    assert.deepStrictEqual(lrc.parse('just text\n[ti:Title]'), []);
    assert.strictEqual(lrc.parse('[01:02]a')[0].t, 62000);
    assert.strictEqual(lrc.parse('[00:01.5]a')[0].t, 1500);
    const measure = s => s.length * 10;
    assert.deepStrictEqual(lrc.wrap('aaa bbb ccc', 70, 2, measure), ['aaa bbb', 'ccc']);
    assert.strictEqual(lrc.wrap('aaa bbb ccc ddd eee', 70, 2, measure), null);
    assert.strictEqual(lrc.wrap('abcdefghijkl', 70, 2, measure), null);
    const fitted = lrc.fit('aaa bbb ccc ddd', 100, 2, [20, 10], (s, size) => s.length * size);
    assert.deepStrictEqual(fitted, { size: 10, lines: ['aaa bbb', 'ccc ddd'] });
    const cut = lrc.fit('abcdefghijklmnopqrstuvwxyz', 100, 1, [10], (s, size) => s.length * size);
    assert.strictEqual(cut.lines.length, 1);
    assert.ok(cut.lines[0].endsWith('…') && cut.lines[0].length <= 10);
}

/* ---------- font ---------- */
function testFont() {
    const s = font.supported('Über  den Wolken – „Frei“');
    assert.strictEqual(s.text, 'Über den Wolken – „Frei“');
    assert.ok(s.readable && s.missing === 0);
    assert.strictEqual(font.supported('日本語').readable, false);
    assert.ok(font.supported('Привет').readable);
    assert.ok(font.measure('bold', 'WW', 56) > font.measure('bold', 'ii', 56));
    assert.ok(Math.abs(font.measure('bold', 'Test', 28) * 2 - font.measure('bold', 'Test', 56)) < 0.001);
    const surface = font.surface(200, 60);
    font.draw(surface, 'bold', 'Ä', 100, 50, 40, '#ffffff', { align: 'center' });
    let lit = 0;
    for (let i = 3; i < surface.d.length; i += 4) if (surface.d[i]) lit++;
    assert.ok(lit > 200, 'glyph drawn');
    // Drawing outside the surface must not throw or write.
    font.draw(surface, 'bold', 'X', -500, -500, 40, '#ffffff');
    font.draw(surface, 'bold', 'X', 5000, 5000, 40, '#ffffff');
}

/* ---------- uplink ---------- */
async function testUplink() {
    assert.ok(publicIpv4('35.186.224.24'));
    ['10.0.0.1', '192.168.1.1', '127.0.0.1', '160.48.199.1', '169.254.1.1', '100.64.0.1', 'x', '::1']
        .forEach(ip => assert.ok(!publicIpv4(ip), ip));
    const dir = tmp();
    const calls = [];
    let lease = null, dnsAnswer = '35.186.224.24', resolves = 0;
    const http = new UplinkHttp(dir, quiet, {
        readLease: file => (file.endsWith('uplink.json') ? lease : { ip: '10.9.8.7' }),
        resolve4: (host, servers, done) => { resolves++; assert.deepStrictEqual(servers, ['1.1.1.1']); done(null, dnsAnswer); },
        transport: (o, done) => { calls.push(o); done(null, { status: 200, headers: {}, body: '{}' }); },
    });
    assert.strictEqual(http.status(), 'Store online - app not routed');
    await rejects(http.request({ host: 'api.spotify.com', path: '/v1/me' }), 'NO_UPLINK');
    lease = { ip: '172.20.10.3', dns: ['1.1.1.1', 'bogus'] };
    assert.strictEqual(http.status(), 'ROUTED');
    await rejects(http.request({ host: 'example.com', path: '/' }), 'HOST_FORBIDDEN');
    await rejects(http.request({ host: 'api.spotify.com.evil.example', path: '/' }), 'HOST_FORBIDDEN');
    await rejects(http.request({ host: 'api.spotify.com', path: '/a b' }), 'BAD_PATH');
    await rejects(http.request({ host: 'api.spotify.com', path: '/a\r\nX: y' }), 'BAD_PATH');
    assert.strictEqual(calls.length, 0);
    const res = await http.request({ method: 'POST', host: 'API.spotify.com', path: '/v1/x', headers: { A: 'b' }, body: 'k=v' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls[0].address, '35.186.224.24');
    assert.strictEqual(calls[0].host, 'api.spotify.com');
    assert.strictEqual(calls[0].headers.Host, 'api.spotify.com');
    assert.strictEqual(calls[0].headers['Content-Length'], 3);
    await http.request({ host: 'api.spotify.com', path: '/v1/y' });
    assert.strictEqual(resolves, 1, 'DNS answer cached');
    // A forged private answer for an allowed name is refused.
    dnsAnswer = '192.168.0.10';
    await rejects(http.request({ host: 'lrclib.net', path: '/api/get' }), 'DNS');
    assert.strictEqual(calls.length, 2);
}

/* ---------- Spotify ---------- */
const CLIENT = 'a'.repeat(32), REFRESH = 'R'.repeat(40);
function fakeHttp(handler) {
    const calls = [];
    return { calls, request(o) { calls.push(o); return Promise.resolve().then(() => handler(o, calls.length)); } };
}
function playing(over) {
    return JSON.stringify(Object.assign({ is_playing: true, progress_ms: 12000, currently_playing_type: 'track',
        item: { type: 'track', id: '4uLU6hMCjMI75M1A2tKUQC', name: 'Test Song', duration_ms: 200000,
            artists: [{ name: 'Test Artist' }, { name: 'Guest' }], album: { name: 'Test Album' } } }, over || {}));
}
async function testSpotify() {
    assert.ok(validImport({ client_id: CLIENT, refresh_token: REFRESH }));
    assert.ok(!validImport({ client_id: 'short', refresh_token: REFRESH }));
    assert.ok(!validImport({ client_id: CLIENT, refresh_token: 'has space in it and more text' }));
    assert.ok(!validImport(null));

    const dir = tmp(), usb = tmp();
    let now = 1000000;
    let tokenCalls = 0, apiStatus = 200, apiBody = playing(), retryAfter;
    const http = fakeHttp(o => {
        if (o.host === 'accounts.spotify.com') {
            tokenCalls++;
            assert.strictEqual(o.method, 'POST');
            assert.ok(/grant_type=refresh_token/.test(o.body) && o.body.indexOf('client_id=' + CLIENT) >= 0);
            assert.ok(!/client_secret/.test(o.body), 'PKCE: no client secret');
            return { status: 200, headers: {}, body: JSON.stringify({ access_token: 'access-' + tokenCalls, expires_in: 3600,
                refresh_token: 'N'.repeat(40) + tokenCalls }) };
        }
        assert.strictEqual(o.host, 'api.spotify.com');
        assert.strictEqual(o.method, 'GET', 'read-only API use');
        assert.ok(/^\/v1\/me\/player\/currently-playing/.test(o.path));
        now += 200;
        return { status: apiStatus, headers: retryAfter ? { 'retry-after': retryAfter } : {}, body: apiBody };
    });
    const sp = new Spotify(dir, http, quiet, { now: () => now, usbRoots: [usb] });
    assert.strictEqual(sp.state, 'signed_out');
    await rejects(sp.nowPlaying(), 'SIGNED_OUT');
    assert.strictEqual(sp.importFromUsb().ok, false);
    fs.mkdirSync(path.join(usb, 'STICK'));
    fs.writeFileSync(path.join(usb, 'STICK', IMPORT_NAME), '{"client_id":"nope"}');
    assert.ok(/not valid/.test(sp.importFromUsb().message));
    fs.writeFileSync(path.join(usb, 'STICK', IMPORT_NAME), JSON.stringify({ client_id: CLIENT, refresh_token: REFRESH }));
    assert.strictEqual(sp.importFromUsb().ok, true);
    assert.strictEqual(sp.state, 'ready');
    assert.strictEqual(fs.statSync(path.join(dir, 'spotify-auth.json')).mode & 0o077, 0, 'sign-in file is private');

    const t = await sp.nowPlaying();
    assert.strictEqual(t.kind, 'track');
    assert.strictEqual(t.title, 'Test Song');
    assert.strictEqual(t.artist, 'Test Artist');
    assert.strictEqual(t.album, 'Test Album');
    assert.strictEqual(t.durationMs, 200000);
    assert.strictEqual(t.at, now - 100, 'position is dated to the middle of the request');
    assert.strictEqual(positionAt(t, t.at + 3000), 15000);
    assert.strictEqual(positionAt(Object.assign({}, t, { playing: false }), t.at + 3000), 12000);
    assert.strictEqual(positionAt(t, t.at + 999999), 200000);
    // The rotated refresh token replaced the imported one on disk.
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'spotify-auth.json'), 'utf8')).refresh_token, 'N'.repeat(40) + '1');
    await sp.nowPlaying();
    assert.strictEqual(tokenCalls, 1, 'access token reused');
    now += 3600 * 1000;
    await sp.nowPlaying();
    assert.strictEqual(tokenCalls, 2, 'expired token refreshed');

    apiStatus = 204;
    assert.strictEqual((await sp.nowPlaying()).kind, 'none');
    apiStatus = 200; apiBody = playing({ currently_playing_type: 'episode', item: { type: 'episode', name: 'Pod' } });
    assert.deepStrictEqual(await sp.nowPlaying(), { kind: 'none', reason: 'Podcast' });
    apiBody = 'not json';
    assert.strictEqual((await sp.nowPlaying()).kind, 'none');
    apiStatus = 429; retryAfter = '7';
    assert.strictEqual((await rejects(sp.nowPlaying(), 'RATE_LIMIT')).retryAfterMs, 7000);
    retryAfter = undefined; apiStatus = 403;
    await rejects(sp.nowPlaying(), 'FORBIDDEN');
    // 401: exactly one refresh and one retry.
    apiStatus = 401;
    const before = http.calls.length;
    await rejects(sp.nowPlaying(), 'HTTP');
    assert.strictEqual(http.calls.length - before, 3);

    // A stored sign-in is read back by a new instance; an invalid grant asks for a new sign-in.
    const sp2 = new Spotify(dir, fakeHttp(() => ({ status: 400, headers: {}, body: '{"error":"invalid_grant"}' })), quiet, { now: () => now });
    assert.strictEqual(sp2.state, 'ready');
    await rejects(sp2.nowPlaying(), 'REAUTH');
    assert.strictEqual(sp2.state, 'reauth');
    assert.strictEqual(sp2.signedIn(), false);
    sp2.signOut();
    assert.ok(!fs.existsSync(path.join(dir, 'spotify-auth.json')));
}

/* ---------- LRCLIB ---------- */
async function testLrclib() {
    assert.strictEqual(plainTitle('Test Song - 2011 Remaster'), 'Test Song');
    assert.strictEqual(plainTitle('Test Song (feat. Someone)'), 'Test Song');
    assert.strictEqual(plainTitle('Test Song - Live at Somewhere'), 'Test Song');
    assert.strictEqual(plainTitle('Hyphen - Song'), 'Hyphen - Song');
    const track = { id: '4uLU6hMCjMI75M1A2tKUQC', title: 'Test Song - 2011 Remaster', artist: 'Test & Artist',
        album: 'Test Album', durationMs: 200400 };
    const dir = tmp();
    let now = 5000000, mode = 'exact';
    const http = fakeHttp(o => {
        assert.strictEqual(o.host, 'lrclib.net');
        assert.strictEqual(o.method, 'GET');
        assert.ok(/ClusterLyrics/.test(o.headers['User-Agent']));
        if (o.path.indexOf('/api/get?') === 0) {
            assert.ok(o.path.indexOf('artist_name=Test%20%26%20Artist') > 0, o.path);
            assert.ok(o.path.indexOf('duration=200') > 0);
            if (mode === 'exact') return { status: 200, headers: {}, body: JSON.stringify({ syncedLyrics: LRC, plainLyrics: 'x' }) };
            if (mode === 'plain') return { status: 200, headers: {}, body: JSON.stringify({ syncedLyrics: null, plainLyrics: 'x' }) };
            if (mode === 'down') return { status: 503, headers: {}, body: '' };
            return { status: 404, headers: {}, body: '{}' };
        }
        assert.ok(o.path.indexOf('/api/search?track_name=Test%20Song&') === 0, o.path);
        if (mode === 'none') return { status: 200, headers: {}, body: '[]' };
        return { status: 200, headers: {}, body: JSON.stringify([
            { duration: 251, syncedLyrics: '[00:01.00]Other recording' },
            { duration: 202, syncedLyrics: '[00:02.00]Close match' },
            { duration: 200, syncedLyrics: '' },
            { duration: 200.4, syncedLyrics: '[00:03.00]Best match' }]) };
    });
    const ly = new Lyrics(dir, http, quiet, { now: () => now });
    const a = await ly.get(track);
    assert.strictEqual(a.status, 'synced');
    assert.strictEqual(a.lines.length, 6);
    assert.strictEqual(http.calls.length, 1);
    await ly.get(track);
    assert.strictEqual(http.calls.length, 1, 'memory cache');
    const again = new Lyrics(dir, http, quiet, { now: () => now });
    assert.strictEqual((await again.get(track)).lines.length, 6);
    assert.strictEqual(http.calls.length, 1, 'disk cache');
    assert.strictEqual(again.clearCache(), 1);

    mode = 'search';
    const b = await new Lyrics(tmp(), http, quiet, { now: () => now }).get(track);
    assert.strictEqual(b.lines[0].text, 'Best match', 'closest length wins; another recording is ignored');
    mode = 'plain';
    const c = await new Lyrics(tmp(), http, quiet, { now: () => now }).get(track);
    assert.strictEqual(c.lines[0].text, 'Best match', 'a synced search result beats an unsynced exact one');

    mode = 'none';
    const dir2 = tmp(), ly2 = new Lyrics(dir2, http, quiet, { now: () => now });
    assert.strictEqual((await ly2.get(track)).status, 'none');
    const n = http.calls.length;
    assert.strictEqual((await new Lyrics(dir2, http, quiet, { now: () => now }).get(track)).status, 'none');
    assert.strictEqual(http.calls.length, n, 'negative answer cached');
    now += 8 * 24 * 3600 * 1000;
    await new Lyrics(dir2, http, quiet, { now: () => now }).get(track);
    assert.strictEqual(http.calls.length, n + 2, 'asked again after a week');

    mode = 'down';
    const dir3 = tmp(), ly3 = new Lyrics(dir3, http, quiet, { now: () => now });
    await rejects(ly3.get(track), 'HTTP');
    assert.ok(!fs.existsSync(path.join(dir3, 'lyrics-cache', track.id + '.json')), 'errors are not cached');
    // An id that is not a plain token never becomes a file name.
    mode = 'exact';
    const dir4 = tmp();
    await new Lyrics(dir4, http, quiet, { now: () => now }).get(Object.assign({}, track, { id: '../../etc/passwd' }));
    assert.ok(!fs.existsSync(path.join(dir4, 'lyrics-cache')));
}

/* ---------- KOMBI layers ---------- */
class FakeRender {
    constructor(app) { this.app = app; this.ops = []; this.layers = new Map(); this.next = 1; this.handlers = {};
        this.ready = false; this.backend = ''; this.targets = ''; this.connected = 0; this.closed = 0; }
    on(name, fn) { this.handlers[name] = fn; }
    emit(name, ...args) { if (this.handlers[name]) this.handlers[name](...args); }
    connect() { this.connected++; }
    close() { this.closed++; this.ready = false; }
    hello(targets, backend) { this.ready = true; this.backend = backend || 'id7'; this.targets = targets; this.emit('ready'); }
    image(o) { const ref = this.next++; this.layers.set(ref, Object.assign({}, o)); this.ops.push(['image', ref, o]); return ref; }
    set(ref, o) { Object.assign(this.layers.get(ref), o); this.ops.push(['set', ref, o]); }
    drop(ref) { this.layers.delete(ref); this.ops.push(['drop', ref]); }
    pixels(ref, rects, px) {
        const l = this.layers.get(ref);
        const need = rects ? rects.reduce((n, r) => n + r.w * r.h * 4, 0) : (l.iw || l.w) * (l.ih || l.h) * 4;
        assert.strictEqual(px.length, need, 'pixel payload size');
        (rects || []).forEach(r => assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= l.w && r.y + r.h <= l.h, 'rect inside image'));
        this.ops.push(['pixels', ref, rects, px.length]);
        return true;
    }
}
function testKombi() {
    let now = 100000;
    const traces = [];
    const k = new K.KombiLyrics(quiet, { ClusterRender: FakeRender, now: () => now, trace: m => traces.push(m) });
    const cr = k.cr;
    k.show({ title: 'Test Song', artist: 'Test Artist', current: 'First test line', next: 'Second', gap: false });
    assert.strictEqual(cr.connected, 0, 'show() alone does not connect');
    assert.strictEqual(cr.ops.length, 0);
    k.start();
    assert.strictEqual(cr.connected, 1);
    assert.strictEqual(cr.ops.length, 0, 'nothing before the service says hello');
    cr.hello('map:1088x480,panel:1920x720,hud:800x480');
    const made = cr.ops.filter(o => o[0] === 'image');
    assert.strictEqual(made.length, 4);
    made.forEach(o => {
        const l = o[2];
        assert.strictEqual(l.target, 'map', 'only the map window, never the panel');
        assert.strictEqual(l.klass, 'overlay');
        assert.strictEqual(l.guide_hold, false, 'BMW turn box stays visible');
        assert.strictEqual(l.contend, false, "BMW's own map is not taken over by default");
        assert.strictEqual(l.visible, false);
        assert.ok(l.x >= 0 && l.y >= 0 && l.x + l.w <= 1088 && l.y + l.h <= 480, 'inside the map window');
    });
    assert.strictEqual(made[0][2].exclusive, true);
    assert.ok(made.slice(1).every(o => !o[2].exclusive && o[2].z > made[0][2].z));
    assert.strictEqual(cr.ops.filter(o => o[0] === 'pixels').length, 4, 'background, header, current, next');
    assert.strictEqual(cr.ops.filter(o => o[0] === 'set' && o[2].visible === true).length, 4);
    assert.strictEqual(k.status().visible, true);

    // The same content again uploads nothing.
    let mark = cr.ops.length;
    now += 1000;
    k.show({ title: 'Test Song', artist: 'Test Artist', current: 'First test line', next: 'Second', gap: false });
    assert.strictEqual(cr.ops.length, mark);
    // A new line: current and next only, the current one as a row rectangle.
    now += 1000;
    k.show({ title: 'Test Song', artist: 'Test Artist', current: 'Second', next: 'Third', gap: false });
    const ups = cr.ops.slice(mark).filter(o => o[0] === 'pixels');
    assert.strictEqual(ups.length, 2);
    assert.ok(ups[0][2] && ups[0][2].length === 1 && ups[0][2][0].w === K.TEXT_W && ups[0][2][0].h < K.CUR.h);
    // Too fast to read: skipped until the minimum interval has passed.
    mark = cr.ops.length; now += 100;
    k.show({ title: 'Test Song', artist: 'Test Artist', current: 'Third', next: 'Fourth', gap: false });
    assert.strictEqual(cr.ops.length, mark);
    now += 400;
    k.show({ title: 'Test Song', artist: 'Test Artist', current: 'Third', next: 'Fourth', gap: false });
    assert.ok(cr.ops.length > mark);
    // A very long line still fits the texture (two lines, smaller type or ellipsis).
    const long = K.renderCurrent('word '.repeat(60).trim(), '#ffffff', false);
    assert.strictEqual(long.surface.d.length, K.TEXT_W * K.CUR.h * 4);
    assert.ok(long.rows[0] >= 0 && long.rows[1] <= K.CUR.h && long.rows[0] < long.rows[1]);
    const gap = K.renderCurrent('', '#ffffff', true);
    assert.ok(gap.rows[0] >= 0 && gap.rows[1] <= K.CUR.h);

    // "Also replace BMW's own map" switches contention on for every layer.
    mark = cr.ops.length;
    k.configure({ takeOverBmwMap: true });
    assert.strictEqual(cr.ops.slice(mark).filter(o => o[0] === 'set' && o[2].contend === true).length, 4);
    // hide: everything invisible, nothing dropped; show again makes it visible without new layers.
    mark = cr.ops.length;
    k.hide('vehicle moving');
    assert.strictEqual(cr.ops.slice(mark).filter(o => o[0] === 'set' && o[2].visible === false).length, 4);
    assert.strictEqual(k.status().visible, false);
    assert.strictEqual(k.status().hideReason, 'vehicle moving');
    k.hide('vehicle moving');
    assert.strictEqual(cr.ops.length, mark + 4, 'hide is idempotent');
    now += 1000;
    k.show({ title: 'Test Song', artist: 'Test Artist', current: 'Third', next: 'Fourth', gap: false });
    assert.strictEqual(cr.ops.filter(o => o[0] === 'image').length, 4);
    assert.strictEqual(k.status().visible, true);
    // release: every layer dropped.
    k.release('switched off');
    assert.strictEqual(cr.layers.size, 0);
    assert.strictEqual(k.status().layers, false);
    k.close();
    assert.strictEqual(cr.closed, 1);
    assert.ok(traces.some(t => /layers created/.test(t)) && traces.some(t => /hidden: vehicle moving/.test(t)));

    // Waze coexistence: background is non-exclusive, small and translucent.
    const kw = new K.KombiLyrics(quiet, { ClusterRender: FakeRender });
    kw.configure({ layoutMode: 'withWaze', fontSizePct: 75, takeOverBmwMap: true });
    kw.start();
    kw.show({ title: 'Demo', artist: 'Artist', current: 'One short line', next: 'Next one', gap: false });
    kw.cr.hello('map:1088x480,panel:1920x720');
    const wave = kw.cr.ops.filter(o => o[0] === 'image');
    assert.strictEqual(wave.length, 4);
    assert.strictEqual(wave[0][2].exclusive, false);
    assert.strictEqual(wave[0][2].contend, false);
    assert.ok(wave[0][2].y >= 250 && wave[0][2].h < K.MAP_H);
    assert.ok(wave.every(o => o[2].x >= 0 && o[2].x + o[2].w <= K.MAP_W));
    assert.ok(K.backgroundPixels(true)[3] < 255, 'alpha preserved');
    assert.strictEqual(kw.status().fontSizePct, 75);
    const originalRefs = wave.map(o => o[1]);
    kw.configure({ layoutMode: 'exclusive' });
    assert.strictEqual(kw.cr.ops.filter(o => o[0] === 'drop').length, 4);
    assert.ok(originalRefs.every(ref => !kw.cr.layers.has(ref)));
    assert.strictEqual(kw.cr.ops.filter(o => o[0] === 'image').slice(-4)[0][2].exclusive, true);
    kw.configure({ fontSizePct: 50 });
    assert.strictEqual(kw.status().fontSizePct, 50);
    kw.show({ title: '', artist: '', current: '', next: '', gap: true, noteOnly: true });
    assert.ok(kw.status().visible);
    kw.close();

    // Another map size (iDrive 8) is not drawn on.
    const k8 = new K.KombiLyrics(quiet, { ClusterRender: FakeRender });
    k8.start();
    k8.cr.hello('map:874x749,hud:353x203', 'id8');
    k8.show({ title: 'T', artist: 'A', current: 'x', next: '', gap: false });
    assert.strictEqual(k8.cr.ops.length, 0);
    assert.strictEqual(k8.status().supported, false);
}

/* ---------- KOMBI through the real client and a socket speaking the service's framing ---------- */
function testKombiWire() {
    const net = require('net');
    const dir = tmp(), sock = path.join(dir, 'render.sock');
    const messages = [], frames = [];
    let conn = null;
    const send = (obj) => {
        const body = Buffer.from(JSON.stringify(obj), 'utf8'), m = Buffer.alloc(5 + body.length);
        m.writeUInt32LE(body.length + 1, 0); m[4] = 0x4a; body.copy(m, 5);
        conn.write(m);
    };
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('wire test timeout: ' + JSON.stringify(messages.map(m => m.op)))), 4000);
        const server = net.createServer(c => {
            conn = c;
            let buf = Buffer.alloc(0);
            c.on('data', d => {
                buf = Buffer.concat([buf, d]);
                while (buf.length >= 5) {
                    const len = buf.readUInt32LE(0);
                    if (buf.length < 4 + len) break;
                    const type = buf[4], body = buf.slice(5, 4 + len);
                    buf = buf.slice(4 + len);
                    if (type === 0x4a) {
                        const m = JSON.parse(body.toString('utf8'));
                        messages.push(m);
                        if (m.op === 'hello') send({ ev: 'hello', proto: 1, backend: 'id7', targets: 'map:1088x480,panel:1920x720,hud:800x480' });
                    } else if (type === 0x46) frames.push({ ref: body.readUInt32LE(0), rects: body.readUInt16LE(12), bytes: body.length });
                }
                const visible = messages.filter(m => m.op === 'set' && m.visible === 1).length;
                if (visible === 4 && frames.length >= 4) {
                    clearTimeout(timer);
                    try {
                        assert.deepStrictEqual(messages[0], { op: 'hello', app: 'cluster_lyrics', proto: 1 });
                        const layers = messages.filter(m => m.op === 'layer');
                        assert.strictEqual(layers.length, 4);
                        layers.forEach(l => {
                            assert.strictEqual(l.target, 'map');
                            assert.strictEqual(l.kind, 'image');
                            assert.strictEqual(l.class, 'overlay');
                            assert.strictEqual(l.guide_hold, 0);
                            assert.strictEqual(l.contend, 0);
                            assert.strictEqual(l.visible, 0, 'created hidden');
                        });
                        assert.strictEqual(layers[0].exclusive, 1);
                        assert.deepStrictEqual([layers[0].iw, layers[0].ih, layers[0].w, layers[0].h, layers[0].sampling], [16, 16, 1088, 480, 'bilinear']);
                        assert.ok(layers.slice(1).every(l => l.exclusive === undefined && l.iw === l.w && l.ih === l.h));
                        // Every image got its pixels: a 14-byte frame header, no rects, the whole image.
                        layers.forEach(l => {
                            const f = frames.find(x => x.ref === l.ref);
                            assert.ok(f, 'pixels for layer ' + l.ref);
                            assert.strictEqual(f.bytes, 14 + l.iw * l.ih * 4);
                        });
                        k.close(); server.close(); resolve();
                    } catch (e) { k.close(); server.close(); reject(e); }
                }
            });
        });
        const k = new K.KombiLyrics(quiet, { socketPath: sock });
        server.listen(sock, () => {
            k.start();
            k.show({ title: 'Test Song', artist: 'Test Artist', current: 'First test line', next: 'Second', gap: false });
        });
    });
}

/* ---------- engine ---------- */
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
async function testEngine() {
    assert.strictEqual(displayable([{ t: 0, text: '日本' }, { t: 1, text: '語' }]), null);
    assert.strictEqual(displayable([{ t: 0, text: 'ok' }, { t: 1, text: '' }]).length, 2);

    let now = 1000000;
    const timers = [];
    const kombiCalls = [];
    const kombi = { show(c) { kombiCalls.push(['show', c]); }, hide(r) { kombiCalls.push(['hide', r]); },
        release(r) { kombiCalls.push(['release', r]); } };
    let answer = { kind: 'track', id: 'trackA', title: 'Test Song', artist: 'Test Artist', album: 'Al', durationMs: 60000,
        progressMs: 4000, playing: true, at: now };
    let signedIn = true, fail = null;
    const spotify = { state: 'ready', signedIn: () => signedIn,
        nowPlaying: () => fail ? Promise.reject(fail) : Promise.resolve(Object.assign({}, answer, { at: now })) };
    const waiting = {};
    const lyrics = { memory: new Map(), get(track) { return new Promise((resolve, reject) => { waiting[track.id] = { resolve, reject }; }); } };
    const engine = new LyricsEngine({ spotify, lyrics, kombi, log: quiet, now: () => now,
        setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); } });
    const last = () => kombiCalls[kombiCalls.length - 1];

    engine.tick();
    assert.deepStrictEqual(last(), ['release', 'switched off']);
    engine.configure({ kombiOn: true, kombiMode: 'parked', offsetMs: 0 });
    engine.setActive(true);
    assert.strictEqual(timers.length, 1);
    assert.strictEqual(timers[0].ms, 0);
    timers.shift();
    await engine.pollOnce();
    assert.strictEqual(engine.track.title, 'Test Song');
    assert.strictEqual(timers[0].ms, 4000, 'next poll in 4 s while playing');
    engine.tick();
    assert.deepStrictEqual(last(), ['hide', 'lyrics loading']);
    waiting.trackA.resolve({ status: 'synced', lines: lrc.parse('[00:05.00]First test line\n[00:10.00]Second test line') });
    await flush();
    assert.strictEqual(engine.lyricsState, 'synced');

    // Standstill gate: no speed -> hidden; standing needs 1.5 s; moving hides at once.
    engine.tick();
    assert.deepStrictEqual(last(), ['hide', 'no fresh speed signal']);
    engine.observeVehicle(0, 100, false);
    engine.tick();
    assert.deepStrictEqual(last(), ['hide', 'vehicle moving']);
    now += 1600; engine.observeVehicle(0, 100, false);
    engine.tick();
    assert.strictEqual(last()[0], 'show');
    assert.deepStrictEqual(last()[1], { title: 'Test Song', artist: 'Test Artist', current: 'First test line',
        next: 'Second test line', gap: false });
    engine.observeVehicle(2, 100, false);   // creeping: decision stands
    engine.tick();
    assert.strictEqual(last()[0], 'show');
    engine.observeVehicle(12, 100, false);
    engine.tick();
    assert.deepStrictEqual(last(), ['hide', 'vehicle moving']);
    engine.observeVehicle(0, 100, false);
    engine.tick();
    assert.deepStrictEqual(last(), ['hide', 'vehicle moving'], 'not shown again before 1.5 s at rest');
    engine.observeVehicle(0, 9000, false);
    engine.tick();
    assert.deepStrictEqual(last(), ['hide', 'no fresh speed signal'], 'a stale sample is not a standstill');
    engine.observeVehicle(0, 100, true);
    engine.tick();
    assert.deepStrictEqual(last(), ['hide', 'no live vehicle data'], 'emulator data never reaches the cluster');

    // "Also while driving" ignores the vehicle; the delay setting shifts the line.
    engine.configure({ kombiMode: 'always' });
    engine.observeVehicle(80, 100, false);
    engine.tick();
    assert.strictEqual(last()[0], 'show');
    assert.strictEqual(engine.frame().current, 'First test line');
    const rawBefore = engine.rawPosition();
    const original = engine.timing();
    assert.strictEqual(original.delayMs, 0);
    assert.strictEqual(original.trackMs, rawBefore);
    assert.strictEqual(original.lyricMs, rawBefore);
    engine.configure({ offsetMs: 2000 });
    assert.strictEqual(engine.timing().trackMs, rawBefore, 'song clock stays unchanged');
    assert.strictEqual(engine.timing().lyricMs, rawBefore - 2000, 'positive delay shifts lyric clock back');
    assert.strictEqual(engine.frame().gap, true, 'with 2 s delay the first line has not started');
    engine.configure({ offsetMs: -2000 });
    assert.strictEqual(engine.timing().trackMs, rawBefore, 'song time unaffected by negative delay');
    assert.strictEqual(engine.timing().lyricMs, rawBefore + 2000, 'negative delay makes lyrics early');
    assert.strictEqual(engine.frame().current, 'First test line');
    engine.configure({ offsetMs: 3000 });
    assert.strictEqual(engine.position(), rawBefore - 3000, 'max positive delay works');
    engine.configure({ offsetMs: 0 });
    assert.deepStrictEqual(engine.timing(), original, 'reset restores original timing');
    now += 5000;
    assert.strictEqual(engine.frame().current, 'Second test line');

    // No answer from Spotify for too long: do not keep counting on old data.
    now += 21000;
    engine.tick();
    assert.deepStrictEqual(last(), ['hide', 'Spotify state too old']);
    await engine.pollOnce();
    engine.tick();
    assert.strictEqual(last()[0], 'show');

    // Paused: hidden after 5 s.
    answer = Object.assign({}, answer, { playing: false });
    await engine.pollOnce();
    assert.strictEqual(timers[timers.length - 1].ms, 8000);
    engine.tick();
    assert.strictEqual(last()[0], 'show');
    now += 5100;
    await engine.pollOnce();
    engine.tick();
    assert.deepStrictEqual(last(), ['hide', 'paused']);

    // New song: old lyrics are never shown for it, even if the old request answers late.
    answer = { kind: 'track', id: 'trackB', title: 'Other', artist: 'Someone', album: '', durationMs: 90000, progressMs: 1000, playing: true };
    await engine.pollOnce();
    engine.tick();
    assert.deepStrictEqual(last(), ['hide', 'lyrics loading']);
    assert.strictEqual(engine.frame(), null);
    waiting.trackB.resolve({ status: 'none', lines: [] });
    await flush();
    engine.tick();
    assert.strictEqual(last()[0], 'show', 'missing lyrics show a note');
    assert.deepStrictEqual(last()[1], { title: '', artist: '', current: '', next: '', gap: true, noteOnly: true });
    engine.lyricsState = 'plain';
    engine.tick();
    assert.strictEqual(last()[1].noteOnly, true);
    engine.lyricsState = 'instrumental';
    engine.tick();
    assert.strictEqual(last()[1].noteOnly, true);
    engine.lyricsState = 'unreadable';
    engine.tick();
    assert.strictEqual(last()[1].noteOnly, true);
    engine.lyricsState = 'error';
    engine.tick();
    assert.deepStrictEqual(last(), ['hide', 'no synchronised lyrics (error)']);
    answer = Object.assign({}, answer, { id: 'trackC' });
    await engine.pollOnce();
    const lateC = waiting.trackC;
    answer = Object.assign({}, answer, { id: 'trackD' });
    await engine.pollOnce();
    lateC.resolve({ status: 'synced', lines: lrc.parse('[00:00.50]Late answer for another song') });
    await flush();
    assert.strictEqual(engine.lyricsState, 'loading', 'late answer for the previous song ignored');
    waiting.trackD.reject(Object.assign(new Error('LRCLIB HTTP 503'), { code: 'HTTP' }));
    await flush();
    assert.strictEqual(engine.lyricsState, 'error');

    // Errors: rate limit honoured, back-off grows, expired sign-in stops polling.
    fail = Object.assign(new Error('rate'), { code: 'RATE_LIMIT', retryAfterMs: 7000 });
    await engine.pollOnce();
    assert.strictEqual(timers[timers.length - 1].ms, 7000);
    fail = Object.assign(new Error('net'), { code: 'ECONNRESET' });
    await engine.pollOnce();
    await engine.pollOnce();
    assert.ok(timers[timers.length - 1].ms >= 10000 && timers[timers.length - 1].ms <= 60000);
    fail = Object.assign(new Error('no uplink'), { code: 'NO_UPLINK' });
    await engine.pollOnce();
    assert.strictEqual(timers[timers.length - 1].ms, 10000);
    const count = timers.length;
    fail = Object.assign(new Error('expired'), { code: 'REAUTH' });
    timers.length = 0;
    await engine.pollOnce();
    assert.strictEqual(timers.length, 0, 'no polling without a valid sign-in');
    assert.ok(count > 0);
    signedIn = false;
    engine.tick();
    assert.deepStrictEqual(last(), ['hide', 'not signed in']);
    engine.setActive(false);
    engine.configure({ kombiOn: false });
    engine.tick();
    assert.deepStrictEqual(last(), ['release', 'switched off']);
}

/* ---------- background startup / manual control ---------- */
function testBootControl() {
    function fake(kombiOn, autoStartOnBoot) {
        const v = { kombiOn, autoStartOnBoot };
        return { get(key) { return v[key]; }, set(key, value) { v[key] = value; },
            stored: v };
    }
    const newInstall = fake(false, true);
    const boot0 = new BootControl(newInstall);
    assert.strictEqual(boot0.autostartEnabled(), true);
    assert.strictEqual(boot0.active(), false, 'safe default: no cluster takeover');
    assert.strictEqual(boot0.startedAutomatically, false);

    const savedEnabled = fake(true, true);
    const boot1 = new BootControl(savedEnabled);
    assert.strictEqual(boot1.active(), true, 'saved KOMBI setting resumes without opening the app');
    assert.strictEqual(boot1.startedAutomatically, true);
    savedEnabled.set('autoStartOnBoot', false);
    boot1.onSettingsChanged('autoStartOnBoot');
    assert.strictEqual(boot1.active(), true, 'changing preference does not interrupt current song');
    const boot2 = new BootControl(savedEnabled);
    assert.strictEqual(boot2.active(), false, 'next launch begins with KOMBI off');
    assert.strictEqual(boot2.startedAutomatically, false);
    assert.strictEqual(boot2.toggle(), true, 'manual press works with boot autostart disabled');
    boot2.onSettingsChanged('kombiOn');
    assert.strictEqual(boot2.active(), true);
    assert.strictEqual(new BootControl(savedEnabled).active(), false, 'manual activation stays session-only');
    assert.strictEqual(boot2.toggle(), false);
    assert.strictEqual(savedEnabled.get('kombiOn'), false, 'manual off persists');

    const viaSettings = new BootControl(fake(false, false));
    viaSettings.settings.set('kombiOn', true);
    viaSettings.onSettingsChanged('kombiOn');
    assert.strictEqual(viaSettings.active(), true, 'master switch from settings activates immediately');
}

function testManifest() {
    const spec = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
    assert.strictEqual(spec.mguInternet, true);
    const byKey = {};
    spec.settings.forEach(s => { byKey[s.key] = s; });
    assert.strictEqual(byKey.kombiOn.default, false, 'nothing reaches the cluster until switched on');
    assert.strictEqual(spec.mguAppStartType, 'autostart', 'native package start mode');
    assert.strictEqual(byKey.autoStartOnBoot.default, true, 'resume preference defaults to On');
    assert.strictEqual(byKey.kombiMode.default, 'parked');
    assert.strictEqual(byKey.takeOverBmwMap.default, false);
    assert.strictEqual(byKey.layoutMode.default, 'exclusive');
    assert.ok(byKey.layoutMode.options.some(o => o[0] === 'withWaze'));
    assert.strictEqual(byKey.kombiFontPct.default, 75);
    assert.ok(byKey.kombiFontPct.steps.indexOf(50) >= 0 && byKey.kombiFontPct.steps.indexOf(120) >= 0);
    assert.ok(byKey.offsetMs.steps.indexOf(0) >= 0);
    assert.deepStrictEqual(Object.keys(spec.signals), ['de.bmw.infotainment.vehicle.Vehicle2']);
    const repo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mgu-repo.json'), 'utf8'));
    const entry = repo.components.find(c => c.id === 'cluster_lyrics');
    assert.ok(entry, 'listed in mgu-repo.json');
    assert.strictEqual(entry.version, spec.version);
    assert.ok(entry.requires && entry.requires['cluster-render']);
    // No app source uses syntax newer than the head unit's Node 8.
    fs.readdirSync(APP).filter(n => /\.js$/.test(n) && n !== 'lyric_font_data.js').forEach(n => {
        const src = fs.readFileSync(path.join(APP, n), 'utf8');
        assert.ok(!/\?\.[a-zA-Z_(\[]|\?\?|catch\s*\{/.test(src.replace(/\/\/.*$/gm, '')), n + ': newer syntax');
    });
}

(async () => {
    testLrc();
    testFont();
    await testUplink();
    await testSpotify();
    await testLrclib();
    testKombi();
    await testKombiWire();
    await testEngine();
    testBootControl();
    testManifest();
    console.log('Cluster Lyrics: LRC, font, uplink, Spotify, LRCLIB, KOMBI layers, engine and manifest OK');
})().catch(e => { console.error(e); process.exit(1); });
