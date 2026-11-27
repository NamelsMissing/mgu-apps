'use strict';
/** Shared deterministic colour selection for iDrive previews and KOMBI GLSL. */
const PALETTE = {
    m: [0.08, 0.70, 1.00],
    cyan: [0.09, 0.96, 0.94],
    green: [0.24, 0.99, 0.52],
    purple: [0.69, 0.30, 1.00],
    pink: [1.00, 0.22, 0.71],
    red: [1.00, 0.16, 0.24],
    orange: [1.00, 0.37, 0.09],
    amber: [1.00, 0.58, 0.16],
    ice: [0.75, 0.92, 1.00],
    white: [1.00, 1.00, 1.00],
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const numeric = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);
function hsv(h, s, v) {
    h = ((h % 1) + 1) % 1;
    const x = h * 6, i = Math.floor(x);
    const f = x - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    return [ [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q] ][i];
}
/** Instrument colours per driving mode (colorMode 'drive', 0.7.0). */
const DRIVE_COLORS = {
    comfort: [0.30, 0.72, 1.00],
    sport: [1.00, 0.22, 0.16],
    eco: [0.10, 0.86, 0.95],
};
/** FES mode name -> comfort / sport / eco (adaptive and unknown: comfort). */
function driveTheme(mode) { return mode === 'sport' || mode === 'eco' ? mode : 'comfort'; }
function resolveColor(options, now) {
    const o = options || {};
    let rgb;
    if (o.colorMode === 'drive') {
        rgb = DRIVE_COLORS[driveTheme(o.driveMode)];
    } else if (o.colorMode === 'rgb') {
        rgb = [o.rgbRed, o.rgbGreen, o.rgbBlue].map((v) => clamp(numeric(v, 0), 0, 255) / 255);
    } else if (o.colorMode === 'cycle') {
        const durationMs = clamp(numeric(o.cycleSeconds, 20), 5, 120) * 1000;
        rgb = hsv((numeric(now, Date.now()) % durationMs) / durationMs, 0.90, 1.0);
    } else rgb = PALETTE[o.accent] || PALETTE.m;
    const strength = clamp(numeric(o.colorBrightness, 100), 25, 100) / 100;
    return rgb.map((v) => clamp(v * strength, 0, 1)).concat([1]);
}
/** Period-inspired 6WB Comfort/Sport/ECO colours; optional global RGB override. */
function resolve6WBColor(options, now) {
    const o = options || {};
    if (o.sixwbColorSource === 'studio') return resolveColor(o, now);
    const rgb = { comfort: [0.91, 0.93, 0.95], sport: [1.00, 0.20, 0.23], eco: [0.24, 0.68, 1.00] }
        [sixwbThemeOf(o)] || [0.91, 0.93, 0.95];
    const strength = clamp(numeric(o.colorBrightness, 100), 25, 100) / 100;
    return rgb.map((v) => clamp(v * strength, 0, 1)).concat([1]);
}
/** 6WB theme actually shown: a fixed choice, or the driving mode ('drive'). */
function sixwbThemeOf(o) { return o && o.sixwbTheme === 'drive' ? driveTheme(o.driveMode) : (o && o.sixwbTheme) || 'comfort'; }
/** True when the instrument colour depends on the driving mode. */
function followsDriveMode(o) {
    if (!o) return false;
    if (o.layout === 'sixwb') return o.sixwbColorSource === 'studio' ? o.colorMode === 'drive' : o.sixwbTheme === 'drive';
    return o.colorMode === 'drive';
}
function colorHex(rgba) {
    return '#' + rgba.slice(0, 3).map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
}
module.exports = { PALETTE, DRIVE_COLORS, hsv, resolveColor, resolve6WBColor, colorHex, driveTheme, sixwbThemeOf, followsDriveMode };
