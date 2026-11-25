'use strict';
const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const inv=require('../apps/mgu_audio_diagnostics/inventory');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mguaudiotest-'));
function put(p,text){const f=path.join(root,p);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,text);}
try{
    put('proc/asound/cards','0 [aplmgu] apl_mgu\n');
    put('proc/asound/pcm','00-00 BT Playback 1\n');
    put('proc/asound/card2/pcm0p/sub0/hw_params','access: RW_INTERLEAVED\nformat: S16_LE\nchannels: 2\nrate: 48000 (48000/1)\n');
    put('proc/asound/card2/pcm0p/sub1/hw_params','closed\n');
    put('proc/2587/comm','AlsaRoutingAdap\n');
    put('proc/2866/comm','carplay\n');
    put('proc/2866/maps', '123 rw-s 0 0 0 /dev/shm/smartx_CarPlayMain_CF_48_STEREO_p_ringbuffer\n' +
        '456 r-xp 0 0 0 /usr/lib/cinemo/libNmeAudioDevice.so\n' +
        '789 rw-s 0 0 0 /var/secret_track.mp3\n');
    put('usr/lib/libasound.so.2','mock');
    put('usr/lib/alsa-lib/libasound_module_pcm_smartx.so','mock');
    put('dev/shm/smartx_CarPlayMain_CF_48_STEREO_p_connection','secret mock ringbuffer');
    put('dev/shm/smartx_MediaSink_AudioOut_Front_CF_48_COMBINED_STEREO_MULTICHANNEL_p_connection','secret');
    put('dev/shm/smartx_ECallSink_CF_24_MONO_c_connection','secret');
    const data=inv.collect(fs,root);
    assert(data.alsaLib&&data.smartxLib);
    assert.strictEqual(data.endpointCount,3);
    assert.strictEqual(data.endpoints.find(x=>x.name.indexOf('CarPlay')>=0).category,'CARPLAY / RESERVED');
    assert.strictEqual(data.endpoints.find(x=>x.name.indexOf('MediaSink')>=0).category,'BMW MEDIA / RESERVED');
    assert.strictEqual(data.endpoints.find(x=>x.name.indexOf('ECall')>=0).category,'VOICE / RESERVED');
    assert(data.services.indexOf('AlsaRoutingAdap')>=0&&data.services.indexOf('carplay')>=0);
    assert.deepStrictEqual(data.alsaPlayback,[{device:'card2/pcm0p/sub0',format:'S16_LE',access:'RW_INTERLEAVED',channels:2,sampleRate:48000}]);
    assert.equal(data.carPlay[0].pid,2866);
    assert.deepStrictEqual(data.carPlay[0].libraries,['libNmeAudioDevice.so']);
    assert.equal(data.carPlay[0].pcm,'nicht verifiziert');
    assert.equal(data.carPlay[0].smartx.length,1);
    data.dsp=inv.dspStatus({frames:1024,config:{enabled:true},streams:[
        {source:'mgu_video_hub',sampleRate:48000,channels:2,format:'s16le',frames:1024,filteredFrames:1024},
        {source:'secret URL or title'}
    ]});
    data.events=[{at:data.at,message:'CarPlay-Prozess 2866'}];
    const log=inv.copyLog(root,data.events);
    assert(fs.readFileSync(log,'utf8').includes(data.events[0].message));
    assert.equal(fs.statSync(log).mode&0o777,0o600);
    const file=inv.exportReport(root,data);
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.strictEqual(saved.app,'mgu_audio_diagnostics');
    assert(!JSON.stringify(saved).includes('secret'));
    assert.equal(saved.dsp.streams[0].format,'s16le');
    assert.equal(saved.dsp.streams[1].source,'Unbekannter PCM-Client');
    assert.deepStrictEqual(saved.events,data.events);
    assert.strictEqual(fs.statSync(file).mode&0o777,0o600);
    console.log('PASS read-only MGU audio inventory and private diagnostics export');
}finally{fs.rmSync(root,{recursive:true,force:true});}
