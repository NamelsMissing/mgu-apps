'use strict';

const { ClusterRender } = require('./cluster_render_client');

const LINE_FS = `#version 100
precision mediump float;
varying vec2 v_uv;
uniform vec4 u_color;
void main(){
  float e=min(v_uv.x,1.0-v_uv.x);
  gl_FragColor=vec4(u_color.rgb,u_color.a*smoothstep(0.0,0.06,e));
}`;
const COLORS = { opened: [0.20, 0.82, 0.48, 0.9], closed: [0.86, 0.20, 0.18, 0.9] };
const Z = 900;
const W = 160, H = 4;
const MAP_RECT = { x: 464, y: 469, w: W, h: H };

class StatusLine {
    constructor(log, renderer) {
        this.renderer = renderer || new ClusterRender('blitzer_status');
        this.ref = 0;
        this.state = 'unknown';
        this.renderer.on('disconnected', () => this.update('unknown'));
        this.renderer.on('layer', (ref, state, reason) => {
            if (ref === this.ref && state === 'error') log.warn('Blitzer status line: ' + reason);
        });
        this.renderer.on('refused', (op, ref, reason) => {
            log.warn('Blitzer status renderer: ' + op + ' ' + reason);
        });
        this.renderer.connect();
    }

    update(state) {
        if (state !== 'opened' && state !== 'closed') {
            if (this.ref) this.renderer.drop(this.ref);
            this.ref = 0;
            this.state = 'unknown';
            return;
        }
        if (!this.renderer.ready) return;
        if (!this.ref) {
            this.ref = this.renderer.effect(Object.assign({
                target: 'map', klass: 'overlay', z: Z, visible: false,
                contend: false, guide_hold: false, fs: LINE_FS
            }, MAP_RECT));
            if (!this.ref) return;
            this.renderer.uniform(this.ref, 'u_color', COLORS[state]);
            this.renderer.set(this.ref, { visible: true });
        } else if (state !== this.state) {
            this.renderer.uniform(this.ref, 'u_color', COLORS[state]);
        }
        this.state = state;
    }

    close() {
        this.update('unknown');
        this.renderer.close();
    }
}

module.exports = { StatusLine, MAP_RECT };
