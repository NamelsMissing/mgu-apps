'use strict';
const mgu = require('./kit/mgu');
const INV = require('./inventory');
const DSP = require('./kit/dsp-client');

const W=1600, H=520;
const COL={bg:'#080e19',panel:'#111c2e',outline:'#2b3f58',white:'#e8f1fc',
    dim:'#9fb0c5',cyan:'#77c2fa',green:'#71dda8',amber:'#ffcd80'};
const PAGES=['Überblick','SmartX-Kanäle','Dienste & DSP'];
function short(x,max) {
    const v=String(x===undefined||x===null?'--':x).replace(/[\r\n\t]/g,' ');
    return v.length>max?v.slice(0,max-1)+'…':v;
}
function draw(cv,s,a) {
    const text=(v,x,y,z,color,opts)=>cv.text(String(v),x,y,z||22,color||COL.white,opts);
    const targets=[];
    const btn=(name,x,y,w,label,act)=>{
        cv.roundRect(x,y,w,53,12,'#1d3451');
        cv.strokeRoundRect(x,y,w,53,12,1,COL.outline);
        text(label,x+w/2,y+35,22,COL.white,{align:'center'});
        targets.push({name,x,y,w,h:53,run:act});
    };
    cv.clear(COL.bg);
    cv.roundRect(20,17,1560,484,24,COL.panel);
    text('MGU AUDIO DIAGNOSTICS',58,69,37,COL.white,{font:'bold'});
    text('NUR LESEN · keine Wiedergabe · keine CarPlay-Eingriffe',60,107,21,COL.amber);
    text(PAGES[s.page],60,154,28,COL.cyan);
    cv.roundRect(48,173,1053,269,16,'#0a1525');
    const report=s.report||{}, dsp=s.dsp||{};
    function row(k,v,y,color) {
        text(k,70,y,23,COL.dim);
        text(short(v,56),1067,y,22,color||COL.white,{align:'right'});
    }
    if(s.page===0) {
        row('Architektur',report.arch||'--',213);
        row('ALSA libasound.so.2',report.alsaLib?'Vorhanden':'Nicht gefunden',256,report.alsaLib?COL.green:COL.amber);
        row('SmartX ALSA-Plugin',report.smartxLib?'Vorhanden':'Nicht gefunden',299,report.smartxLib?COL.green:COL.amber);
        row('SmartX Shared-Memory-Verbindungen',report.endpointCount||0,342);
        row('PCM-DSP-Dienst',s.dspError?'Nicht erreichbar':s.dsp?'Verbunden':'Noch nicht geprüft',385,s.dsp?COL.green:COL.amber);
        text('Keine ALSA-/SmartX-Verbindung wird geöffnet.',70,421,19,COL.dim);
    } else if(s.page===1) {
        const list=report.endpoints||[],offset=s.offset*5;
        for(let i=0;i<5;i++) {
            const entry=list[offset+i];if(!entry)break;
            const y=207+i*42;
            text(short(entry.name,47),70,y,19,COL.white);
            text(short(entry.category,24),895,y,19,COL.amber,{align:'right'});
            text('GID '+entry.gid+' / '+entry.mode,1071,y,17,COL.dim,{align:'right'});
        }
        text('Metadaten · '+(list.length?offset+1:0)+'–'+Math.min(offset+5,list.length)+' / '+list.length,70,423,19,COL.dim);
    } else {
        row('Gefundene Audio-Prozesse',short((report.services||[]).join(', ')||'--',59),213);
        row('DSP-Konfiguration',s.dspError?'Offline: '+short(s.dspError,37):s.dsp?(dsp.enabled?'DSP EIN':'BYPASS EIN'):'--',256);
        row('PCM-Frames verarbeitet',s.dsp?dsp.frames:'--',299);
        row('Gleichzeitig verbundene PCM-Quellen',s.dsp?dsp.streams:'--',342);
        row('BMW-Audioausgabe','Nicht nachgewiesen',385,COL.amber);
        text('PCM-Frames bestätigen keine Ausgabe an Lautsprecher.',70,421,19,COL.dim);
    }
    btn('refresh',1140,177,356,'Neu einlesen',a.refresh);
    btn('next',1140,245,356,'Weitere Einträge',a.next);
    btn('page',1140,313,356,'Ansicht wechseln',a.page);
    btn('export',1140,381,356,'Diagnose exportieren',a.exportData);
    text(short(s.status,116),58,475,19,s.error?COL.amber:COL.dim);
    s.targets=targets;
}
mgu.run({
    start(ctx) {
        const s={page:0,offset:0,busy:false,report:null,dsp:null,dspError:'',status:'Lese MGU-Audiodaten …',
            error:false,targets:[]};
        let loop;
        function message(t,error){s.status=t;s.error=!!error;if(loop)loop.kick();}
        async function refresh(){
            if(s.busy)return;
            s.busy=true;
            try {
                s.report=INV.collect();s.offset=0;s.dsp=null;s.dspError='';
                try {
                    const r=await DSP.request({op:'status'},{timeout:1500});
                    s.dsp={enabled:!!(r.config&&r.config.enabled),frames:r.frames||0,streams:(r.streams||[]).length};
                } catch(e){s.dspError=short(e.message||e,60);}
                message('Diagnose aktualisiert · '+s.report.endpointCount+' SmartX-Verbindungen');
            }catch(e){message('Fehler beim Lesen: '+short(e.message||e,90),true);}
            finally{s.busy=false;if(loop)loop.kick();}
        }
        function next(){
            if(s.busy)return;
            if(s.page===1) {
                const count=s.report?(s.report.endpoints||[]).length:0;
                s.offset=(s.offset+1)%Math.max(1,Math.ceil(count/5));
            } else s.page=(s.page+1)%PAGES.length;
            if(loop)loop.kick();
        }
        function page(){if(s.busy)return;s.page=(s.page+1)%PAGES.length;s.offset=0;if(loop)loop.kick();}
        function exportData(){
            if(s.busy||!s.report)return message('Erst neu einlesen.',true);
            try{
                const file=INV.exportReport(ctx.dataDir,Object.assign({},s.report,{dsp:s.dsp}));
                message('Export gespeichert: '+file.split('/').pop());
            }catch(e){message('Exportfehler: '+short(e.message||e,80),true);}
        }
        const actions={refresh,next,page,exportData};
        ctx.ui.onClick('BTN_PAGE',page);
        ctx.ui.onClick('BTN_NEXT',next);
        ctx.ui.onClick('BTN_REFRESH',refresh);
        ctx.ui.onClick('BTN_EXPORT',exportData);
        ctx.onTap((x,y)=>{
            if(s.busy)return;
            const b=s.targets.slice().reverse().find(t=>x>=t.x&&x<=t.x+t.w&&y>=t.y&&y<=t.y+t.h);
            if(b)b.run();
        });
        ctx.onTab(i=>{if(s.busy)return;s.page=((i%PAGES.length)+PAGES.length)%PAGES.length;s.offset=0;loop&&loop.kick();});
        loop=ctx.loop('MAIN',2,()=>{const cv=ctx.canvas(W,H);draw(cv,s,actions);return ctx.ui.image('MAIN_GFX',cv);});
        ctx.ui.onVisible((name,visible)=>{if(name==='MAIN'&&visible)refresh();});
        setImmediate(refresh);
    }
});
module.exports={draw};
