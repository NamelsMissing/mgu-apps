'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const qrcode = require('./qr_vendor');

function diagnosticText(report) {
    const summary = Object.assign({}, report);
    delete summary.log;
    return 'AMBIENT LIGHTING DIAGNOSTICS\n' + JSON.stringify(summary, null, 2) +
        '\n\nLIVE LOG (UTC)\n' + report.log.map(row =>
            '[' + new Date(row.at).toISOString() + '] ' + row.kind + ' ' + row.message).join('\n') + '\n';
}

function createReport(report, format) {
    if (format !== 'text' && format !== 'json') throw new RangeError('Unknown report format');
    const text = format === 'json' ? JSON.stringify(report, null, 2) : diagnosticText(report);
    const packed = zlib.deflateSync(Buffer.from(text, 'utf8')).toString('base64');
    const id = crypto.createHash('sha256').update(packed, 'ascii').digest('hex').slice(0, 16);
    const chunks = packed.match(/.{1,480}/g);
    const pages = chunks.map((part, i) => 'AMBIENT1 ' + id + ' ' + format + ' ' +
        (i + 1) + '/' + chunks.length + '\n' + part);
    return {id, format, pages, size: Buffer.byteLength(text, 'utf8')};
}

function matrix(payload) {
    const qr = qrcode(0, 'M');
    qr.addData(payload);
    qr.make();
    return qr;
}
function draw(cv, qr, x, y, maxSize) {
    const n = qr.getModuleCount(), quiet = 4;
    const pixel = Math.floor(maxSize / (n + quiet * 2));
    if (pixel < 2) throw new RangeError('QR is too dense');
    const size = pixel * (n + quiet * 2);
    const left = x + Math.floor((maxSize - size) / 2), top = y + Math.floor((maxSize - size) / 2);
    cv.fillRect(left, top, size, size, '#FFFFFF');
    for (let row = 0; row < n; row++) {
        let start = 0;
        while (start < n) {
            if (!qr.isDark(row, start)) { start++; continue; }
            let end = start + 1;
            while (end < n && qr.isDark(row, end)) end++;
            cv.fillRect(left + (start + quiet) * pixel, top + (row + quiet) * pixel, (end - start) * pixel, pixel, '#000000');
            start = end;
        }
    }
}

module.exports = {createReport, diagnosticText, matrix, draw};
