'use strict';
const assert=require('assert');
const AM=require('../apps/mgu_audio_diagnostics/audio_manager');
async function main(){
    const seen=[];
    const mock={
        async proxy(name,instance){assert.equal(instance,'1');assert.equal(name,'org.genivi.am.commandinterface.CommandControl');return {name};},
        async call(proxy,name,args,timeout){
            seen.push(name);assert.equal(timeout,1800);assert.deepEqual(args,{});
            if(name==='getListMainSources')return {amError:'E_OK',listMainSources:[{sourceID:106,name:'CarPlayMain'},{sourceID:107,name:'Hidden!'},
                {sourceID:'VIN012345678901234',name:'private'}]};
            if(name==='getListMainSinks')return {amError:0,listMainSinks:[{sinkID:200,name:'MainSink'}]};
            if(name==='getListMainConnections')return {amError:0,listMainConnections:[
                {mainConnectionID:88,sourceID:106,sinkID:200,connectionState:2}]};
            throw Error('unexpected call');
        }
    };
    const a=await AM.collect(mock);
    assert(a.available);assert.equal(a.sources.length,2);assert.equal(a.connections.length,1);
    assert.equal(a.connections[0].source,'CarPlayMain');assert.equal(a.connections[0].sink,'MainSink');
    assert.deepEqual(seen,['getListMainSources','getListMainSinks','getListMainConnections']);
    assert.equal(a.sources[1].name,'Hidden_');
    const unavailable=await AM.collect({proxy:async()=>{throw new Error('DENIED secret-token');},call:()=>{throw Error('unreachable');}});
    assert.equal(unavailable.available,false);
    assert(!JSON.stringify(unavailable).includes('secret-token'));
    const partial=await AM.collect({proxy:mock.proxy,call:async(p,n)=>n==='getListMainConnections'?
        {amError:3}:{amError:0,[n==='getListMainSinks'?'listMainSinks':'listMainSources']:[]}});
    assert(partial.available&&partial.errors.length===1&&partial.connections.length===0);
    console.log('PASS AudioManager read-only source/sink/connection inventory and failure handling');
}
main().catch(e=>{console.error(e.stack);process.exit(1);});
