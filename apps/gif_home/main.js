'use strict';

const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { Canvas } = require('./kit/canvas');
const { setImage, makeLayer, dropLayer } = require('./kit/record');
const { open } = require('./kit/pack');
const { decode } = require('./gif');
const qrcode = require('./qr_vendor');
const { GifUploadServer, localAddresses, bridgeStatus, PORT, IFACE } = require('./upload');
const { compensateWidget } = require('./widget_tone');
const { Library, MODES, atomic } = require('./library');
const { Playback } = require('./playback');
const { diagnostics } = require('./diagnostics');

const W = 1600, H = 520, PIXEL_IMAGE = 23401;
const PRESETS = [
    ['demo', 'Animated BMW logo', 'demo.json'],
    ['drift', 'Pixel drift: Night City', 'drift_city.json'],
    ['sunset', 'Pixel drive: Sunset', 'sunset_drive.json'],
    ['garage', 'Pixel art: Neon Garage', 'garage_nights.json'],
    ['tunnel', 'Pixel art: Midnight Run', 'tunnel_run.json']
];
const PRESET_IDS = PRESETS.map(p => p[0]);
const MODE_NAMES = ['Single GIF', 'Random – Selected GIFs', 'Random – Group', 'Sequential', 'Random – All'];
const NEEDS_BRIDGE = target => target.interface === IFACE || target.priority === 2;

function rectFor(srcW, srcH, x, y, w, h, mode) {
    const scale = mode === 'contain' ? Math.min(w / srcW, h / srcH) : Math.max(w / srcW, h / srcH);
    const dw = Math.round(srcW * scale), dh = Math.round(srcH * scale);
    return { x: Math.round(x + (w - dw) / 2), y: Math.round(y + (h - dh) / 2), w: dw, h: dh };
}

function qrLayer(link) {
    const code = qrcode(0, 'M');
    code.addData(link); code.make();
    const n = code.getModuleCount(), step = Math.floor(312 / (n + 8));
    const off = Math.floor((320 - n * step) / 2);
    return makeLayer(320, 320, r => {
        r.fillRect(0, 0, 320, 320, '#fff');
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
            if (code.isDark(y, x)) r.fillRect(off + x * step, off + y * step, step, step, '#000');
    });
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const diag = diagnostics(ctx.dataDir, log);
        let logVersion = 0;
        const record = message => { logVersion++; diag.record(message); };
        record('GIF Home startup');
        const library = new Library(ctx.dataDir, PRESET_IDS,
            { source: settings.get('source'), paused: settings.get('pause') }, record);
        const resources = open(path.join(__dirname, 'resources'));
        function gifBytes(id) {
            const preset = PRESETS.find(item => item[0] === id);
            if (!preset) return library.read(id);
            const value = resources.json(preset[2]);
            if (!value || !value.base64) throw new Error('Built-in animation unavailable');
            return Buffer.from(value.base64, 'base64');
        }
        const presets = PRESETS.map(p => ({ id: p[0], name: p[1] }));
        const files = () => library.state.files.concat(presets);
        const label = id => { const f = files().find(item => item.id === id); return f ? f.name : 'None'; };
        const player = new Playback(id => decode(gifBytes(id)), record, PRESET_IDS[0]);
        const cursorFile = path.join(ctx.dataDir, 'playback-cursor.json');
        let resume = null, lastSave = 0, cursorDirty = false;
        try {
            if (fs.statSync(cursorFile).size < 1024) resume = JSON.parse(fs.readFileSync(cursorFile, 'utf8')).id;
        } catch (_) {}
        const panels = ['Home / Preview', 'Library', 'Playback', 'Phone Connection', 'Diagnostics'];
        let panel = 0, row = 0, logOffset = 0, confirmClear = false, dirty = true, screenKey = '';
        let widgetIndex = Object.create(null), frame = -1, notice = '';
        const phone = { enabled: false, addresses: [], index: 0, bridge: '', ready: false,
            detail: '', qr: null, link: '', export: false, searching: false };
        function update(skip, persist) {
            const speed = settings.get('speed') === 'slow' ? 0.5 : settings.get('speed') === 'fast' ? 1.5 : 1;
            const previous = player.id, now = Date.now();
            frame = player.update(library.state, files().map(f => f.id), now, speed, skip, resume);
            resume = null;
            if (previous !== player.id) { dirty = true; cursorDirty = true; }
            if (cursorDirty && (persist || now - lastSave >= 5000)) {
                lastSave = now;
                cursorDirty = false;
                try { atomic(cursorFile, JSON.stringify({ id: player.id })); }
                catch (_) { record('Could not save playback position'); }
            }
            return frame;
        }
        function snapshot() {
            const playbackNotice = !player.gif ? 'No decodable GIF' :
                !eligible().includes(player.id) ? 'Selection unavailable. Playing the built-in fallback.' : '';
            return Object.assign({}, library.state, { presets, active: player.id, activeName: label(player.id),
                error: library.error, playbackNotice });
        }
        function eligible() {
            const p = library.state.playback;
            const g = library.state.groups.find(item => item.id === p.group);
            return p.mode === 'single' ? [p.single] : p.mode === 'all' ? files().map(f => f.id) :
                p.mode === 'group' ? (g ? g.ids : []) : p.selected;
        }
        function apply(action, check) {
            if (action && action.type === 'next' && library.state.playback.mode === 'single') {
                const ids = files().map(f => f.id);
                const current = ids.indexOf(library.state.playback.single);
                action = { type: 'activate', id: ids[(current + 1) % ids.length], revision: action.revision };
            }
            if (action && action.type === 'next') update(true, true);
            else {
                library.change(action, check);
                update(false, true);
            }
            dirty = true;
        }
        const upload = new GifUploadServer({
            record, api: {
                state: snapshot,
                preview: gifBytes,
                diagnostics: diag.entries,
                upload(bytes, name) {
                    library.add(bytes, name, false);
                    update(); dirty = true;
                },
                action(action) { apply(action, true); }
            }
        });

        function clearQr() {
            if (phone.qr) dropLayer(phone.qr);
            phone.qr = null; phone.link = ''; dirty = true;
        }
        function refreshQr() {
            const link = phone.ready ? upload.link(phone.export ? '/diagnostics' : '/') : '';
            if (link === phone.link) return;
            clearQr();
            if (link) {
                try { phone.qr = qrLayer(link); phone.link = link; }
                catch (_) { phone.detail = 'Could not generate QR code'; record(phone.detail); }
            }
        }
        async function checkBridge() {
            if (phone.searching || !phone.enabled || !upload.target) return;
            phone.searching = true;
            const target = upload.target;
            try {
                const bridge = NEEDS_BRIDGE(target) ? await bridgeStatus() : null;
                if (target !== upload.target) return;
                const exists = localAddresses().some(a => a.ip === target.ip && a.interface === target.interface &&
                    a.netmask === target.netmask);
                const ready = bridge && bridge.ready === true && Date.now() - bridge.checkedAt < 10000;
                const status = !bridge ? 'Not required' : ready ? 'Ready' : 'Error';
                const detail = !exists ? 'Selected address is no longer available. Rescan.' :
                    !upload.listening ? 'HTTP server is not listening' :
                    !upload.active ? 'QR session expired. Rescan to pair again.' :
                    bridge && !ready ? (bridge.error || 'Firewall not ready. Waiting for helper.') : '';
                if (phone.bridge !== status || phone.detail !== detail) {
                    record('Network bridge: ' + status + (detail ? ' · ' + detail : ''));
                    dirty = true;
                }
                phone.bridge = status;
                phone.detail = detail;
                phone.ready = !detail;
                refreshQr();
            } finally { phone.searching = false; }
        }
        async function connect(next) {
            if (phone.connecting) return;
            phone.connecting = true;
            panel = 3;
            phone.enabled = true; phone.export = false; phone.ready = false;
            phone.bridge = ''; phone.detail = 'Searching for local Wi-Fi'; clearQr();
            upload.end();
            try {
                const previous = phone.addresses[phone.index];
                phone.addresses = localAddresses();
                const old = previous ? phone.addresses.findIndex(a => a.ip === previous.ip) : -1;
                phone.index = next && phone.addresses.length ? (old + 1) % phone.addresses.length : 0;
                const target = phone.addresses[phone.index];
                if (!target) {
                    phone.detail = 'No private IPv4 address. Connect the phone to the MGU Wi-Fi.';
                    record(phone.detail);
                    return;
                }
                await upload.start();
                upload.begin(target);
                await checkBridge();
            } catch (_) {
                phone.detail = upload.serverError || 'HTTP server is not listening on TCP ' + PORT;
                record(phone.detail);
            } finally { phone.connecting = false; dirty = true; }
        }
        function stopPhone() {
            phone.enabled = false; phone.ready = false; phone.bridge = ''; phone.detail = 'Phone session stopped';
            clearQr();
            record(phone.detail);
            return upload.close();
        }

        function drawFrame(cv, width, height, widget) {
            if (!player.gif || frame < 0) return;
            const gif = player.gif, img = gif.frames[frame];
            const r = rectFor(gif.width, gif.height, 0, 0, width, height, settings.get('fit'));
            if (widget) cv.drawImage(img.data, gif.width, gif.height, r.x, r.y, r.w, r.h);
            else {
                setImage(PIXEL_IMAGE, gif.width, gif.height, img.data);
                cv.image(PIXEL_IMAGE, r.x, r.y, r.w, r.h);
            }
        }
        function widgetImage(inst) {
            const key = String(inst.spawnId);
            update();
            const stamp = player.id + ':' + (inst.big ? frame : label(player.id));
            if (!inst.visible || widgetIndex[key] === stamp) return null;
            if (!inst.big) {
                ctx.widget.set(inst.spawnId, 'Title', 'GIF Home', 'Text');
                ctx.widget.set(inst.spawnId, 'TextRecordings', label(player.id), 'Text');
                ctx.widget.set(inst.spawnId, 'TextCam', 'Tap to open', 'Text');
                widgetIndex[key] = stamp;
                return null;
            }
            try {
                const dims = ctx.spec.startWidget.size || [384, 256];
                const cv = new Canvas(dims[0], dims[1]).clear('#080911');
                drawFrame(cv, dims[0], dims[1], true);
                if (frame < 0) cv.text('NO GIF', dims[0] / 2, dims[1] / 2, 28, '#fff', { align: 'center' });
                compensateWidget(cv, settings.get('widgetTone') || 'neutral');
                widgetIndex[key] = stamp;
                return cv;
            } catch (_) {
                record('Widget frame could not be rendered');
                return null;
            }
        }

        const intervalLabel = p => p.seconds ? p.seconds + ' s' : 'One full GIF pass';
        function playRows() {
            const p = library.state.playback, group = library.state.groups.find(g => g.id === p.group);
            return [
                'Mode · ' + MODE_NAMES[MODES.indexOf(p.mode)],
                'Group · ' + (group ? group.name : 'None'),
                'Interval · ' + intervalLabel(p),
                p.paused ? 'Resume playback' : 'Pause playback',
                'Next GIF'
            ];
        }
        async function render() {
            update();
            if (phone.link && !upload.active) { clearQr(); phone.detail = 'QR session expired. Rescan to pair again.'; }
            const key = JSON.stringify([panel, row, logOffset, panel === 0 ? frame : 0, player.id,
                library.state.revision, panel === 4 ? logVersion : 0, panel === 3 ? [upload.phoneAt, upload.lastError, upload.lastRequest] : null]);
            if (key === screenKey && !dirty) return;
            screenKey = key; dirty = false;
            const cv = ctx.canvas(W, H).clear('#090b13');
            const line = (s, y, x, size, ink) => cv.text(String(s).slice(0, x > 800 ? 44 : 112),
                x || 40, y, size || 27, ink || '#d9e5f9');
            if (panel === 0) drawFrame(cv, W, H, false);
            if (panel === 1) {
                const list = files(), start = Math.floor(row / 7) * 7;
                list.slice(start, start + 7).forEach((f, index) => line((index + start === row ? '> ' : '   ') +
                    f.name + (f.id === player.id ? '   • Playing' : ''), 95 + index * 45));
                line('Next item moves through the library. Select plays the highlighted GIF.', 420, 40, 22);
            }
            if (panel === 2) {
                playRows().forEach((entry, i) => line((row === i ? '> ' : '   ') + entry, 95 + i * 49));
                line(library.state.playback.selected.length + ' selected GIFs · ' + eligible().length + ' in current mode', 375);
            }
            if (panel === 3) {
                const target = upload.target;
                line('HTTP server · ' + (upload.listening ? 'Running' : (upload.serverError || 'Not listening')), 91);
                line('Network bridge · ' + (phone.bridge || 'Waiting'), 135);
                line('Selected IP / Port · ' + (target ? target.ip + ':' + upload.port + ' (' + target.interface + ')' : 'None'), 179);
                line('QR session · ' + (upload.active ? 'Active' : 'Expired / inactive'), 223);
                line('Phone connection · ' + (upload.active && phone.ready && upload.phoneAt !== null ? 'Connected' : 'Not verified'), 267);
                line('Last request · ' + (upload.lastRequest || 'Phone request not received'), 311, 40, 23);
                line('Last error · ' + (upload.lastError || phone.detail || 'None'), 353, 40, 23, '#ffd4ad');
                line(phone.export ? 'Scan to download diagnostic JSON' : phone.link ? 'Scan with iPhone Camera' : phone.detail, 399, 40, 23);
                if (phone.qr) cv.blit(phone.qr, 1220, 65);
            }
            if (panel === 4) {
                const entries = diag.entries().slice().reverse();
                entries.slice(logOffset, logOffset + 8).forEach((entry, i) =>
                    line(entry.time.slice(11, 19) + '  ' + entry.message, 80 + i * 38, 40, 22));
                line(confirmClear ? 'Press Select again to clear the log' :
                    'Next item pages the log. Select clears it. Export is available under Phone.', 412, 40, 22);
            }
            cv.fillRect(0, H - 80, W, 80, [7, 9, 19, 235]);
            line(panels[panel], H - 33, 40, 28, '#fff');
            line(label(player.id) + '  |  ' + MODE_NAMES[MODES.indexOf(library.state.playback.mode)], H - 33, 400, 24);
            if (notice || library.error) line(notice || library.error, H - 8, 400, 16, '#ffd4ad');
            try { await ui.image('MAIN_GFX', cv); }
            catch (e) { record('Preview frame could not be sent to HMI'); dirty = true; throw e; }
        }
        function setPanel(next) {
            panel = next; row = 0; logOffset = 0; confirmClear = false; notice = ''; dirty = true;
        }
        function nextRow() {
            if (panel === 3) return connect(phone.addresses.length > 1);
            if (panel === 4) {
                logOffset = logOffset + 8 >= diag.entries().length ? 0 : logOffset + 8;
                confirmClear = false;
            } else if (panel === 0) apply({ type: 'next' });
            else row = (row + 1) % (panel === 1 ? files().length : playRows().length);
            dirty = true;
        }
        function select() {
            const p = library.state.playback;
            try {
                if (panel === 0) apply({ type: 'playback', paused: !p.paused });
                if (panel === 1) {
                    const file = files()[row];
                    if (file) apply({ type: 'activate', id: file.id });
                }
                if (panel === 2) {
                    const groups = [null].concat(library.state.groups.map(g => g.id));
                    const times = [0, 5, 10, 15, 30];
                    const changes = [
                        { mode: MODES[(MODES.indexOf(p.mode) + 1) % MODES.length] },
                        { group: groups[(groups.indexOf(p.group) + 1) % groups.length] },
                        { seconds: times[(times.indexOf(p.seconds) + 1) % times.length] },
                        { paused: !p.paused }
                    ];
                    apply(row === 4 ? { type: 'next' } : Object.assign({ type: 'playback' }, changes[row]));
                }
                if (panel === 3 && upload.active && phone.ready && upload.phoneAt !== null) {
                    phone.export = !phone.export; refreshQr();
                } else if (panel === 3) return connect(false);
                if (panel === 4) {
                    if (confirmClear) { diag.clear(); logOffset = 0; }
                    confirmClear = !confirmClear;
                }
                notice = '';
            } catch (e) {
                notice = e.code ? 'Storage error (' + e.code + ')' : e.message;
                record('Local action failed: ' + notice);
            }
            dirty = true;
        }

        update();
        settings.onChange(key => {
            screenKey = ''; widgetIndex = Object.create(null);
            if (key === 'widgetBackground' || key === 'widgetTone') updateWidgetBackground();
        });
        ui.onClick('BTN_PAGE', () => setPanel((panel + 1) % panels.length));
        ui.onClick('BTN_PHONE', () => {
            if (panel !== 3 && phone.enabled && upload.active) return setPanel(3);
            if (panel !== 3) setPanel(3);
            if (!phone.enabled || !upload.active) return connect(false);
            return stopPhone();
        });
        ui.onClick('BTN_NEXT', nextRow);
        ui.onClick('BTN_SELECT', select);
        ui.onClick('BTN_DIAG', () => setPanel(4));
        ui.onVisible((name, visible) => { if (name === 'MAIN' && visible) dirty = true; });
        ctx.loop('MAIN', 4, render);
        setInterval(() => { checkBridge().catch(() => record('Network status check failed')); }, 2500);
        // The playlist advances even when neither preview nor widget is visible.
        setInterval(() => update(), 250);

        function updateWidgetBackground() {
            if (!ctx.widget) return;
            const enabled = !!settings.get('widgetBackground') && settings.get('widgetTone') !== 'neutral';
            ctx.widget.instances().forEach(inst => ctx.widget.set(inst.spawnId, 'background', enabled, 'Bool'));
        }
        if (ctx.widget) {
            ctx.widget.loop(() => Math.max(1, Math.min(6, Number(settings.get('widgetFps')) || 4)), widgetImage);
            ctx.widget.onChange(() => { widgetIndex = Object.create(null); updateWidgetBackground(); });
        }
    }
});

module.exports = { rectFor, qrLayer };
