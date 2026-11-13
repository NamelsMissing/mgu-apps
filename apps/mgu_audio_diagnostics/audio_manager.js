'use strict';
// Read-only GENIVI AudioManager CommandControl inventory; no connect/disconnect,
// volume, gain, routing or other write methods are ever requested.
const SERVICE='org.genivi.am.commandinterface.CommandControl';
function safeName(x) {
    return String(x===null||x===undefined?'':x).replace(/[^A-Za-z0-9_ .-]/g,'_').slice(0,64);
}
function smallId(x) {
    return Number.isInteger(x) && x>=0 && x<=65535 ? x : null;
}
function normalizeSources(data) {
    if(!Array.isArray(data))return [];
    return data.slice(0,128).map(x=>({id:smallId(x&&x.sourceID),name:safeName(x&&x.name)}))
        .filter(x=>x.id!==null);
}
function normalizeSinks(data) {
    if(!Array.isArray(data))return [];
    return data.slice(0,128).map(x=>({id:smallId(x&&x.sinkID),name:safeName(x&&x.name)}))
        .filter(x=>x.id!==null);
}
function normalizeConnections(data) {
    if(!Array.isArray(data))return [];
    return data.slice(0,128).map(x=>({
        id:smallId(x&&(x.mainConnectionID===undefined?x.connectionID:x.mainConnectionID)),
        sourceID:smallId(x&&x.sourceID),
        sinkID:smallId(x&&x.sinkID),
        state:Number.isInteger(x&&x.connectionState)?x.connectionState:null
    })).filter(x=>x.sourceID!==null && x.sinkID!==null);
}
function errLabel(error) {
    const s=String(error&&error.code || error&&error.message || error || 'unavailable');
    if(/timeout|timed out/i.test(s))return 'timeout';
    if(/permission|denied|EACCES|EPERM/i.test(s))return 'access denied';
    if(/not available|unavailable|unsupported|not found|not exist|not connected/i.test(s))return 'unavailable';
    return 'service error';
}
async function collect(signals) {
    const report={available:false,at:new Date().toISOString(),sources:[],sinks:[],connections:[],errors:[]};
    if(!signals||typeof signals.proxy!=='function'||typeof signals.call!=='function') {
        report.errors.push('CommandControl proxy unavailable');return report;
    }
    let proxy;
    try {proxy=await signals.proxy(SERVICE,'1');report.available=true;}
    catch(e){report.errors.push('CommandControl: '+errLabel(e));return report;}
    const methods=[
        ['getListMainSources','listMainSources',normalizeSources,'sources'],
        ['getListMainSinks','listMainSinks',normalizeSinks,'sinks'],
        ['getListMainConnections','listMainConnections',normalizeConnections,'connections']
    ];
    for(const [name,key,normalize,target] of methods) {
        try {
            const reply=await signals.call(proxy,name,{},1800);
            if(!reply||(reply.amError!==0&&reply.amError!=='E_OK')) {
                report.errors.push(name+': unsupported or error');continue;
            }
            if(!Array.isArray(reply[key])) {
                report.errors.push(name+': missing '+key);continue;
            }
            report[target]=normalize(reply[key]);
        }catch(e){report.errors.push(name+': '+errLabel(e));}
    }
    // resolve connection endpoints through the two name lists. Never infer a
    // CarPlay signal route from SHM file names alone.
    for(const conn of report.connections) {
        const source=report.sources.find(s=>s.id===conn.sourceID);
        const sink=report.sinks.find(s=>s.id===conn.sinkID);
        conn.source=source?source.name:'source '+conn.sourceID;
        conn.sink=sink?sink.name:'sink '+conn.sinkID;
    }
    return report;
}
module.exports={collect,normalizeSources,normalizeSinks,normalizeConnections,safeName};
