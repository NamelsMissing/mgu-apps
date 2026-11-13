'use strict';
const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const Wave=require('../apps/equalizer/music_export');
const Core=require('../native/equalizer-dsp/core');
const Client=require('../kit/runtime/dsp-client');
const {Service}=require('../native/equalizer-dsp/server');
const {TOTAL_FRAMES}=require('../apps/equalizer/test_music');
async function main(){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'mgu-wav-'));
    const runtime=path.join(root,'run');
    const service=new Service({runtime,stateFile:path.join(root,'settings.json')});
    try{
        const sample=Wave.header(Wave.FRAMES_BYTES);
        assert.equal(sample.toString('ascii',0,4),'RIFF');
        assert.equal(sample.toString('ascii',8,12),'WAVE');
        assert.equal(sample.readUInt32LE(24),44100);
        assert.equal(sample.readUInt32LE(40),TOTAL_FRAMES*4);
        assert.equal(Wave.activeProfile(Core.defaults()),false);
        await service.start();
        await assert.rejects(Wave.exportComparison(root,{runtime}),/DSP EIN/);
        let status=await Client.request({op:'status'},{runtime});
        const config=Core.defaults();
        config.enabled=true;config.bands[0].gainDb=6;
        status=await Client.request({op:'set',config,expectedRevision:status.revision},{runtime});
        const result=await Wave.exportComparison(root,{runtime});
        assert.equal(result.frames,TOTAL_FRAMES);
        const original=fs.readFileSync(result.original);
        const processed=fs.readFileSync(result.processed);
        assert.equal(original.length,44+TOTAL_FRAMES*4);
        assert.equal(processed.length,original.length);
        assert(!original.equals(processed));
        assert.equal(original.toString('ascii',0,4),'RIFF');
        assert.equal(processed.toString('ascii',0,4),'RIFF');
        const after=await Client.request({op:'status'},{runtime});
        assert(after.frames>=TOTAL_FRAMES);
        assert.equal(fs.statSync(result.original).mode&0o777,0o600);
        assert.equal(fs.statSync(result.processed).mode&0o777,0o600);
        assert.equal(after.stockCarPlayRouted,false);
        console.log('PASS original and real DSP WAV exports, 32s, 44100Hz stereo, actual PCM frames, private permissions');
        // Fail-open PcmFilter must never mislabel an unprocessed file as EQ audio.
        let configs=await Client.request({op:'status'},{runtime});
        await service.stop();
        const missing=path.join(root,'missing');
        await assert.rejects(Wave.exportComparison(root,{runtime:missing}),/ENOENT|DSP/);
        assert(configs.revision>0);
    }finally{
        try{await service.stop();}catch(e){}
        fs.rmSync(root,{recursive:true,force:true});
    }
}
main().catch(e=>{console.error(e.stack);process.exit(1);});
