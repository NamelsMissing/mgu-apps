'use strict';
/**
 * Pixel-only brightness compensation for BMW's home widget skin.
 *
 * Some ID7 skins darken/crop the Drive Recorder widget at its edges. This
 * function can counter part of the dimming in the PNG before it reaches HMI.
 * It cannot disable a native compositor mask, which remains skin-controlled.
 * Only widget canvases are changed; the full app preview and GIF files are not.
 */
function compensateWidget(cv, mode) {
    if (mode === 'original' || mode === 'neutral') return cv;
    if (mode === 'strong') return extendEdges(cv);
    // Preserve the 0.3.1 curve for comparisons.
    const gamma = 0.84, centreGain = 1.12, edgeGain = 0.42;
    const table = new Uint8Array(256);
    const d = cv.d, w = cv.w, h = cv.h;
    if (!w || !h) return cv;
    for (let i = 0; i < 256; i++) table[i] = Math.round(255 * Math.pow(i / 255, gamma));
    for (let y = 0; y < h; y++) {
        const edge = Math.abs((y + 0.5) * 2 / h - 1);
        const gain = centreGain + edgeGain * edge * edge;
        for (let x = 0, i = y * w * 4; x < w; x++, i += 4) {
            d[i] = Math.min(255, Math.round(table[d[i]] * gain));
            d[i + 1] = Math.min(255, Math.round(table[d[i + 1]] * gain));
            d[i + 2] = Math.min(255, Math.round(table[d[i + 2]] * gain));
        }
    }
    return cv;
}

/**
 * Four-sided correction for comparison with the native skin. Scale RGB by
 * the same factor and roll the boost off toward white to preserve hue and
 * highlight headroom. The coefficients are deliberately conservative until
 * on-car measurements are available.
 */
function extendEdges(cv) {
    const { d, w, h } = cv;
    for (let y = 0; y < h; y++) {
        const vertical = Math.pow(Math.abs((y + 0.5) * 2 / h - 1), 3);
        for (let x = 0; x < w; x++) {
            const horizontal = Math.pow(Math.abs((x + 0.5) * 2 / w - 1), 3);
            const i = (y * w + x) * 4;
            const peak = Math.max(d[i], d[i + 1], d[i + 2]);
            const gain = 1 + (0.12 + 0.36 * vertical + 0.28 * horizontal) * (255 - peak) / 255;
            for (let c = 0; c < 3; c++) d[i + c] = Math.round(d[i + c] * gain);
        }
    }
    return cv;
}

module.exports = { compensateWidget };
