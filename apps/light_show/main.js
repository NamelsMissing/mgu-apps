'use strict';
const mgu = require('./kit/mgu');
const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const Link = require('./link');
const Guard = require('./guard');
const Journal = require('./journal');
const Engine = require('./engine');
const F = require('./flm-control');

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const journal = new Journal(ctx.dataDir);
        let engine, link, guard, lastStatus = '', hiddenTimer = null;
        let selectedOutput = null, selectedFlmSide = 'left', lastObservation = '';
        let confirmReturnScreen = 'DIAGNOSTICS';
        const flmConfig = () => F.settings(Number(settings.get('flmPwm')), Number(settings.get('flmSeconds')));
        const openLightCheck = (target) => { confirmReturnScreen = target; return ui.open('CONFIRM_LIGHTS'); };
        const observationsPath = path.join(ctx.dataDir, 'light-show-observations.json');
        let observations = [];
        try {
            const saved = JSON.parse(fs.readFileSync(observationsPath, 'utf8'));
            if (Array.isArray(saved)) observations = saved.filter((x) => x && typeof x === 'object').slice(-100);
        } catch (e) { if (e.code !== 'ENOENT') log.warn('Light Show observation load: ' + e.message); }
        const refresh = () => {
            if (!engine) return;
            const s = engine.status(), text = (s.state === 'RUNNING' ? 'COMMANDS' : s.state) + ': ' + s.note;
            const line = text + (s.state === 'RUNNING' ? ' (' + s.remainingSeconds + ' s)' : '');
            if (line !== lastStatus) { lastStatus = line; ui.text('STATUS', line); }
            if (ui.isVisible('DIAGNOSTICS')) ui.text('DIAG_TEXT', diagnostics());
            if (selectedOutput && ui.isVisible('OUTPUT_OBSERVE')) {
                ui.text('OBSERVE_STATUS', line + '\n' +
                    'FLM replies' +
                    ' are NOT physical lamp measurements.' +
                    (journal.pending() ? '\nSaved BDC/FLM lock pending - check normal lamps before repeat.' : ''));
                ui.text('OBSERVE_RECORDED', lastObservation || 'Record the observed light and sound after the test.');
            }
        };
        const changed = () => {
            if (engine && engine.run && ['STARTING', 'RUNNING'].indexOf(engine.state) >= 0) {
                const why = guard.reason();
                if (why || !link.available) engine.stop(why || 'Diagnostic connection lost');
            }
            refresh();
        };
        guard = new Guard(Date.now, changed);
        link = new Link(ctx.signals, log, changed);
        engine = new Engine({ link, guard, journal, log, changed: refresh });

        function diagnostics() {
            const s = engine.status(), g = guard.snapshot();
            return [
                'Light Show 0.2.5 - FLM02 only / physical channel mapping unverified',
                'State: ' + s.state + ' - ' + s.note,
                'TASU: ' + (link.available ? 'available' : 'unavailable'),
                'BDC address: 40 | SGBD: ' + (link.index || 'not read') + ' | required: ' + P.INDEX,
                'Speed: ' + (g.speedKmh === null ? 'unknown' : g.speedKmh.toFixed(2) + ' km/h') + ' | age: ' + g.speedAgeMs + ' ms',
                'Selector: ' + (g.stage || 'unknown') + ' | ' + (g.blockedBy || 'P and stationary'),
                'Acknowledged commands (not proof of light): ' + s.sent + ' | measured step: ' + s.stepMs + ' ms',
                'Historical BDC return (only when recovering an old run): ' + (s.releaseConfirmed ? 'confirmed' : 'not confirmed this run'),
                'Cleanup acknowledgements (not physical lamp proof): ' + JSON.stringify(s.cleanup),
                'FLM settings: ' + settings.get('flmPwm') + '% PWM / ' + settings.get('flmSeconds') + ' s',
                'Stop command: ' + (s.stopConfirmed ? 'acknowledged' : 'not acknowledged') + ' | route: ' + s.control.route
                    + (s.control.outputId == null ? '' : ' | single output 0x' + s.control.outputId.toString(16).toUpperCase())
                    + (s.control.route === 'flm' ? ' | ' + s.control.side + ' channel ' + s.control.channel
                        + ' | ' + s.control.pwm + '% / ' + s.control.seconds + 's' : ''),
                'Recovery marker: ' + (journal.pending() ? 'PENDING - STOP or checked-light recovery' : 'clear'),
                'A positive diagnostic response is not a measured lamp state.',
                'Original start/show error: ' + (engine.originalFault || 'none recorded'),
                'Output status (raw, not physical proof):',
            ].concat(engine.outputSamples.map((x) => x.label + ': ' + (x.summary || x.error || 'raw only') + '\n' + (x.reply || ''))).concat([
                '', 'Headlamps (read only):',
            ]).concat(engine.headlamps.map((x) => x.side + ' [' + P.hex([x.address]) + '] ' + (x.name || 'module')
                + ' | SGBD ' + (x.index || 'unknown') + '\nHigh-beam mapping: ' + (x.highBeamRaw || 'unavailable')
                + '\n' + (x.error || x.note || ''))).concat([
                '', 'FLM02 channel observations (latest first; earlier BDC records retained):',
            ]).concat(observations.slice(-30).reverse().map((o) => o.at + ' ' + o.prg + ': ' + o.result
                + ' | ECU: ' + o.ecuState + ' | ' + o.ecuNote)).concat([
                '', 'Recent diagnostic requests:',
            ]).concat(link.trace.slice(-14).map((r) => r.at.slice(11, 23) + ' [' + P.hex([r.address]) + '] > ' + r.tx + ' < ' + (r.rx || r.error || 'waiting'))).join('\n');
        }
        function saveLog() {
            try {
            const report = { app: 'light_show', version: '0.2.5', at: new Date().toISOString(),
                    physicalEffectVerified: false, headlamps: engine.headlamps, status: engine.status(), guard: guard.snapshot(),
                    settings: { route: 'flm', flmPwm: Number(settings.get('flmPwm')),
                        flmSeconds: Number(settings.get('flmSeconds')) }, flmSettings: flmConfig(), bdcIndex: link.index,
                    recoveryPending: journal.pending(), originalFault: engine.originalFault,
                    individualObservations: observations, outputSamples: engine.outputSamples, trace: link.trace };
                const file = path.join(ctx.dataDir, 'light-show-diagnostics.json');
                fs.writeFileSync(file + '.tmp', JSON.stringify(report, null, 2)); fs.renameSync(file + '.tmp', file);
                ui.text('DIAG_TEXT', diagnostics() + '\n\nSaved: ' + file);
            } catch (e) { ui.text('DIAG_TEXT', diagnostics() + '\n\nLog save failed: ' + e.message); }
        }
        ['BTN_STOP', 'BTN_DIAG_STOP'].forEach((name) => ui.onClick(name, () => engine.stop('Stopped by user')));
        ui.onClick('BTN_DIAG', () => { ui.text('DIAG_TEXT', diagnostics()); return ui.open('DIAGNOSTICS'); });
        ui.onClick('BTN_EXPORT', saveLog);
        ui.onClick('BTN_HEADLAMPS', async () => { await engine.inspectHeadlamps(); ui.text('DIAG_TEXT', diagnostics()); });
        ui.onClick('BTN_FLM_INDEX', () => ui.open('FLM_INDEX'));
        ui.onClick('BTN_FLM_BACK', () => ui.open('MAIN'));
        for (const side of Object.keys(F.MODULES)) {
            ui.onClick('BTN_FLM_' + side.toUpperCase(), () => {
                selectedFlmSide = side;
                const opts = flmConfig();
                ui.text('FLM_SIDE', F.MODULES[side].name + ' / channels 1-15 / ' + opts.pwm + '% / ' + opts.seconds + ' s. Channel mapping and physical effects unverified.');
                return ui.open('FLM_CHANNELS');
            });
        }
        ui.onClick('BTN_FLM_CHANNEL_BACK', () => ui.open('FLM_INDEX'));
        for (let channel = 1; channel <= 15; channel++) {
            const button = 'BTN_FLM_CH_' + ('0' + channel.toString(16).toUpperCase()).slice(-2);
            ui.onClick(button, async () => {
                if (engine.run) return;
                let opts;
                try { opts = flmConfig(); } catch (e) { engine.update('ERROR', e.message); return; }
                selectedOutput = { route: 'flm', side: selectedFlmSide, channel,
                    pwm: opts.pwm, seconds: opts.seconds,
                    prg: F.MODULES[selectedFlmSide].name + '_KANAL_' + channel,
                    label: 'Experimental ' + F.MODULES[selectedFlmSide].name + ' LED channel ' + channel,
                    group: 'FLM_CHANNELS' };
                lastObservation = '';
                ui.text('OBSERVE_NAME', selectedOutput.label + '\n' + opts.pwm + '% PWM / ' + opts.seconds + ' s; physical channel unknown.');
                await ui.open('OUTPUT_OBSERVE');
                await engine.testFlm(selectedFlmSide, channel, opts.pwm, opts.seconds);
                refresh();
            });
        }
        ui.onClick('BTN_OUTPUT_STOP', () => engine.stop('Stopped individual light test'));
        ui.onClick('BTN_OUTPUT_REPEAT', () => {
            if (!selectedOutput) return;
            if (journal.pending()) return openLightCheck('OUTPUT_OBSERVE');
            return engine.testFlm(selectedOutput.side, selectedOutput.channel, selectedOutput.pwm, selectedOutput.seconds);
        });
        ui.onClick('BTN_OUTPUT_CHECK_LIGHTS', () => openLightCheck('OUTPUT_OBSERVE'));
        ui.onClick('BTN_OUTPUT_BACK', async () => {
            await engine.stop('Leaving individual light test');
            return ui.open('FLM_CHANNELS');
        });
        function observe(result) {
            if (!selectedOutput) return;
            if (engine.run) { lastObservation = 'Wait until STOP has finished before recording.'; refresh(); return; }
            const status = engine.status();
            const record = { at: new Date().toISOString(), id: selectedOutput.id || null,
                prg: selectedOutput.prg, label: selectedOutput.label, result,
                route: 'flm',
                side: selectedOutput.side || null, channel: selectedOutput.channel || null,
                pwm: selectedOutput.pwm || null, seconds: selectedOutput.seconds || null,
                ecuState: status.state, ecuNote: status.note, cleanupConfirmed: status.stopConfirmed };
            observations.push(record); observations = observations.slice(-100);
            try {
                fs.writeFileSync(observationsPath + '.tmp', JSON.stringify(observations, null, 2));
                fs.renameSync(observationsPath + '.tmp', observationsPath);
                lastObservation = 'Saved: ' + result + ' (will be in diagnostic export)';
            } catch (e) { lastObservation = 'Observation kept in memory; save failed: ' + e.message; }
            refresh();
        }
        [['BTN_OUTPUT_VISIBLE', 'visible, no unusual noise'],
            ['BTN_OUTPUT_VISIBLE_NOISE', 'visible and unusual noise'],
            ['BTN_OUTPUT_NO_EFFECT', 'no visible effect, no noise'],
            ['BTN_OUTPUT_NOISE', 'unusual noise without visible light']]
            .forEach(([button, result]) => ui.onClick(button, () => observe(result)));
        ui.onClick('BTN_CLEAR_LOCK', () => openLightCheck('DIAGNOSTICS'));
        ui.onClick('BTN_CANCEL_CLEAR', () => ui.open(confirmReturnScreen));
        ui.onClick('BTN_CONFIRM_CLEAR', async () => {
            await engine.acknowledgeNormalLights(); await ui.open(confirmReturnScreen);
        });
        settings.onChange(() => {
            if (engine.run) engine.stop('FLM02 settings changed');
            refresh();
        });
        ui.onVisible(() => {
            clearTimeout(hiddenTimer);
            hiddenTimer = setTimeout(() => {
                if (!['MAIN', 'DIAGNOSTICS', 'CONFIRM_LIGHTS', 'FLM_INDEX',
                    'FLM_CHANNELS', 'OUTPUT_OBSERVE'].some((n) => ui.isVisible(n))) {
                    if (engine.run) engine.stop('App closed');
                }
            }, 250);
        });
        // These are best-effort cleanup hooks: abrupt power loss cannot await
        // diagnostic replies. The persistent marker survives for the next open.
        if (ctx.app && ctx.app.on) ctx.app.on('shutdown', () => engine.stop('Head unit shutting down'));
        process.on('SIGTERM', () => { engine.stop('App stopped').then(() => process.exit(0)); });
        guard.init(ctx.signals, log).catch((e) => log.warn('Light Show vehicle signals: ' + e));
        let recoveryTried = false;
        function recover() {
            if (!recoveryTried && journal.pending() && link.available && !engine.run) {
                recoveryTried = true; engine.stop('Recovering previous lamp override');
            }
        }
        link.init().then(recover).catch((e) => log.warn('Light Show diagnostics: ' + e));
        setInterval(() => { changed(); recover(); }, 200);
        refresh();
    },
});
