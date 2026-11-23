'use strict';

const SIZES = [[64, 48], [256, 240], [320, 224]];

// Straight RGBA. Native upload premultiplies, while Canvas reads these original bytes.
function testImage(pixels, width, height, phase) {
    const marker = phase % (width - 8);
    for (let y = 0, i = 0; y < height; y++) {
        for (let x = 0; x < width; x++, i += 4) {
            const right = x >= width / 2, bottom = y >= height / 2;
            const moving = phase > 0 && y >= height / 4 && y < height / 4 + 8 && x >= marker && x < marker + 8;
            const grid = y < 4 && (x + y) % 2 === 0;
            pixels[i] = moving || grid ? 0 : right === bottom ? 255 : 0;
            pixels[i + 1] = moving ? 255 : grid ? 0 : right ? 255 : 0;
            pixels[i + 2] = moving || grid ? 0 : bottom ? 255 : 0;
            pixels[i + 3] = y >= height - 8 ? (x < width / 2 ? 0 : 128) : 255;
        }
    }
    return pixels;
}

module.exports = {testImage, SIZES};
