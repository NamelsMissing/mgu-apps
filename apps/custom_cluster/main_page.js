'use strict';
/**
 * Centre-screen main page (0.7.1): a to-scale live miniature of the KOMBI
 * (selected layout, live values, colour, map window, intro/sweep state) and
 * status cards beside it. Centre screen only: nothing here reaches the
 * cluster. Faces are resampled once per layout/colour and cached; per frame
 * only the readouts and bands are redrawn (the page refreshes at 2 Hz).
 */
const L = require('./layout_panels.js');
const D = require('./sixwb_dials.js');
const { PANEL_TEST_MS } = require('./cluster_layers.js');

const KW = 1920, KH = 720;
const MINI = { x: 24, y: 52, w: 1056, h: 396 };        // 1920x720 at 0.55
const S = MINI.w / KW;
const NAMES = { stock: 'BMW original', sixwb: 'BMW 6WB', oem: 'G21 OEM-style', g80: 'G80-inspired',
    sport: 'M Sport', classic: 'Classic', minimal: 'Minimal digital' };
const GREEN = '#2fd27a', MAGENTA = '#ff4fc3';

/** Area-averaged, alpha-correct downscale of RGBA pixels into a new Canvas. */
function resample(Canvas, src, sw, sh, dw, dh) {
    dw = Math.max(1, Math.round(dw)); dh = Math.max(1, Math.round(dh));
    const out = new Canvas(dw, dh), d = out.d, fx = sw / dw, fy = sh / dh;
    for (let y = 0; y < dh; y++) {
        const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
        for (let x = 0; x < dw; x++) {
            const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
            let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let sy = y0; sy < y1 && sy < sh; sy++) for (let sx = x0; sx < x1 && sx < sw; sx++) {
                const i = (sy * sw + sx) * 4, al = src[i + 3];
                r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; n++;
            }
            const o = (y * dw + x) * 4;
            if (a > 0) { d[o] = r / a; d[o + 1] = g / a; d[o + 2] = b / a; d[o + 3] = a / n; }
        }
    }
    return out;
}

let faceCache = null;
function cachedFaces(Canvas, layout, accentHex, theme) {
    const key = layout + '|' + accentHex + '|' + theme;
    if (faceCache && faceCache.key === key && faceCache.Canvas === Canvas) return faceCache.faces;
    let faces;
    if (layout === 'sixwb') faces = D.POSITIONS.map(pos => resample(Canvas, D.face(pos, accentHex, theme, Canvas),
        D.SIZE, D.SIZE, D.DRAW_SIZE * S, D.DRAW_SIZE * S));
    else faces = L.SIDES.map(side => resample(Canvas, L.face(layout, side, accentHex, Canvas).d, L.SIZE, L.SIZE, L.DRAW * S, L.DRAW * S));
    faceCache = { key, Canvas, faces };
    return faces;
}
const kx = (x) => MINI.x + x * S, ky = (y) => MINI.y + y * S;

function drawMiniature(cv, t, m, Canvas) {
    const { st, layout, accentHex } = m;
    cv.roundRect(MINI.x - 6, MINI.y - 6, MINI.w + 12, MINI.h + 12, 22, '#1a2029');
    cv.roundRect(MINI.x, MINI.y, MINI.w, MINI.h, 18, '#000000');
    // BMW's own map window (Waze / map / lyrics live here) and bottom strip.
    cv.gradientRect(kx(416), ky(0) + 6, 1088 * S, 600 * S - 6, [[0, '#1b2b3a'], [1, '#0b131a']]);
    for (let i = 1; i < 6; i++) cv.fillRect(kx(416), ky(i * 100), 1088 * S, 1, '#ffffff10');
    cv.text(m.centreLabel, kx(960), ky(300) - 4, 19, '#8fa9bf', { align: 'center', literal: true });
    cv.text(m.wazeLine, kx(960), ky(300) + 22, 15, '#5f7486', { align: 'center', literal: true });
    cv.fillRect(MINI.x + 12, ky(604), MINI.w - 24, 1, '#ffffff18');
    cv.text('BMW bottom strip', kx(960), ky(668), 14, '#3f4a55', { align: 'center', literal: true });
    if (layout === 'stock') {
        cv.text('BMW original instruments', kx(212), ky(330), 18, '#5f6c78', { align: 'center', literal: true });
        cv.text('BMW original instruments', kx(1708), ky(330), 18, '#5f6c78', { align: 'center', literal: true });
        return;
    }
    // Cover plates with the accent light edge that frames the map window.
    L.COVERS.forEach(c => {
        cv.roundRect(kx(c.x), ky(c.y), c.w * S, c.h * S, 14, '#0a1018');
        const ex = c.inner === 'right' ? kx(c.x + c.w) - 3 : kx(c.x) + 1;
        cv.gradientRect(ex, ky(c.y + 70), 2, (c.h - 140) * S, [[0, accentHex + '00'], [0.5, accentHex + 'b0'], [1, accentHex + '00']]);
    });
    if (m.st.introPlaying) {
        // Mirrors what the KOMBI shows: the intro covers sides and centre.
        cv.gradientRect(MINI.x + 4, ky(48), MINI.w - 8, 548 * S, [[0, '#190634'], [0.55, '#6a1a62'], [1, '#ff7a4a']]);
        cv.text('START-UP INTRO', kx(960), ky(300), 26, '#ffe6f6', { align: 'center', font: 'bold', spacing: 2, literal: true });
        cv.text('layout and needle sweep follow', kx(960), ky(300) + 28, 16, '#f0b9dc', { align: 'center', literal: true });
        return;
    }
    const faces = cachedFaces(Canvas, layout, accentHex, m.sixwbTheme);
    if (layout === 'sixwb') {
        D.POSITIONS.forEach((pos, i) => {
            const x = kx(pos.x), y = ky(pos.y), size = D.DRAW_SIZE * S, cx = x + size / 2, cy = y + size / 2;
            cv.blit(faces[i], x, y);
            const v = m.data[pos.key], f = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v / pos.max)) : 0;
            const a = (-145 + 290 * f) * Math.PI / 180, r = size * 0.42;
            cv.line(cx, cy, cx + Math.sin(a) * r, cy - Math.cos(a) * r, 3, accentHex);
            cv.circle(cx, cy, 6, '#1b222c');
        });
        return;
    }
    L.SIDES.forEach((side, i) => {
        const x = kx(side.x), y = ky(side.y), size = L.DRAW * S;
        cv.blit(faces[i], x, y);
        const v = m.data[side.key];
        if (typeof v === 'number' && Number.isFinite(v))
            L.drawProgress(cv, layout, side, L.fraction(layout, side, v), x, y, size / L.U, accentHex);
        const r = L.readout(side, m.data, accentHex, Canvas), b = { dx: 90, dy: 118, w: 204, h: 122 };
        cv.blit(resample(Canvas, r.d, L.READ_W, L.READ_H, b.w * S, b.h * S), x + b.dx * S, y + b.dy * S);
    });
}

function pill(cv, x, y, text, color) {
    const w = cv.textWidth(text, 16, { font: 'bold' }) + 26;
    cv.roundRect(x - w, y, w, 28, 14, color + '30');
    cv.text(text, x - w / 2, y + 20, 16, color, { align: 'center', font: 'bold', literal: true });
}
function card(cv, t, x, y, w, h, title) {
    cv.roundRect(x, y, w, h, 14, t.panelEdge || '#242c39');
    cv.roundRect(x + 1, y + 1, w - 2, h - 2, 13, t.panelBottom || '#0a0d13');
    cv.text(title, x + 18, y + 27, 15, t.dim, { font: 'bold', spacing: 1.2 });
}
function row(cv, t, x, y, label, value, color) {
    cv.text(label, x, y, 18, t.dim);
    cv.text(String(value), x + 440, y, 18, color || t.text, { align: 'right' });
}

/**
 * m = { st (ClusterLayers.status()), layout, accentHex, data {speed,rpm,stage,gear,oil,coolant},
 *       waze, driveMode, intro, testNotice, sixwbTheme }
 */
function renderMainPage(cv, t, G, m, Canvas) {
    const st = m.st;
    G.frame(cv, t, ['Custom Cluster'], 0, [{ text: st.ready ? 'RENDERER READY' : 'RENDERER OFFLINE' }]);
    const intro = st.introPlaying, inKombi = st.panelActive;
    m.centreLabel = intro ? 'Start-up intro playing' : 'Waze / BMW map / Lyrics';
    m.wazeLine = m.waze || '';
    drawMiniature(cv, t, m, Canvas);
    cv.text((NAMES[m.layout] || m.layout || 'Unknown').toUpperCase(), MINI.x + 22, MINI.y + 30, 17, '#c9d4de', { font: 'bold', spacing: 1.3, literal: true });
    pill(cv, MINI.x + MINI.w - 14, MINI.y + 10, intro ? 'INTRO' : inKombi ? 'IN KOMBI' : 'PREVIEW',
        intro ? MAGENTA : inKombi ? GREEN : '#8a95a6');

    // Card 1: may the KOMBI show it right now?
    const X = 1100, W = 476;
    card(cv, t, X, 52, W, 150, 'KOMBI SAFE');
    cv.text(st.parked ? 'Ready' : 'Not now', X + 18, 114, 32, st.parked ? GREEN : t.warn, { font: 'bold' });
    cv.text(String(st.testGuard || '').replace(/^Ready: /, '').slice(0, 44), X + 18, 140, 16, t.dim);
    const speed = st.speedKmh == null ? '-' : Math.round(st.speedKmh) + ' km/h';
    const rpm = st.engineRpm == null ? '-' : Math.round(st.engineRpm) + ' rpm';
    cv.text('Selector ' + (st.gearLabel || st.gearPosition || '?') + '   ·   ' + speed + '   ·   ' + rpm, X + 18, 168, 18, t.text);
    cv.text('Data ' + (st.sampleAgeSeconds == null ? 'none yet' : st.sampleAgeSeconds + ' s old'), X + 18, 192, 15,
        st.live ? t.dim : t.warn);

    // Card 2: what the KOMBI is doing.
    card(cv, t, X, 214, W, 108, 'KOMBI STATUS');
    let line = m.testNotice, color = t.text;
    if (intro) { line = 'Start-up intro, then layout'; color = MAGENTA; }
    else if (inKombi && st.autoRun) { line = 'Shown automatically while parked'; color = GREEN; }
    else if (inKombi) { line = 'Test active · ' + st.secondsLeft + ' s left'; color = GREEN; }
    else if (st.autoMode === 'parked') line = 'Automatic: ' + String(st.autoReason || 'waiting for P');
    cv.text(String(line).slice(0, 42), X + 18, 266, 21, color, { font: inKombi ? 'bold' : undefined });
    if (inKombi && !st.autoRun && !intro) {
        cv.roundRect(X + 18, 286, W - 36, 8, 4, '#1b222c');
        cv.roundRect(X + 18, 286, Math.max(8, (W - 36) * Math.min(1, st.secondsLeft * 1000 / PANEL_TEST_MS)), 8, 4, GREEN);
    } else cv.text('Last: ' + String(st.disarmReason || '-').slice(0, 50), X + 18, 302, 15, t.dim);

    // Card 3: look & behaviour.
    card(cv, t, X, 334, W, 124, 'INSTRUMENTS');
    cv.text('Colour', X + 18, 388, 18, t.dim);
    cv.text(m.accentHex.toUpperCase(), X + W - 76, 388, 18, t.text, { align: 'right', literal: true });
    cv.roundRect(X + W - 64, 372, 46, 20, 8, m.accentHex);
    row(cv, t, X + 18, 415, 'Driving mode', m.driveMode);
    row(cv, t, X + 18, 442, 'Intro · sweep', m.intro);

    cv.text('Renderer ' + (st.ready ? 'connected' : 'offline') + '  ·  slot ' + String(st.panelTargetState || '-').slice(0, 30),
        MINI.x, 490, 16, st.ready ? t.dim : t.warn);
    cv.text('Parked only (P, stopped, fresh data). BMW indicators stay visible.', X + W, 490, 16, t.warn, { align: 'right' });
    return cv;
}
module.exports = { renderMainPage, resample, MINI, NAMES };
