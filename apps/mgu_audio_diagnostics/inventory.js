'use strict';
// Only metadata. No ALSA device open, audio read, or SmartX ringbuffer access.
const fs = require('fs');
const path = require('path');
function read(file, max, io) {
    io = io || fs; let fd;
    try {
        fd = io.openSync(file, 'r');
        const buf = Buffer.alloc(max || 4096);
        return buf.slice(0, io.readSync(fd, buf, 0, buf.length, 0)).toString('utf8');
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
    const services = [];
    for (const pid of processes) {
        const comm = (read(target('/proc/' + pid + '/comm'), 80, io) || '').trim();
        if (expected.test(comm) && services.indexOf(comm) < 0) services.push(comm);
    }
    return {schema:1, app:'mgu_audio_diagnostics', version:'0.1.1', at:new Date().toISOString(), arch:process.arch,
        alsaLib:!!stat(target('/usr/lib/libasound.so.2'),io),
        smartxLib:!!stat(target('/usr/lib/alsa-lib/libasound_module_pcm_smartx.so'),io),
        cards:lines('/proc/asound/cards',2048,6), pcm:lines('/proc/asound/pcm',2048,8),
        endpointCount:entries.length, endpoints, services:services.sort().slice(0,12),
        note:'Metadata only. No PCM opened. No audible BMW route confirmed.'};
}
function exportReport(dir, data) {
    const out = path.join(dir,'mgu-audio-diagnostics.json'), temp=out+'.tmp';
    const text = JSON.stringify({schema:1,app:'mgu_audio_diagnostics',version:'0.1.1',
        at:data.at,arch:data.arch,alsaLib:data.alsaLib,smartxLib:data.smartxLib,
        cards:data.cards,pcm:data.pcm,endpointCount:data.endpointCount,
        endpoints:data.endpoints,services:data.services,dsp:data.dsp||null,audioManager:data.audioManager||null,note:data.note},null,2);
    if (Buffer.byteLength(text)>48000) throw new Error('Diagnose zu gross');
    const fd=fs.openSync(temp,'w',0o600);
    try {fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    try {fs.renameSync(temp,out);}catch(e){try{fs.unlinkSync(temp);}catch(_){}throw e;}
    return out;
}
module.exports={collect,category,exportReport};
