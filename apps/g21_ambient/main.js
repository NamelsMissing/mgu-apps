'use strict';

const mgu = require('./kit/mgu');
const A = require('./logic');
const QR = require('./qr_log');
const { SafeDiag } = require('./safe_diag');
const { AmbientProfiles, MODES, modeFromSignal } = require('./ambient_profiles');
const { TABS, COLOR, FAVORITES, DRIVE_MODES, DIAGNOSTICS, LOG, PICKER, TRACK, SLIDERS,
    drawPage, valueEditor } = require('./hmi');

const OFF = A.COLORS.length - 1;
const DEFAULT_RGB = [0, 127, 254];
const RGB = SLIDERS.slice(0, 3);
const BRIGHTNESS = 3;

mgu.run({
    async start(ctx) {
        const settings = ctx.settings;
        const ctl = new SafeDiag(ctx);
        const profiles = new AmbientProfiles(settings);
        let tab = COLOR, favoriteSelected = 0, modeSelected = 0;
        let driveMode = null, colorNotice = '', favoriteNotice = '', modeNotice = '';
        let diagnosticView = 'overview', diagnosticPage = 0, diagnosticRaw = false, guidedResult = false, plan = null;
        let logExport = null, exportError = '', logTouch = null, scrollDelta = 0;
        let touchedSlider = null, lastDragUpdate = 0, editRevision = 0;
        let fallbackControls = [], fallbackFocus = null, fallbackEditor = null;

        const number = (key, min, max, fallback) => {
            const value = settings.get(key);
            const n = typeof value === 'string' && value.trim() ? Number(value) : value;
            return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
        };
        const presetIndex = () => number('presetColor', 0, OFF, 0);
        const brightness = () => number('brightness', 0, 100, 50);
        const duration = () => number('duration', 1, 254, 5);
        const selectedPreset = () => settings.get('colorMode') === 'custom' ? null : presetIndex();
        const selected = () => selectedPreset() === null
            ? A.exactColor(RGB.map((s, i) => number(s.key, 0, 254, DEFAULT_RGB[i])))
            : A.COLORS[presetIndex()];

        const resetConfirmation = () => {
            editRevision++;
            ctl.cancel();
            colorNotice = '';
            plan = null;
        };
        const setTab = index => {
            if (!Number.isInteger(index) || index < 0 || index >= TABS.length) return;
            resetConfirmation();
            touchedSlider = null;
            fallbackEditor = null;
            fallbackFocus = null;
            fallbackControls = [];
            tab = index;
            logTouch = null;
            scrollDelta = 0;
        };
        ctl.setExperimentalLin(settings.get('experimentalLin') === 'on');
        settings.onChange(() => {
            resetConfirmation();
            ctl.setExperimentalLin(settings.get('experimentalLin') === 'on');
        });
        if (settings.get('colorMode') === 'saved') settings.set('colorMode', 'preset');
        if (Number(settings.get('presetColor')) === 6) settings.set('presetColor', '0');

        const updateRGB = (rgb, grid = A.rgbToGrid(rgb), extra = {}) => settings.setMany(Object.assign({
            colorMode: 'custom', customRed: rgb[0], customGreen: rgb[1], customBlue: rgb[2],
            customHue: grid.hue, customSat: grid.saturation,
        }, extra));
        const updateGrid = (hue, saturation) => updateRGB(A.hsvToRgb(hue, saturation), { hue, saturation });
        const choosePreset = index => settings.setMany({ colorMode: 'preset', presetColor: String(index) });
        const sliderValue = index => index === BRIGHTNESS ? brightness() : selected().rgb[index];
        const setSlider = (index, value) => {
            const next = Math.max(0, Math.min(SLIDERS[index].max, Math.round(value)));
            if (next === sliderValue(index)) return;
            if (index === BRIGHTNESS) {
                settings.set('brightness', next);
            } else {
                const rgb = selected().rgb.slice();
                rgb[index] = next;
                updateRGB(rgb);
            }
        };
        const editSlider = index => {
            resetConfirmation();
            touchedSlider = null;
            const editor = valueEditor(SLIDERS[index], sliderValue(index), value => setSlider(index, value));
            if (typeof ctx.sheet !== 'function' || !ctx.sheet(editor)) fallbackEditor = editor;
        };
        const snapshot = () => profiles.snapshot(selected(), brightness());
        const loadSnapshot = look => {
            const { rgb, brightness: level, on } = look.main;
            if (on === 0) settings.setMany({ colorMode: 'preset', presetColor: String(OFF), brightness: level });
            else updateRGB(rgb, A.rgbToGrid(rgb), { brightness: level });
        };
        const apply = async () => {
            if (tab !== COLOR || fallbackEditor) return;
            const revision = editRevision;
            colorNotice = '';
            if (!ctl.bdcTestTargets.length || !ctl.bdcSelection && ctl.bdcTestTargets.length > 1) {
                diagnosticView = 'control';
                setTab(DIAGNOSTICS);
                colorNotice = ctl.bdcGuidance;
                return;
            }
            await ctl.applyBdc(selected(), brightness(), duration(), () => revision === editRevision);
            if (revision === editRevision) colorNotice = ctl.info;
        };

        const moveFallback = delta => {
            if (fallbackEditor) { fallbackEditor.move(delta); return; }
            if (!fallbackControls.length) return;
            const index = fallbackControls.findIndex(item => item.key === fallbackFocus);
            const next = index < 0 ? 0 : (index + delta + fallbackControls.length) % fallbackControls.length;
            fallbackFocus = fallbackControls[next].key;
        };
        const activateFallback = () => {
            if (fallbackEditor) {
                const editor = fallbackEditor;
                fallbackEditor = null;
                return editor.press();
            }
            const item = fallbackControls.find(control => control.key === fallbackFocus);
            if (item) return item.run();
        };
        ctx.ui.onClick('BTN_PAGE', () => setTab((tab + 1) % TABS.length));
        ctx.ui.onClick('BTN_PREV', () => moveFallback(-1));
        ctx.ui.onClick('BTN_NEXT', () => moveFallback(1));
        ctx.ui.onClick('BTN_ACTION', activateFallback);
        ctx.ui.onClick('BTN_SETTINGS', () => {
            resetConfirmation();
            fallbackEditor = null;
            touchedSlider = null;
        });
        ctx.onTab(setTab);
        const cancelOnHide = (name, visible) => {
            if (name !== 'MAIN' || visible) return;
            resetConfirmation();
            fallbackEditor = null;
            touchedSlider = null;
            fallbackControls = [];
        };
        if (typeof ctx.ui.onVisible === 'function') ctx.ui.onVisible(cancelOnHide);
        if (typeof ctx.ui.onFocus === 'function') ctx.ui.onFocus(cancelOnHide);
        if (typeof ctx.hideButton === 'function') {
            ['BTN_PAGE', 'BTN_PREV', 'BTN_NEXT', 'BTN_ACTION'].forEach(id => ctx.hideButton(id));
        }
        const scrollAvailable = typeof ctx.onScroll === 'function';
        if (scrollAvailable) ctx.onScroll((dy, id) => {
            if (tab !== LOG || logExport || (id && id !== 'ambient-log') || !Number.isFinite(dy)) return false;
            scrollDelta += dy;
            const rows = Math.trunc(scrollDelta / 22);
            if (!rows) return true;
            scrollDelta -= rows * 22;
            return ctl.log.move(rows);
        });
        if (typeof ctx.onTouch === 'function') ctx.onTouch((phase, x, y) => {
            if (tab === LOG && !logExport) {
                if (!scrollAvailable) {
                    if (phase === 1) logTouch = x >= 49 && x <= 1540 && y >= 174 && y <= 475 ? y : null;
                    if (phase === 3 && logTouch !== null) {
                        const delta = logTouch - y;
                        if (Math.abs(delta) > 18) ctl.log.move(Math.round(delta / 22));
                        logTouch = null;
                    }
                }
                return;
            }
            if (tab !== COLOR || fallbackEditor || !Number.isFinite(x) || !Number.isFinite(y)) {
                touchedSlider = null;
                return;
            }
            if (phase === 1) {
                touchedSlider = null;
                if (x >= PICKER.x && x < PICKER.x + PICKER.w && y >= PICKER.y && y < PICKER.y + PICKER.h) {
                    touchedSlider = 'picker';
                } else if (x >= TRACK.x - 12 && x <= TRACK.x + TRACK.w + 12) {
                    const channel = SLIDERS.findIndex(spec => y >= spec.y - 10 && y <= spec.y + 25);
                    if (channel >= 0) touchedSlider = channel;
                }
            }
            const now = Date.now();
            if (touchedSlider !== null && (phase === 1 || (phase === 2 && now - lastDragUpdate >= 100) || phase === 3)) {
                if (touchedSlider === 'picker') {
                    const px = Math.max(PICKER.x, Math.min(PICKER.x + PICKER.w - 1, x));
                    const py = Math.max(PICKER.y, Math.min(PICKER.y + PICKER.h - 1, y));
                    const cell = A.pickerCell(px, py, PICKER.x, PICKER.y, PICKER.w, PICKER.h);
                    updateGrid(cell.hue, cell.saturation);
                } else {
                    const i = touchedSlider;
                    setSlider(i, (x - TRACK.x) * SLIDERS[i].max / TRACK.w);
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
                const look = profiles.data.follow && profiles.mode(next);
                if (look) {
                    loadSnapshot(look);
                    modeNotice = next.toUpperCase() + ' look loaded into the editor.';
                }
            },
        }, ctx.log, { pollMs: 2500 }).catch(e => ctx.log.warn('FES ambient mode: ' + e));

        let gridPreset, cachedGrid;
        const colorModel = () => {
            const preset = selectedPreset(), color = selected();
            let grid;
            if (preset === null) {
                grid = { hue: number('customHue', 0, 359, 210), saturation: number('customSat', 0, 100, 100) };
            } else {
                if (gridPreset !== preset) {
                    gridPreset = preset;
                    cachedGrid = A.rgbToGrid(color.rgb);
                }
                grid = cachedGrid;
            }
            let notice = ctl.bdcGuidance;
            if (!ctl.online) notice = 'TASU unavailable · preview only.';
            else if (ctl.busy) notice = 'Checking vehicle…';
            else if (ctl.bdcConfirming) notice = 'Confirm BDC test within 8 seconds while stationary.';
            else if (colorNotice) notice = colorNotice;
            return { color, preset, grid, brightness: brightness(), duration: duration(), notice,
                confirming: ctl.bdcConfirming, busy: ctl.busy, online: ctl.online,
                configured: ctl.bdcTestTargets.length > 0, ready: !!ctl.bdcSelection,
                choosePreset, editSlider, apply };
        };
        const favoritesModel = () => ({
            favorites: Array.from({ length: 6 }, (_, i) => profiles.loadFavorite(i)),
            selected: favoriteSelected,
            notice: favoriteNotice,
            select(i) { favoriteSelected = i; favoriteNotice = ''; },
            save() {
                profiles.saveFavorite(favoriteSelected, snapshot());
                favoriteNotice = 'Favorite ' + (favoriteSelected + 1) + ' saved.';
            },
            load() {
                const look = profiles.loadFavorite(favoriteSelected);
                if (look) { loadSnapshot(look); favoriteNotice = 'Favorite loaded into the editor.'; }
            },
            remove() {
                profiles.clearFavorite(favoriteSelected);
                favoriteNotice = 'Favorite deleted.';
            },
        });
        const modesModel = () => ({
            modes: MODES.map(name => ({ name, look: profiles.mode(name) })),
            selected: modeSelected,
            driveMode,
            notice: modeNotice,
            following: profiles.data.follow,
            select(i) { modeSelected = i; modeNotice = ''; },
            save() {
                profiles.saveMode(MODES[modeSelected], snapshot());
                modeNotice = 'Look saved.';
            },
            load() {
                const look = profiles.mode(MODES[modeSelected]);
                if (look) { loadSnapshot(look); modeNotice = 'Look loaded into the editor.'; }
            },
            remove() {
                profiles.clearMode(MODES[modeSelected]);
                modeNotice = 'Look deleted.';
            },
            follow() {
                const following = profiles.toggleFollow();
                const look = following && profiles.mode(driveMode);
                if (look) { loadSnapshot(look); modeNotice = 'Current driving mode loaded into the editor.'; }
                else modeNotice = '';
            },
        });
        const diagnosticsModel = () => ({
            diag: ctl, view: diagnosticView, page: diagnosticPage, raw: diagnosticRaw, guidedResult, plan,
            color: selected(), brightness: brightness(), duration: duration(),
            select(view, result = false) {
                diagnosticView = view; diagnosticPage = 0; diagnosticRaw = false; guidedResult = result;
            },
            setPage(page) { diagnosticPage = page; },
            toggleRaw() { diagnosticRaw = !diagnosticRaw; diagnosticPage = 0; },
            currentPlan() { plan = A.slot11Plan(selected().rgb); },
            factoryPlan() { plan = A.slot11RestorePlan(); },
        });
        const openExport = format => {
            try {
                const report = QR.createReport(ctl.report(ctx.spec ? ctx.spec.version : '0.4.6'), format);
                logExport = Object.assign(report, {page: 0, matrix: QR.matrix(report.pages[0])});
                exportError = '';
            } catch (error) {
                logExport = null;
                exportError = 'QR export unavailable';
                ctl.log.add('QR ERROR', exportError, 'warning');
            }
        };
        const logModel = () => ({
            log: ctl.log, export: logExport, error: exportError, openExport,
            closeExport() { logExport = null; },
            clear() { ctl.log.clear(); exportError = ''; },
            qrPage(delta) {
                if (!logExport) return;
                const page = Math.max(0, Math.min(logExport.pages.length - 1, logExport.page + delta));
                if (page === logExport.page) return;
                logExport.matrix = QR.matrix(logExport.pages[page]);
                logExport.page = page;
            },
        });
        const models = [colorModel, favoritesModel, modesModel, diagnosticsModel, logModel];

        ctx.loop('MAIN', 8, () => {
            const t = ctx.theme(), cv = ctx.canvas(1600, 520).clear(t.bg);
            if (fallbackEditor) {
                fallbackEditor.draw(cv, t, true);
            } else {
                const controls = [];
                drawPage(cv, t, tab, models[tab](), (x, y, w, h, key, run) => {
                    if (cv.own) { cv.target(x, y, w, h, run, key, 8); return; }
                    controls.push({ key, run, x, y, w, h });
                });
                fallbackControls = controls;
                if (!cv.own && controls.length) {
                    const current = controls.find(item => item.key === fallbackFocus) || controls[0];
                    fallbackFocus = current.key;
                    cv.strokeRoundRect(current.x - 2, current.y - 2, current.w + 4, current.h + 4, 8, 3, t.sel || t.accent);
                    cv.text('Previous / Next moves focus · Select activates', 800, 516, 18, t.dim, { align: 'center' });
                }
            }
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
