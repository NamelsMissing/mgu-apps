'use strict';

const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { PhoneBridge } = require('./phone_bridge');
const { StatusLine } = require('./status_line');
const { BackgroundStatus } = require('./background_status');
const QR = require('./qr');

mgu.run({
    async start(ctx) {
        const { settings, ui, log } = ctx;
        const line = new StatusLine(log);
        const bridge = new PhoneBridge(ctx.dataDir, log, updateLine);
        const background = new BackgroundStatus({ dir: ctx.dataDir, file: 'blitzer-status-background.json',
            version: ctx.spec.version, startReason: ctx.app && ctx.app.startReason });
        let link = 'on';
        let qr = null;
        let qrUrl = '';

        function updateLine() {
            line.update(settings.get('phoneBadge') ? bridge.reported() : 'unknown');
        }
        function syncSettings() {
            bridge.setEnabled(settings.get('phoneBridge'));
            updateLine();
        }
        function tick() {
            bridge.tick();
            updateLine();
            background.update({
                linkEnabled: bridge.enabled, listening: bridge.listening(),
                firewallReady: bridge.enabled && bridge.net.ready,
                lastReport: bridge.reported(), reports: bridge.events,
                rendererReady: line.renderer.ready, statusLineEnabled: !!settings.get('phoneBadge'),
            });
        }

        syncSettings();
        settings.onChange(syncSettings);
        tick();
        const timer = setInterval(tick, 500);
        process.once('exit', () => {
            clearInterval(timer);
            bridge.setEnabled(false);
            line.close();
        });

        ui.onClick('BTN_LINK', () => {
            link = link === 'on' ? 'off' : 'on';
            ui.text('BTN_LINK', link === 'on' ? 'Show closed link' : 'Show opened link');
        });
        ui.onVisible((name, visible) => {
            if (name === 'MAIN' && visible) background.seen();
        });

        ctx.loop('MAIN', 2, async () => {
            const t = ctx.theme();
            const cv = ctx.canvas(1600, 520).clear(t.bg);
            const url = bridge.url(link);
            const state = bridge.reported();
            const age = bridge.ageSeconds();
            const openedLink = link === 'on';
            const eventName = openedLink ? 'Is Opened' : 'Is Closed';

            G.frame(cv, t, ['Blitzer Status'], 0, [{ text: openedLink ? 'OPENED LINK' : 'CLOSED LINK' }]);
            cv.text('Last iPhone report', 48, 92, 23, t.dim);
            cv.text(state === 'unknown' ? 'No recent report' : state === 'opened' ? 'Opened' : 'Closed',
                48, 135, 38, state === 'opened' ? '#2fd27a' : state === 'closed' ? '#e0453a' : t.text);
            const received = 'Received reports  ' + bridge.events;
            cv.text(state === 'unknown' ? received : received + '  |  Last report ' + age + ' s ago',
                48, 177, 20, t.dim);
            cv.text(bridge.listening() ? 'CarPlay Wi-Fi  ' + bridge.host + ':' + bridge.port :
                bridge.enabled ? 'Waiting for the CarPlay Wi-Fi address' : 'Enable the iPhone Shortcuts bridge in Settings',
                48, 221, 22, bridge.listening() ? t.text : t.warn, { literal: true });
            if (bridge.enabled) cv.text(bridge.net.ready ? 'Phone port open' :
                'Phone port closed  ' + bridge.net.error, 48, 255, 19, bridge.net.ready ? t.text : t.warn);
            cv.text('KOMBI status line  ' + (settings.get('phoneBadge') ? 'On' : 'Off'), 48, 289, 20, t.dim);

            cv.text('iPhone  /  Shortcuts > Automation > App > Blitzer.de > ' + eventName,
                48, 352, 21, t.text);
            cv.text('Choose Run Immediately and add Get Contents of URL with the address from the QR code.',
                48, 386, 19, t.dim);
            cv.text('iOS sends Closed when Blitzer.de leaves the foreground.', 48, 420, 19, t.dim);

            if (url) {
                try {
                    if (url !== qrUrl) { qr = QR.matrix(url); qrUrl = url; }
                    QR.draw(cv, qr, 1130, 75, 385);
                } catch (e) {
                    cv.text('QR code unavailable', 1130, 240, 21, t.warn);
                }
                cv.text(url, 48, 479, 20, t.text, { literal: true });
            }
            await ui.image('MAIN_GFX', cv);
        });
    }
});
