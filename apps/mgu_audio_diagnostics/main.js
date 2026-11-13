'use strict';
const mgu=require('./kit/mgu');
const INV=require('./inventory');
const AM=require('./audio_manager');
const DSP=require('./kit/dsp-client');

const W=1600, H=520;
const C={bg:'#080e19',panel:'#111c2e',outline:'#29445f',white:'#ecf3fc',
    dim:'#9faebf',cyan:'#76c5ff',green:'#72dea9',amber:'#ffd08a'};
const PAGE=['Ueberblick','SmartX-Kanaele','AudioManager','DSP & Dienste'];
function ascii(x) {
    return String(x===undefined||x===null?'--':x).replace(/Ä/g,'Ae').replace(/Ö/g,'Oe')
        .replace(/Ü/g,'Ue').replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue')
        .replace(/ß/g,'ss').replace(/[\r\n\t]/g,' ').replace(/[^\x20-\x7e]/g,'?');
}
function short(x,n) {
    const t=ascii(x);return t.length>n?t.slice(0,n-3)+'...':t;
}
function draw(cv,state,acts) {
    const s=state, report=s.report||{}, dsp=s.dsp||{}, am=s.am||{};
    const text=(value,x,y,size,color,opts)=>cv.text(short(value,140),x,y,size||22,color||C.white,opts);
    const targets=[];
    const row=(label,value,y,color)=>{
        text(short(label,34),74,y,22,C.dim);
        text(short(value,32),1060,y,22,color||C.white,{align:'right'});
    };
    const button=(key,x,y,label,fn)=>{
        cv.roundRect(x,y,355,54,11,'#1d3552');
        cv.strokeRoundRect(x,y,355,54,11,1,C.outline);
        text(label,x+177,y+35,22,C.white,{align:'center'});
        targets.push({key,x,y,w:355,h:54,run:fn});
    };
    cv.clear(C.bg);
    cv.roundRect(26,18,1548,479,22,C.panel);
    text('MGU AUDIO DIAGNOSTICS',58,69,35,C.white,{font:'bold'});
    text('READ ONLY  /  NO CAR AUDIO CHANGES',61,109,20,C.amber);
    text(PAGE[s.page],61,155,27,C.cyan);
    cv.roundRect(49,174,1056,270,15,'#0a1526');
    if(s.page===0) {
        row('Architektur',report.arch||'--',212);
        row('ALSA-Bibliothek',report.alsaLib?'Vorhanden':'Fehlt',255,report.alsaLib?C.green:C.amber);
        row('SmartX-Plugin',report.smartxLib?'Vorhanden':'Fehlt',298,report.smartxLib?C.green:C.amber);
        row('SmartX-Kanaele (vorhanden)',report.endpointCount||0,341);
        row('DSP-Dienst',s.dspError?'Nicht erreichbar':s.dsp?'Verbunden':'Noch nicht gelesen',384,s.dsp?C.green:C.amber);
        text('Die Zahl vorhandener Kanaele ist KEINE aktive Stream-Zahl.',75,419,18,C.dim);
    } else if(s.page===1) {
        const entries=report.endpoints||[],start=s.offset*5;
        for(let i=0;i<5&&start+i<entries.length;i++) {
            const e=entries[start+i],y=207+42*i;
            text(short(e.name,43),73,y,18,C.white);
            text(short(e.category,22),890,y,18,C.amber,{align:'right'});
            text('GID '+e.gid+' / '+e.mode,1072,y,17,C.dim,{align:'right'});
        }
        text('Kanal-Metadaten  |  '+(entries.length?start+1:0)+'-'+Math.min(start+5,entries.length)+' / '+entries.length,
            74,423,18,C.dim);
    } else if(s.page===2) {
        const links=am.connections||[];
        const start=s.offset*3;
        row('AudioManager-Schnittstelle',s.amError?'Nicht verfuegbar':am.available?'Erreichbar':'Nicht gelesen',213,
            am.available?C.green:C.amber);
        row('Registrierte Quellen / Senken',am.sources?am.sources.length+' / '+am.sinks.length:'--',253);
        row('HMI-Medienverbindungen',am.connections?links.length:'--',293);
        if(links.length) {
            for(let i=0;i<2&&start+i<links.length;i++){
                const link=links[start+i];
                text(short(link.source+' -> '+link.sink,78),75,336+35*i,20,C.white);
            }
        } else {
            text('Keine gemeldete Verbindung oder Abfrage nicht verfuegbar.',75,344,19,C.amber);
        }
        const msg=(am.errors||[]).join('; ');
        text(short(msg||'Verbindungen sind keine PCM-Kopien.',104),74,420,17,C.dim);
    } else {
        row('DSP-Konfiguration',s.dspError?'Keine Verbindung':s.dsp?(dsp.enabled?'DSP EIN':'BYPASS EIN'):'--',213);
        row('Verarbeitete PCM-Frames',s.dsp?dsp.frames:'--',255);
        row('PCM-Streams am DSP',s.dsp?dsp.streams:'--',297);
        row('Laufende Audio-Dienste',(report.services||[]).length,339);
        row('BMW-Musik durch DSP',dsp.stockCarPlayRouted?'Ja':'Nicht verbunden',381,C.amber);
        text('DSP EIN alleine leitet CarPlay NICHT durch den Filter.',75,420,19,C.dim);
    }
    button('refresh',1142,176,'Neu einlesen',acts.refresh);
    button('next',1142,243,'Weitere Eintraege',acts.next);
    button('page',1142,310,'Ansicht wechseln',acts.page);
    button('export',1142,377,'Diagnose exportieren',acts.exportData);
    text(short(s.status,117),60,476,18,s.error?C.amber:C.dim);
    s.targets=targets;
}
mgu.run({
    start(ctx) {
        const s={page:0,offset:0,busy:false,report:null,dsp:null,dspError:'',
            am:null,amError:'',status:'Lese Audioinformationen...',error:false,targets:[]};
        let loop;
        function message(msg,isError){s.status=msg;s.error=!!isError;if(loop)loop.kick();}
        async function refresh() {
            if(s.busy)return;
            s.busy=true;if(loop)loop.kick();
            try {
                s.report=INV.collect();s.offset=0;s.dsp=null;s.dspError='';
                try{
                    const d=await DSP.request({op:'status'},{timeout:1500});
                    s.dsp={enabled:!!(d.config&&d.config.enabled),frames:d.frames||0,
                        streams:(d.streams||[]).length,stockCarPlayRouted:!!d.stockCarPlayRouted};
                }catch(e){s.dspError=short(e.message||e,58);}
                s.am=await AM.collect(ctx.signals);
                s.amError=s.am.available?'':(s.am.errors||[]).join('; ');
                message('Aktualisiert: '+s.report.endpointCount+' SmartX-Kanaele, '+
                    (s.am.connections||[]).length+' AudioManager-Verbindungen');
            }catch(e){message('Diagnosefehler: '+short(e.message||e,85),true);}
            finally{s.busy=false;if(loop)loop.kick();}
        }
        function page(){if(s.busy)return;s.page=(s.page+1)%PAGE.length;s.offset=0;if(loop)loop.kick();}
        function next(){
            if(s.busy)return;
            if(s.page===1){
                const count=(s.report&&s.report.endpoints||[]).length;
                s.offset=(s.offset+1)%Math.max(1,Math.ceil(count/5));
            }else if(s.page===2){
                const count=(s.am&&s.am.connections||[]).length;
                s.offset=(s.offset+1)%Math.max(1,Math.ceil(count/2));
            }else s.page=(s.page+1)%PAGE.length;
            if(loop)loop.kick();
        }
        function exportData(){
            if(s.busy||!s.report)return message('Zuerst neu einlesen.',true);
            try{
                const file=INV.exportReport(ctx.dataDir,Object.assign({},s.report,{dsp:s.dsp,audioManager:s.am}));
                message('Gespeichert: '+file.split('/').pop());
            }catch(e){message('Export: '+short(e.message||e,90),true);}
        }
        const acts={refresh,page,next,exportData};
        ctx.ui.onClick('BTN_PAGE',page);
        ctx.ui.onClick('BTN_NEXT',next);
        ctx.ui.onClick('BTN_REFRESH',refresh);
        ctx.ui.onClick('BTN_EXPORT',exportData);
        ctx.onTap((x,y)=>{
            if(s.busy)return;
            const hit=s.targets.slice().reverse().find(t=>x>=t.x&&x<=t.x+t.w&&y>=t.y&&y<=t.y+t.h);
            if(hit)hit.run();
        });
        ctx.onTab(i=>{
            if(s.busy)return;
            s.page=((i%PAGE.length)+PAGE.length)%PAGE.length;s.offset=0;
            if(loop)loop.kick();
        });
        loop=ctx.loop('MAIN',2,()=>{
            const cv=ctx.canvas(W,H);
            draw(cv,s,acts);
            return ctx.ui.image('MAIN_GFX',cv);
        });
        ctx.ui.onVisible((name,visible)=>{if(name==='MAIN'&&visible)refresh();});
        setImmediate(refresh);
    }
});
module.exports={draw};
