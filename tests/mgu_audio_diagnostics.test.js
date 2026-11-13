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
    put('proc/2587/comm','AlsaRoutingAdap\n');
    put('proc/2866/comm','carplay\n');
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
    data.dsp={enabled:false,frames:0,streams:0};
    const file=inv.exportReport(root,data);
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.strictEqual(saved.app,'mgu_audio_diagnostics');
    assert(!JSON.stringify(saved).includes('secret'));
    assert.strictEqual(fs.statSync(file).mode&0o777,0o600);
    console.log('PASS read-only MGU audio inventory and private diagnostics export');
}finally{fs.rmSync(root,{recursive:true,force:true});}
