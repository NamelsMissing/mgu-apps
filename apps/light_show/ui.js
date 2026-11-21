'use strict';
// Everything Light Show draws on the centre display. Pure drawing from a view model:
// main.js decides, this file only paints and registers the touch / iDrive targets
// (left to right, top to bottom: the order the iDrive knob walks them).
const qrcode = require('./qr_vendor');
const Car3D = require('./car3d');

const W = 1600, H = 520;
const TABS = ['Show', 'Lights', 'Vehicle', 'Phone'];
const PAGE = { SHOW: 0, LIGHTS: 1, VEHICLE: 2, PHONE: 3 };
const TOP = 52, EDGE = 24, FOOT_Y = 452, FOOT_H = 52;
const LIGHT_ROWS = 6, LIGHT_COLS = 2, LIGHTS_PER_PAGE = LIGHT_ROWS * LIGHT_COLS;

const FOLD = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss', '–': '-', '—': '-', '…': '...' };
function ascii(value) {
    let s = String(value === undefined || value === null ? '' : value).replace(/[ÄÖÜäöüß–—…]/g, (c) => FOLD[c] || c);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) { /* Node without ICU */ }
    return s.replace(/[^\x20-\x7e]/g, '?').replace(/\s+/g, ' ').trim();
}

function makeUi(G, colors) {
    const withAlpha = colors.withAlpha, rgba = colors.rgba;
    const LIT = { literal: true };
    const inkOn = (c) => { const v = rgba(c); return (v[0] * 299 + v[1] * 587 + v[2] * 114) / 1000 > 150 ? '#05070a' : '#ffffff'; };
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
        words.forEach((word) => {
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
    function button(cv, t, x, y, w, h, text, run, key, opts) {
        const o = opts || {}, S = o.color || t.sel || t.accent;
        if (o.primary && !o.off) cv.roundRect(x, y, w, h, h / 2, withAlpha(S, 0.92));
        else {
            cv.roundRect(x, y, w, h, h / 2, withAlpha('#ffffff', o.off ? 0.03 : o.on ? 0.16 : 0.07));
            cv.strokeRoundRect(x, y, w, h, h / 2, o.on ? 2.5 : 1.5, withAlpha(o.color || (o.on ? S : '#ffffff'), o.off ? 0.12 : o.on ? 0.95 : o.color ? 0.75 : 0.3));
        }
        const size = Math.min(o.size || 20, h * 0.4);
        cv.text(fit(cv, String(text).toUpperCase(), size, w - h * 0.6, { font: 'bold', spacing: 1.2 }),
            x + w / 2, y + h / 2 + size * 0.36, size,
            o.off ? withAlpha(t.dim, 0.6) : o.primary ? inkOn(S) : o.color || t.text, { align: 'center', font: 'bold', spacing: 1.2, literal: true });
        if (!o.off && run) cv.target(x, y, w, h, run, key, h / 2);
    }
    function tile(cv, t, x, y, w, h, on, run, key) {
        const S = t.sel || t.accent;
        cv.roundRect(x, y, w, h, 12, withAlpha(on ? S : '#b4bccc', on ? 0.2 : 0.07));
        if (on) cv.strokeRoundRect(x, y, w, h, 12, 2.5, withAlpha(S, 0.95));
        if (run) cv.target(x, y, w, h, run, key, 12);
    }
    function footer(cv, t, hint, hintColor, buttons) {
        const shown = (buttons || []).filter(Boolean);
        let x = W - EDGE - shown.reduce((s, b) => s + b.w, 0) - 12 * Math.max(0, shown.length - 1);
        paragraph(cv, hint || '', EDGE + 4, FOOT_Y + 22, 17, hintColor || t.dim, x - EDGE - 24, 2);
        shown.forEach((b) => { button(cv, t, x, FOOT_Y, b.w, FOOT_H, b.text, b.run, b.key, b); x += b.w + 12; });
    }
    /** Convex polygon as a fan of quads (the vehicle recorder only knows quads). */
    function polygon(cv, pts, c) {
        if (pts.length === 4) return cv.quad(pts, c);
        for (let i = 1; i < pts.length - 1; i += 2) {
            const b = pts[i], d = pts[i + 1], e = pts[i + 2] || pts[i + 1];
            cv.quad([pts[0], b, d, e], c);
        }
        return cv;
    }
    /** The 3D car with lamp glows, into the box. */
    function car(cv, t, box, m, lamps, opts) {
        const o = opts || {};
        cv.roundRect(box.x, box.y, box.w, box.h, 16, withAlpha('#0b111a', 0.85));
        cv.gradientRect(box.x + 8, box.y + box.h * 0.55, box.w - 16, box.h * 0.45 - 8,
            [[0, withAlpha('#2a4a78', 0)], [1, withAlpha('#2a4a78', 0.28)]]);
        Car3D.render({
            poly: (pts, c) => polygon(cv, pts, c),
            dot: (x, y, r, c) => cv.circle(x, y, r, c),
        }, { x: box.x + 10, y: box.y + (o.top || 6), w: box.w - 20, h: box.h - (o.top || 6) - 18, yaw: m.yaw, pitch: o.pitch || -0.3 }, lamps);
    }
    function chip(cv, x, y, text, color, size) {
        const s = size || 14, w = cv.textWidth(ascii(text).toUpperCase(), s, { font: 'bold', spacing: 1, literal: true }) + 18;
        cv.roundRect(x, y, w, s + 12, (s + 12) / 2, withAlpha(color, 0.16));
        cv.text(ascii(text).toUpperCase(), x + 9, y + s + 3, s, color, { font: 'bold', spacing: 1, literal: true });
        return w;
    }
    const statusColor = (t, s) => s === 'visible' ? (t.ok || t.accent) : s === 'noise' ? t.crit : s === 'not-visible' ? t.warn : t.dim;

    /* ---------------- Show ---------------- */
    function drawShow(cv, t, m, a) {
        const r = m.runner, carBox = { x: EDGE, y: TOP, w: 640, h: FOOT_Y - TOP - 14 };
        if (m.commOff) chip(cv, carBox.x + 22, carBox.y + carBox.h - 56, 'Test: headlamps silenced', t.warn, 12);
        car(cv, t, carBox, m, m.carLamps, { top: 46 });
        label(cv, r.busy ? r.title : 'Light Show', carBox.x + 22, carBox.y + 36, 22, t.text, carBox.w - 200, { font: 'bold' });
        chip(cv, carBox.x + carBox.w - 150, carBox.y + 16, r.busy ? (r.state === 'RUNNING' ? 'Playing' : 'Working') : m.allowed ? 'Ready' : 'Locked',
            r.busy ? (t.accent2 || t.accent) : m.allowed ? (t.ok || t.accent) : t.crit);
        if (r.progress) {
            const p = r.progress, bw = carBox.w - 44;
            cv.roundRect(carBox.x + 22, carBox.y + carBox.h - 22, bw, 6, 3, withAlpha('#ffffff', 0.12));
            cv.roundRect(carBox.x + 22, carBox.y + carBox.h - 22, Math.max(6, bw * p.step / p.steps), 6, 3, t.sel || t.accent);
        }
        // effects 3 x 3
        const x0 = carBox.x + carBox.w + 16, w = W - EDGE - x0, gap = 10, cw = (w - 2 * gap) / 3, ch = 58;
        cv.text('EFFECT', x0 + 2, TOP + 14, 14, t.dim, { font: 'bold', spacing: 2, literal: true });
        m.effects.forEach((e, i) => {
            const x = x0 + (i % 3) * (cw + gap), y = TOP + 24 + Math.floor(i / 3) * (ch + gap), on = e.id === m.config.effect;
            tile(cv, t, x, y, cw, ch, on, () => a.effect(e.id), 'FX_' + e.id);
            label(cv, e.name, x + 16, y + 26, 19, on ? t.text : withAlpha(t.text, 0.85), cw - 28, { font: 'bold' });
            label(cv, e.text, x + 16, y + 47, 13.5, t.dim, cw - 28);
        });
        // settings: label + value button, 4 in a row
        const sy = TOP + 24 + 3 * (ch + gap) + 8, sw = (w - 3 * gap) / 4;
        [['STEP', m.config.stepMs + ' ms', a.nextStep, 'SET_STEP'], ['PAUSE', m.config.gapMs ? m.config.gapMs + ' ms' : 'none', a.nextGap, 'SET_GAP'],
            ['REPEAT', m.config.cycles + 'x', a.nextCycles, 'SET_CYC'], ['LED BRIGHTNESS', m.config.pwm + '%', a.nextPwm, 'SET_PWM']].forEach((s, i) => {
            const x = x0 + i * (sw + gap);
            cv.text(s[0], x + 4, sy + 12, 12.5, t.dim, { font: 'bold', spacing: 1.5, literal: true });
            button(cv, t, x, sy + 20, sw, 44, s[1], s[2], s[3], { size: 18 });
        });
        const iy = sy + 84;
        const pl = m.plan;
        const sel = m.config.selection.length;
        const info = !sel ? 'No lights picked yet: test lights under LIGHTS and add them to the show.'
            : pl && pl.error ? pl.error
            : pl ? sel + ' lights, ' + pl.steps.length * (pl.cycles || 1) + ' steps, about ' + Math.max(1, Math.round(pl.estimateMs / 1000)) + ' s. ' + (pl.notes[0] || '') : '';
        paragraph(cv, info, x0 + 2, iy, 16, pl && pl.error ? t.warn : t.dim, w - 4, 2);
        const hint = !m.allowed ? m.lockText : r.recoveryPending && !r.busy ? 'A previous run is not released yet: press STOP.' : r.note;
        footer(cv, t, hint, !m.allowed || r.state === 'ERROR' ? t.crit : null, [
            sel ? { text: 'Clear lights', w: 185, key: 'CLEAR_LIGHTS', run: a.clearSelection, off: r.busy } : null,
            { text: 'Stop', w: 200, key: 'STOP', run: a.stop, color: t.crit, off: !r.busy && !r.recoveryPending },
            { text: r.busy ? 'Playing...' : 'Start show', w: 260, key: 'START', run: a.start, primary: true,
                off: r.busy || !m.allowed || !pl || !!pl.error || r.recoveryPending },
        ]);
    }

    /* ---------------- Lights ---------------- */
    function drawLights(cv, t, m, a) {
        const list = m.lightList, panelW = 520, listW = W - 2 * EDGE - panelW - 16, colW = (listW - 12) / LIGHT_COLS, rowH = 60;
        const start = m.lightsPage * LIGHTS_PER_PAGE;
        list.slice(start, start + LIGHTS_PER_PAGE).forEach((l, k) => {
            const x = EDGE + (k % LIGHT_COLS) * (colW + 12), y = TOP + Math.floor(k / LIGHT_COLS) * (rowH + 8), on = l.id === m.selectedLamp;
            tile(cv, t, x, y, colW, rowH, on, () => a.pickLamp(l.id), 'LAMP_' + l.id);
            cv.circle(x + 24, y + rowH / 2, 8, l.hex);
            cv.circle(x + 24, y + rowH / 2, 13, withAlpha(l.hex, 0.25));
            label(cv, l.label, x + 46, y + 26, 18, t.text, colW - 200, { font: 'bold' });
            label(cv, l.module + (l.experimental ? ' (exp.)' : ''), x + 46, y + 47, 13.5, t.dim, colW - 200);
            const n = m.config.selection.indexOf(l.id);
            if (n >= 0) { cv.circle(x + colW - 28, y + rowH / 2, 15, t.sel || t.accent); cv.text(String(n + 1), x + colW - 28, y + rowH / 2 + 6, 16, inkOn(t.sel || t.accent), { align: 'center', font: 'bold', literal: true }); }
            const st = l.statusText;
            const sw = cv.textWidth(ascii(st).toUpperCase(), 12, { font: 'bold', spacing: 1, literal: true }) + 18;
            chip(cv, x + colW - (n >= 0 ? 56 : 14) - sw, y + 18, st, statusColor(t, l.status), 12);
        });
        if (!list.length) paragraph(cv, m.profile ? 'No light is available on this car with the current settings. See VEHICLE.' : 'The car is scanned by itself once it is parked in P (read-only, a few seconds). Then Light Show knows which control units and lights this car has.', EDGE + 10, TOP + 40, 20, t.dim, listW - 20, 4);
        // detail panel with a small 3D car
        const px = W - EDGE - panelW, l = list.find((x) => x.id === m.selectedLamp);
        car(cv, t, { x: px, y: TOP, w: panelW, h: 196 }, m, l ? [{ points: l.points, hex: l.hex, on: true }] : [], { pitch: -0.42 });
        if (l) {
            label(cv, l.label, px + 4, TOP + 226, 22, t.text, panelW - 8, { font: 'bold' });
            label(cv, l.statusText + ' - ' + l.module, px + 4, TOP + 250, 15, statusColor(t, l.status), panelW - 8);
            const bw = (panelW - 24) / 3;
            const tested = m.lastTested === l.id && !m.runner.busy;
            if (tested) {
                cv.text('WHAT DID YOU SEE AND HEAR?', px + 4, TOP + 282, 13, t.dim, { font: 'bold', spacing: 1.5, literal: true });
                button(cv, t, px, TOP + 292, bw, 46, 'Lit, quiet', () => a.observe('visible'), 'OBS_OK', { size: 16 });
                button(cv, t, px + bw + 12, TOP + 292, bw, 46, 'Nothing', () => a.observe('none'), 'OBS_NONE', { size: 16 });
                button(cv, t, px + 2 * (bw + 12), TOP + 292, bw, 46, 'Noise', () => a.observe('noise'), 'OBS_NOISE', { size: 16, color: t.warn });
            } else {
                paragraph(cv, !l.available ? l.why : l.status === 'visible' ? 'Tested: it lit up without noise. Add it to the show or test again.'
                    : 'Test it once while you watch the car. Only lights that lit up without unusual noise can join a show.', px + 4, TOP + 286, 15, t.dim, panelW - 8, 3);
            }
            const inShow = m.config.selection.indexOf(l.id) >= 0;
            button(cv, t, px, TOP + 350, bw, 46, 'Test', a.test, 'TEST', { primary: true, off: !l.available || m.runner.busy || !m.allowed || m.runner.recoveryPending, size: 17 });
            button(cv, t, px + bw + 12, TOP + 350, bw, 46, inShow ? 'Remove' : 'Add to show', a.toggle, 'TOGGLE', { off: (!l.available || l.status !== 'visible') && !inShow, size: 15, on: inShow });
            button(cv, t, px + 2 * (bw + 12), TOP + 350, bw, 46, 'Rename', a.rename, 'RENAME', { size: 16 });
        }
        const pages = Math.max(1, Math.ceil(list.length / LIGHTS_PER_PAGE));
        footer(cv, t, !m.allowed ? m.lockText : m.notice || ('Page ' + (m.lightsPage + 1) + ' of ' + pages + ', ' + list.length + ' lights. Test: P, standstill, nobody in front.'),
            !m.allowed ? t.crit : null, [
                { text: m.groupFilter ? m.groupFilter + ' lights' : 'All lights', w: 190, key: 'GROUP', run: a.nextGroup, on: !!m.groupFilter },
                { text: m.showAll ? 'Usable only' : 'Show all', w: 180, key: 'ALL', run: a.toggleAll },
                { text: 'Previous', w: 150, key: 'PREV', run: a.prevLights, off: m.lightsPage === 0 },
                { text: 'Next', w: 130, key: 'NEXT', run: a.nextLights, off: m.lightsPage >= pages - 1 },
                { text: 'Stop', w: 150, key: 'STOP_L', run: a.stop, color: t.crit, off: !m.runner.busy && !m.runner.recoveryPending },
            ]);
    }

    /* ---------------- Vehicle ---------------- */
    function drawVehicle(cv, t, m, a) {
        const p = m.profile, lw = 760;
        G.panel(cv, t, EDGE, TOP, lw, FOOT_Y - TOP - 14, '');
        cv.text('EXTERIOR LIGHT CONTROL UNITS', EDGE + 24, TOP + 34, 14, t.dim, { font: 'bold', spacing: 2, literal: true });
        if (!p) paragraph(cv, 'Not scanned yet. The scan asks every control unit for its identity (22 F1 50, read-only). Nothing is switched.', EDGE + 24, TOP + 74, 19, t.text, lw - 48, 4);
        else {
            label(cv, p.summary + ' (' + p.method + ')', EDGE + 24, TOP + 62, 15, t.dim, lw - 48);
            const unit = (a) => p.units.find((u) => u.address === a);
            const gw = unit(0x10), rear = p.rlm || [], stale = p.unconfirmed || [];
            const hints = p.order && p.order.hints.length ? p.order.hints.join(', ') : p.order ? p.order.codes.length + ' option codes read' : (p.orderError || 'vehicle order not read');
            const rows = [
                ['Gateway (0x10)', gw ? (gw.name || gw.index || '-') : '-', gw ? 'gateway' : 'absent', 'Vehicle order: ' + hints],
                ['Body controller (0x40)', p.bdc.name || p.bdc.index || '-', p.bdc.support, (p.bdc.functions || []).length + ' light functions' + (p.bdc.outputs ? ' + single outputs (experimental)' : '')],
                ['Headlamp left (0x43)', p.flm.left.name || p.flm.left.index || '-', p.routes.flm.left, 'LED channels of the left headlamp'],
                ['Headlamp right (0x44)', p.flm.right.name || p.flm.right.index || '-', p.routes.flm.right, 'LED channels of the right headlamp'],
                ['Rear light modules', rear.length ? rear.map((u) => u.name || u.index).join(', ') : '-',
                    !rear.length ? 'absent' : rear.some((r) => r.support === 'prg') ? 'prg' : rear[0].support,
                    rear.length ? 'Tail light functions and LED channels depend on the module' : 'Check the BDC light functions under Lights'],
            ];
            rows.forEach((r, i) => {
                const y = TOP + 74 + i * 60;
                card(cv, EDGE + 18, y, lw - 36, 54);
                label(cv, r[0], EDGE + 36, y + 23, 17, t.text, 280, { font: 'bold' });
                label(cv, r[1], EDGE + 320, y + 23, 17, t.text, 250);
                const addresses = [[0x10], [0x40], [0x43], [0x44], rear.map((u) => u.address)][i];
                const unconfirmed = addresses.filter((address) => stale.indexOf(address) >= 0).map((address) => unit(address).addressHex);
                label(cv, unconfirmed.length ? 'No reply this scan: ' + unconfirmed.join(', ') + '. Last identity shown.' : r[3], EDGE + 36, y + 44, 13.5, t.dim, lw - 90);
                const c = unconfirmed.length ? t.warn : r[2] === 'verified' || r[2] === 'gateway' ? (t.ok || t.accent) : r[2] === 'prg' || r[2] === 'experimental' || r[2] === 'detected' ? t.warn : t.crit;
                const txt = unconfirmed.length ? 'Last seen' : m.supportText(r[2]);
                const cw = cv.textWidth(ascii(txt).toUpperCase(), 12, { font: 'bold', spacing: 1, literal: true }) + 18;
                chip(cv, EDGE + lw - 36 - cw, y + 8, txt, c, 12);
            });
        }
        const rx = EDGE + lw + 16, rw = W - EDGE - rx;
        G.panel(cv, t, rx, TOP, rw, FOOT_Y - TOP - 14, '');
        cv.text('ALL CONTROL UNITS', rx + 24, TOP + 34, 14, t.dim, { font: 'bold', spacing: 2, literal: true });
        const units = p ? p.units : [], cols = 2, per = 12, cw = (rw - 48 - 16) / cols, start = m.unitsPage * per;
        units.slice(start, start + per).forEach((u, k) => {
            const x = rx + 24 + (k % cols) * (cw + 16), y = TOP + 64 + Math.floor(k / cols) * 34;
            cv.text(u.addressHex, x, y, 15, u.light ? (t.sel || t.accent) : t.dim, { font: 'bold', literal: true });
            label(cv, (u.name || u.index || 'no identity') + (u.role ? '  ' + u.role : ''), x + 56, y, 15, t.text, cw - 60);
        });
        if (!units.length) paragraph(cv, 'The list appears after the scan.', rx + 24, TOP + 74, 17, t.dim, rw - 48, 2);
        button(cv, t, rx + 20, TOP + 264, rw - 40, 46, (m.commOff ? 'On' : 'Off') + ': test - headlamps ignore car messages', a.toggleCommOff, 'COMM',
            { on: m.commOff, size: 15, color: m.commOff ? t.warn : null, off: m.runner.busy });
        paragraph(cv, 'Test option (like BimmerLight, 28 02 01): during a show the headlamp modules ignore the car\'s own light requests; normal communication returns at the end. SUPPORTED = tested in a car, FROM BMW DATA = from the BMW PRG.',
            rx + 24, TOP + 330, 13.5, t.dim, rw - 48, 3);
        const pages = Math.max(1, Math.ceil(units.length / per));
        footer(cv, t, m.notice || (m.recoveryUnreadable ? 'Recovery file unreadable: check every normal light with the car\'s own switches, then confirm.' : m.runner.state === 'SCANNING' ? m.runner.note : 'Park in P to scan. The scan only reads identities and vehicle order.'),
            m.recoveryUnreadable ? t.crit : null, [
                m.recoveryUnreadable ? { text: 'Lights checked', w: 230, key: 'ACK', run: a.acknowledge, color: t.warn } : null,
                pages > 1 ? { text: 'More units', w: 190, key: 'UNITS', run: a.nextUnits } : null,
                { text: m.runner.state === 'SCANNING' ? 'Scanning...' : p ? 'Scan again' : 'Scan vehicle', w: 240, key: 'SCAN', run: a.scan, primary: true, off: m.runner.busy || m.runner.recoveryPending || !m.allowed },
            ]);
    }
    function card(cv, x, y, w, h) { cv.roundRect(x, y, w, h, 10, withAlpha('#b4bccc', 0.07)); }

    /* ---------------- Phone ---------------- */
    function qr(cv, t, link, x, y, size) {
        let code = null;
        if (link) try { code = qrcode(0, 'M'); code.addData(link); code.make(); } catch (_) { code = null; }
        cv.roundRect(x, y, size, size, 14, code ? '#ffffff' : withAlpha('#000000', 0.45));
        if (!code) { cv.text('NO LINK', x + size / 2, y + size / 2, 22, t.warn, { align: 'center', font: 'bold', literal: true }); return; }
        const n = code.getModuleCount(), quiet = 3, cell = Math.floor(size / (n + quiet * 2)), span = cell * (n + quiet * 2);
        const ox = x + Math.floor((size - span) / 2), oy = y + Math.floor((size - span) / 2);
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
            if (code.isDark(r, c)) cv.fillRect(ox + (c + quiet) * cell, oy + (r + quiet) * cell, cell, cell, '#05070a');
    }
    function drawPhone(cv, t, m, a) {
        const ph = m.phone, size = 330;
        G.panel(cv, t, EDGE, TOP, size + 48, FOOT_Y - TOP - 14, '');
        qr(cv, t, ph.ready ? ph.link : null, EDGE + 24, TOP + 22, size);
        label(cv, ph.ready ? 'Scan with the phone camera' : 'Waiting for the network', EDGE + 24 + size / 2, TOP + size + 54, 17, ph.ready ? t.text : t.warn, size, { align: 'center' });
        const x = EDGE + size + 64, w = W - EDGE - x;
        G.panel(cv, t, x, TOP, w, FOOT_Y - TOP - 14, '');
        cv.text('CONTROL THE LIGHTS FROM YOUR PHONE', x + 26, TOP + 36, 15, t.dim, { font: 'bold', spacing: 2, literal: true });
        const steps = [
            ['Join the car\'s Wi-Fi hotspot with the phone', true],
            ['Firewall helper mgu-light-net', ph.net.ready, ph.net.ready ? 'port ' + ph.port + ' open' : ph.net.error || 'waiting'],
            ['Light Show phone server', ph.listening, ph.listening ? 'listening' : ph.error || 'starting'],
            ['Phone connected', ph.connected, ph.connected ? 'now' : 'scan the code'],
        ];
        steps.forEach((s, i) => {
            const y = TOP + 80 + i * 52;
            cv.circle(x + 38, y - 6, 10, s[1] ? (t.ok || t.accent) : withAlpha(t.warn, 0.9));
            label(cv, s[0], x + 62, y, 19, t.text, w - 360, { font: 'bold' });
            if (s[2]) label(cv, s[2], x + w - 26, y, 16, s[1] ? t.dim : t.warn, 300, { align: 'right' });
        });
        paragraph(cv, 'The phone page shows the same lights, tests and effects as this screen, with a 3D car you can turn. ' +
            'Every command still needs P and standstill. The code changes with every start of the app.', x + 26, TOP + 300, 16, t.dim, w - 52, 3);
        label(cv, ph.link || '', x + 26, TOP + 376, 14, withAlpha(t.dim, 0.8), w - 52);
        footer(cv, t, m.notice || 'No Internet needed: the phone talks to the head unit over the car Wi-Fi.', null, [
            { text: 'Stop', w: 150, key: 'STOP_P', run: a.stop, color: t.crit, off: !m.runner.busy && !m.runner.recoveryPending },
        ]);
    }

    function draw(cv, t, m, a) {
        cv.clear(t.bg);
        const badge = m.allowed ? { text: 'PARKED', color: t.ok || t.accent } : { text: m.lock === 'moving' ? 'NOT IN P' : 'LOCKED', color: t.crit };
        const badges = [m.runner.busy ? { text: m.runner.state === 'RUNNING' ? 'SHOW RUNNING' : m.runner.state, color: t.accent2 || t.accent } : null,
            m.phone.connected ? { text: 'PHONE', color: t.accent2 || t.accent } : null, badge];
        G.frame(cv, t, TABS, m.page, badges);
        if (m.page === PAGE.LIGHTS) drawLights(cv, t, m, a);
        else if (m.page === PAGE.VEHICLE) drawVehicle(cv, t, m, a);
        else if (m.page === PAGE.PHONE) drawPhone(cv, t, m, a);
        else drawShow(cv, t, m, a);
        return cv;
    }
    return { draw, fit };
}

module.exports = { makeUi, ascii, TABS, PAGE, LIGHTS_PER_PAGE, W, H };
