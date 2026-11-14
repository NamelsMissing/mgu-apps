'use strict';
/**
 * Custom Cluster 0.6.2 - scrollable current-session console and guarded renderer probes.
 * Stock is the default. Real values only can reach cluster-render; emulator
 * and demo values stay exclusively on the centre-screen preview.
 */
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const G = require('./kit/gauges');
const { ClusterLayers } = require('./cluster_layers.js');
const { PhoneBridge } = require('./phone_bridge.js');
const { WazeControl } = require('./waze_control.js');
const { drawG80Preview } = require('./g80_preview.js');
const { draw6WBPreview } = require('./sixwb_preview.js');
const { resolveColor, resolve6WBColor, colorHex } = require('./cluster_colors.js');
const { withAlpha } = require('./kit/canvas');
const QR = require('./cluster_diagnostics.js');
const { LiveLog } = require('./live_log.js');

function fmt(v, unit) { return G.isNum(v) ? String(Math.round(v)) + (unit || '') : '--'; }
function ageText(age) { return age === null ? 'no sample' : age + 's old'; }

mgu.run({
    async start(ctx) {
        const { settings, log: baseLog, ui } = ctx;
        const liveLog = new LiveLog(1200, 96, 15);
        const diskJournal = QR.startJournal(ctx);
        const journal = {
            get path() { return diskJournal.path; },
            get error() { return diskJournal.error; },
            write(message) {
                liveLog.append(message); // always capture, even if disk I/O fails
                return diskJournal.write(message);
            },
            reset() { liveLog.clear(); diskJournal.reset(); },
        };
        const log = Object.create(baseLog);
        ['info', 'warn', 'error', 'debug'].forEach(level => {
            log[level] = (...args) => {
                const msg = args.map(a => String(a && a.message || a)).join(' ');
                // UI events and renderer states already have explicit trace entries.
                if (level !== 'debug' && !(level === 'info' &&
                    /^(cluster ui:|panel layer |panel target |panel test:|cluster log export )/.test(msg)))
                    journal.write(level.toUpperCase() + ' ' + msg);
                if (typeof baseLog[level] === 'function') baseLog[level].apply(baseLog, args);
            };
        });
        const car = new Car(Object.assign({}, ctx, { log }), ['rpm', 'speed', 'temps', 'gear'], { pollMs: 5000 });
        const cluster = new ClusterLayers(log);
        cluster.setTraceSink((line) => {
            journal.write('PANEL ' + line);
            // Always save a separate full text snapshot when a real panel
            // attempt ENDS, regardless of whether QR Logs was ever opened.
            if (line.indexOf('restore requested:') >= 0)
                saveTxt('automatic after KOMBI release');
        });
        const waze = new WazeControl(log);
        const bridge = new PhoneBridge(ctx.dataDir, log, () => {
            cluster.badge(bridge.reported() === 'opened');
        });
        let qrReport = null, qrPage = 0, qrMatrix = null, qrError = '', qrNotice = '';
        let clearArmedUntil = 0;
        let staticPreviewUntil = 0, lastJournalStateAt = 0;
        let txtPaths = [], txtError = '', txtReason = 'No manual text export yet';
        function saveTxt(reason) {
            try {
                const content = QR.snapshot(ctx, cluster, waze.status, bridge.reported(),
                    uiEvents.join('\n'));
                const paths = QR.save(ctx, content);
                txtPaths = paths;
                txtError = paths.length ? '' : 'No writable app/USB directory';
                txtReason = reason;
                journal.write('TEXT EXPORT ' + reason + ' path=' + paths.join('; ') +
                    (txtError ? ' ERROR=' + txtError : ''));
                return paths;
            } catch (e) {
                txtError = String(e && (e.code || e.message) || e);
                txtPaths = [];
                journal.write('TEXT EXPORT FAILED ' + reason + ': ' + txtError);
                return [];
            }
        }
        journal.write('App started; auto log path=' + (journal.path || 'unavailable'));
        // On this ID7 firmware opening a second RHMI canvas state can silently
        // fail. Keep the working MAIN HMI state and switch its content instead.
        let currentPage = 'MAIN';
        const uiEvents = [];
        function uiEvent(event) {
            uiEvents.push(new Date().toISOString() + ' ' + event);
            if (uiEvents.length > 40) uiEvents.shift();
            log.info('cluster ui: ' + event);
            journal.write('HMI ' + event);
        }
        function updateButtons() {
            // Reflect the current actions in the real HMI bar and its GPU bar.
            // Settings remains the firmware-managed Settings button.
            if (currentPage === 'LIVE_LOGS') {
                ui.text('BTN_TEST', 'Back to cluster');
                ui.text('BTN_DIAG', 'Older');
                ui.text('BTN_QR', 'Newer');
                ui.text('BTN_LOG', 'Latest');
                return;
            }
            ui.text('BTN_LOG', 'Live Logs');
            ui.text('BTN_TEST', currentPage === 'DIAGNOSTICS' ? 'Restore BMW' :
                currentPage === 'MAIN' ?
                    (!settings.get('enablePanelTests') || settings.get('panelTestMode') === 'preview' ?
                        'Static HMI preview' : 'Parked panel test') :
                    'Back to cluster');
            ui.text('BTN_DIAG', currentPage === 'QR_REPORT' ?
                (clearArmedUntil > Date.now() ? 'Confirm delete' : 'Delete logs') :
                currentPage === 'DIAGNOSTICS' ? 'Back to cluster' : 'Diagnostics');
            ui.text('BTN_QR', currentPage === 'DIAGNOSTICS' ? 'Save TXT' :
                currentPage === 'QR_REPORT' ? 'Next QR page' : 'QR logs');
        }
        function showPage(name) {
            if (currentPage !== name) clearArmedUntil = 0;
            currentPage = name;
            if (name === 'LIVE_LOGS') liveLog.latest();
            uiEvent('in-page ' + name);
            updateButtons();
        }
        ui.onVisible((name, visible) => {
            uiEvent(name + (visible ? ' visible' : ' hidden'));
            // A fresh entry from the app tile, Home, or Settings must always
            // show the preview. All secondary views now live inside MAIN;
            // there are no hidden RHMI states that can steal focus.
            if (name === 'MAIN' && visible) showPage('MAIN');
        });

        function syncSettings() {
            cluster.settings({ layout: settings.get('layout'), accent: settings.get('accent'),
                sixwbTheme: settings.get('sixwbTheme'), sixwbColorSource: settings.get('sixwbColorSource'),
                colorMode: settings.get('colorMode'), rgbRed: settings.get('rgbRed'),
                rgbGreen: settings.get('rgbGreen'), rgbBlue: settings.get('rgbBlue'),
                colorBrightness: settings.get('colorBrightness'), cycleSeconds: settings.get('cycleSeconds'),
                phoneBadge: !!settings.get('phoneBadge'), wazeMap: settings.get('wazeMap'),
                panelTestMode: settings.get('panelTestMode'), panelTarget: settings.get('panelTarget') });
            bridge.setEnabled(!!settings.get('phoneBridge'));
            waze.setChoice(settings.get('wazeMap'));
        }
        syncSettings();
        settings.onChange(() => {
            syncSettings();
            updateButtons();
            journal.write('Settings: layout=' + settings.get('layout') +
                ' panelOptIn=' + !!settings.get('enablePanelTests') +
                ' test=' + settings.get('panelTestMode') +
                ' target=' + settings.get('panelTarget'));
        });
        car.onSample((d) => { if (!d.demo) cluster.sample(d); });
        ui.onClick('BTN_TEST', () => {
            if (currentPage === 'DIAGNOSTICS') {
                uiEvent('manual Restore BMW requested');
                cluster.restoreOriginal(); // trace sink saves a TXT report automatically
                return;
            }
            if (currentPage !== 'MAIN') return showPage('MAIN');
            if (!settings.get('enablePanelTests') || settings.get('panelTestMode') === 'preview') {
                // Safe when the engine is off: no RAMSES panel layer is created.
                staticPreviewUntil = Date.now() + 30000;
                uiEvent('static 30 s HMI-only preview requested');
                journal.write('STATIC PREVIEW started (does not take over KOMBI); panel opt-in=' +
                    !!settings.get('enablePanelTests'));
                return;
            }
            uiEvent('parked test clicked');
            journal.write('TEST REQUEST before=' + JSON.stringify(cluster.status()));
            const enabled = cluster.armPanel();
            journal.write('TEST RESULT armed=' + enabled + ' state=' + JSON.stringify(cluster.status()));
            if (!enabled && /stale|no complete sample|release not confirmed|Renderer not connected|not ready|Prior panel/i.test(cluster.status().disarmReason)) {
                // User can always repeat an HMI-only demonstration. It must
                // not manufacture motion readings or override the KOMBI gate.
                staticPreviewUntil = Date.now() + 30000;
                uiEvent('KOMBI test refused; showing HMI-only preview instead');
            }
            log.info('panel test: ' + (enabled ? 'armed for 12 s' : cluster.status().disarmReason));
        });
        ui.onClick('BTN_DIAG', () => {
            if (currentPage === 'LIVE_LOGS') return liveLog.move(-12);
            if (currentPage === 'QR_REPORT') return deleteLogs();
            if (currentPage === 'DIAGNOSTICS') return showPage('MAIN');
            uiEvent('show diagnostics in main state');
            cluster.pollStatus(true);
            return showPage('DIAGNOSTICS');
        });
        // The QR view uses the same proven MAIN HMI state; a new report captures
        // the current renderer state, including any running test.
        function captureQr() {
            try {
                uiEvent('capture QR report');
                qrNotice = '';
                clearArmedUntil = 0;
                updateButtons();
                cluster.pollStatus(true);
                qrReport = QR.report(ctx, cluster, waze.status, bridge.reported(), uiEvents.join('\n'));
                qrPage = 0;
                qrMatrix = QR.matrix(qrReport.pages[qrPage]);
                qrError = '';
                log.info('cluster log export ' + qrReport.id + ': ' + qrReport.pages.length +
                    ' QR pages; saved to ' + qrReport.storedAt.join(', '));
                journal.write('QR snapshot ' + qrReport.id + ' saved=' + qrReport.storedAt.join(', '));
            } catch (e) {
                qrReport = null;
                qrMatrix = null;
                qrError = String(e && e.message || e);
                log.warn('cluster QR: ' + qrError);
            }
        }
        function deleteLogs() {
            const now = Date.now();
            if (clearArmedUntil <= now) {
                clearArmedUntil = now + 8000;
                qrNotice = 'Press Confirm delete within 8 seconds to clear local Custom Cluster logs.';
                uiEvent('delete logs confirmation requested');
                updateButtons();
                return;
            }
            clearArmedUntil = 0;
            const result = QR.clearSaved(ctx);
            qrReport = null;
            qrMatrix = null;
            qrPage = 0;
            qrError = '';
            uiEvents.length = 0;
            cluster.clearHistory();
            journal.reset();
            txtPaths = [];
            txtError = '';
            txtReason = 'Logs were cleared';
            qrNotice = 'Deleted ' + result.deleted + ' local log file(s).' +
                (result.errors.length ? ' Errors: ' + result.errors.join('; ').slice(0, 85) : '') +
                ' USB copies were kept.';
            uiEvent('local diagnostic exports deleted: ' + result.deleted);
            log.info('cluster QR: ' + qrNotice);
            updateButtons();
        }
        const openQr = () => { uiEvent('show QR in main state'); captureQr(); return showPage('QR_REPORT'); };
        ui.onClick('BTN_QR', () => {
            if (currentPage === 'LIVE_LOGS') return liveLog.move(12);
            if (currentPage === 'DIAGNOSTICS') return saveTxt('manual Save TXT button');
            return currentPage === 'QR_REPORT' ? nextQrPage() : openQr();
        });
        ui.onClick('BTN_LOG', () => {
            if (currentPage === 'LIVE_LOGS') return liveLog.latest();
            cluster.pollStatus(true);
            return showPage('LIVE_LOGS');
        });
        // Same touch gesture as the Heating Comfort console; the native
        // Older/Newer buttons also work with the rotary controller.
        let logTouchY = null;
        if (typeof ctx.onTouch === 'function') ctx.onTouch((phase, x, y) => {
            if (currentPage !== 'LIVE_LOGS') { logTouchY = null; return; }
            if (phase === 1 && x >= 35 && x <= 1565 && y >= 105 && y <= 480) logTouchY = y;
            else if (phase === 3 && logTouchY !== null) {
                const dy = y - logTouchY;
                if (Math.abs(dy) > 18) liveLog.move(-Math.round(dy / 24));
                logTouchY = null;
            }
        });
        function nextQrPage() {
            uiEvent('QR next page');
            if (!qrReport || !qrReport.pages.length) return captureQr();
            try {
                qrPage = (qrPage + 1) % qrReport.pages.length;
                qrMatrix = QR.matrix(qrReport.pages[qrPage]);
                qrError = '';
            } catch (e) {
                qrError = String(e && e.message || e);
                qrMatrix = null;
                log.warn('cluster QR page: ' + qrError);
            }
        }

        // A stale Shortcut event is never displayed as proof that an app runs.
        const cleanup = setInterval(() => {
            if (clearArmedUntil && Date.now() >= clearArmedUntil) {
                clearArmedUntil = 0;
                qrNotice = 'Delete confirmation expired; no logs removed.';
                updateButtons();
            }
            cluster.observeVehicle(car.data());
            cluster.badge(bridge.reported() === 'opened');
            cluster.apply();
            cluster.pollStatus(false);
            const now = Date.now();
            if (now - lastJournalStateAt >= 15000) {
                lastJournalStateAt = now;
                const st = cluster.status();
                journal.write('STATE layout=' + st.layout + ' selector=' + st.gearPosition +
                    ' speed=' + st.speedKmh + ' rpm=' + st.engineRpm +
                    ' sampleAge=' + st.sampleAgeSeconds + 's speedAge=' + st.speedAgeSeconds +
                    's rpmAge=' + st.rpmAgeSeconds + 's guard=' + st.testGuard +
                    ' panel=' + st.panelActive + ' layer=' + st.panelLayer +
                    ' slot=' + st.panelTargetState + ' renderer=' + st.rendererBackend);
            }
        }, 250);
        process.once('exit', () => {
            journal.write('App process closing');
            clearInterval(cleanup); cluster.close(); bridge.stop();
        });

        function renderLiveLogs(target) {
            const t = ctx.theme();
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            const page = liveLog.view();
            G.frame(cv, t, ['Custom Cluster', 'Live Logs'], 0,
                [{ text: page.following ? 'LIVE' : 'HISTORY' }]);
            cv.text('Current session  |  ' + new Date(liveLog.startedAt).toISOString().slice(11, 19) +
                ' UTC  |  Lines ' + page.start + '-' + page.end + ' / ' + page.total,
                48, 76, 23, t.text, { literal: true });
            cv.text(page.following ? 'Following newest events' : 'Paused on older events',
                1095, 76, 18, page.following ? '#2fd27a' : t.warn);
            if (!page.lines.length) cv.text('Waiting for diagnostic events...', 48, 130, 22, t.dim);
            page.lines.forEach((line, i) => {
                const color = /\b(?:ERROR|WARN|FAILED|refused|stale|NOT verified)\b/i.test(line) ? t.warn : t.text;
                cv.text(line, 48, 111 + i * 24, 20, color, { literal: true });
            });
            cv.text('Older / Newer: scroll 12 lines  |  Latest: follow log  |  New app process: new log',
                48, 496, 18, t.dim);
            if (page.dropped) cv.text('Oldest lines rotated: ' + page.dropped, 1200, 496, 16, t.dim);
            return ui.image(target, cv);
        }

        function renderQr(target) {
            const t = ctx.theme();
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            G.frame(cv, t, ['Custom Cluster', 'QR diagnostics'], 0, [{ text: 'OFFLINE LOG' }]);
            if (!qrReport || !qrMatrix) {
                cv.text(qrNotice ? 'Custom Cluster logs' : 'QR export unavailable',
                    60, 130, 37, qrNotice ? t.text : t.warn, { font: 'bold' });
                cv.text((qrNotice || 'Error: ' + (qrError || 'No report generated')).slice(0, 125),
                    60, 200, 23, t.text);
                cv.text('Press Next QR page to create a new report, or Back to cluster.',
                    60, 270, 24, t.dim);
                return ui.image(target, cv);
            }
            cv.text('Cluster diagnostic QR export', 60, 98, 37, t.text, { font: 'bold' });
            cv.text('Page ' + (qrPage + 1) + ' / ' + qrReport.pages.length +
                '   Report ' + qrReport.id, 60, 151, 27, t.text);
            cv.text('Photograph/scan every page in order.', 60, 215, 25, t.dim);
            cv.text('Next QR page cycles through all pages.', 60, 257, 22, t.dim);
            cv.text('Use Back to cluster at any time.', 60, 301, 22, t.dim);
            cv.text('Auto TXT: ' + (journal.path || 'unavailable').slice(-99),
                60, 346, 15, t.dim);
            cv.text('To decode: tools/decode_custom_cluster_logs.py', 60, 407, 18, t.text);
            cv.text((qrNotice || 'Delete logs clears local app exports only (USB untouched).').slice(0, 100),
                60, 453, 19, qrNotice ? t.warn : t.dim);
            try { QR.draw(cv, qrMatrix, 1080, 75, 395); }
            catch (e) { cv.text('QR image error: ' + String(e.message).slice(0, 58), 60, 459, 20, t.warn); }
            return ui.image(target, cv);
        }

        function renderDiagnostics(target) {
            const t = ctx.theme();
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            const current = cluster.status();
            const statusLines = cluster.rendererStatus().split('\n')
                .filter((line) => /^(slot |target |layer |panel|scene|Dcsm|cluster|error|guard)/i.test(line))
                .slice(0, 13);
            G.frame(cv, t, ['Custom Cluster', 'Diagnostics'], 0, [{ text: 'PARKED TEST' }]);
            cv.text('Renderer: ' + current.rendererBackend +
                '  /  ' + (current.ready ? 'connected' : 'offline'), 48, 85, 25, t.text);
            cv.text('Targets: ' + current.rendererTargets.slice(0, 110), 48, 118, 17, t.dim);
            cv.text('Requested: ' + (current.panelActive ? 'YES' : 'NO') +
                ' / ' + current.panelTarget + ' / ' + (current.activeTestMode || '-'), 48, 158, 21, t.text);
            cv.text('Layer: ' + current.panelLayer +
                '  |  Slot: ' + current.panelTargetState, 48, 188, 20, t.text);
            cv.text('Slot reason: ' + (current.panelTargetReason || '-').slice(0, 112), 48, 216, 17, t.warn);
            cv.text('Last refusal: ' + (current.lastRefusal || '-').slice(0, 115), 48, 244, 17, t.warn);
            cv.text('Test guard: ' + current.testGuard.slice(0, 100) +
                ' | Opt-in: ' + (settings.get('enablePanelTests') ? 'YES' : 'NO'), 48, 270, 18, t.warn);
            cv.text('Selector=' + (current.gearPosition || '?') +
                ' | speed=' + (current.speedKmh === null ? '?' : current.speedKmh.toFixed(1)) +
                ' (age ' + ageText(current.speedAgeSeconds) + ')' +
                ' | rpm=' + (current.engineRpm === null ? '?' : Math.round(current.engineRpm)) +
                ' (age ' + ageText(current.rpmAgeSeconds) + ')', 48, 295, 17, t.text);
            cv.text('Auto log: ' + (journal.path || 'NOT SAVED').slice(-117),
                48, 324, 15, journal.path ? t.text : t.warn);
            cv.text('Log I/O: ' + (journal.error || 'OK'), 48, 344, 15,
                journal.error ? t.warn : t.dim);
            cv.text('Save TXT: ' + (txtPaths.length ? txtPaths.join(' | ') : (txtError || txtReason)).slice(-115),
                48, 363, 15, txtError ? t.warn : t.text);
            cv.text('Restore: ' + (current.recoveryState || '-').slice(0, 107),
                48, 384, 15, t.warn);
            cv.text('Renderer slot reports (read-only):', 48, 405, 17, t.text);
            if (!statusLines.length)
                cv.text('No renderer status yet.', 48, 423, 15, t.dim);
            statusLines.slice(0, 6).forEach((line, i) =>
                cv.text(line.slice(0, 201), 48, 426 + i * 14, 12, t.dim));
            return ui.image(target, cv);
        }

        updateButtons();
        ctx.loop('MAIN', 2, () => {
            if (currentPage === 'DIAGNOSTICS') return renderDiagnostics('MAIN_GFX');
            if (currentPage === 'QR_REPORT') return renderQr('MAIN_GFX');
            if (currentPage === 'LIVE_LOGS') return renderLiveLogs('MAIN_GFX');
            const t = ctx.theme(), realData = car.data(), st = cluster.status();
            const previewActive = Date.now() < staticPreviewUntil;
            // Static preview works with ignition off and stale signals, but is
            // NEVER allowed into the KOMBI renderer or its safety guard.
            const d = previewActive ? Object.assign({}, realData,
                { speed: 0, rpm: 0, demo: true }) : realData;
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            const layout = settings.get('layout');
            const activeOptions = { accent: settings.get('accent'),
                colorMode: settings.get('colorMode'), rgbRed: settings.get('rgbRed'),
                rgbGreen: settings.get('rgbGreen'), rgbBlue: settings.get('rgbBlue'),
                colorBrightness: settings.get('colorBrightness'), cycleSeconds: settings.get('cycleSeconds'),
                sixwbTheme: settings.get('sixwbTheme'), sixwbColorSource: settings.get('sixwbColorSource') };
            const accentHex = colorHex(layout === 'sixwb' ? resolve6WBColor(activeOptions, Date.now())
                : resolveColor(activeOptions, Date.now()));
            G.frame(cv, t, ['Custom Cluster'], 0,
                [previewActive ? { text: 'STATIC PREVIEW - IDRIVE ONLY' } :
                    d.demo ? { text: 'PREVIEW ONLY' } :
                    { text: st.ready ? 'RENDERER READY' : 'RENDERER OFFLINE' }]);

            G.panel(cv, t, 24, 48, 1070, 450, 'Cluster design: ' + layout.toUpperCase());
            if (layout === 'sixwb') {
                draw6WBPreview(cv, { x: 38, y: 86, w: 1042, h: 398 }, d,
                    { wazeMap: settings.get('wazeMap'), color: accentHex, mode: settings.get('sixwbTheme') }, st);
            } else if (layout === 'g80' || layout === 'oem') {
                drawG80Preview(cv, { x: 38, y: 86, w: 1042, h: 398 }, d,
                    { wazeMap: settings.get('wazeMap'), color: accentHex, variant: layout }, st);
            } else if (layout === 'classic') {
                G.radial(cv, t, 300, 302, 156, { value: d.speed, min: 0, max: 260, label: 'SPEED', unit: 'km/h', ticks: 13, color: accentHex });
                G.radial(cv, t, 824, 302, 156, { value: d.rpm, min: 0, max: 5000, label: 'RPM', ticks: 10, color: accentHex });
            } else if (layout === 'sport') {
                G.segBar(cv, t, 75, 135, 964, 120, { label: 'Engine speed', value: d.rpm, min: 0, max: 5000,
                    unit: 'rpm', step: 250, limit: 4800, color: accentHex });
                cv.text(fmt(d.speed), 115, 407, 82, t.text, { font: 'num' });
                cv.text('km/h', 420, 407, 30, t.dim);
                cv.text('OIL ' + fmt(d.oil, ' C'), 800, 394, 27, t.dim);
            } else if (layout === 'minimal') {
                cv.text(fmt(d.speed), 170, 310, 128, t.text, { font: 'num' });
                cv.text('km/h', 520, 308, 36, t.dim);
                cv.text('RPM  ' + fmt(d.rpm), 175, 415, 36, accentHex);
            } else {
                cv.text('BMW ORIGINAL CLUSTER', 80, 255, 46, t.text, { font: 'bold' });
                cv.text('Waze map remains unchanged', 85, 330, 28, t.dim);
            }

            G.panel(cv, t, 1120, 48, 456, 450, 'Renderer / panel test');
            cv.text('Cluster render: ' + (st.ready ? 'Connected' : 'Waiting'), 1150, 137, 24, st.ready ? '#2fd27a' : t.warn);
            cv.text('Live speed/RPM: ' + (st.live ? 'YES' : 'NO') +
                ' | Selector: ' + (st.gearPosition || '?'), 1150, 173, 19, st.parked ? '#2fd27a' : t.dim);
            cv.text('Last accepted pair: ' + ageText(st.sampleAgeSeconds) +
                ' | KOMBI safe: ' + (st.parked ? 'YES' : 'NO'), 1150, 197, 17, st.parked ? '#2fd27a' : t.dim);
            cv.text('Panel: ' + (st.panelActive ? 'REQUESTED (' + st.secondsLeft + 's)' :
                st.suspended ? 'CUSTOM RELEASED' : 'STOCK'),
                1150, 224, 20, st.panelActive ? '#2fd27a' : t.text);
            cv.text('Layer: ' + st.panelLayer.slice(0, 29) +
                '  / Slot: ' + st.panelTargetState.slice(0, 12), 1150, 257, 16, t.dim);
            cv.text('Test: ' + (!settings.get('enablePanelTests') || previewActive ? 'HMI ONLY' :
                st.activeTestMode || settings.get('panelTestMode')) +
                ' @ ' + settings.get('panelTarget'), 1150, 286, 16, t.dim);
            cv.text('Last: ' + st.disarmReason.slice(0, 39), 1150, 314, 16, t.dim);
            cv.text('Waze: ' + waze.status.slice(0, 34), 1150, 341, 18, t.text);
            cv.text('iPhone event: ' + bridge.reported(), 1150, 369, 17, t.text);
            cv.text('Phone bridge: ' + (bridge.url('on') ? 'ready' : 'off'), 1150, 396, 17, t.text);
            if (bridge.url('on')) {
                cv.text(bridge.url('on'), 1135, 418, 11, t.text);
                cv.text(bridge.url('off'), 1135, 442, 11, t.text);
            } else cv.text('Shortcuts URLs in Settings', 1150, 434, 17, t.dim);
            if (qrError) cv.text('QR: ' + qrError.slice(0, 48), 1140, 463, 13, t.warn);

            if (layout === 'g80' || layout === 'oem' || layout === 'sixwb') {
                cv.text(previewActive ? 'Static preview: no KOMBI graphics are changed' :
                    'KOMBI takeover only in verified P; OEM music may be hidden',
                    1136, 474, 16, t.warn);
            } else if (!st.live && layout !== 'stock') {
                cv.fillRect(54, 460, 1000, 33, withAlpha('#e6ad37', 0.12));
                cv.text(d.demo ? 'PREVIEW ONLY - never sent to the cluster' : 'No real signals: BMW cluster stays in control',
                    70, 483, 20, t.warn);
            }
            return ctx.ui.image('MAIN_GFX', cv);
        });
    }
});
