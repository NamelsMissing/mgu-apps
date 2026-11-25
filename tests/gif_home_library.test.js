'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { decode } = require('../apps/gif_home/gif');
const { Library } = require('../apps/gif_home/library');
const { Playback } = require('../apps/gif_home/playback');

const demo = Buffer.from(require('../apps/gif_home/resources/demo.json').base64, 'base64');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-home-library-'));
const records = [];
const log = entry => records.push(entry);
const open = () => new Library(dir, ['demo', 'drift'], { source: 'auto', paused: true }, log);
function clean(dir) {
    fs.readdirSync(dir).forEach(child => {
        const f = path.join(dir, child);
        if (fs.statSync(f).isDirectory()) clean(f);
        else fs.unlinkSync(f);
    });
    fs.rmdirSync(dir);
}

try {
    fs.writeFileSync(path.join(dir, 'custom.gif'), demo);
    let lib = open();
    const legacy = lib.state.files[0].id;
    assert.strictEqual(lib.state.playback.single, legacy);
    assert.strictEqual(lib.state.playback.paused, true);
    assert.strictEqual(lib.state.files.length, 1);
    const a = lib.add(demo, 'duplicate.gif');
    const b = lib.add(demo, 'duplicate.gif');
    assert.notStrictEqual(a, b);
    assert.deepStrictEqual(lib.read(a), demo);
    assert.throws(() => lib.add(Buffer.from('GIF89a'), 'bad.gif'), /GIF/);
    assert.throws(() => decode(demo.slice(0, demo.length - 2)), /GIF/);
    assert.throws(() => lib.read('../custom.gif'), /Unknown GIF/);
    lib.change({ type: 'rename', id: a, name: '../renamed' });
    assert.strictEqual(lib.state.files.find(f => f.id === a).name, '.._renamed.gif');
    assert.throws(() => lib.change({ type: 'rename', id: a, name: 'a', revision: 0 }, true), /Refresh/);
    lib.change({ type: 'createGroup', name: 'E30' });
    const g = lib.state.groups[0].id;
    lib.change({ type: 'renameGroup', id: g, name: 'Classics' });
    lib.change({ type: 'members', id: g, add: true, ids: [a, b] });
    lib.change({ type: 'members', id: g, add: false, ids: [a] });
    lib.change({ type: 'playback', mode: 'group', group: g, selected: [b, a], paused: false, seconds: 5 });
    const saved = lib.state;
    lib = open();
    assert.deepStrictEqual(lib.state, saved);
    assert.strictEqual(records.filter(s => s === 'Migrated custom.gif').length, 1);
    assert.deepStrictEqual(lib.state.groups[0].ids, [b]);
    lib.change({ type: 'deleteGroup', id: g, confirm: true });
    assert.deepStrictEqual(lib.read(b), demo);
    lib.change({ type: 'activate', id: a });
    assert.throws(() => lib.change({ type: 'delete', ids: [a] }), /Confirm/);
    assert.throws(() => lib.change({ type: 'delete', ids: ['demo'], confirm: true }), /Confirm/);
    lib.change({ type: 'delete', ids: [a], confirm: true });
    assert.notStrictEqual(lib.state.playback.single, a);
    assert(!fs.existsSync(lib.fileFor(a)));
    lib.change({ type: 'delete', ids: [b, legacy], confirm: true });
    assert.strictEqual(open().state.files.length, 0);
    const recoveryId = lib.add(demo, 'recover.gif');
    fs.writeFileSync(lib.file, '{"broken":true}');
    lib = open();
    assert(lib.error);
    assert(fs.existsSync(lib.fileFor(recoveryId)));
    assert.throws(() => lib.add(demo, 'x'), /preserved/);
    assert.strictEqual(fs.readFileSync(lib.file, 'utf8'), '{"broken":true}');
} finally { clean(dir); }

const gif = { duration: 300, frames: [{ delay: 100 }, { delay: 200 }] };
const ids = ['demo', 'a', 'b', 'c'];
let attempts = [];
const make = () => new Playback(id => {
    attempts.push(id);
    if (id === 'bad') throw Error('bad GIF');
    return gif;
}, log, 'demo', () => 0.25);
const state = { groups: [{ id: 'g', ids: ['b', 'c'] }], playback: {
    mode: 'single', single: 'a', selected: ['a', 'b', 'c'], seconds: 0, paused: false, group: 'g'
} };
let p = make();
const update = (t, speed, skip, resume) => p.update(state, ids, t, speed || 1, skip, resume);
assert.strictEqual(update(0), 0);
assert.strictEqual(update(100), 1);
assert.strictEqual(update(3000), 0);
assert.strictEqual(p.id, 'a');
assert.deepStrictEqual(attempts, ['a'], 'only current GIF decoded');
state.playback.mode = 'sequential';
update(3100);
assert.strictEqual(p.id, 'b');
update(3101, 1, true);
assert.strictEqual(p.id, 'c');
state.playback.seconds = 5;
update(8000);
assert.strictEqual(p.id, 'c');
update(8101);
assert.strictEqual(p.id, 'a');
state.playback.paused = true;
update(8201);
update(16000);
assert.strictEqual(p.id, 'a');
state.playback.paused = false;
update(16000);
assert.strictEqual(p.id, 'a');
state.playback.mode = 'selected';
state.playback.seconds = 0;
p = make();
const cycle = [];
for (let i = 0; i < 9; i++) {
    update(i * 150, 2, false, i === 0 ? 'c' : null);
    cycle.push(p.id);
}
assert.strictEqual(cycle[0], 'c');
for (let i = 0; i < cycle.length; i += 3) assert.strictEqual(new Set(cycle.slice(i, i + 3)).size, 3);
assert(cycle.every((id, i) => i === 0 || cycle[i - 1] !== id));
state.playback.mode = 'group';
p = make();
update(0);
assert(['b', 'c'].includes(p.id));
update(300);
assert(['b', 'c'].includes(p.id));
state.playback.mode = 'all';
p = make();
const all = [];
for (let i = 0; i < 4; i++) { update(i * 300); all.push(p.id); }
assert.deepStrictEqual(all.sort(), ids.slice().sort());
state.playback.mode = 'sequential';
state.playback.selected = ['bad', 'b'];
p = make();
attempts = [];
update(0);
assert.deepStrictEqual(attempts, ['bad', 'b']);
assert.strictEqual(p.id, 'b');
state.playback.selected = [];
update(1);
assert.strictEqual(p.id, 'demo');
console.log('GIF Home library migration, persistence, validation and playback passed');
