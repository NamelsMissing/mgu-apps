'use strict';

// Original, dependency-free two-player Pong. The same input snapshots are used
// by the console emulators, so the first game also tests the controller layer.
const WIDTH = 900, HEIGHT = 450, PADDLE = 92;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

class Pong {
    constructor(options) {
        this.title = 'Arcade / Pong';
        this.cpuPlayer2 = !!(options && options.cpuPlayer2);
        this.width = WIDTH; this.height = HEIGHT;
        this.left = HEIGHT / 2; this.right = HEIGHT / 2;
        this.scores = [0, 0]; this.reset(1);
        this.sound = false;
        this.samples = new Float32Array(1600);
        this.toneLeft = this.toneHz = this.tonePhase = 0;
    }
    reset(dir) { this.ballX = WIDTH / 2; this.ballY = HEIGHT / 2; this.vx = dir * 5.8; this.vy = 2.7; }
    tick(pads, delta) {
        const dt = clamp(delta || 1, 0.5, 2.0);
        this.audioFrames = Math.round(800 * dt);
        const p1 = pads[0] || {}, p2 = pads[1] || {};
        this.left = clamp(this.left + ((p1.down ? 1 : 0) - (p1.up ? 1 : 0)) * 7.5 * dt, PADDLE / 2 + 10, HEIGHT - PADDLE / 2 - 10);
        if (this.cpuPlayer2) {
            // Deliberately imperfect AI: slower tracking than a human paddle.
            const target = this.vx > 0 ? this.ballY : HEIGHT / 2;
            this.right = clamp(this.right + clamp(target - this.right, -4.8 * dt, 4.8 * dt),
                PADDLE / 2 + 10, HEIGHT - PADDLE / 2 - 10);
        } else this.right = clamp(this.right + ((p2.down ? 1 : 0) - (p2.up ? 1 : 0)) * 7.5 * dt,
            PADDLE / 2 + 10, HEIGHT - PADDLE / 2 - 10);
        this.ballX += this.vx * dt; this.ballY += this.vy * dt;
        if (this.ballY <= 11 || this.ballY >= HEIGHT - 11) { this.vy = -this.vy; this.ballY = clamp(this.ballY, 11, HEIGHT - 11); this.beep(330, 1200); }
        const left = this.ballX < 52 && this.vx < 0 && Math.abs(this.ballY - this.left) < PADDLE / 2 + 8;
        const right = this.ballX > WIDTH - 52 && this.vx > 0 && Math.abs(this.ballY - this.right) < PADDLE / 2 + 8;
        if (left || right) {
            this.beep(620, 1400);
            this.vx = -this.vx * 1.03;
            this.vy = clamp((this.ballY - (left ? this.left : this.right)) * 0.09, -7, 7);
            this.ballX = left ? 52 : WIDTH - 52;
        }
        if (this.ballX < -10) { this.scores[1]++; this.reset(1); this.beep(200, 2800); }
        if (this.ballX > WIDTH + 10) { this.scores[0]++; this.reset(-1); this.beep(200, 2800); }
    }
    setAudioEnabled(on) {
        this.sound = !!on;
        if (!on) this.toneLeft = 0;
    }
    beep(hz, duration) {
        if (!this.sound) return;
        this.toneHz = hz;
        this.toneLeft = duration;
        this.tonePhase = 0;
    }
    releaseInput() { this.toneLeft = 0; }
    getAudioSamples() {
        if (!this.sound || !this.audioFrames) return null;
        const left = this.samples.subarray(0, this.audioFrames);
        left.fill(0);
        const step = 2 * Math.PI * this.toneHz / 48000;
        for (let i = 0; i < left.length && this.toneLeft; i++, this.toneLeft--) {
            this.tonePhase += step;
            left[i] = Math.sin(this.tonePhase) * 0.22 * Math.min(1, this.toneLeft / 300);
        }
        return {rate: 48000, left};
    }
    draw(cv, x, y, w, h) {
        const sx = w / WIDTH, sy = h / HEIGHT;
        cv.roundRect(x, y, w, h, 15, '#0b1726');
        for (let row = 12; row < HEIGHT; row += 32) cv.fillRect(x + w / 2 - 3, y + row * sy, 6, 17 * sy, '#36506c');
        cv.text(String(this.scores[0]), x + w * 0.38, y + h * .22, 58, '#deecff', {align: 'center', font: 'num'});
        cv.text(String(this.scores[1]), x + w * 0.62, y + h * .22, 58, '#deecff', {align: 'center', font: 'num'});
        cv.roundRect(x + 33 * sx, y + (this.left - PADDLE/2) * sy, 15 * sx, PADDLE * sy, 6, '#4cbcff');
        cv.roundRect(x + (WIDTH - 48) * sx, y + (this.right - PADDLE/2) * sy, 15 * sx, PADDLE * sy, 6, '#ff678d');
        cv.circle(x + this.ballX * sx, y + this.ballY * sy, 10 * Math.min(sx, sy), '#ffffff');
    }
    save() { return {scores: this.scores.slice()}; }
    stop() {}
}

module.exports = {Pong};
