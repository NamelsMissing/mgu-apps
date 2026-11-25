'use strict';

function phone() {
    var token = new URLSearchParams(location.search).get('t');
    var state, busy = false, marked = [], preview = null;
    var byId = function (id) { return document.getElementById(id); };
    var endpoint = function (path) { return path + '?t=' + encodeURIComponent(token); };
    var status = byId('status');
    byId('export').href = endpoint('/diagnostics');

    function get(path, method, body, type) {
        return new Promise(function (resolve, reject) {
            var x = new XMLHttpRequest();
            x.open(method || 'GET', path);
            x.timeout = 35000;
            if (method === 'POST') {
                x.setRequestHeader('X-GIF-Home', '1');
                x.setRequestHeader('Content-Type', type || 'application/json');
            }
            x.onload = function () {
                try {
                    var data = JSON.parse(x.responseText);
                    if (x.status !== 200) throw new Error(data.error || 'HTTP ' + x.status);
                    resolve(data);
                } catch (e) { reject(e); }
            };
            x.onerror = x.ontimeout = function () { reject(new Error('The MGU did not respond. Check Phone Connection.')); };
            x.send(body || null);
        });
    }
    function run(fn) {
        if (busy || !state) return;
        busy = true;
        byId('controls').disabled = true;
        status.textContent = 'Waiting for MGU confirmation…';
        Promise.resolve().then(fn).then(function (data) {
            receive(data);
            status.textContent = 'Confirmed by MGU';
        }).catch(function (e) { status.textContent = e.message; render(); }).then(function () {
            busy = false;
            byId('controls').disabled = false;
        });
    }
    function action(type, values) {
        run(function () {
            return get(endpoint('/action'), 'POST', JSON.stringify(Object.assign({
                type: type, revision: state.revision
            }, values)));
        });
    }
    function node(tag, parent, text) {
        var item = document.createElement(tag);
        if (text) item.textContent = text;
        parent.appendChild(item);
        return item;
    }
    function button(parent, text, fn) {
        var b = node('button', parent, text);
        b.type = 'button';
        b.onclick = fn;
        return b;
    }
    function select(parent, text, items, value, fn) {
        var label = node('label', parent, text);
        var input = node('select', label);
        items.forEach(function (item) {
            var opt = node('option', input, item[1]);
            opt.value = item[0];
        });
        input.value = value;
        input.onchange = function () { fn(input.value); };
    }
    function checkbox(parent, text, checked, fn) {
        var label = node('label', parent);
        var input = node('input', label);
        input.type = 'checkbox';
        input.checked = checked;
        label.appendChild(document.createTextNode(text));
        input.onchange = function () { fn(input.checked); };
    }
    function rename(type, item) {
        var value = prompt('New name', item.name);
        if (value) action(type, { id: item.id, name: value });
    }
    function remove(ids) {
        if (ids.length && confirm('Delete ' + ids.length + ' uploaded GIF(s)?'))
            action('delete', { ids: ids, confirm: true });
    }
    function render() {
        var p = state.playback;
        var library = byId('library'), groups = byId('groups'), playback = byId('playback');
        var files = state.files.concat(state.presets);
        marked = marked.filter(function (id) { return files.some(function (f) { return f.id === id; }); });
        library.textContent = groups.textContent = playback.textContent = '';
        files.forEach(function (f) {
            var card = node('article', library);
            node('h3', card, f.name);
            node('p', card, f.bytes ? (f.bytes / 1024).toFixed(1) + ' KiB · ' + f.width + ' × ' +
                f.height + ' · ' + f.frames + ' frames · ' + (f.duration / 1000).toFixed(2) + ' s' : 'Built-in animation');
            checkbox(card, 'Mark for bulk actions', marked.indexOf(f.id) >= 0, function (on) {
                marked = marked.filter(function (id) { return id !== f.id; });
                if (on) marked.push(f.id);
            });
            checkbox(card, 'Selected for playback', p.selected.indexOf(f.id) >= 0, function (on) {
                var ids = p.selected.filter(function (id) { return id !== f.id; });
                if (on) ids.push(f.id);
                action('playback', { selected: ids });
            });
            button(card, 'Preview', function () {
                if (preview) preview.remove();
                preview = node('img', card);
                preview.alt = 'Preview of ' + f.name;
                preview.src = endpoint('/preview') + '&id=' + encodeURIComponent(f.id);
            });
            button(card, 'Play on Home', function () { action('activate', { id: f.id }); });
            if (f.bytes) {
                button(card, 'Rename', function () { rename('rename', f); });
                button(card, 'Delete', function () { remove([f.id]); });
            }
        });
        state.groups.forEach(function (g) {
            var card = node('article', groups);
            node('h3', card, g.name);
            node('p', card, files.filter(function (f) { return g.ids.indexOf(f.id) >= 0; })
                .map(function (f) { return f.name; }).join(', ') || 'Empty group');
            button(card, 'Add marked', function () { if (marked.length) action('members', { id: g.id, ids: marked, add: true }); });
            button(card, 'Remove marked', function () { if (marked.length) action('members', { id: g.id, ids: marked, add: false }); });
            button(card, 'Play group', function () { action('playback', { mode: 'group', group: g.id }); });
            button(card, 'Rename', function () { rename('renameGroup', g); });
            button(card, 'Delete group', function () {
                if (confirm('Delete this group? Its GIFs will stay in the library.'))
                    action('deleteGroup', { id: g.id, confirm: true });
            });
        });
        select(playback, 'Mode', [
            ['single', 'Single GIF'], ['selected', 'Random – Selected GIFs'], ['group', 'Random – Group'],
            ['sequential', 'Sequential'], ['all', 'Random – All']
        ], p.mode, function (v) { action('playback', { mode: v }); });
        select(playback, 'Single GIF', files.map(function (f) { return [f.id, f.name]; }), p.single,
            function (v) { action('playback', { single: v }); });
        select(playback, 'Group', [['', 'Choose group']].concat(state.groups.map(function (g) {
            return [g.id, g.name];
        })), p.group || '', function (v) { action('playback', { group: v || null }); });
        var intervals = [0, 5, 10, 15, 30];
        var intervalLabel = intervals.map(function (v) { return [v, v ? v + ' seconds' : 'One full GIF pass']; });
        intervalLabel.push(['custom', 'Custom…']);
        if (intervals.indexOf(p.seconds) < 0) intervalLabel.push([p.seconds, p.seconds + ' seconds']);
        select(playback, 'Switch after', intervalLabel, String(p.seconds), function (v) {
            if (v === 'custom') v = prompt('Seconds (1–3600)', p.seconds || 20);
            if (v !== null && v !== '' && /^\d+$/.test(v)) action('playback', { seconds: Number(v) });
        });
        button(playback, p.paused ? 'Resume' : 'Pause', function () { action('playback', { paused: !p.paused }); });
        button(playback, 'Next GIF', function () { action('next'); });
        node('h3', playback, 'Selected order');
        var ordered = node('ol', playback);
        p.selected.forEach(function (id, i) {
            var f = files.filter(function (item) { return item.id === id; })[0];
            var row = node('li', ordered, f.name + ' ');
            if (i > 0) button(row, 'Move up', function () {
                var ids = p.selected.slice();
                ids[i] = ids[i - 1]; ids[i - 1] = id;
                action('playback', { selected: ids });
            });
        });
    }
    function receive(data) {
        var rebuild = !state || state.revision !== data.revision;
        state = data;
        byId('active').textContent = state.activeName || 'No GIF';
        byId('expiry').textContent = state.expires ? 'Session ends at ' + new Date(state.expires).toLocaleTimeString() : '';
        byId('issue').textContent = state.error || state.playbackNotice || '';
        if (rebuild) render();
    }
    byId('delete').onclick = function () {
        remove(marked.filter(function (id) { return state.files.some(function (f) { return f.id === id; }); }));
    };
    byId('group').onclick = function () {
        var value = prompt('Group name');
        if (value) action('createGroup', { name: value });
    };
    byId('renew').onclick = function () {
        run(function () { return get(endpoint('/renew'), 'POST', '{}'); });
    };
    byId('upload').onclick = function () {
        var input = byId('files'), files = Array.prototype.slice.call(input.files);
        if (!files.length) { status.textContent = 'Choose one or more GIFs.'; return; }
        run(function () {
            var errors = [], count = 0;
            return files.reduce(function (chain, file) {
                return chain.then(function () {
                    return get(endpoint('/upload') + '&name=' + encodeURIComponent(file.name), 'POST', file, 'image/gif')
                        .then(function (data) { receive(data); count++; })
                        .catch(function (e) { errors.push(file.name + ' · ' + e.message); });
                });
            }, Promise.resolve()).then(function () {
                input.value = '';
                if (errors.length) throw new Error(count + ' stored. ' + errors.join(' / '));
                return state;
            });
        });
    };
    function poll() {
        if (busy || document.hidden) return;
        var previous = state;
        get(endpoint('/state')).then(function (data) {
            if (busy || previous !== state) return;
            receive(data);
            if (!previous) status.textContent = 'Connected to MGU';
            byId('connection').textContent = 'MGU online';
            byId('controls').disabled = false;
        }).catch(function (e) {
            if (!busy) byId('connection').textContent = e.message;
        });
    }
    poll();
    setInterval(poll, 3000);
}
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>GIF Home</title><style>
*{box-sizing:border-box}body{margin:0;background:#101827;color:#eef4ff;font:16px system-ui,-apple-system,sans-serif}
main{max-width:850px;margin:auto;padding:20px}h1{margin:0}h2{margin-top:28px}h3,p{margin:0 0 10px;overflow-wrap:anywhere}
a{color:#9dccff}button,input,select{font:inherit}button,select{margin:4px 5px 4px 0;padding:9px 12px;min-height:44px;
border:1px solid #607a9f;border-radius:8px;background:#233a57;color:#fff}button:disabled{opacity:.55}
label{display:block;padding:4px 0}label select{display:block;max-width:100%}input[type=checkbox]{margin-right:8px}
article{background:#1a293e;border-radius:12px;padding:14px;margin:10px 0}img{display:block;max-width:100%;max-height:240px;margin-top:6px}
fieldset{padding:0;border:0;min-width:0}#issue,#status,#connection{overflow-wrap:anywhere;color:#b8d2f8}
@media(min-width:650px){#library,#groups{display:grid;grid-template-columns:1fr 1fr;gap:10px}}
</style></head><body><main><h1>GIF Home</h1><p id="connection">Connecting to MGU…</p>
<p>Playing <strong id="active"></strong></p><p id="issue"></p><p id="status" role="status"></p>
<fieldset id="controls" disabled><section><h2>GIF library</h2>
<input id="files" type="file" accept="image/gif,.gif" multiple aria-label="Choose GIFs">
<button type="button" id="upload">Upload</button><button type="button" id="delete">Delete marked uploads</button>
<div id="library"></div></section><section><h2>Groups</h2>
<button type="button" id="group">Create group</button><div id="groups"></div></section>
<section><h2>Playback</h2><div id="playback"></div></section>
<section><h2>Connection</h2><button type="button" id="renew">Extend session</button>
<p id="expiry"></p><a id="export">Download diagnostic log</a></section></fieldset></main>
<script>(${phone.toString()})();</script></body></html>`;
module.exports = { page };
