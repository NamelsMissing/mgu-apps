'use strict';
// One client in the existing shared cluster-render service. No binary patch,
// no second RAMSES participant and no reconfiguration of Waze on cluster.
const { ClusterRender } = require('./cluster_render_client.js');
const fragmentShader = require('./cluster_shader.js');
const g80Shader = require('./g80_panel_shader.js');
const sixwbShader = require('./sixwb_panel_shader.js');
const probeShader = require('./panel_probe_shader.js');
const { PALETTE, resolveColor, resolve6WBColor, colorHex } = require('./cluster_colors.js');
const COLORS = Object.keys(PALETTE).reduce((m, k) => { m[k] = PALETTE[k].concat([1]); return m; }, {});
const BADGE_FS = `#version 100
precision mediump float;
varying vec2 v_uv;
void main() {
  vec2 p=v_uv-vec2(0.5);
  float r=length(p);
  float outside=1.0-smoothstep(0.43,0.48,r);
  float inside=1.0-smoothstep(0.16,0.20,r);
  vec3 c=mix(vec3(0.03,0.26,0.17),vec3(0.36,1.0,0.60),inside);
  gl_FragColor=vec4(c,outside);
}`;
const MODES = { stock: 0, sport: 1, classic: 2, minimal: 3, g80: 4, oem: 5, sixwb: 6 };
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const PANEL_TEST_MS = 12000;
const PANEL_TARGETS = { panel: true, panel201: true, panel202: true };

class ClusterLayers {
    constructor(log, socket, client) {
        this.log = log;
        this.cr = client || new ClusterRender('custom_cluster', socket);
        this.effectRef = 0;
        this.panelRef = 0;
        this.badgeRef = 0;
        this.ready = false;
        this.layerState = 'inactive';
        this.targetState = 'unknown';
        this.panelLayerState = 'inactive';
        this.panelLayerReason = '';
        this.panelTargetState = 'unknown';
        this.panelTargetReason = '';
        this.lastRefusal = '';
        this.rendererStatusText = '';
        this.rendererStatusAt = 0;
        this.lastStatusRequestAt = 0;
        this.activePanelTarget = 'panel';
        this.activeTestMode = '';
        this.lastSample = 0;
        this.data = {};
        this.panelEvents = [];
        this.traceSink = null;
        this.suspended = false;
        this.recoveryState = 'not requested';
        this.recoveryRequestedAt = 0;
        this.recoveryStatusAt = 0;
        this.options = { layout: 'stock', accent: 'm', phoneBadge: false, wazeMap: 'auto',
            sixwbTheme: 'comfort', sixwbColorSource: 'original',
            colorMode: 'palette', colorBrightness: 100,
            panelTestMode: 'probe', panelTarget: 'panel' };
        this.phoneOpen = false;
        this.lastSent = 0;
        this.armedUntil = 0;
        this.disarmReason = 'Off by default';
        this.cr.on('ready', () => {
            this.ready = true;
            this.tracePanel('renderer ready: ' + (this.cr.backend || 'unknown') + ', targets ' + (this.cr.targets || '-'));
            this.lastStatusRequestAt = 0;
            this.apply();
            this.pollStatus(true);
            this.log.info('cluster renderer connected backend=' + this.cr.backend + ' targets=' + this.cr.targets);
        });
        this.cr.on('disconnected', () => {
            this.tracePanel('renderer disconnected');
            this.ready = false;
            this.layerState = 'disconnected';
            this.panelLayerState = 'disconnected';
        });
        this.cr.on('layer', (ref, state, reason) => {
            if (ref === this.panelRef) {
                this.tracePanel('panel layer ' + state + (reason ? ': ' + reason : ''));
                this.panelLayerState = state;
                this.panelLayerReason = reason || '';
                this.log.info('panel layer ' + state + (reason ? ': ' + reason : ''));
            } else if (ref === this.effectRef || ref === this.badgeRef) {
                this.layerState = state;
            }
            if (state === 'error') this.log.warn('cluster layer: ' + reason);
        });
        this.cr.on('target', (target, state, holder, reason) => {
            if (target === 'map') this.targetState = target + ': ' + state;
            if (target === this.activePanelTarget) {
                this.tracePanel('target ' + target + ': ' + state + (holder ? ' (' + holder + ')' : '') +
                    (reason ? ' - ' + reason : ''));
                this.panelTargetState = state + (holder ? ' (' + holder + ')' : '');
                this.panelTargetReason = reason || '';
                this.log.info('panel target ' + target + ': ' + this.panelTargetState +
                    (reason ? ' ' + reason : ''));
            }
        });
        this.cr.on('status', (value) => {
            this.rendererStatusText = String(value || '').slice(0, 24000);
            if (this.recoveryRequestedAt && !this.panelRef) {
                const panel = this.rendererStatusText.split('\n')
                    .find((line) => /^target panel slot 0x203 /i.test(line));
                if (panel) {
                    this.recoveryStatusAt = Date.now();
                    this.recoveryState = /;\s*idle[;\s]/i.test(panel) ?
                        'panel idle (BMW media NOT verified)' :
                        'panel not idle (recovery NOT verified)';
                    this.tracePanel('post-release: ' + panel.slice(0, 300));
                }
            }
            this.rendererStatusAt = Date.now();
            if (this.armedUntil) {
                // Preserve the renderer's *during-test* state; a QR export
                // made after 12 seconds otherwise sees only the idle slot.
                const lines = this.rendererStatusText.split('\n')
                    .filter((line) => /^(target (panel|map)|slot 0x(100|200|203)|renderer:)/i.test(line)).slice(0, 6);
                if (lines.length) this.tracePanel('during test: ' + lines.join(' | '));
            }
        });
        this.cr.on('refused', (op, ref, reason) => {
            this.tracePanel('renderer refused ' + op + ' ref=' + ref + ': ' + reason);
            this.lastRefusal = op + ' ref=' + ref + ': ' + reason;
            this.log.warn('cluster ' + this.lastRefusal);
        });
        this.cr.connect();
    }

    tracePanel(event) {
        const line = new Date().toISOString() + ' ' + String(event).replace(/\s+/g, ' ').slice(0, 600);
        this.panelEvents.push(line);
        if (this.panelEvents.length > 80) this.panelEvents.shift();
        // Preserve transitions immediately on disk, not only when QR is opened.
        if (this.traceSink) {
            try { this.traceSink(line); } catch (_) { /* logging must not stop rendering */ }
        }
    }
    setTraceSink(fn) {
        this.traceSink = typeof fn === 'function' ? fn : null;
        if (this.traceSink) this.tracePanel('automatic session logging enabled');
    }
    history() { return this.panelEvents.join('\n') || '(no panel events yet)'; }
    // This only releases OUR client layers; it cannot command the BMW HMI to
    // re-open its music widget. Never claim OEM graphics have been restored.
    restoreOriginal() {
        this.armedUntil = 0;
        this.activeTestMode = '';
        this.suspended = true;
        if (this.panelRef) { this.cr.drop(this.panelRef); this.panelRef = 0; }
        if (this.effectRef) { this.cr.drop(this.effectRef); this.effectRef = 0; }
        if (this.badgeRef) { this.cr.drop(this.badgeRef); this.badgeRef = 0; }
        this.recoveryRequestedAt = Date.now();
        this.recoveryStatusAt = 0;
        this.recoveryState = 'release requested; BMW music unverified';
        this.disarmReason = 'All Custom Cluster graphics released (BMW media unverified)';
        this.tracePanel('restore requested: drop own layers, disconnect renderer client');
        this.ready = false;
        // A socket disconnect also releases the renderer-side ownership if a
        // previous drop got lost. Never restart the shared renderer/Waze tool.
        try {
            this.cr.close();
            this.cr.connect();
        } catch (e) {
            this.recoveryState = 'renderer reconnect failed: ' + String(e.message || e);
            this.tracePanel(this.recoveryState);
        }
        return this.recoveryState;
    }
    clearHistory() { this.panelEvents.length = 0; }

    settings(options) {
        const previous = this.options;
        this.options = options;
        if (previous.layout !== options.layout && options.layout === 'stock') {
            this.suspended = true; // stock never requests a custom display
        }
        if (previous.layout !== options.layout || previous.panelTarget !== options.panelTarget ||
            previous.panelTestMode !== options.panelTestMode) this.disarm('Panel settings changed');
        this.apply();
    }
    sample(d) {
        if (!d || d.demo || !finite(d.speed) || !finite(d.rpm) || d.speed < 0 || d.speed > 350 || d.rpm < 0 || d.rpm > 8000) return;
        this.data = d;
        this.lastSample = Date.now();
        this.apply();
    }
    // Gear selection can change without an rpm/speed notification. Observe it
    // separately, without falsely refreshing the last real telemetry sample.
    observeVehicle(d) {
        if (!d || d.demo) {
            if (this.armedUntil) { this.disarm('Non-live vehicle data'); this.apply(); }
            return;
        }
        if (this.data.stage !== d.stage) {
            this.data.stage = d.stage;
            this.apply();
        }
    }
    badge(opened) { this.phoneOpen = !!opened; this.apply(); }
    live() { return !!this.lastSample && Date.now() - this.lastSample < 30000; }
    parked() { return this.live() && this.data.stage === 'P' && this.data.speed >= 0 && this.data.speed < 0.5; }
    testGuard() {
        if (!this.lastSample) return 'Waiting for real speed + RPM (no complete sample yet)';
        if (!this.live()) return 'Speed/RPM stale (' + Math.round((Date.now() - this.lastSample) / 1000) + 's)';
        if (this.data.stage !== 'P') return 'Selector ' + (this.data.stage || 'unknown') + ' - P required';
        if (this.data.speed >= 0.5) return 'Vehicle moving (' + this.data.speed.toFixed(1) + ' km/h)';
        return 'Ready: real speed/RPM, stopped, selector P';
    }
    pollStatus(force) {
        if (!this.ready) return;
        const now = Date.now();
        const wait = this.panelRef ? 1500 : 8000;
        if (force || now - this.lastStatusRequestAt >= wait) {
            this.lastStatusRequestAt = now;
            this.cr.status();
        }
    }
    panelTarget() {
        const target = this.options.panelTarget;
        return PANEL_TARGETS[target] ? target : 'panel';
    }
    armPanel() {
        if (this.armedUntil) { this.restoreOriginal(); return false; }
        if (this.options.layout !== 'g80' && this.options.layout !== 'oem' && this.options.layout !== 'sixwb') {
            this.disarmReason = 'Choose a full-panel design first';
            this.tracePanel('test refused: ' + this.disarmReason);
            return false;
        }
        if (!this.parked()) { this.disarmReason = this.testGuard(); this.tracePanel('test refused: ' + this.disarmReason); return false; }
        // Do not stack requests on top of a release with unconfirmed slot state.
        if (this.recoveryRequestedAt &&
            (!this.recoveryStatusAt ||
             this.recoveryState.indexOf('panel idle') !== 0)) {
            this.disarmReason = 'Prior panel release not confirmed; use Restore BMW and check OEM media';
            this.tracePanel('test refused: ' + this.disarmReason);
            return false;
        }
        if (!this.ready) { this.disarmReason = 'Renderer not connected'; this.tracePanel('test refused: ' + this.disarmReason); return false; }
        const target = this.panelTarget();
        if (target !== 'panel' && !String(this.cr.targets || '').split(',').some((t) => t.trim().indexOf(target + ':') === 0)) {
            this.disarmReason = target + ' not advertised by installed renderer';
            this.tracePanel('test refused: ' + this.disarmReason);
            return false;
        }
        this.suspended = false;
        this.activePanelTarget = target;
        this.activeTestMode = this.options.panelTestMode === 'design' ? 'design' : 'probe';
        this.panelTargetState = 'requesting';
        this.panelTargetReason = '';
        this.panelLayerState = 'requesting';
        this.panelLayerReason = '';
        this.lastRefusal = '';
        this.rendererStatusText = '';
        this.armedUntil = Date.now() + PANEL_TEST_MS;
        this.tracePanel('test armed: ' + this.options.layout + '/' + this.activeTestMode +
            ' target=' + target + ' speed=' + this.data.speed + ' rpm=' + this.data.rpm);
        this.disarmReason = this.activeTestMode + ' test: 12 seconds maximum';
        this.apply();
        this.pollStatus(true);
        return true;
    }
    disarm(reason) {
        const hadPanel = !!this.panelRef;
        if (this.armedUntil || hadPanel) this.tracePanel('test ended: ' + (reason || 'unknown'));
        this.armedUntil = 0;
        if (reason) this.disarmReason = reason;
        if (hadPanel) this.restoreOriginal();
        else this.activeTestMode = '';
    }
    apply() {
        if (this.suspended) return; // never recreate a layer during OEM recovery
        const mode = MODES[this.options.layout] || 0;
        const valid = this.live();
        if (this.armedUntil && (!this.parked() || Date.now() >= this.armedUntil)) {
            this.disarm(this.parked() ? 'Test timeout — original cluster restored' : this.testGuard());
        }
        const panelActive = (mode === 4 || mode === 5 || mode === 6) && this.armedUntil > Date.now() && this.parked();
        if (panelActive && !this.panelRef) {
            const probe = this.activeTestMode === 'probe';
            this.panelRef = this.cr.effect({ target: this.activePanelTarget, klass: 'content',
                contend: true, guide_hold: false,
                x: probe ? 86 : 0, y: probe ? 300 : 0,
                w: probe ? 260 : 1920, h: probe ? 110 : 720,
                fs: probe ? probeShader : mode === 6 ? sixwbShader : g80Shader });
            this.lastSent = 0;
            if (!this.panelRef) {
                this.tracePanel('renderer refused panel layer creation');
                this.disarmReason = 'Renderer refused panel layer creation';
                this.armedUntil = 0;
                this.panelLayerState = 'creation failed';
            }
        }
        if (!panelActive && this.panelRef) this.disarm('Original cluster restored');
        const show = mode > 0 && mode < 4 && valid;
        if (show && !this.effectRef) {
            this.effectRef = this.cr.effect({ target: 'map', klass: 'overlay',
                // NEVER evict the BMW stock map merely to show coloured dials.
                // Waze may hold the map slot; otherwise the OEM map wins.
                contend: false, guide_hold: false, x: 0, y: 0, w: 1088, h: 480,
                fs: fragmentShader });
        }
        if (!show && this.effectRef) { this.cr.drop(this.effectRef); this.effectRef = 0; }
        if (panelActive && this.panelRef && Date.now() - this.lastSent >= 150) {
            const d = this.data;
            if (this.activeTestMode !== 'probe') {
                this.cr.uniform(this.panelRef, 'u_values', [d.speed, d.rpm, finite(d.oil) ? d.oil : -1,
                    finite(d.coolant) ? d.coolant : -1]);
                const sixwbMode = { comfort: 0, sport: 1, eco: 2 }[this.options.sixwbTheme] || 0;
                this.cr.uniform(this.panelRef, 'u_options', [1,
                    finite(d.gear) ? d.gear : 0, this.options.phoneBadge && this.phoneOpen ? 1 : 0,
                    mode === 6 ? sixwbMode : mode === 5 ? 1 : 0]);
            }
            this.cr.uniform(this.panelRef, 'u_accent', mode === 6 ? resolve6WBColor(this.options, Date.now())
                : resolveColor(this.options, Date.now()));
            this.lastSent = Date.now();
        }
        if (show && this.effectRef && Date.now() - this.lastSent >= 150) {
            const d = this.data;
            this.cr.uniform(this.effectRef, 'u_values', [d.speed, d.rpm, finite(d.oil) ? d.oil : -1,
                finite(d.coolant) ? d.coolant : -1]);
            this.cr.uniform(this.effectRef, 'u_style', [mode, 1, 0, 0]);
            this.cr.uniform(this.effectRef, 'u_accent', resolveColor(this.options, Date.now()));
            this.lastSent = Date.now();
        }
        const wantBadge = this.options.phoneBadge && this.phoneOpen && !panelActive;
        if (wantBadge && !this.badgeRef) {
            // No contend: a stock layout does NOT seize the centre-slot from BMW.
            // When Waze has that slot, this floats over it (same compositor).
            this.badgeRef = this.cr.effect({ target: 'map', klass: 'overlay',
                contend: false, x: 992, y: 9, w: 74, h: 74, fs: BADGE_FS });
        }
        if (!wantBadge && this.badgeRef) { this.cr.drop(this.badgeRef); this.badgeRef = 0; }
    }
    status() {
        // The last *reported* selector position is independent from the
        // stricter parked-test guard. A stationary BMW can stop publishing
        // speed/RPM changes, making telemetry stale even when P is selected.
        return { ready: this.ready, layer: this.layerState, target: this.targetState,
            live: this.live(), layout: this.options.layout, parked: this.parked(),
            gearPosition: this.data.stage || null, gearP: this.data.stage === 'P',
            speedKmh: finite(this.data.speed) ? this.data.speed : null,
            engineRpm: finite(this.data.rpm) ? this.data.rpm : null,
            sampleAgeSeconds: this.lastSample ? Math.max(0, Math.floor((Date.now() - this.lastSample) / 1000)) : null,
            panelActive: !!this.panelRef, panelLayer: this.panelLayerState,
            panelLayerReason: this.panelLayerReason,
            panelTarget: this.activePanelTarget, panelTargetState: this.panelTargetState,
            panelTargetReason: this.panelTargetReason, activeTestMode: this.activeTestMode,
            rendererBackend: this.cr.backend || 'unknown', rendererTargets: this.cr.targets || '',
            rendererStatusAt: this.rendererStatusAt,
            lastRefusal: this.lastRefusal, disarmReason: this.disarmReason,
            recoveryState: this.recoveryState, recoveryRequestedAt: this.recoveryRequestedAt,
            suspended: this.suspended,
            testGuard: this.testGuard(),
            secondsLeft: this.panelRef ? Math.max(0, Math.ceil((this.armedUntil - Date.now()) / 1000)) : 0,
            color: colorHex(this.options.layout === 'sixwb' ? resolve6WBColor(this.options, Date.now())
                : resolveColor(this.options, Date.now())) };
    }
    rendererStatus() { return this.rendererStatusText; }
    close() {
        this.restoreOriginal();
        this.cr.close();
    }
}
module.exports = { ClusterLayers, MODES, COLORS, PANEL_TEST_MS };
