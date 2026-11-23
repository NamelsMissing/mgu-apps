'use strict';

// node tests/gamestation_app.test.js - GameStation 0.4: library and saves, the game session
// (pacing, pause, overload), battery RAM of all three cores, the phone server's new endpoints,
// every page of the car UI, and main.js against a stand-in for the kit (parked-only gate,
// tabs, start / quit / delete). No car, SDK, network or copyrighted ROMs needed.
// GAMESTATION_UI_DUMP=<dir> also writes the pages as PNG files.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const EventEmitter = require('events');
const {PassThrough} = require('stream');
const Module = require('module');

const APP = path.join(__dirname, '..', 'apps', 'mgu_gamestation');
const KIT = path.join(__dirname, '..', 'kit', 'runtime');
const G = require(path.join(KIT, 'gauges'));
const kitCanvas = require(path.join(KIT, 'canvas'));
const {Recorder, play} = require(path.join(KIT, 'record'));
const {THEMES} = require(path.join(KIT, 'themes'));
const {Library, safeName, title} = require(path.join(APP, 'library'));
const {Session, AUTOSAVE_MS, OVERLOAD_WINDOW} = require(path.join(APP, 'session'));
const {NesGame} = require(path.join(APP, 'nes_core'));
const {GameBoyGame} = require(path.join(APP, 'gb_core'));
const {SnesGame, sramSize} = require(path.join(APP, 'snes_core'));
const {ControllerServer} = require(path.join(APP, 'controller_server'));
const {makeUi, ascii, fitRect, PAGE, PAGE_SIZE, PLATFORMS, STAGE, W, H} = require(path.join(APP, 'ui'));

const quiet = {info() {}, warn() {}, error() {}};
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), 'gamestation-' + name + '-'));
function rmrf(p) {
    if (!fs.existsSync(p)) return;
    if (fs.statSync(p).isDirectory()) { fs.readdirSync(p).forEach(n => rmrf(path.join(p, n))); fs.rmdirSync(p); }
    else fs.unlinkSync(p);
}

/* ---------------- test cartridges (original, tiny) ---------------- */
function nesRom(battery) {
    const b = Buffer.alloc(16 + 0x4000 + 0x2000);
    b.write('NES\x1a', 0, 'binary'); b[4] = 1; b[5] = 1; b[6] = battery ? 0x02 : 0;
    // LDA #$42; STA $6000; JMP $8005
    Buffer.from([0xa9, 0x42, 0x8d, 0x00, 0x60, 0x4c, 0x05, 0x80]).copy(b, 16);
    b[16 + 0x3ffc] = 0; b[16 + 0x3ffd] = 0x80;
    return b;
}
function snesRom(battery) {
    const b = Buffer.alloc(0x8000);
    b[0] = 0x80; b[1] = 0xfe; // BRA -2 at $8000
    b.write('ORIGINAL SMOKE TEST', 0x7fc0);
    b[0x7fd5] = 0x20; b[0x7fd6] = battery ? 0x02 : 0x00; b[0x7fd8] = battery ? 3 : 0;
    b[0x7ffc] = 0; b[0x7ffd] = 0x80;
    return b;
}
function gbRom(battery) {
    const b = Buffer.alloc(0x8000);
    b[0x143] = 0x80; b[0x147] = battery ? 0x03 : 0x00; b[0x149] = battery ? 0x02 : 0x00;
    return b;
}

/* ---------------- library ---------------- */
function testLibrary() {
    const dir = tmp('lib');
    try {
        const lib = new Library(dir);
        assert.deepStrictEqual(lib.list('nes'), []);
        assert.strictEqual(safeName('../../etc/passwd.nes'), '_.._etc_passwd.nes', 'no folders in names');
        assert.strictEqual(safeName('.hidden.gb'), 'hidden.gb');
        assert.strictEqual(title('Super_Game (USA).sfc'), 'Super Game (USA)');
        assert.strictEqual(lib.add('nes', 'Zeta.nes', nesRom()), 'Zeta.nes');
        lib.add('nes', 'alpha game.nes', nesRom());
        assert.throws(() => lib.add('nes', 'Zeta.nes', nesRom()), e => e.code === 'EEXIST', 'no silent overwrite');
        lib.add('nes', 'Zeta.nes', nesRom(true), true);
        assert.strictEqual(lib.read('nes', 'Zeta.nes')[6], 0x02, 'replace overwrites');
        assert.throws(() => lib.add('nes', 'game.exe', nesRom()), /Unsupported/);
        assert.throws(() => lib.read('nes', '../x.nes'), /not found/);
        // a name an older version stored (leading space) still shows up
        fs.writeFileSync(path.join(dir, 'roms', 'nes', ' old.nes'), nesRom());
        assert.deepStrictEqual(lib.list('nes').map(g => g.name), ['alpha game.nes', ' old.nes', 'Zeta.nes'].sort((a, b) =>
            title(a).toLowerCase().localeCompare(title(b).toLowerCase())));
        assert.deepStrictEqual(lib.counts(), {nes: 3, snes: 0, gb: 0, chip8: 0, sms: 0, gg: 0, genesis: 0, gba: 0, a26: 0, a78: 0, pce: 0, vb: 0, ws: 0, ngp: 0, ps1: 0});
        // saves: written only when changed, atomically
        assert.strictEqual(lib.loadSave('nes', 'Zeta.nes'), null);
        assert.strictEqual(lib.store('nes', 'Zeta.nes', Buffer.from([1, 2, 3])), true);
        assert.strictEqual(lib.store('nes', 'Zeta.nes', Buffer.from([1, 2, 3])), false, 'unchanged save is not rewritten');
        assert.deepStrictEqual(Array.from(lib.loadSave('nes', 'Zeta.nes')), [1, 2, 3]);
        assert.ok(lib.list('nes').find(g => g.name === 'Zeta.nes').saved);
        assert.ok(!fs.readdirSync(path.join(dir, 'saves', 'nes')).some(n => n.endsWith('.tmp')));
        // last game survives a restart, disappears with the game
        lib.remember('nes', 'Zeta.nes');
        assert.deepStrictEqual(new Library(dir).last(), {kind: 'nes', name: 'Zeta.nes', title: 'Zeta'});
        assert.strictEqual(lib.remove('nes', 'Zeta.nes'), true);
        assert.strictEqual(lib.remove('nes', 'Zeta.nes'), false);
        assert.deepStrictEqual(Array.from(lib.loadSave('nes', 'Zeta.nes')), [1, 2, 3], 'deleting a ROM keeps its save');
        assert.strictEqual(new Library(dir).last(), null);
        const hash = 'ab'.repeat(32);
        lib.storeState('chip8', hash, 1, {pc: 512});
        lib.storeState('chip8', hash, 2, {pc: 514});
        assert.deepStrictEqual(new Library(dir).loadState('chip8', hash, 2), {pc: 514});
        assert.throws(() => lib.statePath('chip8', '../' + hash, 1), /Invalid/);
        const stateFile = lib.statePath('chip8', hash, 1);
        const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        data.state.pc = 516;
        fs.writeFileSync(stateFile, JSON.stringify(data));
        assert.throws(() => lib.loadState('chip8', hash, 1), /checksum/);
        data.version = 2;
        fs.writeFileSync(stateFile, JSON.stringify(data));
        assert.throws(() => lib.loadState('chip8', hash, 1), /Incompatible/);
        lib.remember('arcade', 'pong');
        assert.strictEqual(lib.last().title, 'Pong');
    } finally { rmrf(dir); }
    console.log('ok: library add / replace / list / delete, saves, last game');
}

/* ---------------- session ---------------- */
function testSession() {
    let clock = 10000, work = 0;
    const ticks = [];
    const game = {width: 10, height: 10, tick(p) { ticks.push(p); clock += work; }, sram: () => Buffer.from([7]), stop() { this.stopped = true; }};
    const stored = [];
    const s = new Session(game, 'nes', 'x.nes', {now: () => clock, store: (k, n, b) => { stored.push(b[0]); return true; }});
    assert.strictEqual(s.step([{}, {}], true), 1, 'first step runs one frame');
    clock += 17; assert.strictEqual(s.step([{}, {}], true), 1);
    clock += 8; assert.strictEqual(s.step([{}, {}], true), 0, 'not due yet');
    clock += 9; assert.strictEqual(s.step([{}, {}], true), 1, 'leftover time carries over');
    clock += 500; assert.strictEqual(s.step([{}, {}], true), 2, 'catch-up is capped');
    clock += 17; assert.strictEqual(s.step([{}, {}], true), 1, 'no burst after a stall');
    assert.strictEqual(s.step([{}, {}], false), 0, 'held while not allowed');
    clock += 1000; assert.strictEqual(s.step([{}, {}], true), 1, 'no catch-up after being held');
    s.pause('user');
    assert.strictEqual(stored.length, 1, 'pausing saves');
    clock += 100; assert.strictEqual(s.step([{}, {}], true), 0, 'paused');
    s.resume(); assert.strictEqual(s.step([{}, {}], true), 1);
    clock += AUTOSAVE_MS; s.step([{}, {}], true);
    assert.strictEqual(stored.length, 2, 'autosave while playing');
    // overload: sustained slow frames pause instead of killing the game
    work = 60;
    for (let i = 0; i < OVERLOAD_WINDOW + 5 && !s.paused; i++) { clock += 17; s.step([{}, {}], true); }
    assert.ok(s.paused && s.reason === 'overload', 'overload pauses');
    assert.ok(s.game, 'the game is kept');
    work = 0; s.resume(); clock += 17;
    assert.strictEqual(s.step([{}, {}], true), 1, 'resume after overload');
    // an exception pauses with the reason
    game.tick = () => { throw new Error('bad opcode'); };
    clock += 17; s.step([{}, {}], true);
    assert.ok(s.paused && s.reason === 'error' && /bad opcode/.test(s.detail));
    s.stop();
    assert.ok(game.stopped && s.stopped && s.game === null);
    assert.strictEqual(s.step([{}, {}], true), 0);
    // pictures: only the newest, once
    const t = new Session({tick() {}, stop() {}}, 'gb', 'g.gb', {});
    t.paint('a', 1, 1); t.paint('b', 1, 1);
    assert.strictEqual(t.take().pixels, 'b');
    assert.strictEqual(t.take(), null);
    // arcade: one time-scaled tick per screen frame
    let delta = 0;
    const pong = new Session({tick(p, d) { delta = d; }, draw() {}, stop() {}}, 'arcade', 'pong', {now: () => clock});
    pong.step([{}, {}], true); clock += 33; pong.step([{}, {}], true);
    assert.ok(delta > 1.9 && delta <= 2, 'Pong moves by elapsed time');
    console.log('ok: session pacing, catch-up cap, pause / resume, autosave, overload and error pause');
}

/* ---------------- battery RAM in the cores ---------------- */
function testSaves() {
    const sink = () => {};
    const nes = new NesGame(nesRom(true), sink);
    nes.tick([{}, {}]);
    const ram = nes.sram();
    assert.ok(ram && ram.length === 0x2000 && ram[0] === 0x42, 'NES battery RAM is read back');
    nes.stop();
    const again = new NesGame(nesRom(true), sink, {save: ram});
    assert.strictEqual(again.nes.cpu.ram.data[0x6000], 0x42, 'NES battery RAM is loaded before start');
    again.stop();
    assert.strictEqual(new NesGame(nesRom(false), sink).sram(), null, 'no battery, no save');

    const snes = new SnesGame(snesRom(true), sink);
    assert.strictEqual(sramSize(snes.snes.mmu), 8192);
    const save = Buffer.alloc(8192); save[5] = 0x99;
    const loaded = new SnesGame(snesRom(true), sink, {save});
    assert.strictEqual(loaded.sram()[5], 0x99, 'SNES SRAM is loaded and read back');
    assert.strictEqual(new SnesGame(snesRom(false), sink).sram(), null);

    const gb = new GameBoyGame(gbRom(true), sink);
    const gbram = gb.sram();
    assert.ok(gbram && gbram.length >= 8192, 'Game Boy cartridge RAM is read back');
    gbram[3] = 0x55;
    const gb2 = new GameBoyGame(gbRom(true), sink, {save: gbram});
    assert.strictEqual(gb2.sram()[3], 0x55, 'Game Boy cartridge RAM is loaded');
    gb2.tick([{a: true}]);
    assert.strictEqual(new GameBoyGame(gbRom(false), sink).sram(), null);

    // the SNES and Game Boy engines' debug output stays out of the log
    const log = console.log; let lines = 0;
    console.log = () => { lines++; };
    try { const s = new SnesGame(snesRom(false), sink); s.tick([{}, {}]); new GameBoyGame(gbRom(false), sink).tick([{}]); }
    finally { console.log = log; }
    assert.strictEqual(lines, 0, 'engine debug lines are muted');
    console.log('ok: battery saves for NES, SNES and Game Boy; engine debug output muted');
}

/* ---------------- phone server ---------------- */
function response() {
    return Object.assign(new EventEmitter(), {status: null, body: null, headers: null,
        writeHead(n, h) { this.status = n; this.headers = h; }, end(b) { this.body = b; }});
}
function call(server, method, url, remote, body) {
    const req = new EventEmitter();
    req.socket = {remoteAddress: remote || '172.16.222.20'};
    req.method = method; req.url = url; req.headers = {'content-length': String(body ? body.length : 0)};
    const res = response();
    server.request(req, res);
    if (method === 'POST') { if (body) req.emit('data', body); req.emit('end'); }
    return res;
}
function uploadDisc(server, name, body, replace) {
    return new Promise(resolve => {
        const req = new PassThrough();
        req.socket = {remoteAddress: '172.16.222.20'};
        req.method = 'POST';
        req.url = '/rom?t=' + server.token + '&platform=ps1&name=' + encodeURIComponent(name) +
            (replace ? '&replace=1' : '');
        req.headers = {};
        const res = response();
        res.end = () => resolve(res.status);
        server.request(req, res);
        req.write(body.slice(0, 11));
        req.end(body.slice(11));
    });
}
function maskedFrame(obj) {
    const payload = Buffer.from(JSON.stringify(obj)), key = Buffer.from([9, 8, 7, 6]);
    const wire = Buffer.alloc(6 + payload.length);
    wire[0] = 0x81; wire[1] = 0x80 | payload.length; key.copy(wire, 2);
    for (let i = 0; i < payload.length; i++) wire[6 + i] = payload[i] ^ key[i & 3];
    return wire;
}
async function testServer() {
    const dir = tmp('srv');
    const seen = [];
    try {
        const server = new ControllerServer(dir, {
            upload: (k, n) => seen.push('up:' + n), removed: (k, n) => seen.push('rm:' + n),
            removing: (k, n) => seen.push('removing:' + n), command: (p, m) => seen.push('cmd:' + p + ':' + m.type),
            state: () => ({title: 'Pong', paused: false}), address: () => '172.16.222.1',
        }, quiet, {port: 0, netStatusPort: 0});
        const t = server.token;
        // the firewall helper's probe: loopback only, no token
        let res = call(server, 'GET', '/.mgu-gamestation-health', '127.0.0.1');
        assert.strictEqual(res.status, 200); assert.strictEqual(res.headers['X-MGU-GameStation'], '1');
        assert.strictEqual(call(server, 'GET', '/.mgu-gamestation-health', '172.16.222.20').status, 403, 'not from Wi-Fi');
        assert.strictEqual(call(server, 'GET', '/?t=' + t, '8.8.8.8').status, 403);
        assert.strictEqual(call(server, 'GET', '/roms?t=wrong').status, 403);
        assert.strictEqual(call(server, 'GET', '/?t=' + t).status, 200);
        assert.strictEqual(call(server, 'POST', '/rom?t=' + t + '&platform=nes&name=My%20Game.nes', null, nesRom()).status, 201);
        assert.strictEqual(call(server, 'POST', '/rom?t=' + t + '&platform=nes&name=My%20Game.nes', null, nesRom()).status, 409);
        assert.strictEqual(call(server, 'POST', '/rom?t=' + t + '&platform=nes&name=My%20Game.nes&replace=1', null, nesRom(true)).status, 201);
        assert.strictEqual(call(server, 'POST', '/rom?t=' + t + '&platform=nes&name=bad.nes', null, Buffer.alloc(64)).status, 400);
        res = call(server, 'GET', '/roms?t=' + t);
        const cat = JSON.parse(res.body);
        assert.deepStrictEqual(cat.games.nes.map(g => g.name), ['My Game.nes']);
        assert.deepStrictEqual(cat.games.snes, []);
        assert.strictEqual(cat.state.title, 'Pong');
        assert.strictEqual(call(server, 'POST', '/delete?t=' + t + '&platform=nes&name=nope.nes').status, 404);
        assert.strictEqual(call(server, 'POST', '/delete?t=' + t + '&platform=nes&name=My%20Game.nes').status, 200);
        assert.deepStrictEqual(seen.filter(s => !/^removing/.test(s)), ['up:My Game.nes', 'up:My Game.nes', 'rm:My Game.nes']);
        const iso = Buffer.alloc(17 * 2048);
        iso.write('\x01CD001\x01', 16 * 2048, 'binary');
        assert.strictEqual(await uploadDisc(server, 'Disc.iso', iso), 201);
        assert.strictEqual(await uploadDisc(server, 'Disc.iso', iso), 409);
        assert.strictEqual(await uploadDisc(server, 'Disc.iso', Buffer.alloc(32), true), 400);
        const disc = server.library.read('ps1', 'Disc.iso');
        assert.strictEqual(disc, path.join(dir, 'roms', 'ps1', 'Disc.iso'));
        assert.ok(fs.readFileSync(disc).equals(iso), 'a rejected replacement leaves the disc intact');
        assert.deepStrictEqual(fs.readdirSync(path.dirname(disc)), ['Disc.iso'], 'temporary upload files are removed');
        assert.ok(server.url(2).indexOf('http://172.16.222.1:') === 0);

        // pads: a pause command, state pushed to the phone, slot takeover after silence
        const written = [];
        const sock = () => ({destroyed: false, write(b) { written.push(b); }, destroy() { this.destroyed = true; }, end() {}});
        const p = {closed: false, lastSeen: Date.now(), keys: {}, buffered: Buffer.alloc(0), index: 0, socket: sock()};
        server.players[0] = p;
        server.onData(p, maskedFrame({type: 'pause'}));
        assert.ok(seen.indexOf('cmd:1:pause') >= 0);
        server.broadcast({title: 'Zelda-like', paused: true});
        const out = written[written.length - 1];
        assert.strictEqual(out[0], 0x81);
        assert.deepStrictEqual(JSON.parse(out.slice(2).toString()), {type: 'state', title: 'Zelda-like', paused: true});
        const upgrade = () => {
            const s = Object.assign(new EventEmitter(), sock(), {remoteAddress: '172.16.222.30', setNoDelay() {}});
            server.upgrade({url: '/?p=1&t=' + t, headers: {upgrade: 'websocket', 'sec-websocket-version': '13',
                'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ=='}}, s, Buffer.alloc(0));
            return s;
        };
        assert.ok(upgrade().destroyed, 'a live phone keeps its slot');
        p.lastSeen -= 5000;
        const taker = upgrade();
        assert.ok(!taker.destroyed && p.closed && server.players[0].socket === taker, 'a silent slot is taken over');

        // firewall helper status (the root tool on 127.0.0.1:18978)
        server.readNet();
        await new Promise(r => setTimeout(r, 50));
        assert.strictEqual(server.net.ready, false);
        const helper = http.createServer((req, r) => { r.writeHead(200); r.end(JSON.stringify({ready: true, error: ''})); });
        await new Promise(r => helper.listen(0, '127.0.0.1', r));
        server.netStatusPort = helper.address().port;
        server.netBusy = false; server.readNet();
        await new Promise(r => setTimeout(r, 100));
        helper.close();
        assert.deepStrictEqual(server.net, {known: true, ready: true, error: ''});

        // listen, restart after a failure
        server.start();
        await new Promise(r => setTimeout(r, 50));
        assert.ok(server.listening);
        server.stop();
        assert.ok(!server.listening && !server.http);
    } finally { rmrf(dir); }
    console.log('ok: phone server health probe, list / replace / delete, pause command, state push, slot takeover, firewall status');
}

/* ---------------- car UI ---------------- */
const dump = process.env.GAMESTATION_UI_DUMP;
let uiActions = null;
function render(name, model, theme) {
    const actions = uiActions;
    const ui = makeUi(G, kitCanvas);
    const cv = new Recorder(W, H, {textScale: 1});
    cv.reset();
    ui.draw(cv, theme || THEMES.ice, model, actions);
    if (dump) {
        const out = new kitCanvas.Canvas(W, H);
        play(cv.words(), out);
        fs.writeFileSync(path.join(dump, name + '.png'), out.png());
    }
    return cv;
}
function testUi() {
    const calls = [];
    const a = {};
    ['open', 'platform', 'turn', 'play', 'resumeLast', 'toggleDelete', 'remove', 'togglePause', 'quit', 'nextMode'].forEach(n => {
        a[n] = arg => calls.push([n, arg]);
    });
    a.drawArcade = (cv, x, y, w, h) => calls.push(['arcade', x, y, w, h]);
    uiActions = a;
    const keys = cv => cv.targets.map(t => t.key);
    const press = (cv, key) => cv.targets.find(t => t.key === key).run();
    const platforms = PLATFORMS.map((p, i) => Object.assign({count: [9, 0, 2, 1][i] || 0}, p));
    const games = n => Array.from({length: n}, (_, i) => ({kind: 'nes', name: 'g' + i + '.nes',
        title: i === 1 ? 'An extremely long game title that will never fit into a single card of the list' : 'Game ' + (i + 1),
        detail: '40 KB' + (i % 2 ? '  ·  save kept' : '')}));
    const base = extra => Object.assign({page: PAGE.GAMES, allowed: true, lock: 'parked', lockHint: '', notice: null,
        platform: 0, deleting: false, armed: null, running: null, last: null, platforms, game: null}, extra);
    const list = (n, page) => ({items: games(n).slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE), page,
        pages: Math.max(1, Math.ceil(n / PAGE_SIZE)), start: page * PAGE_SIZE, total: n});

    let cv = render('games', base({list: list(9, 0), last: {kind: 'nes', name: 'g3.nes', title: 'Game 4'}}));
    assert.deepStrictEqual(keys(cv), [...PLATFORMS.map((_, i) => 'PLATFORM_' + i),
        'GAME_0', 'GAME_1', 'GAME_2', 'GAME_3', 'GAME_4', 'GAME_5', 'NEXT', 'CONTINUE', 'DELETE_MODE'],
        'platforms, then the games, then the footer (the knob walks them in this order)');
    press(cv, 'GAME_2'); press(cv, 'NEXT'); press(cv, 'PLATFORM_2'); press(cv, 'CONTINUE');
    assert.deepStrictEqual(calls.splice(0).map(c => c[0]), ['play', 'turn', 'platform', 'resumeLast']);
    cv.targets.forEach(t => assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= W && t.y + t.h <= H, t.key + ' on the page'));

    cv = render('games_delete', base({list: list(9, 1), deleting: true, armed: 'nes/g7.nes'}), THEMES.m_tricolour);
    assert.ok(keys(cv).indexOf('DEL_7') >= 0 && keys(cv).indexOf('GAME_7') < 0, 'delete mode: no accidental start');
    assert.ok(keys(cv).indexOf('CONTINUE') < 0);
    render('games_empty', base({platform: 1, list: list(0, 0)}), THEMES.amber);
    cv = render('games_moving', base({allowed: false, lock: 'moving', lockHint: 'The car is moving.', list: list(2, 0),
        last: {kind: 'nes', name: 'g0.nes', title: 'Game 1'}}));
    assert.ok(keys(cv).indexOf('CONTINUE') < 0, 'Continue is off while moving');

    const game = extra => Object.assign({title: 'Game 1', platform: 'NINTENDO', paused: false, reason: '', detail: '',
        focus: true, arcade: false, width: 256, height: 240, saved: true, fps: 58,
        players: [{label: 'iDrive controller', ok: true, state: 'Ready'}, {label: 'Phone (player 2)', ok: false, wait: true, state: 'Scan the code'}],
        help: 'iDrive: push = D-pad · press = A · hold = SELECT · double press = START · turn right = B · turn left = X.'}, extra);
    cv = render('playing', base({page: PAGE.PLAY, game: game(), running: {kind: 'nes', name: 'g0.nes'}}));
    assert.deepStrictEqual(keys(cv), ['PAUSE', 'TO_GAMES', 'TO_PADS', 'QUIT']);
    assert.ok(Array.prototype.indexOf.call(cv.images || [], 71) >= 0 || cv.u, 'the game picture is drawn');
    render('playing_overload', base({page: PAGE.PLAY, game: game({paused: true, reason: 'overload', detail: '61 ms per frame', width: 512, height: 208, fps: 12})}), THEMES.amber);
    cv = render('playing_moving', base({page: PAGE.PLAY, allowed: false, lock: 'nosignal', lockHint: 'Waiting for a valid vehicle-speed signal.', game: game()}));
    assert.ok(keys(cv).indexOf('PAUSE') < 0, 'cannot resume while the car is not parked');
    render('playing_pong', base({page: PAGE.PLAY, game: game({arcade: true, title: 'Pong', platform: 'BUILT-IN GAMES', width: 0, height: 0, saved: false})}));
    assert.ok(calls.some(c => c[0] === 'arcade' && c[3] === STAGE.w), 'Pong draws in the stage');
    calls.splice(0);
    cv = render('playing_none', base({page: PAGE.PLAY, last: {kind: 'gb', name: 'x.gb', title: 'X'}}));
    assert.deepStrictEqual(keys(cv), ['EMPTY_GAMES', 'CONTINUE']);

    const slot = (ok, link) => ({role: 'Controller and adding games', link, locked: 'The phone server is starting.', ok, wait: !ok, state: ok ? 'Phone connected' : 'Waiting for a phone'});
    const rows = [{name: 'Wi-Fi port', state: 'bad', value: 'mgu-game-net not installed'}, {name: 'Phone server', state: 'ok', value: '172.16.222.97:18878'},
        {name: 'iDrive', state: 'off', value: 'Not used in this setup'}, {name: 'Vehicle', state: 'ok', value: 'Parked, games allowed'},
        {name: 'Game', state: 'off', value: 'None running'}];
    cv = render('controllers', base({page: PAGE.PADS, pads: {mode: 'phones', ready: false, blocked: 'Install "GameStation Phone Port" (mgu-game-net) from MGU Store.',
        slots: [slot(true, 'http://172.16.222.97:18878/?p=1&t=' + 'a'.repeat(32)), slot(false, null)], rows}}));
    assert.deepStrictEqual(keys(cv), ['MODE']);
    press(cv, 'MODE');
    assert.strictEqual(calls.pop()[0], 'nextMode');

    assert.strictEqual(ascii('Pokémon – Gelbe Edition'), 'Pokemon - Gelbe Edition');
    assert.deepStrictEqual(fitRect({x: 0, y: 0, w: 900, h: 450}, 256, 240), {x: 210, y: 0, w: 480, h: 450});
    assert.deepStrictEqual(fitRect({x: 0, y: 0, w: 900, h: 450}, 256, 240, 'integer'), {x: 322, y: 105, w: 256, h: 240});
    const icon = fs.readFileSync(path.join(APP, 'icon.png'));
    assert.strictEqual(icon.readUInt32BE(16), 140);
    assert.strictEqual(icon.readUInt32BE(20), 140);
    assert.strictEqual(icon[25], 6, 'BMW app icon retains its RGBA canvas');

    console.log('ok: car UI pages (games, delete mode, playing, paused, Pong, controllers) and knob order');
}

/* ---------------- main.js against a stand-in for the kit ---------------- */
async function testApp() {
    const dir = tmp('app');
    let spec = null;
    const load = Module._load;
    Module._load = function (request, parent) {
        if (parent && path.dirname(parent.filename) === APP && request.indexOf('./kit/') === 0) {
            if (request === './kit/mgu') return {run(s) { spec = s; }};
            return load.call(this, path.join(KIT, request.slice(6)), parent);
        }
        return load.apply(this, arguments);
    };
    const before = process.listeners('exit').slice();
    delete require.cache[require.resolve(path.join(APP, 'main.js'))];
    require(path.join(APP, 'main.js'));
    Module._load = load;
    const lib = new Library(dir);
    lib.add('nes', 'Battery.nes', nesRom(true));
    lib.add('nes', 'Plain.nes', nesRom(false));

    const clicks = {}, hooks = {}, settings = {controllerMode: 'phones', theme: 'ice'}, grabs = [];
    let frame = null, tick = null, speed = null, visible = true, focus = true;
    const ctx = {
        log: quiet, dataDir: dir, spec: {version: '0.5.0'},
        settings: {get: k => settings[k], set: (k, v) => { settings[k] = v; }, onChange: () => {}},
        theme: () => THEMES.ice,
        signals: {watch: (iface, inst, handlers) => {
            if (handlers.statusCarSpeed2) speed = handlers.statusCarSpeed2;
            return Promise.resolve({});
        }},
        controller: {grab: on => grabs.push(on), onInput: () => {}},
        display: {sheet: null},
        ui: {onClick: (id, fn) => { clicks[id] = fn; }, onVisible: fn => { hooks.visible = fn; }, onFocus: fn => { hooks.focus = fn; },
            isVisible: () => visible, hasFocus: () => focus, image: (n, cv) => { frame = cv; return Promise.resolve(); }},
        onTab: fn => { hooks.tab = fn; },
        canvas: (w, h) => { const r = new Recorder(w, h, {textScale: 1}); r.reset(); return r; },
        loop: (name, fps, fn) => { tick = fn; },
    };
    const keys = () => { tick(); return frame.targets.map(t => t.key); };
    const press = key => { tick(); const t = frame.targets.find(x => x.key === key); assert.ok(t, 'no target ' + key); t.run(); };
    const parked = () => speed({speedVehicleCentreOfGravity: 0});
    const native = require(path.join(APP, 'retro_core'));
    const original = native.RetroGame;
    let nativeFrames = 0;
    native.RetroGame = class extends original {
        constructor(id, bytes, output, options) {
            super(id, bytes, output, Object.assign({}, options, {
                helper: path.join(APP, '../../native/gamestation-retro/mgu-gamestation-retro'),
                onFrame(block, duration) { nativeFrames++; options.onFrame(block, duration); },
            }));
        }
    };
    try {
        await spec.start(ctx);
        const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'app.json'), 'utf8'));
        assert.deepStrictEqual(manifest.screens[0].buttons.map(b => b[0]).filter(id => id !== 'BTN_SETTINGS').sort(), Object.keys(clicks).sort(),
            'every bar button in app.json has a handler');
        assert.ok(keys().indexOf('GAME_0') >= 0, 'NES games listed first');
        // no speed signal: nothing starts
        press('GAME_0');
        assert.ok(keys().indexOf('PLATFORM_0') >= 0, 'still on Games without a speed signal');
        parked();
        press('GAME_0');                                    // Battery.nes
        assert.deepStrictEqual(keys(), ['PAUSE', 'TO_GAMES', 'TO_PADS', 'QUIT'], 'Playing page');
        for (let i = 0; i < 5; i++) { tick(); await new Promise(r => setTimeout(r, 20)); }
        // the game wrote 0x42 to battery RAM; pausing saves it
        press('PAUSE');
        assert.strictEqual(lib.loadSave('nes', 'Battery.nes')[0], 0x42, 'pause writes the in-game save');
        assert.ok(keys().indexOf('PAUSE') >= 0);
        // moving: the game holds and the knob is released
        settings.controllerMode = 'idrive';
        press('PAUSE');                                     // resume
        tick();
        assert.strictEqual(grabs[grabs.length - 1], true, 'iDrive captured while playing');
        speed({speedVehicleCentreOfGravity: 640});          // 10 km/h
        tick();
        assert.strictEqual(grabs[grabs.length - 1], false, 'knob released when the car moves');
        assert.ok(keys().indexOf('PAUSE') < 0, 'no resume while moving');
        parked();
        tick();
        assert.strictEqual(grabs[grabs.length - 1], true);
        focus = false; hooks.focus('MAIN', false);
        assert.strictEqual(grabs[grabs.length - 1], false, 'focus loss releases immediately');
        focus = true; hooks.focus('MAIN', true);
        tick();
        speed({speedVehicleCentreOfGravity: 65535});
        assert.strictEqual(grabs[grabs.length - 1], false, 'invalid speed invalidates the previous speed');
        const realNow = Date.now;
        const parkedAt = realNow();
        try {
            Date.now = () => parkedAt;
            parked();
            tick();
            assert.strictEqual(grabs[grabs.length - 1], true);
            Date.now = () => parkedAt + 5000;
            tick();
            assert.strictEqual(grabs[grabs.length - 1], false, 'five-second signal expiry');
        } finally { Date.now = realNow; }
        parked();
        // tabs keep the game; the Games page offers to go back
        hooks.tab(PAGE.GAMES);
        assert.ok(keys().indexOf('TO_GAME') >= 0);
        assert.strictEqual(grabs[grabs.length - 1], false);
        hooks.tab(PAGE.PADS);
        assert.ok(keys().indexOf('MODE') >= 0);
        press('MODE');
        assert.strictEqual(settings.controllerMode, 'hybrid');
        // delete the running game on the car: two presses, the game stops first
        hooks.tab(PAGE.GAMES);
        press('DELETE_MODE');
        press('DEL_0'); press('DEL_0');
        assert.ok(!fs.existsSync(path.join(dir, 'roms', 'nes', 'Battery.nes')));
        assert.ok(keys().indexOf('TO_GAME') < 0, 'the deleted game is no longer running');
        // continue the last game after a restart of the app
        press('DELETE_MODE');
        press('GAME_0');                                    // Plain.nes
        press('QUIT');
        assert.ok(keys().indexOf('CONTINUE') >= 0, 'Continue offers the last game');
        clicks.BTN_ACTION();
        assert.deepStrictEqual(keys(), ['PAUSE', 'TO_GAMES', 'TO_PADS', 'QUIT'], 'BTN_ACTION continues the last game');
        clicks.BTN_ACTION();
        tick();
        clicks.BTN_PAIR();
        assert.ok(keys().indexOf('MODE') >= 0, 'BTN_PAIR opens Controllers');
        clicks.BTN_PLATFORM();
        assert.ok(keys().indexOf('PLATFORM_1') >= 0);
        // Arcade
        hooks.tab(PAGE.GAMES); press('PLATFORM_3'); press('GAME_0');
        tick(); await new Promise(r => setTimeout(r, 20)); tick();
        assert.deepStrictEqual(keys(), ['PAUSE', 'TO_GAMES', 'TO_PADS', 'QUIT'], 'Pong runs');
        lib.add('chip8', 'Key.ch8', Buffer.from('1200', 'hex'));
        hooks.tab(PAGE.GAMES); press('PLATFORM_4'); press('GAME_0');
        clicks.BTN_DIAG();
        assert.ok(keys().includes('STATE_SAVE'), 'state slots are available for the CHIP-8 core');
        press('STATE_SLOT'); press('STATE_SAVE'); press('STATE_LOAD');
        assert.ok(keys().includes('TONE'), 'diagnostics is accessible from the BMW button bar');
        // screen hidden: held
        visible = false; tick(); visible = true; focus = false; tick(); focus = true;

        if (process.platform === 'linux' && process.arch === 'x64') {
            const {fixtures} = require('./gamestation_retro.test');
            lib.add('gba', 'Native.gba', fixtures().gba);
            parked();
            hooks.tab(PAGE.GAMES);
            press('PLATFORM_' + PLATFORMS.findIndex(p => p.id === 'gba'));
            press('GAME_0');
            tick();
            for (let i = 0; i < 100 && nativeFrames < 3; i++) await new Promise(r => setTimeout(r, 15));
            assert.ok(nativeFrames >= 3, 'native emulator starts through the normal GameStation UI');
            speed({speedVehicleCentreOfGravity: 640});
            const held = nativeFrames;
            await new Promise(r => setTimeout(r, 80));
            assert.strictEqual(nativeFrames, held, 'native frame commands and delivery stop on vehicle motion');
            assert.ok(lib.loadSave('gba', 'Native.gba'), 'battery cache saved when the car moves');
            parked(); tick();
            for (let i = 0; i < 100 && nativeFrames === held; i++) await new Promise(r => setTimeout(r, 15));
            assert.ok(nativeFrames > held, 'native emulator resumes after verified standstill');
            press('QUIT');
        }
    } finally {
        native.RetroGame = original;
        process.listeners('exit').filter(l => before.indexOf(l) < 0).forEach(l => { l(); process.removeListener('exit', l); });
        rmrf(dir);
    }
    console.log('ok: app: parked gate, start / pause / save, knob release when moving, tabs, delete running game, continue, Pong');
}

(async () => {
    testLibrary();
    testSession();
    testSaves();
    await testServer();
    testUi();
    await testApp();
})().catch(e => { console.error(e); process.exit(1); });
