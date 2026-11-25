'use strict';
// Only metadata. No ALSA device open, audio read, or SmartX ringbuffer access.
const fs = require('fs');
const path = require('path');
function read(file, max, io) {
    io = io || fs; let fd;
    try {
        fd = io.openSync(file, 'r');
        const buf = Buffer.alloc(max || 4096);
        let total = 0;
        while (total < buf.length) {
            const size = io.readSync(fd, buf, total, buf.length - total, null);
            if (!size) break;
            total += size;
        }
        return buf.toString('utf8', 0, total);
    } catch (_) { return null; }
    finally { if (fd !== undefined) try { io.closeSync(fd); } catch (_) {} }
}
function ls(file, io) { try { return (io || fs).readdirSync(file); } catch (_) { return []; } }
function stat(file, io) { try { return (io || fs).statSync(file); } catch (_) { return null; } }
function category(name) {
    if (/CarPlay/i.test(name)) return 'CARPLAY / RESERVED';
    if (/AndroidAuto|CarLife/i.test(name)) return 'PHONE / RESERVED';
    if (/ECall|HFP|Speech|Voice|ECNR|Tel|Ring|Nuance|Ispeech/i.test(name)) return 'VOICE / RESERVED';
    if (/MediaSink_AudioOut_Front/i.test(name)) return 'BMW MEDIA / RESERVED';
    return 'UNVERIFIED / NO WRITE';
}
const VERSION = '0.1.3';
const AUDIO_LIB = /^(libNmeAudio(?:Device|Renderer|Misc)?|libNmeCarPlay|libasound(?:_module_pcm_smartx)?|libias[A-Za-z0-9_]*|libsmartx[A-Za-z0-9_]*)\.so(?:\.[0-9.]+)?$/i;
const PCM_CLIENTS = ['mgu_video_hub', 'equalizer_wav_export', 'equalizer_test_music', 'equalizer_bmw_test'];
function dspStatus(status) {
    return {
        enabled: !!(status.config && status.config.enabled), frames: status.frames || 0,
        streams: (status.streams || []).slice(0, 8).map((s) => ({
            source: PCM_CLIENTS.indexOf(s.source) >= 0 ? s.source : 'Unbekannter PCM-Client',
            sampleRate: s.sampleRate, channels: s.channels, format: s.format || 'nicht verifiziert',
            frames: s.frames, filteredFrames: s.filteredFrames, clippedSamples: s.clippedSamples,
            lastFrameAt: s.lastFrameAt, lastFilteredAt: s.lastFilteredAt
        })),
        stockCarPlayRouted: !!status.stockCarPlayRouted
    };
}
function alsaPlayback(root, io) {
    const active = [];
    for (const card of ls(root, io).filter((n) => /^card[0-9]{1,3}$/.test(n)).slice(0, 16)) {
        const cardDir = path.join(root, card);
        for (const pcm of ls(cardDir, io).filter((n) => /^pcm[0-9]{1,3}p$/.test(n)).slice(0, 16)) {
            const pcmDir = path.join(cardDir, pcm);
            for (const sub of ls(pcmDir, io).filter((n) => /^sub[0-9]{1,3}$/.test(n)).slice(0, 8)) {
                const params = read(path.join(pcmDir, sub, 'hw_params'), 1024, io);
                if (!params) continue;
                const format = params.match(/^format: ([A-Z0-9_]{1,24})$/m);
                const access = params.match(/^access: ([A-Z0-9_]{1,30})$/m);
                const channels = params.match(/^channels: ([0-9]{1,2})$/m);
                const rate = params.match(/^rate: ([0-9]{1,7})(?: |$)/m);
                if (format && channels && rate) active.push({ device: card + '/' + pcm + '/' + sub, format: format[1],
                    access: access ? access[1] : 'nicht verifiziert', channels: Number(channels[1]), sampleRate: Number(rate[1]) });
                if (active.length >= 24) return active;
            }
        }
    }
    return active;
}
function collect(io, root) {
    io = io || fs; root = root || '';
    const target = (p) => root ? path.join(root, p.replace(/^\/+/, '')) : p;
    const lines = (p, size, limit) => (read(target(p), size, io) || '').split('\n').filter(Boolean).slice(0, limit).map(v => v.slice(0, 140));
    const entries = ls(target('/dev/shm'), io).filter(n => /^smartx_[a-zA-Z0-9_.-]{1,130}_connection$/.test(n)).sort();
    const endpoints = entries.slice(0, 120).map(n => {
        const s = stat(target('/dev/shm/' + n), io);
        return {name:n.slice(7,-11), category:category(n), gid:s ? s.gid : null,
            mode:s ? (s.mode & 0o777).toString(8) : 'unknown'};
    });
    const expected = /^(AudioManager|AlsaRoutingAdap|mediaengine|mediaapp|carplay|AVBSourceSinkC|avb_streamhandl|waveplayer|mediaddpserver)$/i;
    const processes = ls(target('/proc'), io).filter(n => /^[0-9]{1,8}$/.test(n)).slice(0,1200);
    const services = [], carPlay = [];
    for (const pid of processes) {
        const comm = (read(target('/proc/' + pid + '/comm'), 80, io) || '').trim();
        if (/^carplay$/i.test(comm) && carPlay.length < 4) {
            const maps = read(target('/proc/' + pid + '/maps'), 128 * 1024, io);
            const mapped = new Set(), smartx = new Set();
            for (const line of (maps || '').split('\n')) {
                const match = line.match(/\/([^/\s]+)(?: \(deleted\))?$/);
                if (!match) continue;
                if (AUDIO_LIB.test(match[1])) mapped.add(match[1]);
                if (/^smartx_CarPlay[A-Za-z0-9_.-]{1,100}_(ringbuffer|connection)$/.test(match[1])) smartx.add(match[1]);
            }
            carPlay.push({ pid: Number(pid), mapsReadable: maps !== null, libraries: Array.from(mapped).sort().slice(0, 30),
                smartx: Array.from(smartx).sort().slice(0, 16), pcm: 'nicht verifiziert' });
        }
        if (expected.test(comm) && services.indexOf(comm) < 0) services.push(comm);
    }
    return {schema:1, app:'mgu_audio_diagnostics', version:VERSION, at:new Date().toISOString(), arch:process.arch,
        alsaLib:!!stat(target('/usr/lib/libasound.so.2'),io),
        smartxLib:!!stat(target('/usr/lib/alsa-lib/libasound_module_pcm_smartx.so'),io),
        cards:lines('/proc/asound/cards',2048,6), pcm:lines('/proc/asound/pcm',2048,8),
        alsaPlayback:alsaPlayback(target('/proc/asound'),io), endpointCount:entries.length, endpoints, carPlay, services:services.sort().slice(0,12),
        note:'Metadata only. No PCM opened. No audible BMW route confirmed.'};
}
function exportReport(dir, data) {
    const out = path.join(dir,'mgu-audio-diagnostics.json'), temp=out+'.tmp';
    const text = JSON.stringify({schema:1,app:'mgu_audio_diagnostics',version:VERSION,
        at:data.at,arch:data.arch,alsaLib:data.alsaLib,smartxLib:data.smartxLib,
        cards:data.cards,pcm:data.pcm,alsaPlayback:data.alsaPlayback,endpointCount:data.endpointCount,
        endpoints:data.endpoints,services:data.services,dsp:data.dsp||null,audioManager:data.audioManager||null,carPlay:data.carPlay,events:data.events||[],note:data.note},null,2);
    if (Buffer.byteLength(text)>96000) throw new Error('Diagnose zu gross');
    const fd=fs.openSync(temp,'w',0o600);
    try {fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    try {fs.renameSync(temp,out);}catch(e){try{fs.unlinkSync(temp);}catch(_){}throw e;}
    return out;
}
function copyLog(dir, events) {
    const out = path.join(dir, 'mgu-audio-diagnostics.log');
    fs.writeFileSync(out + '.tmp', events.map((e) => e.at + '  ' + e.message).join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(out + '.tmp', out);
    return out;
}
module.exports={collect,category,exportReport,dspStatus,copyLog};
