'use strict';
// USB A/B comparison exports of the original Night Drive test song.
// The processed version runs through the existing native DSP PCM socket.
// No ALSA device, BMW media source, AudioManager, or CarPlay routing is opened.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');
const { MusicSource, RATE, TOTAL_FRAMES } = require('./test_music');
let Client;
try { Client = require('./kit/dsp-client'); }
catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') throw e;
    // The in-vehicle package has kit/dsp-client; source checkout tests do not.
    Client = require('../../kit/runtime/dsp-client');
}

const FRAMES_BYTES = TOTAL_FRAMES * 4;
const ORIGINAL = 'night-drive-original.wav';
const PROCESSED = 'night-drive-dsp.wav';
function header(dataBytes) {
    const b = Buffer.alloc(44);
    b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + dataBytes, 4);
    b.write('WAVEfmt ', 8, 'ascii'); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
    b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 4, 28);
    b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36, 'ascii'); b.writeUInt32LE(dataBytes, 40);
    return b;
}
function remove(file) { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
function toWav(temp, filter, onFailure) {
    return new Promise((resolve, reject) => {
        const source = new MusicSource();
        const counter = new Transform({
            transform(chunk, enc, cb) {
                this.bytes += chunk.length;
                if (this.bytes > FRAMES_BYTES) return cb(new Error('Testmusik-PCM zu lang'));
                cb(null, chunk);
            }
        });
        counter.bytes = 0;
        const output = fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 });
        let settled = false;
        function fail(e) {
            if (settled) return; settled = true;
            source.destroy(); if (filter) filter.destroy();
            counter.destroy(); output.destroy();
            reject(e);
        }
        source.on('error', fail); counter.on('error', fail);
        output.on('error', fail);
        if (filter) filter.on('error', fail);
        output.on('finish', () => {
            if (settled) return;
            if (counter.bytes !== FRAMES_BYTES) return fail(new Error('Testmusik-PCM unvollstaendig: ' + counter.bytes));
            if (onFailure && onFailure()) return fail(new Error('DSP-Stream wechselte zu Bypass'));
            settled = true; resolve(counter.bytes);
        });
        output.write(header(FRAMES_BYTES));
        if (filter) source.pipe(filter).pipe(counter).pipe(output);
        else source.pipe(counter).pipe(output);
    });
}
function fileHash(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function activeProfile(config) {
    return !!config && config.enabled && (config.preampDb < 0 ||
        config.bands && config.bands.some((b) => b.gainDb !== 0));
}
async function exportComparison(dir, opts) {
    opts = opts || {};
    const request = opts.request || Client.request;
    const runtime = opts.runtime || Client.RUNTIME;
    const notify = opts.onProgress || (() => {});
    const before = await request({ op: 'status' }, { runtime, timeout: 2000 });
    if (!activeProfile(before.config)) throw new Error('DSP EIN und mindestens eine Gain-Aenderung erforderlich (z.B. 100 Hz +6 dB).');
    if (!Number.isSafeInteger(before.revision)) throw new Error('DSP-Revisionsnummer fehlt');
    const outOriginal = path.join(dir, ORIGINAL);
    const outProcessed = path.join(dir, PROCESSED);
    const partOriginal = outOriginal + '.part';
    const partProcessed = outProcessed + '.part';
    // Repeated exports overwrite exactly these two files, preventing
    // unbounded disk usage in the MGU app sandbox (~11.3 MB in total).
    for (const file of [partOriginal, partProcessed, outOriginal, outProcessed]) remove(file);
    try {
        notify('Originalmusik wird als WAV exportiert ...');
        await toWav(partOriginal, null, null);
        fs.renameSync(partOriginal, outOriginal);
        let failure = '';
        const filter = new (opts.PcmFilter || Client.PcmFilter)({
            runtime, sampleRate: RATE, channels: 2, source: 'equalizer_wav_export', timeout: 2400,
            onFallback: (e) => { failure = String(e || 'unknown'); }
        });
        notify('Der native DSP verarbeitet jetzt Night Drive ...');
        await toWav(partProcessed, filter, () => failure);
        if (failure) throw new Error('DSP-Verbindung unterbrochen: ' + failure);
        const after = await request({ op: 'status' }, { runtime, timeout: 2000 });
        if (after.revision !== before.revision || !activeProfile(after.config))
            throw new Error('DSP-Konfiguration waehrend Export veraendert; Vergleich verworfen');
        if (after.frames < before.frames + TOTAL_FRAMES)
            throw new Error('DSP hat nicht alle PCM-Frames bestaetigt');
        if (fileHash(outOriginal) === fileHash(partProcessed))
            throw new Error('Kein DSP-Unterschied messbar; bitte mindestens ein Filterband aendern');
        fs.renameSync(partProcessed, outProcessed);
        return { original: outOriginal, processed: outProcessed,
            frames: TOTAL_FRAMES, rate: RATE, revision: before.revision, bytes: FRAMES_BYTES };
    } catch (e) {
        for (const file of [partOriginal,partProcessed,outOriginal,outProcessed]) {
            try { remove(file); } catch (_) {}
        }
        throw e;
    }
}
module.exports = { exportComparison, header, activeProfile, ORIGINAL, PROCESSED, FRAMES_BYTES };
