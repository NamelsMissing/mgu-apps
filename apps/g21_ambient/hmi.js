'use strict';

const G = require('./kit/gauges');
const A = require('./logic');

const TABS = ['Color', 'Favorites', 'Drive modes', 'Diagnostics'];
const COLOR = 0, FAVORITES = 1, DRIVE_MODES = 2, DIAGNOSTICS = 3;
const PICKER = { x: 56, y: 168, w: 632, h: 124 };
const TRACK = { x: 155, w: 445 };
const SLIDERS = [
    { key: 'customRed', title: 'Red', y: 312, max: 254, tint: '#EE5866' },
    { key: 'customGreen', title: 'Green', y: 355, max: 254, tint: '#49D59E' },
    { key: 'customBlue', title: 'Blue', y: 398, max: 254, tint: '#5C91FF' },
    { key: 'brightness', title: 'Brightness', y: 452, max: 100, unit: '%', tint: '#F1C65B' },
];
const PRESET_LABELS = ['Warm', 'Blue', 'Red', 'Green', 'Violet', 'Off'];
const text = (cv, s, x, y, size, color, options) => cv.text(String(s), x, y, size, color, options || {});
const rgbHex = rgb => rgb.map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
const swatches = A.SATURATIONS.slice().reverse().map(saturation =>
    A.HUES.map(hue => '#' + rgbHex(A.hsvToRgb(hue, saturation))));

function button(cv, t, x, y, w, h, label, active, tint) {
    cv.roundRect(x, y, w, h, 8, active ? '#256275' : '#253342');
    if (tint) cv.roundRect(x + 8, y + (h - 12) / 2, 12, 12, 3, tint);
    text(cv, label, x + (tint ? 26 : 14), y + h / 2 + 7, 22, active ? '#FFFFFF' : t.text);
}

function status(cv, message, x, y, width, color) {
    let remaining = String(message);
    for (let line = 0; line < 2 && remaining; line++) {
        let end = remaining.length;
        const suffix = line === 1 && cv.textWidth(remaining, 22) > width ? '…' : '';
        while (end > 0 && cv.textWidth(remaining.slice(0, end) + suffix, 22) > width) end--;
        if (line === 0 && end < remaining.length) {
            const space = remaining.lastIndexOf(' ', end);
            if (space > 0) end = space;
        }
        text(cv, remaining.slice(0, end) + suffix, x, y + line * 27, 22, color);
        remaining = remaining.slice(end).trim();
    }
}

function drawPicker(cv, grid, on) {
    const p = PICKER;
    swatches.forEach((row, iy) => row.forEach((value, ix) => {
        const x = Math.ceil(ix * p.w / row.length), right = Math.ceil((ix + 1) * p.w / row.length);
        const y = Math.ceil(iy * p.h / swatches.length), bottom = Math.ceil((iy + 1) * p.h / swatches.length);
        cv.fillRect(p.x + x, p.y + y, right - x, bottom - y, value);
        if (on && A.HUES[ix] === grid.hue && 100 - A.SATURATIONS[iy] === grid.saturation) {
            cv.strokeRoundRect(p.x + x + 1, p.y + y + 1, right - x - 2, bottom - y - 2, 3, 2, '#FFFFFF');
        }
    }));
}

function drawColor(cv, t, m, control) {
    const { color, brightness, preset, grid, duration, notice, confirming, online, busy } = m;
    G.panel(cv, t, 24, 62, 701, 445, 'Color and brightness');
    PRESET_LABELS.forEach((label, i) => {
        const x = 56 + i * 105;
        button(cv, t, x, 111, 99, 41, label, preset === i, A.COLORS[i].on ? '#' + rgbHex(A.COLORS[i].rgb) : '#101820');
        control(x, 111, 99, 41, 'preset-' + i, () => m.choosePreset(i));
    });
    drawPicker(cv, grid, color.on);
    SLIDERS.forEach((spec, i) => {
        const value = i === SLIDERS.length - 1 ? brightness : color.rgb[i];
        const extent = Math.round(TRACK.w * value / spec.max), y = spec.y;
        text(cv, spec.title, 56, y + 12, 22, t.text);
        cv.roundRect(TRACK.x, y, TRACK.w, 14, 6, '#253342');
        if (extent) cv.roundRect(TRACK.x, y, extent, 14, 6, spec.tint);
        cv.strokeRoundRect(TRACK.x + extent - 5, y - 4, 10, 22, 4, 2, '#FFFFFF');
        button(cv, t, 621, y - 11, 70, 38, value + (spec.unit || ''), false);
        control(621, y - 11, 70, 38, spec.key, () => m.editSlider(i));
    });

    G.panel(cv, t, 746, 62, 830, 445, 'Preview');
    const shaded = color.rgb.map(n => Math.round(n * brightness / 100));
    cv.roundRect(778, 113, 760, 134, 12, '#' + rgbHex(shaded));
    text(cv, color.name, 778, 294, 35, t.text, { font: 'bold' });
    text(cv, '#' + rgbHex(color.rgb), 1538, 294, 32, t.text, { align: 'right', font: 'num' });
    text(cv, 'RAM01 test · ' + duration + ' s', 778, 340, 23, t.dim);
    button(cv, t, 778, 369, 368, 52, confirming ? 'Confirm temporary color' : 'Apply temporary color', online && !busy);
    control(778, 369, 368, 52, 'apply', m.apply);
    status(cv, notice, 778, 456, 753, online ? t.text : t.dim);
}

function lookText(look) {
    if (!look) return 'Empty';
    const { rgb, brightness, on } = look.main;
    return (on ? '#' + rgbHex(rgb) : 'Off') + '   ·   ' + brightness + '%';
}

function drawFavorites(cv, t, m, control) {
    G.panel(cv, t, 24, 62, 1552, 445, 'Saved looks');
    for (let i = 0; i < 6; i++) {
        const x = 44 + (i % 3) * 505, y = 109 + Math.floor(i / 3) * 122;
        const look = m.favorites[i];
        cv.roundRect(x, y, 477, 108, 12, i === m.selected ? '#204B5B' : '#222E3C');
        text(cv, 'Favorite ' + (i + 1), x + 20, y + 37, 26, t.text, { font: 'bold' });
        if (look) cv.roundRect(x + 20, y + 52, 64, 37, 6, '#' + rgbHex(look.main.rgb));
        text(cv, lookText(look), x + (look ? 106 : 20), y + 79, 23, look ? t.text : t.dim);
        control(x, y, 477, 108, 'favorite-' + i, () => m.select(i));
    }
    button(cv, t, 44, 375, 246, 48, 'Save current look', true);
    control(44, 375, 246, 48, 'save-fav', m.save);
    if (m.favorites[m.selected]) {
        button(cv, t, 302, 375, 235, 48, 'Load into editor', false);
        control(302, 375, 235, 48, 'load-fav', m.load);
        button(cv, t, 549, 375, 176, 48, 'Delete', false);
        control(549, 375, 176, 48, 'delete-fav', m.remove);
    }
    text(cv, m.notice, 47, 471, 21, t.dim);
}

function drawModes(cv, t, m, control) {
    G.panel(cv, t, 24, 62, 720, 445, 'Driving modes');
    G.panel(cv, t, 765, 62, 811, 445, 'Look for ' + m.modes[m.selected].name);
    m.modes.forEach(({ name, look }, i) => {
        const y = 115 + i * 72;
        button(cv, t, 54, y, 660, 53, name, i === m.selected);
        text(cv, lookText(look), 691, y + 34, 22, t.text, { align: 'right' });
        control(54, y, 660, 53, 'mode-' + name, () => m.select(i));
    });
    text(cv, 'Vehicle mode · ' + (m.driveMode || 'unavailable'), 54, 472, 22, t.dim);
    button(cv, t, 797, 129, 337, 50, 'Save current look', true);
    control(797, 129, 337, 50, 'save-mode', m.save);
    if (m.modes[m.selected].look) {
        button(cv, t, 1150, 129, 365, 50, 'Load into editor', false);
        control(1150, 129, 365, 50, 'load-mode', m.load);
        button(cv, t, 797, 194, 337, 50, 'Delete look', false);
        control(797, 194, 337, 50, 'delete-mode', m.remove);
    }
    button(cv, t, 797, 281, 400, 50, 'Follow vehicle mode · ' + (m.following ? 'On' : 'Off'), m.following);
    control(797, 281, 400, 50, 'follow-mode', m.follow);
    text(cv, m.notice, 797, 391, 22, t.text);
    text(cv, 'Follows the vehicle mode in the editor.', 797, 472, 21, t.dim);
}

function drawDiagnostics(cv, t, m, control) {
    const { diag, showingPlan, plan } = m;
    G.panel(cv, t, 24, 62, 761, 445, 'RAM01 diagnostics');
    text(cv, diag.online ? 'TASU connected' : 'TASU unavailable', 54, 139, 24, diag.online ? t.accent : t.warn);
    status(cv, '0x37 · 22 F150 · ' + diag.ramStatus, 54, 188, 690, t.text);
    text(cv, 'Vehicle speed · ' + (diag.speedFresh ? diag.speed.toFixed(1) + ' km/h' : 'unavailable or stale'), 54, 255, 23, t.text);
    text(cv, 'Last RAM result · 2E E311', 54, 309, 22, t.dim);
    status(cv, diag.lastWrite ? diag.lastWrite.text : 'No write requested', 54, 343, 690,
        diag.lastWrite && !diag.lastWrite.acknowledged ? t.warn : t.text);
    button(cv, t, 54, 415, 294, 50, 'Read RAM identity', false);
    control(54, 415, 294, 50, 'read-ram', m.readRam);

    G.panel(cv, t, 805, 62, 771, 445, showingPlan ? 'Menu position 11 · offline' : 'BDC diagnostics');
    if (showingPlan) {
        const planText = plan && plan.codingReady === false
            ? 'Current profile ' + plan.oldProfile.join(' / ') + ' · requested #' + rgbHex(plan.desiredRGB) + ' · mapping unverified'
            : plan ? 'Factory profile ' + plan.profile.join(' / ') + ' · Lilac #' + rgbHex(plan.factoryLilacRGB)
                : 'Select a plan for existing iDrive color position 11.';
        status(cv, planText, 835, 148, 690, t.text);
        button(cv, t, 835, 233, 325, 49, 'Use current color', false);
        control(835, 233, 325, 49, 'current-plan', m.currentPlan);
        button(cv, t, 1174, 233, 342, 49, 'Factory values', false);
        control(1174, 233, 342, 49, 'factory-plan', m.factoryPlan);
        text(cv, 'Read-only preview', 835, 345, 21, t.dim);
    } else {
        status(cv, '0x40 · 22 DA5F · ' + diag.bdcStatus[0], 835, 148, 690, t.text);
        status(cv, '0x40 · 22 E3D1 · ' + diag.bdcStatus[1], 835, 227, 690, t.text);
        text(cv, 'Retrofit lights may use a separate controller.', 835, 312, 21, t.dim);
        button(cv, t, 835, 415, 273, 50, 'Read BDC status', false);
        control(835, 415, 273, 50, 'read-bdc', m.readBdc);
    }
    button(cv, t, 1186, 415, 330, 50, showingPlan ? 'Back to BDC' : 'Menu 11 plan', false);
    control(1186, 415, 330, 50, 'menu-plan', m.togglePlan);
}

function valueEditor(spec, value, commit) {
    let draft = value;
    return {
        title: spec.title,
        move(delta) { draft = Math.max(0, Math.min(spec.max, draft + delta)); },
        press() { commit(draft); return 'close'; },
        back() { return 'close'; },
        draw(cv, t, fallback = false) {
            cv.clear(t.bg);
            G.panel(cv, t, 352, 100, 896, 380, spec.title);
            text(cv, draft + (spec.unit || ''), 800, 235, 76, t.text, { align: 'center', font: 'num' });
            const bar = Math.round(700 * draft / spec.max);
            cv.roundRect(450, 269, 700, 12, 5, '#253342');
            if (bar > 0) cv.roundRect(450, 269, bar, 12, 5, spec.tint);
            if (fallback) {
                text(cv, 'Previous / Next adjust · Select saves', 800, 367, 24, t.text, { align: 'center' });
                text(cv, 'Next page cancels', 800, 412, 21, t.dim, { align: 'center' });
                return [];
            }
            const targets = [
                { x: 451, w: 150, label: '−1', act: () => this.move(-1) },
                { x: 616, w: 150, label: '+1', act: () => this.move(1) },
                { x: 786, w: 170, label: 'Cancel', act: () => this.back() },
                { x: 970, w: 180, label: 'Set value', act: () => this.press() },
            ];
            targets.forEach(target => {
                target.y = 322; target.h = 52;
                button(cv, t, target.x, target.y, target.w, target.h, target.label, target.label === 'Set value');
            });
            text(cv, 'Turn the controller to adjust · Press to save', 800, 430, 21, t.dim, { align: 'center' });
            return targets;
        },
    };
}

function drawPage(cv, t, tab, model, control) {
    G.frame(cv, t, TABS, tab, []);
    [drawColor, drawFavorites, drawModes, drawDiagnostics][tab](cv, t, model, control);
}

module.exports = { TABS, COLOR, FAVORITES, DRIVE_MODES, DIAGNOSTICS, PICKER, TRACK, SLIDERS, drawPage, valueEditor };
