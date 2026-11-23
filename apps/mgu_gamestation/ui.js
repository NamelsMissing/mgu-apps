'use strict';

// Everything GameStation draws on the centre display. Pure drawing from a view model:
// main.js decides, this file only paints and registers the touch / controller targets.
// The kit's header carries the page tabs (G.frame) and a PARKED badge; colours come from
// the theme chosen in Settings. Targets are registered left to right, top to bottom:
// that is the order the iDrive knob walks them where the kit runs the screen.
const qrcode = require('./qr_vendor');
const {platforms: PLATFORMS} = require('./core_registry');

const W = 1600, H = 520;
const TABS = ['Games', 'Playing', 'Controllers', 'Diagnostics'];
const PAGE = {GAMES: 0, PLAY: 1, PADS: 2, DIAG: 3};
const TOP = 52, EDGE = 24, FOOT_Y = 452, FOOT_H = 52;
const LIST_COLS = 2, LIST_ROWS = 3, PAGE_SIZE = LIST_COLS * LIST_ROWS;
const IMAGE = 71;
// The game picture: between the two side panels, full page height.
const SIDE = 300, STAGE = {x: EDGE + SIDE + 16, y: TOP, w: W - 2 * (EDGE + SIDE + 16), h: H - TOP - 12};
const MODES = {idrive: 'iDrive P1 · CPU P2', phone: 'Phone P1 · CPU P2', phones: 'Two phones', hybrid: 'iDrive P1 · Phone P2'};

const FOLD = {'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss',
    '‘': "'", '’': "'", '“': '"', '”': '"', '„': '"', '–': '-', '—': '-', '…': '...'};
/** The baked fonts hold ASCII (and a few symbols): fold umlauts and accents instead of printing '?'. */
function ascii(value) {
    let s = String(value === undefined || value === null ? '' : value).replace(/[ÄÖÜäöüß‘’“”„–—…]/g, c => FOLD[c] || c);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) { /* Node without ICU */ }
    return s.replace(/[^\x20-\x7e·]/g, '?').replace(/\s+/g, ' ').trim();
}
function megabytes(bytes) {
    const n = Number(bytes) || 0;
    return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}
/** Largest rectangle of aspect w:h inside the box, centred. */
function fitRect(box, w, h, scale, deviceScale) {
    const fit = Math.min(box.w / w, box.h / h);
    const device = deviceScale || 1;
    let k = fit;
    if (scale === 'crop') k = Math.max(box.w / w, box.h / h);
    if (scale === 'integer' && fit * device >= 1) k = Math.floor(fit * device) / device;
    const rw = scale === 'stretch' ? box.w : Math.floor(w * k * device + 1e-7) / device;
    const rh = scale === 'stretch' ? box.h : Math.floor(h * k * device + 1e-7) / device;
    return {x: Math.round((box.x + (box.w - rw) / 2) * device) / device,
        y: Math.round((box.y + (box.h - rh) / 2) * device) / device, w: rw, h: rh};
}

function makeUi(G, colors) {
    const withAlpha = colors.withAlpha, rgba = colors.rgba;
    const LIT = {literal: true};
    function inkOn(c) {
        const v = rgba(c);
        return (v[0] * 299 + v[1] * 587 + v[2] * 114) / 1000 > 150 ? '#05070a' : '#ffffff';
    }
    function fit(cv, value, size, width, opts) {
        const o = Object.assign({}, opts || {}, LIT);
        let s = ascii(value);
        if (cv.textWidth(s, size, o) <= width) return s;
        while (s.length > 1 && cv.textWidth(s + '...', size, o) > width) s = s.slice(0, -1);
        return s.trim() + '...';
    }
    function label(cv, value, x, y, size, color, width, opts) {
        const o = Object.assign({}, opts || {}, LIT);
        cv.text(width ? fit(cv, value, size, width, opts) : ascii(value), x, y, size, color, o);
    }
    function paragraph(cv, value, x, y, size, color, width, lines, opts) {
        const words = ascii(value).split(' '), o = Object.assign({}, opts || {}, LIT), out = [];
        let line = '';
        words.forEach(word => {
            const next = line ? line + ' ' + word : word;
            if (cv.textWidth(next, size, o) <= width || !line) line = next;
            else { out.push(line); line = word; }
        });
        if (line) out.push(line);
        out.slice(0, lines).forEach((s, i) => {
            const last = i === lines - 1 && out.length > lines;
            cv.text(fit(cv, last ? s + ' ...' : s, size, width, opts), x, y + i * size * 1.3, size, color, o);
        });
        return y + Math.min(lines, out.length) * size * 1.3;
    }
    /** A pill button in the kit's style, always drawn (opts: primary, color, off, danger). */
    function button(cv, t, x, y, w, h, text, run, key, opts) {
        const o = opts || {}, S = o.color || t.sel || t.accent;
        if (o.primary && !o.off) cv.roundRect(x, y, w, h, h / 2, withAlpha(S, 0.92));
        else {
            cv.roundRect(x, y, w, h, h / 2, withAlpha('#ffffff', o.off ? 0.03 : 0.07));
            cv.strokeRoundRect(x, y, w, h, h / 2, 1.5, withAlpha(o.color || '#ffffff', o.off ? 0.12 : o.color ? 0.75 : 0.3));
        }
        cv.text(fit(cv, String(text).toUpperCase(), Math.min(22, h * 0.4), w - h * 0.6, {font: 'bold', spacing: 1.5}),
            x + w / 2, y + h / 2 + h * 0.14, Math.min(22, h * 0.4),
            o.off ? withAlpha(t.dim, 0.6) : o.primary ? inkOn(S) : o.color || t.text, {align: 'center', font: 'bold', spacing: 1.5, literal: true});
        if (!o.off && run) cv.target(x, y, w, h, run, key, h / 2);
    }
    function card(cv, x, y, w, h, alpha) { cv.roundRect(x, y, w, h, 10, withAlpha('#b4bccc', alpha === undefined ? 0.07 : alpha)); }
    function playGlyph(cv, cx, cy, r, c) { cv.quad([[cx - r * 0.7, cy - r], [cx + r, cy], [cx + r, cy], [cx - r * 0.7, cy + r]], c); }
    function pauseGlyph(cv, cx, cy, r, c) { cv.fillRect(cx - r * 0.8, cy - r, r * 0.55, r * 2, c); cv.fillRect(cx + r * 0.25, cy - r, r * 0.55, r * 2, c); }
    function dot(cv, x, y, ok, t, wait) {
        if (ok) cv.circle(x, y, 7, t.ok || t.accent);
        else cv.arc(x, y, 4.5, 7.5, 0, 360, wait ? t.warn : t.crit);
    }
    function qr(cv, t, link, x, y, size, locked) {
        let code = null;
        if (link) try { code = qrcode(0, 'M'); code.addData(link); code.make(); } catch (_) { code = null; }
        if (!code) {
            cv.roundRect(x, y, size, size, 12, withAlpha('#000000', 0.45));
            cv.strokeRoundRect(x, y, size, size, 12, 1.5, withAlpha(t.warn, 0.5));
            cv.text('NO LINK', x + size / 2, y + size / 2 - 4, 22, t.warn, {align: 'center', font: 'bold', spacing: 1.5});
            paragraph(cv, locked || '', x + 20, y + size / 2 + 28, 16, t.dim, size - 40, 3);
            return;
        }
        const n = code.getModuleCount(), quiet = 3, cell = Math.floor(size / (n + quiet * 2)), span = cell * (n + quiet * 2);
        const ox = x + Math.floor((size - span) / 2), oy = y + Math.floor((size - span) / 2);
        cv.roundRect(x, y, size, size, 12, '#ffffff');
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
            if (code.isDark(r, c)) cv.fillRect(ox + (c + quiet) * cell, oy + (r + quiet) * cell, cell, cell, '#05070a');
    }

    /* ---------------- footer: a message or hint left, buttons right ---------------- */
    function footer(cv, t, m, hint, buttons) {
        const shown = (buttons || []).filter(Boolean);
        const left = W - EDGE - shown.reduce((sum, b) => sum + b.w, 0) - 12 * Math.max(0, shown.length - 1);
        let x = left;
        shown.forEach(b => { button(cv, t, x, FOOT_Y, b.w, FOOT_H, b.text, b.run, b.key, b); x += b.w + 12; });
        const room = (shown.length ? left - 12 : W - EDGE) - EDGE;
        if (m.notice) {
            const c = m.notice.level === 'error' ? t.crit : m.notice.level === 'warn' ? t.warn : t.ok || t.accent;
            cv.roundRect(EDGE, FOOT_Y, room, FOOT_H, 10, withAlpha(c, 0.16));
            cv.fillRect(EDGE, FOOT_Y + 8, 4, FOOT_H - 16, c);
            label(cv, m.notice.text, EDGE + 20, FOOT_Y + 33, 20, t.text, room - 36);
        } else if (hint) label(cv, hint, EDGE + 4, FOOT_Y + 33, 19, t.dim, room - 8);
    }

    /* ---------------- Games ---------------- */
    function drawGames(cv, t, m, a) {
        const S = t.sel || t.accent, columns = Math.ceil(m.platforms.length / 2);
        const gap = 10, chipW = (W - 2 * EDGE - (columns - 1) * gap) / columns, chipH = 52;
        m.platforms.forEach((p, i) => {
            const x = EDGE + (i % columns) * (chipW + gap), y = TOP + Math.floor(i / columns) * (chipH + 6);
            const on = i === m.platform;
            card(cv, x, y, chipW, chipH, on ? 0.15 : 0.06);
            if (on) cv.fillRect(x + 14, y + chipH - 4, chipW - 28, 3, S);
            label(cv, p.short, x + 16, y + 23, 19, on ? t.text : t.dim, chipW - 32, {font: 'bold'});
            label(cv, (p.id === 'arcade' ? '1 game' : p.count + (p.count === 1 ? ' game' : ' games')) + (p.experimental ? ' / Trial' : ''),
                x + 16, y + 42, 15, t.dim, chipW - 32);
            cv.target(x, y, chipW, chipH, () => a.platform(i), 'PLATFORM_' + i, 10);
        });
        const platformRows = Math.ceil(m.platforms.length / columns);
        const list = m.list, y0 = TOP + platformRows * (chipH + 6) + 10, rowH = 74, colW = (W - 2 * EDGE - 16) / LIST_COLS;
        const spec = m.platforms[m.platform];
        if (!list.total) {
            card(cv, EDGE, y0, W - 2 * EDGE, FOOT_Y - y0 - 14);
            cv.text('No ' + spec.short + ' games yet', W / 2, y0 + 65, 32, t.text, {align: 'center', font: 'bold', literal: true});
            cv.text('Open Controllers, scan a QR code with your phone and upload a game you own.',
                W / 2, y0 + 105, 21, t.dim, {align: 'center', literal: true});
            button(cv, t, W / 2 - 170, y0 + 131, 340, 56, 'Open Controllers', () => a.open(PAGE.PADS), 'EMPTY_PADS', {primary: true});
        }
        list.items.forEach((item, k) => {
            const col = k % LIST_COLS, row = Math.floor(k / LIST_COLS);
            const x = EDGE + col * (colW + 16), y = y0 + row * (rowH + 10);
            const current = m.running && m.running.kind === item.kind && m.running.name === item.name;
            const armed = m.deleting && m.armed === item.kind + '/' + item.name;
            card(cv, x, y, colW, rowH, current ? 0.13 : 0.07);
            if (current) cv.fillRect(x, y + 12, 4, rowH - 24, S);
            cv.roundRect(x + 16, y + 14, 76, rowH - 28, 8, withAlpha(m.deleting ? t.crit : t.accent2 || t.accent, 0.14));
            cv.text(spec.tag, x + 54, y + rowH / 2 + 7, 19, m.deleting ? t.crit : t.accent2 || t.accent, {align: 'center', font: 'bold', spacing: 1, literal: true});
            label(cv, item.title, x + 110, y + 37, 24, t.text, colW - 200);
            label(cv, item.detail, x + 110, y + 64, 17, t.dim, colW - 200);
            if (m.deleting) {
                const bw = armed ? 150 : 120;
                button(cv, t, x + colW - bw - 16, y + (rowH - 44) / 2, bw, 44, armed ? 'Confirm' : 'Delete',
                    () => a.remove(item), 'DEL_' + (list.start + k), {color: t.crit, primary: armed});
            } else {
                cv.circle(x + colW - 44, y + rowH / 2, 22, withAlpha('#ffffff', 0.08));
                playGlyph(cv, x + colW - 44, y + rowH / 2, 9, current ? S : t.text);
                cv.target(x, y, colW, rowH, () => a.play(item), 'GAME_' + (list.start + k), 10);
            }
        });
        const paged = list.pages > 1, arcade = spec.id === 'arcade' || spec.builtIn === true;
        const hint = !m.allowed ? m.lockHint : m.deleting ? 'Delete keeps battery saves and save states. Press Delete twice.' :
            list.total ? list.total + (list.total === 1 ? ' game' : ' games') + (paged ? '  ·  page ' + (list.page + 1) + ' of ' + list.pages : '') +
            (arcade ? '' : '  ·  in-game saves are kept automatically') : '';
        const last = !m.deleting && m.last && !m.running ? m.last : null;
        footer(cv, t, m, hint, [
            paged && {text: 'Previous', w: 170, key: 'PREV', run: () => a.turn(-1), off: list.page === 0},
            paged && {text: 'Next', w: 130, key: 'NEXT', run: () => a.turn(1), off: list.page >= list.pages - 1},
            m.running && !m.deleting && {text: 'Back to game', w: 250, key: 'TO_GAME', run: () => a.open(PAGE.PLAY), primary: true},
            last && {text: 'Continue ' + last.title, w: 330, key: 'CONTINUE', run: a.resumeLast, primary: true, off: !m.allowed},
            a.refresh && !arcade && !m.deleting && {text: 'Refresh', w: 125, key: 'REFRESH', run: a.refresh},
            !arcade && list.total && {text: m.deleting ? 'Done' : 'Delete games', w: m.deleting ? 130 : 220, key: 'DELETE_MODE', run: a.toggleDelete,
                color: m.deleting ? null : t.crit},
        ]);
    }

    /* ---------------- Playing ---------------- */
    function playerRow(cv, t, y, n, p) {
        const c = n === 1 ? '#5ab8ff' : '#ff6f9a';
        cv.roundRect(EDGE + 20, y - 24, 48, 32, 8, withAlpha(c, 0.18));
        cv.text('P' + n, EDGE + 44, y - 1, 18, c, {align: 'center', font: 'bold', literal: true});
        label(cv, p.label, EDGE + 82, y - 10, 19, t.text, SIDE - 100);
        dot(cv, EDGE + 92, y + 14, p.ok, t, p.wait);
        label(cv, p.state, EDGE + 108, y + 20, 16, p.ok ? t.dim : p.wait ? t.warn : t.crit, SIDE - 124);
    }
    function held(g, m) { return !m.allowed || g.paused || !g.focus || g.videoIssue; }

    function picture(cv, g, a, box, exact) {
        cv.fillRect(box.x, box.y, box.w, box.h, '#000000');
        if (!g.arcade && !g.width) return;
        if (g.arcade && !exact && (!g.scale || g.scale === 'fit')) {
            a.drawArcade(cv, box.x, box.y, box.w, box.h);
            return;
        }
        const r = fitRect(box, g.arcade ? 900 : g.width, g.arcade ? 450 : g.height, g.scale,
            exact && cv.place ? cv.place.scale : 1);
        if (g.scale === 'crop') cv.clip(box.x, box.y, box.w, box.h);
        if (g.arcade) a.drawArcade(cv, r.x, r.y, r.w, r.h, true);
        else cv.image(IMAGE, r.x, r.y, r.w, r.h);
        if (g.scale === 'crop') cv.noclip();
    }

    function drawFullscreen(cv, t, m, a) {
        const g = m.game, top = cv.chrome ? 0 : TOP;
        const extra = g.displayMode === 'immersive' && cv.own ? cv.extra || 0 : 0;
        cv.extraUsed = extra > 0;
        const area = {x: 0, y: top, w: W, h: H + extra - top};
        picture(cv, g, a, area, true);
        const paused = held(g, m);
        if (!g.gameMenu && !paused) {
            button(cv, t, W - 134, top + 10, 122, 40, 'Game menu', a.gameMenu, 'GAME_MENU');
            // Standard GPU layout uses a bounded hit area to keep the BMW bar live.
            if (!cv.own) cv.scroll = {bounds: area};
            return;
        }
        const x = (W - 790) / 2, y = top + (area.h - 194) / 2, w = 790, h = 194;
        cv.roundRect(x, y, w, h, 15, withAlpha('#090e16', 0.94));
        const status = !m.allowed ? m.lockHint : g.videoIssue ? g.videoIssue.title + ' / ' + g.videoIssue.detail :
            g.reason === 'overload' ? 'EMULATOR TOO SLOW / ' + g.detail : g.reason === 'error' ? 'EMULATOR STOPPED / ' + g.detail :
            !g.focus ? 'SCREEN NOT IN FRONT' : g.paused ? g.title + ' / Paused' : g.title;
        label(cv, status, x + 15, y + 32, 20, t.text, w - 30);
        const choices = [
            [g.videoIssue ? 'Retry video' : g.paused || g.gameMenu ? 'Resume' : 'Pause', a.togglePause, 'PAUSE', {off: !m.allowed || !g.focus}],
            ['Games', () => a.open(PAGE.GAMES), 'TO_GAMES'],
            ['Controllers', () => a.open(PAGE.PADS), 'TO_PADS'],
            ['Exit fullscreen', a.fullscreen, 'EXIT_FULLSCREEN'],
            ['Quit game', a.quit, 'QUIT', {color: t.crit}],
        ];
        choices.forEach((b, i) => button(cv, t, x + 15 + i * 153, y + 47, 148, 45, b[0], b[1], b[2], b[3]));
        button(cv, t, x + 15, y + 107, 148, 44, g.audioOn ? 'Audio on' : 'Audio off', a.toggleAudio, 'AUDIO_TOGGLE');
        button(cv, t, x + 180, y + 107, 52, 44, '-', () => a.volume(-10), 'VOLUME_DOWN');
        label(cv, g.volume + '%', x + 245, y + 135, 17, t.text, 65);
        button(cv, t, x + 307, y + 107, 52, 44, '+', () => a.volume(10), 'VOLUME_UP');
        if (g.gameMenu && !g.paused) button(cv, t, x + w - 163, y + 107, 148, 44, 'Close menu', a.gameMenu, 'CLOSE_MENU');
        if (g.fps !== undefined) label(cv, g.fps + ' EMU FPS / ' + g.videoFps + ' VIDEO', x + 388, y + 135, 16, t.dim, 215);
        if (!cv.own) cv.scroll = {bounds: area};
    }

    function drawPlay(cv, t, m, a) {
        const g = m.game;
        if (!g) {
            card(cv, EDGE, TOP, W - 2 * EDGE, FOOT_Y - TOP - 14);
            cv.text('No game running', W / 2, 200, 34, t.text, {align: 'center', font: 'bold', literal: true});
            cv.text(m.last ? 'Pick a game in Games, or continue where you left off.' : 'Pick a game in Games.', W / 2, 248, 22, t.dim, {align: 'center', literal: true});
            button(cv, t, W / 2 - 170, 290, 340, 58, 'Open Games', () => a.open(PAGE.GAMES), 'EMPTY_GAMES', {primary: !m.last});
            footer(cv, t, m, !m.allowed ? m.lockHint : '', [
                m.last && {text: 'Continue ' + m.last.title, w: 360, key: 'CONTINUE', run: a.resumeLast, primary: true, off: !m.allowed},
            ]);
            return;
        }
        if (g.displayMode && g.displayMode !== 'standard') return drawFullscreen(cv, t, m, a);
        // left: what it is and who plays
        G.panel(cv, t, EDGE, TOP, SIDE, H - TOP - 12, '');
        cv.text(g.platform, EDGE + 22, TOP + 34, 15, t.dim, {font: 'bold', spacing: 2, literal: true});
        paragraph(cv, g.title, EDGE + 22, TOP + 70, 23, t.text, SIDE - 44, 2, {font: 'bold'});
        playerRow(cv, t, TOP + 170, 1, g.players[0]);
        playerRow(cv, t, TOP + 240, 2, g.players[1]);
        if (g.help) paragraph(cv, g.help, EDGE + 22, TOP + 310, 15, t.dim, SIDE - 44, 6);
        // centre: the picture
        picture(cv, g, a, STAGE, false);
        if (held(g, m)) {
            const bw = Math.min(760, STAGE.w - 60), bx = STAGE.x + (STAGE.w - bw) / 2, by = STAGE.y + STAGE.h / 2 - 78;
            cv.roundRect(bx, by, bw, 156, 16, withAlpha('#000000', 0.82));
            cv.strokeRoundRect(bx, by, bw, 156, 16, 1.5, withAlpha(!m.allowed || g.reason === 'overload' || g.reason === 'error' ? t.warn : '#ffffff', 0.4));
            pauseGlyph(cv, bx + 56, by + 78, 18, !m.allowed ? t.warn : t.text);
            const head = !m.allowed ? (m.lock === 'moving' ? 'CAR MOVING' : 'NO SPEED SIGNAL') :
                g.videoIssue ? g.videoIssue.title : g.reason === 'overload' ? 'EMULATOR TOO SLOW' : g.reason === 'error' ? 'EMULATOR STOPPED' :
                !g.focus ? 'SCREEN NOT IN FRONT' : 'PAUSED';
            cv.text(head, bx + 100, by + 64, 26, !m.allowed || g.reason === 'overload' || g.reason === 'error' ? t.warn : t.text,
                {font: 'bold', spacing: 1.5, literal: true});
            const why = !m.allowed ? m.lockHint : g.videoIssue ? g.videoIssue.detail : g.reason === 'overload' ? 'Paused so the head unit stays responsive (' + g.detail + '). Resume to try again.' :
                g.reason === 'error' ? g.detail : !g.focus ? 'The game continues when GameStation is in front again.' : 'Your progress is kept. Resume when you are ready.';
            paragraph(cv, why, bx + 100, by + 100, 18, t.dim, bw - 130, 2);
        }
        // right: controls
        const rx = W - EDGE - SIDE;
        G.panel(cv, t, rx, TOP, SIDE, H - TOP - 12, '');
        const bw = SIDE - 44, bx = rx + 22;
        button(cv, t, bx, TOP + 26, bw, 62, g.videoIssue ? 'Retry video' : g.paused ? 'Resume' : 'Pause', a.togglePause, 'PAUSE',
            {primary: g.paused, off: !m.allowed && !g.paused});
        button(cv, t, bx, TOP + 104, bw, 56, 'Games', () => a.open(PAGE.GAMES), 'TO_GAMES');
        button(cv, t, bx, TOP + 172, bw, 56, 'Controllers', () => a.open(PAGE.PADS), 'TO_PADS');
        button(cv, t, bx, TOP + 240, bw, 56, 'Quit game', a.quit, 'QUIT', {color: t.crit});
        cv.text(g.states ? 'SAVE SLOTS IN DIAGNOSTICS' : g.saved ? 'SAVES ARE KEPT' : g.arcade ? 'ARCADE' : 'NO BATTERY SAVE', bx + bw / 2, TOP + 336, 14, t.dim,
            {align: 'center', font: 'bold', spacing: 2, literal: true});
        if (g.fps !== undefined) cv.text(g.fps + ' EMU FPS' + (g.arcade ? '' : ' / ' + g.videoFps + ' VIDEO') + (g.audio === 'PCM' ? ' / PCM' : ''), bx + bw / 2, TOP + 364, 14, g.fps < 40 ? t.warn : t.dim,
            {align: 'center', font: 'num', literal: true});
        if (m.notice) paragraph(cv, m.notice.text, bx, TOP + 400, 16, m.notice.level === 'info' ? t.dim : t.warn, bw, 3);
    }

    /* ---------------- Controllers ---------------- */
    function checks(cv, t, rows, x, y, w, rowH) {
        rows.forEach((r, i) => {
            const ry = y + i * rowH, c = r.state === 'ok' ? t.ok || t.accent : r.state === 'off' ? t.dim : r.state === 'bad' ? t.crit : t.warn;
            if (i) cv.fillRect(x, ry - rowH / 2 - 4, w, 1, withAlpha('#ffffff', 0.08));
            if (r.state === 'ok') cv.circle(x + 9, ry - 7, 8, c);
            else cv.arc(x + 9, ry - 7, 5, 8, 0, 360, c);
            label(cv, r.name, x + 32, ry, 19, t.dim, 190);
            label(cv, r.value, x + 230, ry, 19, r.state === 'ok' || r.state === 'off' ? t.text : c, w - 230);
        });
    }
    function drawPads(cv, t, m, a) {
        const p = m.pads, panelW = 404, panelH = FOOT_Y - TOP - 14, qrSize = 250;
        [0, 1].forEach(i => {
            const x = EDGE + i * (panelW + 16), s = p.slots[i], c = i === 0 ? '#5ab8ff' : '#ff6f9a';
            G.panel(cv, t, x, TOP, panelW, panelH, '');
            cv.text('PLAYER ' + (i + 1), x + 24, TOP + 36, 18, c, {font: 'bold', spacing: 2, literal: true});
            dot(cv, x + panelW - 32, TOP + 30, s.ok, t, s.wait);
            label(cv, s.role, x + 24, TOP + 64, 17, t.dim, panelW - 48);
            qr(cv, t, s.link, x + (panelW - qrSize) / 2, TOP + 80, qrSize, s.locked);
            label(cv, s.state, x + panelW / 2, TOP + qrSize + 116, 19, s.ok ? t.text : s.wait ? t.warn : t.crit, panelW - 40, {align: 'center'});
        });
        const x = EDGE + 2 * (panelW + 16), w = W - EDGE - x;
        G.panel(cv, t, x, TOP, w, panelH, '');
        cv.text('CONTROLLER SETUP', x + 26, TOP + 36, 15, t.dim, {font: 'bold', spacing: 2, literal: true});
        label(cv, MODES[p.mode] || MODES.phones, x + 26, TOP + 70, 26, t.text, w - 52, {font: 'bold'});
        checks(cv, t, p.rows, x + 26, TOP + 124, w - 52, 46);
        footer(cv, t, m, p.ready ? 'Phones: join the car\'s Wi-Fi, then scan the code of your player. No Internet needed.' : p.blocked, [
            {text: 'Change setup', w: 240, key: 'MODE', run: a.nextMode},
            m.game && {text: 'Back to game', w: 250, key: 'PADS_GAME', run: () => a.open(PAGE.PLAY), primary: true},
        ]);
    }

    /** Draw page m.page from view model m with actions a. */
    function drawDiagnostics(cv, t, m, a) {
        const d = m.diagnostics, rx = 830, right = W - rx - EDGE;
        G.panel(cv, t, EDGE, TOP, rx - EDGE - 16, 383, '');
        d.rows.forEach((row, i) => {
            const y = TOP + 26 + i * 27;
            label(cv, row[0], EDGE + 16, y, 16, t.dim, 175);
            label(cv, row[1], EDGE + 190, y, 17, t.text, rx - EDGE - 215);
        });
        G.panel(cv, t, rx, TOP, right, 383, '');
        cv.text(d.gpuTest ? 'GPU image test' : d.logPage ? 'Log / page ' + (d.logPage + 1) : 'Live log', rx + 16, TOP + 30, 20, t.text);
        if (d.gpuTest) {
            const test = d.gpuTest;
            const r = fitRect({x: rx + 16, y: TOP + 46, w: right - 32, h: 218}, test.w, test.h, 'integer');
            cv.fillRect(r.x, r.y, r.w, r.h, '#645c35');
            if (test.displayReady) cv.image(test.id, r.x, r.y, r.w, r.h);
            label(cv, test.w + 'x' + test.h + ' / ' + test.status, rx + 16, TOP + 292, 16, t.dim, right - 32);
            button(cv, t, rx + 16, TOP + 325, 145, 44, 'Change size', a.gpuSize, 'GPU_SIZE');
            button(cv, t, rx + 172, TOP + 325, 145, 44, test.moving ? 'Static' : 'Animate', a.gpuMotion, 'GPU_MOTION');
        } else {
            d.lines.forEach((line, i) => label(cv, line, rx + 16, TOP + 65 + i * 34, 16, t.dim, right - 32));
            button(cv, t, rx + 16, TOP + 325, 135, 44, 'Older', () => a.logScroll(1), 'LOG_OLDER');
            button(cv, t, rx + 162, TOP + 325, 135, 44, 'Newer', () => a.logScroll(-1), 'LOG_NEWER');
            button(cv, t, rx + 308, TOP + 325, 135, 44, 'Clear', a.logClear, 'LOG_CLEAR');
        }
        if (a.metricsScroll) {
            button(cv, t, EDGE + 16, TOP + 325, 135, 44, 'Previous', () => a.metricsScroll(-1), 'METRICS_PREV');
            button(cv, t, EDGE + 162, TOP + 325, 135, 44, 'Next', () => a.metricsScroll(1), 'METRICS_NEXT');
        }
        footer(cv, t, m, 'Copy or download the log from the paired phone.', [
            d.states && {text: 'Slot ' + d.slot, w: 120, key: 'STATE_SLOT', run: a.nextSlot},
            d.states && {text: 'Save', w: 110, key: 'STATE_SAVE', run: a.storeState, off: !m.allowed},
            d.states && {text: 'Load', w: 110, key: 'STATE_LOAD', run: a.loadState, off: !m.allowed},
            a.gpuTest && {text: d.gpuTest ? 'Stop GPU test' : 'Test GPU Image', w: 195, key: 'GPU_TEST', run: a.gpuTest, off: !m.allowed},
            a.audioDiagnostics && {text: d.audioPage ? 'Performance' : 'Audio diagnostics', w: 205, key: 'AUDIO_DIAG', run: a.audioDiagnostics},
            {text: d.tone ? 'Stop speaker test' : 'Test Speaker', w: 195, key: 'TONE', run: a.tone, off: !m.allowed},
        ]);
    }

    function draw(cv, t, m, a) {
        cv.clear(t.bg);
        const badge = m.allowed ? {text: 'PARKED', color: t.ok || t.accent} :
            {text: m.lock === 'moving' ? 'MOVING' : 'NO SPEED SIGNAL', color: t.crit};
        const badges = [m.game && m.page !== PAGE.PLAY ? {text: m.game.paused ? 'GAME PAUSED' : 'GAME RUNNING', color: t.accent2 || t.accent} : null, badge];
        const immersive = m.page === PAGE.PLAY && m.game && m.game.displayMode === 'immersive' && cv.own &&
            !m.game.gameMenu && !held(m.game, m);
        G.frame(cv, t, immersive ? [] : TABS, immersive ? -1 : m.page, badges);
        if (m.page === PAGE.PLAY) drawPlay(cv, t, m, a);
        else if (m.page === PAGE.PADS) drawPads(cv, t, m, a);
        else if (m.page === PAGE.DIAG) drawDiagnostics(cv, t, m, a);
        else drawGames(cv, t, m, a);
        return cv;
    }
    return {draw, fit, inkOn};
}

module.exports = {makeUi, ascii, megabytes, fitRect, TABS, PAGE, PAGE_SIZE, PLATFORMS, MODES, STAGE, IMAGE, W, H};
