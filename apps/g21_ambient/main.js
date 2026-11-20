'use strict';

const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const A = require('./logic');
const { SafeDiag } = require('./safe_diag');
const { AmbientProfiles, MODES, modeFromSignal } = require('./ambient_profiles');

// The renderer itself adds the single native Settings tab via BTN_SETTINGS.
const TABS = ['Color', 'Favorites', 'Drive modes', 'Diagnostics'];
const COLOR = 0, FAVORITES = 1, DRIVE_MODES = 2, DIAGNOSTICS = 3;
const OFF = A.COLORS.length - 1;
const DEFAULT_RGB = [0, 127, 254];
const PICKER = { x: 56, y: 130, w: 632, h: 140, cols: 24, rows: 11 };
const RGB_SLIDERS = [
    { key: 'customRed', label: 'R', y: 285 },
    { key: 'customGreen', label: 'G', y: 324 },
    { key: 'customBlue', label: 'B', y: 363 },
];
const BRIGHTNESS_Y = 419;
const SLIDER_X = 145, SLIDER_W = 490;
const text = (cv, s, x, y, size, color, options) => cv.text(String(s), x, y, size, color, options || {});
const rgbHex = rgb => rgb.map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase();
function button(cv, t, x, y, w, label, run, key, active = false) {
    cv.fillRect(x, y, w, 44, active ? '#216071' : '#253342');
    text(cv, label, x + 13, y + 29, 20, active ? '#ffffff' : t.text);
    if (cv.own && run) cv.target(x, y, w, 44, run, key);
}
function status(cv, value, x, y, width, color) {
    let remaining = String(value);
    for (let line = 0; line < 2 && remaining; line++) {
        let end = remaining.length;
        const suffix = line === 1 && cv.textWidth(remaining, 20) > width ? '…' : '';
        while (end > 0 && cv.textWidth(remaining.slice(0, end) + suffix, 20) > width) end--;
        if (line === 0 && end < remaining.length) {
            const space = remaining.lastIndexOf(' ', end);
            if (space > 0) end = space;
        }
        text(cv, remaining.slice(0, end) + suffix, x, y + line * 25, 20, color);
        remaining = remaining.slice(end).trim();
    }
}

const SWATCHES = A.SATURATIONS.slice().reverse().map(saturation =>
    A.HUES.map(hue => '#' + rgbHex(A.hsvToRgb(hue, saturation))));


function drawPicker(cv, hue, saturation, active) {
    const p = PICKER;
    for (let row = 0; row < p.rows; row++) {
        for (let col = 0; col < p.cols; col++) {
            const left = Math.ceil(col * p.w / p.cols), right = Math.ceil((col + 1) * p.w / p.cols);
            const top = Math.ceil(row * p.h / p.rows), bottom = Math.ceil((row + 1) * p.h / p.rows);
            cv.fillRect(p.x + left, p.y + top, right - left, bottom - top,
                SWATCHES[row][col]);
        }
    }
    if (active) {
        const col = A.HUES.indexOf(hue), row = (100 - saturation) / 10;
        if (col >= 0 && Number.isInteger(row) && row >= 0 && row < p.rows) {
            cv.strokeRoundRect(p.x + Math.round(col * p.w / p.cols) - 2,
                p.y + Math.round(row * p.h / p.rows) - 2,
                Math.ceil(p.w / p.cols) + 4, Math.ceil(p.h / p.rows) + 4, 4, 3, '#ffffff');
        }
    }
}
function drawRgbSlider(cv, t, spec, value, isSelected) {
    const y = spec.y;
    text(cv, spec.label, 58, y + 15, 24, isSelected ? t.accent : t.text, { font: 'bold' });
    cv.fillRect(SLIDER_X, y, SLIDER_W, 18, '#233243');
    cv.fillRect(SLIDER_X, y, Math.round(SLIDER_W * value / 254), 18,
        spec.label === 'R' ? '#ee5866' : spec.label === 'G' ? '#49d59e' : '#5c91ff');
    cv.strokeRoundRect(SLIDER_X + Math.round(SLIDER_W * value / 254) - 5, y - 4, 10, 25,
        4, 2, '#ffffff');
    text(cv, String(value).padStart(3, ' '), 650, y + 16, 22, t.text, { font: 'num' });
}
function drawBrightnessSlider(cv, t, value) {
    text(cv, 'BRT', 58, BRIGHTNESS_Y + 15, 22, t.text, { font: 'bold' });
    cv.fillRect(SLIDER_X, BRIGHTNESS_Y, SLIDER_W, 18, '#233243');
    cv.fillRect(SLIDER_X, BRIGHTNESS_Y, Math.round(SLIDER_W * value / 100), 18, '#f1c65b');
    cv.strokeRoundRect(SLIDER_X + Math.round(SLIDER_W * value / 100) - 5,
        BRIGHTNESS_Y - 4, 10, 25, 4, 2, '#ffffff');
    text(cv, value + '%', 650, BRIGHTNESS_Y + 16, 22, t.text, { font: 'num' });
}

mgu.run({
    async start(ctx) {
        const settings = ctx.settings;
        const ctl = new SafeDiag(ctx);
        const profiles = new AmbientProfiles(settings);
        let tab = COLOR, rgbChannel = 0, favoriteSelected = 0, modeSelected = 0;
        let driveMode = null, colorNotice = '', favoriteNotice = '', modeNotice = '', menuPlan = null;
        let touchedSlider = null, lastDragUpdate = 0, editRevision = 0;

        const number = (key, min, max, fallback) => {
            const value = settings.get(key);
            const n = typeof value === 'string' && value.trim() ? Number(value) : value;
            return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
        };
        const presetIndex = () => number('presetColor', 0, OFF, 0);
        const hue = () => number('customHue', 0, 359, 210);
        const saturation = () => number('customSat', 0, 100, 100);
        const brightness = () => number('brightness', 0, 100, 50);
        const duration = () => number('duration', 1, 254, 5);
        const selected = () => settings.get('colorMode') === 'custom'
            ? A.exactColor(RGB_SLIDERS.map((s, i) => number(s.key, 0, 254, DEFAULT_RGB[i])))
            : A.COLORS[presetIndex()];
        const target = () => settings.get('applyTarget') === 'slot11' ? 'slot11' : 'temporary';
        const setMany = change => settings.setMany(change);
        const resetConfirmation = () => {
            editRevision++;
            ctl.cancel();
            colorNotice = '';
            menuPlan = null;
        };
        const setTab = index => {
            if (!Number.isInteger(index) || index < 0 || index >= TABS.length) return;
            resetConfirmation();
            touchedSlider = null;
            tab = index;
        };
        settings.onChange(resetConfirmation);
        if (settings.get('applyTarget') === 'bdc') settings.set('applyTarget', 'temporary');
        if (settings.get('colorMode') === 'saved') settings.set('colorMode', 'preset');
        if (Number(settings.get('presetColor')) === 6) settings.set('presetColor', '0');

        const updateRGB = (rgb, grid = A.rgbToGrid(rgb), extra = {}) => setMany(Object.assign({
            colorMode: 'custom', customRed: rgb[0], customGreen: rgb[1], customBlue: rgb[2],
            customHue: grid.hue, customSat: grid.saturation,
        }, extra));
        const updateGrid = (h, s) => updateRGB(A.hsvToRgb(h, s), { hue: h, saturation: s });
        const setBrightness = value => {
            const next = Math.max(0, Math.min(100, Math.round(value)));
            if (next !== brightness()) settings.set('brightness', next);
        };
        const changeRGB = value => {
            const rgb = selected().rgb.slice();
            rgb[rgbChannel] = Math.max(0, Math.min(254, value));
            updateRGB(rgb);
        };
        const snapshot = () => profiles.snapshot(selected(), brightness());
        const loadSnapshot = look => {
            if (!look) return false;
            const { rgb, brightness: level, on } = look.main;
            if (on === 0) setMany({ colorMode: 'preset', presetColor: String(OFF), brightness: level });
            else updateRGB(rgb, A.rgbToGrid(rgb), { brightness: level });
            return true;
        };
        const chooseTarget = value => {
            if (value !== target()) settings.set('applyTarget', value);
        };
        const planFactory = () => {
            chooseTarget('slot11');
            menuPlan = A.slot11RestorePlan();
        };
        const applyChoice = async () => {
            if (tab !== COLOR) return;
            if (target() === 'slot11') {
                menuPlan = A.slot11Plan(selected().rgb);
                return;
            }
            const revision = editRevision;
            colorNotice = '';
            await ctl.apply(selected(), brightness(), duration(), () => revision === editRevision);
            if (revision === editRevision) colorNotice = ctl.info;
        };
        const saveFavorite = () => {
            profiles.saveFavorite(favoriteSelected, snapshot());
            favoriteNotice = 'Favorite ' + (favoriteSelected + 1) + ' saved.';
        };
        const loadFavorite = () => {
            favoriteNotice = loadSnapshot(profiles.loadFavorite(favoriteSelected))
                ? 'Favorite loaded into the editor.' : 'Favorite is empty.';
        };
        const deleteFavorite = () => {
            profiles.clearFavorite(favoriteSelected);
            favoriteNotice = 'Favorite deleted.';
        };
        const activeMode = () => MODES[modeSelected];
        const saveDriveMode = () => {
            profiles.saveMode(activeMode(), snapshot());
            modeNotice = 'Look saved.';
        };
        const loadDriveMode = () => {
            modeNotice = loadSnapshot(profiles.mode(activeMode())) ? 'Look loaded into the editor.' : 'No look saved.';
        };
        const clearDriveMode = () => {
            profiles.clearMode(activeMode());
            modeNotice = 'Look deleted.';
        };
        const followDriveMode = () => {
            const follow = profiles.toggleFollow();
            if (follow && loadSnapshot(profiles.mode(driveMode))) modeNotice = 'Current driving mode loaded into the editor.';
            else modeNotice = follow ? 'Driving-mode previews enabled.' : 'Driving-mode previews disabled.';
        };

        const page = (index, action) => () => { if (tab === index) return action(); };
        ctx.ui.onClick('BTN_PAGE', () => setTab((tab + 1) % TABS.length));
        ctx.ui.onClick('BTN_MODE', page(COLOR, () => {
            if (settings.get('colorMode') === 'custom') settings.set('colorMode', 'preset');
            else updateRGB(selected().rgb);
        }));
        ctx.ui.onClick('BTN_COLOR', page(COLOR, () => {
            if (settings.get('colorMode') === 'custom') updateGrid((hue() + 15) % 360, saturation());
            else settings.set('presetColor', String((presetIndex() + 1) % A.COLORS.length));
        }));
        ctx.ui.onClick('BTN_SAT', page(COLOR, () => updateGrid(hue(), (Math.floor(saturation() / 10) * 10 + 10) % 110)));
        ctx.ui.onClick('BTN_RGB_NEXT', page(COLOR, () => { rgbChannel = (rgbChannel + 1) % RGB_SLIDERS.length; }));
        ctx.ui.onClick('BTN_RGB_DOWN', page(COLOR, () => changeRGB(selected().rgb[rgbChannel] - 1)));
        ctx.ui.onClick('BTN_RGB_UP', page(COLOR, () => changeRGB(selected().rgb[rgbChannel] + 1)));
        ctx.ui.onClick('BTN_TARGET', page(COLOR, () => chooseTarget(target() === 'slot11' ? 'temporary' : 'slot11')));
        ctx.ui.onClick('BTN_RESTORE', page(COLOR, planFactory));
        ctx.ui.onClick('BTN_FAV_NEXT', page(FAVORITES, () => { favoriteSelected = (favoriteSelected + 1) % 6; }));
        ctx.ui.onClick('BTN_FAV_SAVE', page(FAVORITES, saveFavorite));
        ctx.ui.onClick('BTN_FAV_LOAD', page(FAVORITES, loadFavorite));
        ctx.ui.onClick('BTN_MODE_NEXT', page(DRIVE_MODES, () => { modeSelected = (modeSelected + 1) % MODES.length; }));
        ctx.ui.onClick('BTN_MODE_SAVE', page(DRIVE_MODES, saveDriveMode));
        ctx.ui.onClick('BTN_BRIGHT', page(COLOR, () => setBrightness((Math.floor(brightness() / 10) * 10 + 10) % 110)));
        ctx.ui.onClick('BTN_BRIGHT_DOWN', page(COLOR, () => setBrightness(brightness() - 1)));
        ctx.ui.onClick('BTN_BRIGHT_UP', page(COLOR, () => setBrightness(brightness() + 1)));
        ctx.ui.onClick('BTN_ACTION', () => {
            if (tab === DIAGNOSTICS) return ctl.readRam();
            if (tab === COLOR) return applyChoice();
        });
        ctx.ui.onClick('BTN_BDC_STATUS', page(DIAGNOSTICS, () => ctl.readBdc()));
        ctx.onTab(setTab);
        const cancelOnHide = (name, visible) => { if (name === 'MAIN' && !visible) resetConfirmation(); };
        if (typeof ctx.ui.onVisible === 'function') ctx.ui.onVisible(cancelOnHide);
        if (typeof ctx.ui.onFocus === 'function') ctx.ui.onFocus(cancelOnHide);
        if (typeof ctx.hideButton === 'function') {
            ['BTN_PAGE', 'BTN_TARGET', 'BTN_ACTION', 'BTN_RESTORE', 'BTN_BDC_STATUS',
                'BTN_FAV_NEXT', 'BTN_FAV_SAVE', 'BTN_FAV_LOAD', 'BTN_MODE_NEXT', 'BTN_MODE_SAVE']
                .forEach(id => ctx.hideButton(id));
        }
        if (typeof ctx.onTouch === 'function') ctx.onTouch((phase, x, y) => {
            if (tab !== COLOR || !Number.isFinite(x) || !Number.isFinite(y)) {
                touchedSlider = null;
                return;
            }
            if (phase === 1) {
                touchedSlider = null;
                if (x >= PICKER.x && x < PICKER.x + PICKER.w && y >= PICKER.y && y < PICKER.y + PICKER.h) {
                    touchedSlider = 'picker';
                } else if (x >= SLIDER_X - 12 && x <= SLIDER_X + SLIDER_W + 12) {
                    const channel = RGB_SLIDERS.findIndex(s => y >= s.y - 9 && y <= s.y + 28);
                    if (channel >= 0) touchedSlider = channel;
                    else if (y >= BRIGHTNESS_Y - 9 && y <= BRIGHTNESS_Y + 28) touchedSlider = 'brightness';
                }
            }
            const now = Date.now();
            if (touchedSlider !== null && (phase === 1 || (phase === 2 && now - lastDragUpdate >= 100) || phase === 3)) {
                if (touchedSlider === 'picker') {
                    const px = Math.max(PICKER.x, Math.min(PICKER.x + PICKER.w - 1, x));
                    const py = Math.max(PICKER.y, Math.min(PICKER.y + PICKER.h - 1, y));
                    const cell = A.pickerCell(px, py, PICKER.x, PICKER.y, PICKER.w, PICKER.h);
                    updateGrid(cell.hue, cell.saturation);
                } else if (touchedSlider === 'brightness') {
                    setBrightness((x - SLIDER_X) * 100 / SLIDER_W);
                } else {
                    rgbChannel = touchedSlider;
                    changeRGB(Math.round((x - SLIDER_X) * 254 / SLIDER_W));
                }
                lastDragUpdate = now;
            }
            if (phase === 3) touchedSlider = null;
        });

        ctl.init().catch(e => { ctl.ramStatus = 'TASU initialization: ' + e; });
        ctx.signals.watch('de.bmw.infotainment.drivingexcitement.FES', '1', {
            statusFESVehicleDynamicSwitchHMI: value => {
                const next = modeFromSignal(value);
                if (driveMode === next) return;
                driveMode = next;
                if (next && profiles.data.follow && loadSnapshot(profiles.mode(next))) {
                    modeNotice = next.toUpperCase() + ' look loaded into the editor.';
                }
            },
        }, ctx.log, { pollMs: 2500 }).catch(e => ctx.log.warn('FES ambient mode: ' + e));

        let presetGrid = null, gridPreset = null;
        ctx.loop('MAIN', 8, () => {
            const t = ctx.theme(), cv = ctx.canvas(1600, 520).clear(t.bg);
            G.frame(cv, t, TABS, tab, []);
            if (tab === COLOR) {
                const color = selected(), level = brightness();
                const custom = settings.get('colorMode') === 'custom';
                if (!custom && gridPreset !== color) {
                    gridPreset = color;
                    presetGrid = A.rgbToGrid(color.rgb);
                }
                const grid = custom ? { hue: hue(), saturation: saturation() } : presetGrid;
                G.panel(cv, t, 24, 62, 701, 445, 'Color picker');
                drawPicker(cv, grid.hue, grid.saturation, color.on === 1);
                RGB_SLIDERS.forEach((s, i) => drawRgbSlider(cv, t, s, color.rgb[i], i === rgbChannel));
                drawBrightnessSlider(cv, t, level);
                text(cv, 'RGB 0–254', 56, 478, 19, t.dim);

                G.panel(cv, t, 746, 62, 830, 445, 'Preview');
                cv.fillRect(778, 120, 760, 96, '#' + rgbHex(color.rgb.map(n => Math.round(n * level / 100))));
                text(cv, color.name + '  #' + rgbHex(color.rgb), 785, 253, 34, t.text, { font: 'bold' });
                text(cv, 'RGB ' + color.rgb.join(' / ') + '    Brightness ' + level + '%', 785, 285, 22, t.dim);
                const slot = target() === 'slot11';
                button(cv, t, 778, 309, 235, 'RAM TEST · ' + duration() + ' s', page(COLOR, () => chooseTarget('temporary')), 'ram', !slot);
                button(cv, t, 1023, 309, 235, 'MENU 11 PLAN', page(COLOR, () => chooseTarget('slot11')), 'slot', slot);
                button(cv, t, 1268, 309, 269, slot ? 'PREPARE PLAN' : ctl.confirming ? 'CONFIRM APPLY' : 'APPLY',
                    applyChoice, 'apply', true);
                if (slot) {
                    button(cv, t, 778, 365, 260, 'FACTORY PLAN', page(COLOR, planFactory), 'factory');
                    const planText = menuPlan
                        ? menuPlan.codingReady === false
                            ? 'Position 11 (' + menuPlan.oldProfile.join(' / ') + ') · requested #' + rgbHex(menuPlan.desiredRGB) + ' · mapping unverified'
                            : 'Factory profile 05 / 00 · Lilac #' + rgbHex(menuPlan.factoryLilacRGB)
                        : 'Preview of existing iDrive color 11.';
                    status(cv, planText, 785, 439, 745, t.text);
                    text(cv, 'Offline plan. The vehicle is unchanged.', 785, 491, 19, t.dim);
                } else {
                    const notice = ctl.busy ? 'Diagnostics running…'
                        : ctl.confirming ? ctl.info
                            : !ctl.online ? 'TASU unavailable.'
                                : colorNotice && !colorNotice.startsWith('Press APPLY again') ? colorNotice
                                    : 'Press APPLY twice at standstill.';
                    status(cv, notice, 785, 407, 745, t.text);
                    text(cv, 'Retrofit lights may use a separate controller.', 785, 491, 18, t.dim);
                }
            } else if (tab === FAVORITES) {
                G.panel(cv, t, 24, 62, 1552, 445, 'Saved looks');
                for (let i = 0; i < 6; i++) {
                    const x = 44 + (i % 3) * 505, y = 109 + Math.floor(i / 3) * 124;
                    const look = profiles.loadFavorite(i);
                    cv.fillRect(x, y, 477, 110, i === favoriteSelected ? '#204b5b' : '#222e3c');
                    text(cv, 'Favorite ' + (i + 1), x + 20, y + 35, 27, t.text, { font: 'bold' });
                    if (look) {
                        cv.fillRect(x + 20, y + 52, 75, 38, '#' + rgbHex(look.main.rgb));
                        text(cv, (look.main.on ? '#' + rgbHex(look.main.rgb) : 'Off') + '   ' + look.main.brightness + '%',
                            x + 112, y + 78, 23, t.text);
                    } else text(cv, 'Empty', x + 20, y + 81, 21, t.dim);
                    if (cv.own) cv.target(x, y, 477, 110, page(FAVORITES, () => { favoriteSelected = i; favoriteNotice = ''; }), 'favorite-' + i);
                }
                button(cv, t, 44, 374, 250, 'SAVE', page(FAVORITES, saveFavorite), 'save-fav');
                button(cv, t, 304, 374, 250, 'LOAD', page(FAVORITES, loadFavorite), 'load-fav');
                button(cv, t, 564, 374, 250, 'DELETE', page(FAVORITES, deleteFavorite), 'delete-fav');
                text(cv, favoriteNotice || 'Loading a look updates the editor.', 50, 472, 20, t.dim);
            } else if (tab === DRIVE_MODES) {
                G.panel(cv, t, 24, 62, 766, 445, 'Driving-mode looks');
                G.panel(cv, t, 805, 62, 771, 445, 'Selected mode');
                MODES.forEach((name, i) => {
                    const y = 124 + i * 76, look = profiles.mode(name);
                    button(cv, t, 54, y, 710, name.toUpperCase(), page(DRIVE_MODES, () => {
                        modeSelected = i;
                        modeNotice = '';
                    }), 'mode-' + name, i === modeSelected);
                    text(cv, look ? look.main.on ? '#' + rgbHex(look.main.rgb) : 'Off' : 'No look',
                        492, y + 29, 21, t.text);
                });
                text(cv, 'Vehicle mode · ' + (driveMode ? driveMode.toUpperCase() : 'unavailable'), 55, 477, 21, t.dim);
                text(cv, activeMode().toUpperCase(), 840, 140, 29, t.text, { font: 'bold' });
                const look = profiles.mode(activeMode());
                text(cv, look ? (look.main.on ? '#' + rgbHex(look.main.rgb) : 'Off') + '   ' + look.main.brightness + '%' : 'No saved look',
                    840, 195, 23, t.text);
                button(cv, t, 840, 226, 297, 'SAVE CURRENT LOOK', page(DRIVE_MODES, saveDriveMode), 'save-mode');
                button(cv, t, 1150, 226, 340, 'LOAD INTO EDITOR', page(DRIVE_MODES, loadDriveMode), 'load-mode');
                button(cv, t, 840, 286, 297, 'DELETE LOOK', page(DRIVE_MODES, clearDriveMode), 'delete-mode');
                button(cv, t, 1150, 286, 340, profiles.data.follow ? 'FOLLOW MODE · ON' : 'FOLLOW MODE · OFF',
                    page(DRIVE_MODES, followDriveMode), 'follow-mode', profiles.data.follow);
                text(cv, modeNotice, 840, 397, 20, t.text);
                text(cv, 'Following the driving mode only changes the editor.', 840, 469, 20, t.dim);
            } else {
                G.panel(cv, t, 24, 62, 761, 445, 'RAM01 diagnostics');
                text(cv, ctl.online ? 'TASU connected' : 'TASU unavailable', 56, 139, 24, ctl.online ? t.accent : t.warn);
                status(cv, '0x37 · 22 F150 · ' + ctl.ramStatus, 56, 186, 690, t.text);
                text(cv, 'Vehicle speed · ' + (ctl.speedFresh ? ctl.speed.toFixed(1) + ' km/h' : 'unavailable or stale'),
                    56, 251, 23, t.text);
                text(cv, 'Last RAM write · 2E E311', 56, 300, 22, t.dim);
                status(cv, ctl.lastWrite ? ctl.lastWrite.text : 'No write requested', 56, 332, 690,
                    ctl.lastWrite && !ctl.lastWrite.acknowledged ? t.warn : t.text);
                button(cv, t, 56, 410, 250, 'READ RAM IDENTITY', page(DIAGNOSTICS, () => ctl.readRam()), 'read-ram');

                G.panel(cv, t, 805, 62, 771, 445, 'BDC diagnostic reads');
                status(cv, '0x40 · 22 DA5F · ' + ctl.bdcStatus[0], 835, 146, 690, t.text);
                status(cv, '0x40 · 22 E3D1 · ' + ctl.bdcStatus[1], 835, 217, 690, t.text);
                text(cv, 'The response shows diagnostic access to the BDC.', 835, 309, 20, t.dim);
                text(cv, 'Retrofit wiring determines which controller can change the lights.', 835, 342, 19, t.dim);
                button(cv, t, 835, 410, 250, 'READ BDC STATUS', page(DIAGNOSTICS, () => ctl.readBdc()), 'read-bdc');
            }
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
