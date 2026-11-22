'use strict';
/*
 * Lyrics in ID7's 1088x480 cluster map target. Exclusive mode covers the
 * map; Waze coexistence uses only a compact translucent non-exclusive footer.
 * No cluster gauges, warnings or vehicle controls are modified.
 */
const lrc = require('./lrc.js');
const font = require('./lyric_font.js');

const MAP_W = 1088, MAP_H = 480;
// The visually safe centre is narrower than the available map texture.
const MARGIN = 192, TEXT_W = MAP_W - 2 * MARGIN;
const HEAD = { y: 30, h: 40 }, CUR = { y: 140, h: 156 }, NEXT = { y: 338, h: 46 };
const LINE_GAP = 1.22;
const FULL_LAYOUT = {
    coexist: false, bg: { x: 0, y: 0, w: MAP_W, h: MAP_H },
    head: HEAD, cur: CUR, next: NEXT,
    headSizes: [26, 23, 20], curSizes: [56, 48, 40, 34], nextSizes: [30, 26, 22]
};
const WAZE_LAYOUT = {
    coexist: true, bg: { x: 152, y: 270, w: 784, h: 210 },
    head: { y: 277, h: 30 }, cur: { y: 310, h: 118 }, next: { y: 435, h: 34 },
    headSizes: [18, 16, 14], curSizes: [40, 34, 28, 24], nextSizes: [22, 20, 18]
};
function fontSizePct(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(50, Math.min(120, Math.round(n))) : 75;
}
function scaleSizes(sizes, pct) { return sizes.map(n => Math.max(12, Math.round(n * fontSizePct(pct) / 100))); }
const MIN_REDRAW_MS = 350;
const COLORS = { white: '#f4f7fa', green: '#3ddc84', amber: '#ffb347', blue: '#6cb8ff' };
const DIM = '#93a1b0', HEAD_COLOR = '#b8c4d0';

function backgroundPixels(coexist) {
    // 16x16, stretched bilinearly over the whole map window: a soft vertical gradient.
    const d = Buffer.alloc(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const i = (y * 16 + x) * 4, k = y / 15;
        d[i] = Math.round(13 - 7 * k); d[i + 1] = Math.round(19 - 9 * k); d[i + 2] = Math.round(27 - 12 * k); d[i + 3] = coexist ? Math.round(208 - 22 * k) : 255;
    }
    return d;
}
/** Current line(s), or a single music note when nothing synchronised is available. */
function renderCurrent(text, color, gap, pct, layout) {
    layout = layout || FULL_LAYOUT;
    pct = pct === undefined ? 100 : pct;
    const h = layout.cur.h, s = font.surface(TEXT_W, h);
    if (gap || !text) {
        const noteSize = Math.min(50, Math.round(48 * fontSizePct(pct) / 100));
        const baseline = h / 2 + noteSize * 0.33;
        font.draw(s, 'bold', '♪', TEXT_W / 2, baseline, noteSize, DIM, { align: 'center' });
        return { surface: s, rows: [Math.max(0, Math.floor(baseline - noteSize)),
            Math.min(h, Math.ceil(baseline + noteSize * 0.35))] };
    }
    const sizes = scaleSizes(layout.curSizes, pct);
    const fitted = lrc.fit(text, TEXT_W - 32, 2, sizes, (str, size) => font.measure('bold', str, size));
    const size = fitted.size, step = size * LINE_GAP, n = Math.max(1, fitted.lines.length);
    const block = (n - 1) * step + size;
    const first = (h - block) / 2 + size * 0.80;
    fitted.lines.forEach((line, i) => font.draw(s, 'bold', line, TEXT_W / 2, first + i * step, size, color, { align: 'center' }));
    return { surface: s, rows: [Math.max(0, Math.floor(first - size)),
        Math.min(h, Math.ceil(first + (n - 1) * step + size * 0.36))] };
}
function renderSingle(text, h, sizes, color, face, pct) {
    const s = font.surface(TEXT_W, h);
    if (text) {
        const allowed = pct === undefined ? sizes : scaleSizes(sizes, pct);
        const fitted = lrc.fit(text, TEXT_W - 32, 1, allowed, (str, size) => font.measure(face, str, size));
        if (fitted.lines.length)
            font.draw(s, face, fitted.lines[0], TEXT_W / 2, h * 0.72, fitted.size, color, { align: 'center' });
    }
    return s;
}
function headText(title, artist) {
    return artist ? title + '  \u2013  ' + artist : title;
}
/** Header: truncate a long title before removing the artist. */
function renderHead(title, artist, layout) {
    layout = layout || FULL_LAYOUT;
    const sizes = layout.headSizes, small = sizes[sizes.length - 1], max = TEXT_W - 32;
    let text = headText(title, artist);
    if (artist && font.measure('regular', text, small) > max) {
        const tail = '\u2026  \u2013  ' + artist;
        const room = max - font.measure('regular', tail, small);
        if (room > 90) {
            let cut = title;
            while (cut.length > 1 && font.measure('regular', cut, small) > room) cut = cut.slice(0, -1).trim();
            text = cut + tail;
        }
    }
    return renderSingle(text, layout.head.h, sizes, HEAD_COLOR, 'regular');
}

class KombiLyrics {
    constructor(log, options) {
        options = options || {};
        this.log = log || console;
        this.now = options.now || Date.now;
        const Client = options.ClusterRender || require('./cluster_render_client.js').ClusterRender;
        this.cr = new Client('cluster_lyrics', options.socketPath);
        this.trace = options.trace || (() => {});
        this.options = { accent: 'white', showNext: true, takeOverBmwMap: false, layoutMode: 'exclusive', fontSizePct: 75 };
        this.refs = null;            // { bg, head, cur, next }
        this.visible = false;
        this.wanted = null;          // content asked for by show()
        this.drawn = { head: null, cur: null, next: null, color: null };
        this.curRows = null;
        this.lastRedrawAt = 0;
        this.mapTarget = { state: 'idle', holder: '', reason: '' };
        this.layerStates = {};
        this.lastRefused = '';
        this.budget = '';
        this.uploadedBytes = 0;
        this.hideReason = 'not started';
        this.started = false;
        this.cr.on('ready', () => { this._trace('renderer ready backend=' + this.cr.backend + ' targets=' + this.cr.targets); this._apply(); });
        this.cr.on('disconnected', () => this._trace('renderer disconnected'));
        this.cr.on('layer', (ref, state, reason) => {
            const name = this._name(ref);
            if (!name) return;
            const text = state + (reason ? ' (' + reason + ')' : '');
            if (this.layerStates[name] !== text) { this.layerStates[name] = text; this._trace('layer ' + name + ': ' + text); }
        });
        this.cr.on('target', (target, state, holder, reason) => {
            if (target !== 'map') return;
            const next = { state: state || '', holder: holder || '', reason: reason || '' };
            if (next.state !== this.mapTarget.state || next.holder !== this.mapTarget.holder || next.reason !== this.mapTarget.reason)
                this._trace('map window: ' + next.state + (next.holder ? ' holder=' + next.holder : '') + (next.reason ? ' (' + next.reason + ')' : ''));
            this.mapTarget = next;
        });
        this.cr.on('refused', (op, ref, reason) => {
            this.lastRefused = String(op || '') + ': ' + String(reason || '');
            this._trace('renderer refused ' + this.lastRefused);
        });
        this.cr.on('budget', (cap, max, reason) => { this.budget = cap + '/' + max + ' KB/s' + (reason ? ' ' + reason : ''); });
    }
    _trace(message) { try { this.trace(message); } catch (_) {} }
    _name(ref) {
        if (!this.refs) return null;
        return Object.keys(this.refs).find(k => this.refs[k] === ref) || null;
    }
    start() { if (!this.started) { this.started = true; this.cr.connect(); } }
    close() { this.release('closing'); this.started = false; this.cr.close(); }

    /** The map window's size from the service's hello, or null. */
    mapSize() {
        const m = /(?:^|,)map:(\d+)x(\d+)/.exec(String(this.cr.targets || ''));
        return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
    }
    supported() {
        const size = this.mapSize();
        return !!this.cr.ready && !!size && size.w === MAP_W && size.h === MAP_H;
    }
    _layout() { return this.options.layoutMode === 'withWaze' ? WAZE_LAYOUT : FULL_LAYOUT; }
    _contend() { return !this._layout().coexist && !!this.options.takeOverBmwMap; }
    configure(options) {
        const before = this.options, beforeContend = this._contend();
        const next = Object.assign({}, before, options);
        next.layoutMode = next.layoutMode === 'withWaze' ? 'withWaze' : 'exclusive';
        next.fontSizePct = fontSizePct(next.fontSizePct);
        this.options = next;
        if (before.layoutMode !== next.layoutMode) {
            // Geometry and exclusivity are layer attributes: rebuild on changes.
            const wanted = this.wanted;
            this.release('layout changed');
            this.wanted = wanted;
        } else {
            if (this.refs && beforeContend !== this._contend())
                Object.keys(this.refs).forEach(k => this.cr.set(this.refs[k], { contend: this._contend() }));
            if (before.fontSizePct !== next.fontSizePct)
                this.drawn = { head: null, cur: null, next: null, color: null };
        }
        this._apply();
    }
    /** content: { title, artist, current, next, gap } */
    show(content) {
        this.wanted = content;
        this.hideReason = '';
        this._apply();
    }
    /** Hide the lyrics; the map window is given back. */
    hide(reason) {
        this.wanted = null;
        if (this.refs && this.visible) {
            Object.keys(this.refs).forEach(k => this.cr.set(this.refs[k], { visible: false }));
            this._trace('hidden: ' + (reason || 'no reason given'));
        }
        this.visible = false;
        if (reason) this.hideReason = reason;
    }
    /** Drop every layer: nothing of this app is left on the cluster. */
    release(reason) {
        this.hide(reason);
        if (this.refs) {
            Object.keys(this.refs).forEach(k => this.cr.drop(this.refs[k]));
            this._trace('layers dropped' + (reason ? ': ' + reason : ''));
        }
        this.refs = null; this.layerStates = {};
        this.drawn = { head: null, cur: null, next: null, color: null };
        this.curRows = null;
    }
    _make() {
        const layout = this._layout(), bg = layout.bg;
        const common = { target: 'map', klass: 'overlay', visible: false, guide_hold: false,
            contend: this._contend() };
        const image = (extra) => this.cr.image(Object.assign({}, common, extra));
        const refs = {
            bg: image({ x: bg.x, y: bg.y, w: bg.w, h: bg.h, z: 0,
                iw: 16, ih: 16, sampling: 'bilinear', exclusive: !layout.coexist }),
            head: image({ x: MARGIN, y: layout.head.y, w: TEXT_W, h: layout.head.h, z: 1 }),
            cur: image({ x: MARGIN, y: layout.cur.y, w: TEXT_W, h: layout.cur.h, z: 2 }),
            next: image({ x: MARGIN, y: layout.next.y, w: TEXT_W, h: layout.next.h, z: 3 })
        };
        if (!refs.bg || !refs.head || !refs.cur || !refs.next) {
            Object.keys(refs).forEach(k => { if (refs[k]) this.cr.drop(refs[k]); });
            this._trace('layers refused by the client');
            return false;
        }
        this.refs = refs;
        this.cr.pixels(refs.bg, null, backgroundPixels(layout.coexist));
        this._trace('layers created (' + (layout.coexist ? 'transparent Waze overlay' : 'exclusive map') + ')');
        return true;
    }
    _upload(ref, surface, rows) {
        let ok;
        if (rows) {
            const y0 = rows[0], y1 = rows[1];
            const px = surface.d.slice(y0 * surface.w * 4, y1 * surface.w * 4);
            ok = this.cr.pixels(ref, [{ x: 0, y: y0, w: surface.w, h: y1 - y0 }], px);
            if (ok) this.uploadedBytes += px.length;
        } else {
            ok = this.cr.pixels(ref, null, surface.d);
            if (ok) this.uploadedBytes += surface.d.length;
        }
        if (!ok) this._trace('pixel update refused by the client');
        return ok;
    }
    _apply() {
        const c = this.wanted;
        if (!c || !this.started) return;
        if (!this.supported()) {
            if (this.cr.ready && this.hideReason !== 'unsupported map window') {
                this.hideReason = 'unsupported map window';
                this._trace('not shown: map window is ' + JSON.stringify(this.mapSize()) + ', expected 1088x480');
            }
            return;
        }
        if (!this.refs && !this._make()) return;
        const layout = this._layout(), pct = this.options.fontSizePct;
        const color = COLORS[this.options.accent] || COLORS.white;
        const onlyNote = !!c.noteOnly;
        const head = onlyNote ? '' : headText(c.title || '', c.artist || '');
        const next = onlyNote ? '' : (this.options.showNext ? (c.next || '') : '');
        const cur = onlyNote ? '\u0000note' : (c.gap ? '\u0000gap' : (c.current || ''));
        const first = !this.visible, now = this.now();
        if (!first && now - this.lastRedrawAt < MIN_REDRAW_MS && head === this.drawn.head) return;
        let changed = false;
        if (head !== this.drawn.head) {
            this._upload(this.refs.head, renderHead(onlyNote ? '' : (c.title || ''), onlyNote ? '' : (c.artist || ''), layout));
            this.drawn.head = head; changed = true;
        }
        if (cur !== this.drawn.cur || color !== this.drawn.color) {
            const r = renderCurrent(c.current || '', color, onlyNote || !!c.gap, pct, layout);
            const rows = this.curRows ? [Math.min(this.curRows[0], r.rows[0]), Math.max(this.curRows[1], r.rows[1])] : null;
            this._upload(this.refs.cur, r.surface, rows);
            this.curRows = r.rows; this.drawn.cur = cur; this.drawn.color = color; changed = true;
        }
        if (next !== this.drawn.next) {
            this._upload(this.refs.next, renderSingle(next, layout.next.h, layout.nextSizes, DIM, 'regular', pct));
            this.drawn.next = next; changed = true;
        }
        if (changed) this.lastRedrawAt = now;
        if (first) {
            Object.keys(this.refs).forEach(k => this.cr.set(this.refs[k], { visible: true }));
            this.visible = true;
            this._trace('visibility requested (mode=' + this.options.layoutMode + ', takeOverBmwMap=' + this._contend() + ')');
        }
    }
    status() {
        return { ready: !!this.cr.ready, backend: this.cr.backend || '', mapSize: this.mapSize(), supported: this.supported(),
            visible: this.visible, layers: !!this.refs, map: this.mapTarget, layerStates: this.layerStates,
            lastRefused: this.lastRefused, budget: this.budget, uploadedKb: Math.round(this.uploadedBytes / 1024),
            hideReason: this.hideReason, layoutMode: this.options.layoutMode, fontSizePct: this.options.fontSizePct };
    }
}

module.exports = { KombiLyrics, renderCurrent, renderSingle, renderHead, headText, backgroundPixels,
    MAP_W, MAP_H, MARGIN, TEXT_W, HEAD, CUR, NEXT, FULL_LAYOUT, WAZE_LAYOUT, COLORS };
