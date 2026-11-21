'use strict';

const qrcode = require('./qr_vendor');

function matrix(content) {
    const qr = qrcode(0, 'M');
    qr.addData(content);
    qr.make();
    return qr;
}

function draw(cv, qr, x, y, maxSize) {
    const n = qr.getModuleCount(), quiet = 4;
    const pixel = Math.floor(maxSize / (n + quiet * 2));
    if (pixel < 2) throw new RangeError('QR modules too dense');
    const side = pixel * (n + quiet * 2);
    const left = x + Math.floor((maxSize - side) / 2);
    const top = y + Math.floor((maxSize - side) / 2);
    cv.fillRect(left, top, side, side, '#ffffff');
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++)
        if (qr.isDark(row, col)) cv.fillRect(left + (col + quiet) * pixel,
            top + (row + quiet) * pixel, pixel, pixel, '#000000');
}

module.exports = { matrix, draw };
