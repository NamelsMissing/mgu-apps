'use strict';
/** GIF Home - offline animated GIF in BMW iDrive 7's home-screen start widget. */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { Canvas } = require('./kit/canvas');
const { setImage, makeLayer, dropLayer } = require('./kit/record');
const { open } = require('./kit/pack');
const { decode, LIMIT } = require('./gif');
const qrcode = require('./qr_vendor');
const { GifUploadServer, localAddresses } = require('./upload');
const { compensateWidget } = require('./widget_tone');

const PREVIEW_W = 1600, PREVIEW_H = 520;
const PIXEL_IMAGE = 23401; // unique within this app's renderer process
const PRESETS = [
    ['demo', 'Animated BMW logo', 'demo.json'],
    ['drift', 'Pixel drift: Night City', 'drift_city.json'],
    ['sunset', 'Pixel drive: Sunset', 'sunset_drive.json'],
    ['garage', 'Pixel art: Neon Garage', 'garage_nights.json'],
    ['tunnel', 'Pixel art: Midnight Run', 'tunnel_run.json'],
];
const SOURCES = ['auto', 'demo', 'drift', 'sunset', 'garage', 'tunnel', 'custom'];

/** The same fit logic works for the stock Canvas and the GPU Recorder. */
function rectFor(srcW, srcH, x, y, w, h, mode) {
    const scale = mode === 'contain' ? Math.min(w / srcW, h / srcH) : Math.max(w / srcW, h / srcH);
    const dw = Math.round(srcW * scale), dh = Math.round(srcH * scale);
    return { x: Math.round(x + (w - dw) / 2), y: Math.round(y + (h - dh) / 2), w: dw, h: dh };
}

mgu.run({
    async start(ctx) {
        const ui = ctx.ui, settings = ctx.settings, log = ctx.log;
        const customFile = path.join(ctx.dataDir, 'custom.gif');
        const state = { custom: null, builtins: Object.create(null), active: null, name: '', problem: '',
            demoError: '', help: false,
            start: Date.now(), pauseAt: null, screenIndex: -1, screenDirty: true,
            widgetIndex: Object.create(null), phone: {
                enabled: false, addresses: [], addressIndex: 0, status: '', link: '', layer: null
            } };

        function resetClock() {
            state.start = Date.now(); state.pauseAt = null; state.screenIndex = -1;
            state.screenDirty = true; state.widgetIndex = Object.create(null);
        }
        function loadPreset(id) {
            if (state.builtins[id]) return state.builtins[id];
            const preset = PRESETS.find((item) => item[0] === id);
            if (!preset) return null;
            try {
                const data = open(path.join(__dirname, 'resources')).json(preset[2]);
                const base64 = data && data.base64;
                if (!base64) throw new Error(preset[2] + ' missing');
                state.builtins[id] = decode(Buffer.from(base64, 'base64'));
                state.demoError = '';
                log.info('Built-in GIF loaded: ' + id + ', ' + state.builtins[id].frames.length + ' frames');
                return state.builtins[id];
            } catch (e) {
                state.demoError = e.message || String(e);
                log.warn('Built-in GIF failed (' + id + '): ' + state.demoError);
                return null;
            }
        }
        function loadCustom() {
            try {
                if (!fs.existsSync(customFile)) { state.custom = null; return 'No custom.gif installed'; }
                const stat = fs.statSync(customFile);
                if (!stat.isFile() || stat.size > LIMIT.bytes) throw new Error('File is not a GIF or exceeds 6 MB');
                // Decode the new GIF fully before replacing the working one.
                state.custom = decode(fs.readFileSync(customFile));
                return '';
            } catch (e) {
                state.custom = null;
                log.warn('Custom GIF: ' + e.message);
                return e.message;
            }
        }
        function selectActive() {
            const source = settings.get('source') || 'auto';
            const preset = PRESETS.find((item) => item[0] === source);
            // Old custom/auto choices still work, while all new presets are offline.
            // When a file fails to load, retain the BMW logo as a visible fallback.
            state.active = preset ? loadPreset(source) : state.custom;
            if (!state.active) state.active = loadPreset('demo');
            state.name = !state.active ? 'No GIF' : state.active === state.custom ? 'custom.gif' :
                preset && state.active === state.builtins[source] ? preset[1] : 'Animated BMW logo';
            state.problem = !state.active ? ('Built-in GIF unavailable: ' + (state.demoError || 'resource missing')) :
                source === 'custom' && !state.custom ? 'Custom GIF missing - playing built-in demo' : '';
            resetClock();
        }
        function reload() {
            const err = loadCustom();
            selectActive(err);
            if (err && settings.get('source') === 'custom') log.warn('GIF not loaded: ' + err);
        }

        function storeUploadedGif(bytes) {
            // Validate and decode before touching the last working custom GIF.
            const parsed = decode(bytes);
            const temp = customFile + '.upload.tmp';
            try {
                fs.writeFileSync(temp, bytes, { mode: 0o600 });
                fs.renameSync(temp, customFile);
            } catch (e) {
                try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
                throw e;
            }
            state.custom = parsed;
            state.phone.enabled = false;
            state.phone.status = 'New GIF uploaded successfully';
            clearQr();
            if (settings.get('source') !== 'auto') settings.set('source', 'auto');
            else selectActive('');
            log.info('GIF installed from phone (' + bytes.length + ' bytes, ' + parsed.frames.length + ' frames)');
        }

        const upload = new GifUploadServer({ port: 18883, onUpload: storeUploadedGif, log });
        function clearQr() {
            if (state.phone.layer) dropLayer(state.phone.layer);
            state.phone.layer = null; state.phone.link = '';
            state.screenDirty = true;
        }
        function buildQr(link) {
            clearQr();
            if (!link) return;
            const code = qrcode(0, 'M');
            code.addData(link); code.make();
            const n = code.getModuleCount(), margin = 4;
            const step = Math.max(1, Math.floor(312 / (n + margin * 2)));
            const actual = (n + margin * 2) * step;
            const off = Math.floor((320 - actual) / 2) + margin * step;
            state.phone.layer = makeLayer(320, 320, (r) => {
                r.fillRect(0, 0, 320, 320, '#ffffff');
                for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
                    if (code.isDark(y, x)) r.fillRect(off + x * step, off + y * step, step, step, '#111318');
                }
            });
            state.phone.link = link;
        }
        function address() { return state.phone.addresses[state.phone.addressIndex]; }
        function refreshQr() {
            const a = address();
            if (!a) { clearQr(); state.phone.status = 'No reachable IPv4 address found'; return; }
            try {
                buildQr(upload.link(a.ip));
                state.phone.status = 'Scan with your phone camera';
            } catch (e) { clearQr(); state.phone.status = 'QR error: ' + e.message; }
        }
        async function togglePhone() {
            if (state.phone.enabled) {
                state.phone.enabled = false; upload.end(); clearQr();
                state.phone.status = 'Phone upload stopped';
                return;
            }
            try {
                await upload.start();
                state.phone.addresses = localAddresses();
                state.phone.addressIndex = 0;
                upload.begin();
                state.phone.enabled = true;
                refreshQr();
            } catch (e) {
                state.phone.status = 'Upload server unavailable: ' + e.message;
                log.warn(state.phone.status); clearQr();
            }
        }
        function nextIp() {
            if (!state.phone.enabled) { state.phone.status = 'Select Phone upload first'; state.screenDirty = true; return; }
            const p = state.phone;
            p.addresses = localAddresses();
            if (!p.addresses.length) { refreshQr(); return; }
            p.addressIndex = (p.addressIndex + 1) % p.addresses.length;
            refreshQr();
        }

        function frameIndex(now) {
            const gif = state.active;
            if (!gif) return -1;
            if (settings.get('pause')) {
                if (state.pauseAt === null) state.pauseAt = now;
                now = state.pauseAt;
            } else if (state.pauseAt !== null) {
                state.start += now - state.pauseAt;
                state.pauseAt = null;
            }
            const speed = settings.get('speed') === 'slow' ? 0.5 : settings.get('speed') === 'fast' ? 1.5 : 1;
            let t = Math.max(0, (now - state.start) * speed) % gif.duration;
            for (let i = 0; i < gif.frames.length; i++) {
                if (t < gif.frames[i].delay) return i;
                t -= gif.frames[i].delay;
            }
            return 0;
        }

        /** Transparent source pixels appear over the dark widget background. */
        function widgetImage(inst) {
            const key = String(inst.spawnId);
            if (!inst.big) {
                // BMW's Drive Recorder layout doesn't show images in narrow widgets.
                if (state.widgetIndex[key] !== 'small') {
                    ctx.widget.set(inst.spawnId, 'Title', 'GIF Home', 'Text');
                    ctx.widget.set(inst.spawnId, 'TextRecordings', state.name, 'Text', true);
                    ctx.widget.set(inst.spawnId, 'TextCam', 'Tap to open', 'Text');
                    state.widgetIndex[key] = 'small';
                }
                return null;
            }
            if (!inst.visible) return null;
            const idx = frameIndex(Date.now());
            if (state.widgetIndex[key] === idx) return null;
            state.widgetIndex[key] = idx;
            const sw = ctx.spec.startWidget || {}, dims = sw.size || [384, 256];
            const cv = new Canvas(dims[0], dims[1]).clear('#080911');
            if (idx >= 0) {
                const gif = state.active, f = gif.frames[idx];
                const r = rectFor(gif.width, gif.height, 0, 0, dims[0], dims[1], settings.get('fit'));
                cv.drawImage(f.data, gif.width, gif.height, r.x, r.y, r.w, r.h);
            } else {
                cv.text('NO GIF', dims[0] / 2, dims[1] / 2 - 4, 28, '#ffffff', { align: 'center', font: 'bold' });
                cv.text('Open GIF Home to reload', dims[0] / 2, dims[1] / 2 + 28, 17, '#a4a9bb', { align: 'center' });
            }
            // Native Drive Recorder widgets often dim/fade the image at the
            // edges. Pre-compensate here only, never in the actual GIF asset.
            return compensateWidget(cv, settings.get('widgetTone') || 'balanced');
        }

        async function renderScreen() {
            if (state.phone.enabled && !upload.link((address() || {}).ip)) {
                state.phone.enabled = false; clearQr(); state.phone.status = 'QR session expired — select Phone upload again';
            }
            const idx = frameIndex(Date.now());
            if (idx === state.screenIndex && !state.screenDirty) return;
            state.screenIndex = idx; state.screenDirty = false;
            const cv = ctx.canvas(PREVIEW_W, PREVIEW_H).clear('#090b13');
            if (idx >= 0) {
                const gif = state.active, f = gif.frames[idx];
                setImage(PIXEL_IMAGE, gif.width, gif.height, f.data);
                const contentW = state.phone.enabled ? 1040 : PREVIEW_W;
                const r = rectFor(gif.width, gif.height, 0, 0, contentW, PREVIEW_H, settings.get('fit'));
                cv.image(PIXEL_IMAGE, r.x, r.y, r.w, r.h);
            } else {
                cv.text('No GIF available', PREVIEW_W / 2, 210, 56, '#f4f6ff', { align: 'center', font: 'bold' });
                cv.text(('Built-in demo failed: ' + (state.demoError || 'unknown cause')).slice(0, 90),
                    PREVIEW_W / 2, 280, 25, '#ffb0a5', { align: 'center' });
                cv.text('Press Reload GIF or scan the Phone upload QR code',
                    PREVIEW_W / 2, 330, 25, '#aab1c4', { align: 'center' });
            }
            if (state.phone.enabled) {
                cv.fillRect(1040, 0, 560, PREVIEW_H - 80, '#0b1221');
                if (state.phone.layer) {
                    cv.blit(state.phone.layer, 1160, 42);
                    const a = address();
                    cv.text(a ? a.ip + ':' + upload.port : 'NO IP', 1320, 389, 25, '#c7daf7', { align: 'center', font: 'bold' });
                    cv.text('Phone upload  /  ' + (state.phone.addressIndex + 1) + ' of ' + state.phone.addresses.length,
                        1320, 425, 22, '#99afce', { align: 'center' });
                } else {
                    cv.text(state.phone.status, 1320, 210, 25, '#ffb0a5', { align: 'center' });
                }
            }
            if (state.help && !state.phone.enabled) {
                cv.fillRect(760, 18, 814, 402, [6, 15, 30, 245]);
                cv.text('ADD GIF HOME TO THE BMW HOME SCREEN', 798, 70, 27, '#f4f8ff', { font: 'bold' });
                cv.text('1. Open the iDrive HOME/main menu.', 798, 132, 26, '#d5e7ff');
                cv.text('2. Tilt the iDrive controller UP.', 798, 190, 26, '#d5e7ff');
                cv.text('3. Choose Customize main menu.', 798, 248, 26, '#d5e7ff');
                cv.text('4. Press + and choose GIF Home.', 798, 306, 26, '#d5e7ff');
                cv.text('5. Choose the large tile, then Done.', 798, 364, 26, '#d5e7ff');
            }
            cv.fillRect(0, PREVIEW_H - 80, PREVIEW_W, 80, [7, 9, 19, 235]);
            cv.text('GIF HOME', 40, PREVIEW_H - 35, 28, '#f5f8ff', { font: 'bold' });
            cv.text(state.phone.enabled ? state.phone.status : state.phone.status ||
                (state.name + (state.active ? '  |  ' + state.active.width + ' x ' + state.active.height +
                '  |  ' + state.active.frames.length + ' frames' : '')), 330, PREVIEW_H - 35, 24, '#bac7df');
            if (state.problem) cv.text(state.problem.slice(0, 60), PREVIEW_W - 34, PREVIEW_H - 35, 22, '#ff7272', { align: 'right' });
            await ui.image('MAIN_GFX', cv);
        }

        loadPreset('demo');
        reload();
        settings.onChange((key) => {
            if (key === 'source') selectActive('No custom.gif installed or GIF failed to decode');
            if (key === 'speed' || key === 'fit' || key === 'widgetFps' || key === 'widgetTone') resetClock();
            if (key === 'widgetBackground') {
                state.widgetIndex = Object.create(null);
                updateWidgetBackground();
            }
        });
        ui.onClick('BTN_SOURCE', () => {
            const current = settings.get('source') || 'auto';
            settings.set('source', SOURCES[(SOURCES.indexOf(current) + 1) % SOURCES.length]);
        });
        ui.onClick('BTN_PHONE', togglePhone);
        ui.onClick('BTN_NEXT', nextIp);
        ui.onClick('BTN_RELOAD', () => { state.builtins = Object.create(null); loadPreset('demo'); reload(); state.phone.status = 'GIF reloaded'; });
        ui.onClick('BTN_HELP', () => { state.help = !state.help; state.screenDirty = true; });
        ui.onVisible((name, visible) => { if (name === 'MAIN' && visible) state.screenDirty = true; });
        // The native BMW HMI image path is the default. It works without
        // mgu-renderd and avoids requiring a GPU overlay for the GIF preview.
        ctx.loop('MAIN', 4, renderScreen);
        function updateWidgetBackground() {
            if (!ctx.widget) return;
            const enabled = !!settings.get('widgetBackground');
            ctx.widget.instances().forEach((inst) => {
                ctx.widget.set(inst.spawnId, 'background', enabled, 'Bool');
            });
        }
        if (ctx.widget) {
            ctx.widget.loop(() => settings.get('widgetFps') || 4, widgetImage);
            ctx.widget.onChange(() => {
                state.widgetIndex = Object.create(null);
                updateWidgetBackground();
            });
        }
        log.info('GIF Home ready; custom GIF: ' + customFile);
    },
});

module.exports = { rectFor };
