'use strict';
const mgu=require('./kit/mgu'),fs=require('fs'),path=require('path');
const Guard=require('./guard');
const {Reader,Capture}=require('./probe');
const Feedback=require('./feedback');
const ManualFlash=require('./manual-flash');
const {config}=require('./flash-config');
const Monitor=require('./background-monitor');
const Release=require('./release-status');
const Timing=require('./timing');
const {LeverTrigger,LeverObservation}=require('./lever-trigger');
const VERSION='0.1.26';
mgu.run({async start(ctx){
 const {ui,settings,log}=ctx, capture=new Capture(),reader=new Reader(ctx.signals,log);
 const monitor=new Monitor(Date.now,ctx.app&&ctx.app.startReason);
 monitor.setEnabled(true);
 if(ui.isVisible('MAIN'))monitor.seeMain();
 log.info('Light Flasher startup: '+JSON.stringify(monitor.snapshot()));
 let lastCombined=null, lastRead=0, pending=false, generation=0, exported='', closing=false, connectionState='Not checked', lastError='';
 const feedback=[];let feedbackStatus='No FLM samples recorded';
 let flashExport='',flashExportError='',flashAttempt=0;
 // Sub-100 ms selections are now supported only in the experimental fast mode.
 const leverObservation=new LeverObservation();
 const lever=new LeverTrigger(Date.now);const syncLever=()=>{lever.setRange(settings.get('leverMinMs'),settings.get('leverMaxMs'));lever.setEnabled(settings.get('leverTrigger')===true);};syncLever();
 const bgFile=path.join(ctx.dataDir,'light-flasher-background.json');let lastBg='',bgError='';
 // Keep the most recent lever decisions available after the app restarts.
 try{
   const previous=JSON.parse(fs.readFileSync(bgFile,'utf8'));
   if(Array.isArray(previous.lever&&previous.lever.events))lever.events=previous.lever.events.slice(-30);
 }catch(e){if(e.code!=='ENOENT')log.warn('Background log could not be read: '+e.message)}
 const persistBackground=()=>{try{const lv=lever.snapshot();const bg={...monitor.snapshot(),lever:{enabled:lv.enabled,background:settings.get('leverBackground')===true,state:lv.state,triggers:lv.triggers,rejected:lv.rejected,lastPulseMs:lv.lastPulseMs,limits:lv.limits,rangeValid:lv.rangeValid,reason:lv.reason,events:lv.events}};const raw=JSON.stringify(bg);if(raw!==lastBg){fs.writeFileSync(bgFile+'.tmp',JSON.stringify({...bg,version:VERSION,pid:process.pid,writtenAt:new Date().toISOString()},null,2));fs.renameSync(bgFile+'.tmp',bgFile);lastBg=raw;}bgError='';}catch(e){bgError=String(e.message||e);}};
 persistBackground();
 // Read-only service operations are explicitly initiated from Advanced tests.
 const guard=new Guard(Date.now,()=>{});
 const getConfig=()=>config(settings.get('pattern'),settings.get('interval'),settings.get('hold'),settings.get('fastTest')===true);
 const sub100=()=>Number(settings.get('interval'))<100;
 const cycleSelected=()=>/^cycles:/.test(String(settings.get('hold')));
 const marker=path.join(ctx.dataDir,'manual-flash-pending.json');
 const journal={exists:()=>fs.existsSync(marker),mark:()=>fs.writeFileSync(marker,JSON.stringify({at:new Date().toISOString()}),{flag:'wx'}),clear:()=>fs.unlinkSync(marker)};
 const flash=new ManualFlash(reader.diag,log,undefined,Date.now,journal);let lastLightAt=0,flashTask=null;
 const isLocked=()=>flash.cleanupUnconfirmed||(journal.exists()&&!flash.running);
 let autoRecoveryAttempted=false;
 const recoveryReady=()=>!closing&&!guard.recoveryReason()&&reader.diag.available&&lightProviderAvailable()&&lastCombined==='AUS'&&Date.now()-lastLightAt<=2500;
 const stop=(why)=>{generation++;capture.stop(why);};
 // Observe the OEM beam signal without activating the flasher.
 const lightProviderAvailable=()=>!!(guard.speedSub&&guard.speedSub.available);
 const observeBackground=()=>{monitor.observe(Date.now()-lastLightAt<=2500?{statusMainBeam_headlightFlasher:lastCombined}:null,lightProviderAvailable(),ui.isVisible('MAIN'));persistBackground();};
 const leverSignal=()=>leverObservation.snapshot(Date.now(),lightProviderAvailable());
 const serviceVisible=()=>ui.isVisible('DIAGNOSTICS')||ui.isVisible('ADVANCED')||ui.isVisible('LOGS');
 const update=()=>{
   const locked=isLocked();
   const lockStatus=autoRecoveryAttempted?"Locked - use Restore normal lights":"Locked - waiting for automatic recovery";
   if(ui.isVisible('MAIN')){
     let cfgText;try{const cfg=getConfig();cfgText=cfg.label+' | '+cfg.intervalMs+' ms | '+(cfg.cycleCount===null?cfg.durationMs/1000+' s':cfg.cycleCount+' cycles')+(settings.get('fastTest')===true?' | Fast':'')}catch(e){cfgText=String(e.message||e)}
     ui.text('FLASH_CONFIG',cfgText);
     let status=flash.running?(flash.config&&flash.config.cycleCount?'Cycles '+Math.floor(flash.stepsCompleted/flash.config.steps.length)+'/'+flash.config.cycleCount:'Working...'):locked?lockStatus:lastError?'Error - '+lastError:settings.get('manualFlash')!==true?'Flash control disabled':!reader.diag.available?'Waiting for connection':flash.status.startsWith('Time limit')?flash.status.split('; verify')[0]:flash.status.startsWith('Pattern finished')?(flash.config&&flash.config.cycleCount?'Finished - '+flash.config.cycleCount+' cycles':'Finished'):flash.status.startsWith('Recovery acknowledged')?'Lights released':'Ready';
     if(flashExportError)status+=' | Report save failed';
     ui.text('FLASH_STATUS',status);
   }
   if(ui.isVisible('OPTIONS'))ui.text('LEVER_RANGE_STATUS',lever.rangeValid?'Lever hold: '+lever.opts.minOnMs+' - '+lever.opts.maxOnMs+' ms':'Invalid lever range: minimum must not exceed maximum');
   if(ui.isVisible('DIAGNOSTICS')){
     const signal=leverSignal();
     const live=signal.status==='EIN'?(signal.holdMs===null?'OEM beam ON | Start unknown':'Pull detected | '+signal.holdMs+' ms'):
       signal.status==='AUS'?'Released / OEM beam OFF':'No current OEM beam signal';
     const previous=signal.lastHoldMs===null?'No complete pull measured':'Last measured pull: '+signal.lastHoldMs+' ms';
     ui.text('DIAG_LEVER',live+' | '+previous);
     const timing=Timing.summarize(flash.trace),gaps=timing.startDispatchGaps;
     const release=Release.summarize(flash.trace,flash.cleanupUnconfirmed);
     ui.text('DIAG_STATE',locked?lockStatus:reader.diag.available?'Connection available':'Connection unavailable');
     ui.text('DIAG_RESULT',(lastError?'Error: '+lastError:release.acknowledged?'Cleanup acknowledged':flash.status)+(gaps?' | Actual START gap '+gaps.meanMs+' ms':'')+(flashExportError?' | Report save failed':exported?' | Report saved':flashExport?' | Auto report saved':'')+(bgError?' | Background log save failed':''));
   }
   if(ui.isVisible('LOGS'))updateLogs();
   if(ui.isVisible('ADVANCED')){
     const c=capture.snapshot();
     ui.text('DIAG_CAPTURE',connectionState+' | '+c.reason+' | Reads '+c.rawCount+' | Errors '+c.failures+' | '+feedbackStatus+(lastError?' | '+lastError:''));
   }
 };
 const valid=()=>!closing&&ui.isVisible('ADVANCED');
 const validFeedback=()=>valid();
 const tick=async()=>{
   observeBackground();
   if(!isLocked())autoRecoveryAttempted=false;
   else if(!autoRecoveryAttempted&&!pending&&!capture.active&&!flash.running&&recoveryReady())await recoverLights('recovery-auto');
   feedLever();
   if(capture.active&&(!valid()||Date.now()-capture.started>=60000))stop('Capture ended: state change or time limit');
   if(capture.active&&!pending&&Date.now()-lastRead>=750){
      const id=generation;pending=true;lastRead=Date.now();
      try{
         if(!reader.index){stop('BDC connection lost; check connection again');connectionState='Disconnected';return;}
         if(id!==generation||!capture.active||!valid())return;
         const t=Date.now(),r=await reader.stalk();
         if(id===generation&&capture.active&&valid())capture.raw(r,Date.now()-t);
      }catch(e){if(id===generation&&capture.active){lastError=String(e.message||e);capture.error(e)}}
      finally{pending=false;update()}
   }
   update();
 };
 const handler=(id,fn)=>ui.onClick(id,()=>Promise.resolve().then(fn).catch(e=>{lastError=String(e.message||e);log.warn(lastError);update()}));
 const mainVisible=()=>ui.isVisible('MAIN');
 let runScreenAllowed=mainVisible,runSub100=false,runCycles=false;
 const fastIntervalAllowed=()=>(!(sub100()||runSub100)||(settings.get('fastTest')===true&&lightProviderAvailable()));
 const flashReady=()=>!closing&&settings.get('manualFlash')===true&&!guard.reason()&&lastCombined==='AUS'&&Date.now()-lastLightAt<=2500&&fastIntervalAllowed()&&(!(cycleSelected()||runCycles)||lightProviderAvailable());
 const flashAllowed=()=>mainVisible()&&flashReady();
 const leverBackground=()=>settings.get('leverBackground')===true;
 const leverForeground=()=>mainVisible()||ui.isVisible('OPTIONS');
 const leverScreenOk=()=>!serviceVisible()&&(leverForeground()||leverBackground());
 const leverEnabled=()=>settings.get('leverTrigger')===true&&leverScreenOk()&&lightProviderAvailable()&&lever.rangeValid;
 const leverAllowed=()=>fastIntervalAllowed()&&!closing&&settings.get('manualFlash')===true&&leverEnabled()&&!pending&&!capture.active&&!flash.running&&!isLocked();
 const feedLever=()=>{const fired=lever.update(lastCombined,lastLightAt,leverAllowed());persistBackground();if(fired)startFlash('lever').catch(e=>{lastError=String(e.message||e);log.warn(lastError);update()});};
 async function startFlash(source){
   if(pending||capture.active||flash.running){if(source==='lever')lever.runEnded();throw Error('Another operation in progress');}
   lever.runStarted();
   const attempt={id:++flashAttempt,source,at:new Date().toISOString(),requested:null,outcome:'not started',error:null,lever:source==='lever'?{pulseMs:lever.lastPulseMs}:null};
   flashExport='';flashExportError='';lastError='';
   pending=true;
   const previousTrace=flash.trace;
   let finishAttempt;
   flashTask=new Promise(resolve=>{finishAttempt=resolve});
   let task;
   try{
     const cfg=getConfig();attempt.requested={...cfg,fast:settings.get('fastTest')===true};
     runSub100=cfg.intervalMs<100;runCycles=cfg.cycleCount!==null;
     attempt.background=source==='lever'&&!leverForeground();
     const runAllowed=source==='lever'?()=>leverEnabled()&&flashReady():flashAllowed;
     runScreenAllowed=source==='lever'?leverScreenOk:mainVisible;
     if(!runAllowed())throw Error('Enable manual flash and wait for a current OEM high beam OFF signal');
     attempt.outcome='started';
     task=flash.run({...cfg,fast:settings.get('fastTest')===true},runAllowed,update);
     await task;
     attempt.outcome=flash.status.startsWith('Time limit')?'cycle time limit reached':'finished';
   }catch(e){attempt.error=String(e.message||e);lastError=attempt.error;attempt.outcome='failed or cancelled';log.warn(lastError)}
   finally{
     attempt.endedAt=new Date().toISOString();
     // Only attach this run's trace when ManualFlash actually started a new run.
     attempt.newTrace=!!task&&flash.trace!==previousTrace;
     try{flashExport=saveFlashAttempt(attempt)}catch(e){flashExportError=String(e.message||e);log.warn('Flash autosave: '+flashExportError)}
     flashTask=null;pending=false;runSub100=false;runCycles=false;lever.runEnded();finishAttempt();update();
   }
 }
 handler('BTN_FLASH',()=>startFlash('button'));
 handler('BTN_FLASH_STOP',()=>{flash.cancel();update()});
 async function recoverLights(source){
   if(pending||capture.active||flash.running)throw Error('Stop other operations and wait for cleanup');
   if(!isLocked()){lastError='';flash.status='Already unlocked; no recovery needed';update();return;}
   const automatic=source==='recovery-auto';
   const allowed=()=>recoveryReady()&&(automatic||ui.isVisible('MAIN'));
   if(!allowed())throw Error('Switch OEM high beam OFF and wait for fresh signals and TASU');
   autoRecoveryAttempted=true;
   pending=true;runScreenAllowed=automatic?()=>!serviceVisible()&&!ui.isVisible('OPTIONS'):mainVisible;lever.runStarted();lastError='';flashExport='';flashExportError='';
   const attempt={id:++flashAttempt,source,at:new Date().toISOString(),requested:null,outcome:'not started',error:null};
   const previousTrace=flash.trace;let finishAttempt;
   flashTask=new Promise(resolve=>{finishAttempt=resolve});
   try{await flash.recover(allowed,update);attempt.outcome='recovery acknowledged';autoRecoveryAttempted=false}
   catch(e){attempt.error=String(e.message||e);lastError=attempt.error;attempt.outcome='recovery failed';log.warn(lastError)}
   finally{
     attempt.endedAt=new Date().toISOString();attempt.newTrace=flash.trace!==previousTrace;
     try{flashExport=saveFlashAttempt(attempt)}catch(e){flashExportError=String(e.message||e);log.warn('Recovery autosave: '+flashExportError)}
     flashTask=null;pending=false;lever.runEnded();finishAttempt();update();
   }
 }
 handler('BTN_RECOVER',()=>recoverLights('recovery'));
 const openMenu=name=>{if(flash.running||pending)throw Error('Wait for the current operation to finish');lastError='';return ui.open(name)};
 handler('BTN_OPTIONS',()=>openMenu('OPTIONS'));
 handler('BTN_OPTIONS_BACK',()=>openMenu('MAIN'));
 handler('BTN_DIAG',()=>openMenu('DIAGNOSTICS'));
 handler('BTN_ADVANCED',()=>openMenu('ADVANCED'));
 const logPageSize=5;
 let logPage=0, logEntries=[], logLoadError='';
 let lastLogFrame='';
 const formatEvent=(event,label)=>event.at.slice(0,23).replace('T',' ')+' UTC | '+label+
   (Number.isFinite(event.onMs)?' | '+event.onMs+' ms':'')+(event.why?' | '+event.why:'');
 function loadLogs(){
   logLoadError='';
   const leverEvents=lever.snapshot().events.filter(event=>event&&typeof event.at==='string').map(event=>({...event,text:formatEvent(event,'Lever '+event.kind)}));
   const signalEvents=monitor.snapshot().events.map(event=>({...event,text:formatEvent(event,'OEM beam '+event.combinedSignal)}));
   const reports=[];
   try{
     const runReport=/^light-flasher-run-v[\d.]+-(\d+)-\d+-\d+\.json$/;
     const files=fs.readdirSync(ctx.dataDir)
       .map(name=>({name,match:runReport.exec(name)}))
       .filter(file=>file.match)
       .sort((a,b)=>b.match[1].localeCompare(a.match[1]))
       .slice(0,10);
     for(const {name} of files){
       try{
         const {flashAttempt:attempt}=JSON.parse(fs.readFileSync(path.join(ctx.dataDir,name),'utf8'));
         const at=attempt.endedAt||attempt.at;
         const label=attempt.source+' | '+attempt.outcome+(attempt.error?' | '+attempt.error:'');
         reports.push({at,text:formatEvent({at},label),file:name});
       }catch(e){reports.push({at:'',text:'Report could not be read',file:name})}
     }
   }catch(e){logLoadError='Could not list saved reports: '+e.message}
   logEntries=[...leverEvents,...signalEvents,...reports].sort((a,b)=>b.at.localeCompare(a.at));
   logPage=0;
 }
 function updateLogs(){
   const pages=Math.max(1,Math.ceil(logEntries.length/logPageSize));
   const rows=logEntries.slice(logPage*logPageSize,(logPage+1)*logPageSize);
   const values={
     LOG_STATE:lever.lastReason+(lastError?' | '+lastError:''),
     LOG_PATH:ctx.dataDir,
     LOG_POSITION:logLoadError||(logEntries.length?'Page '+(logPage+1)+' / '+pages:'No diagnostic events yet'),
     LOG_FILES:(exported?'Export saved | ':'')+'Lever: light-flasher-background.json | Export: light-flasher-diagnostics.json',
   };
   for(let i=0;i<logPageSize;i++){
     const row=rows[i];
     values['LOG_ROW_'+i]=row?row.text+(row.file?' | '+row.file:''):' ';
   }
   const frame=JSON.stringify(values);
   if(frame===lastLogFrame)return;
   for(const [id,value] of Object.entries(values))ui.text(id,value);
   lastLogFrame=frame;
 }
 handler('BTN_LOGS',()=>{loadLogs();lastLogFrame='';return openMenu('LOGS')});
 handler('BTN_LOG_OLDER',()=>{logPage=Math.min(logPage+1,Math.max(0,Math.ceil(logEntries.length/logPageSize)-1));update()});
 handler('BTN_LOG_NEWER',()=>{logPage=Math.max(0,logPage-1);update()});
 handler('BTN_LOG_REFRESH',()=>{loadLogs();update()});
 handler('BTN_LOG_SAVE',()=>{saveReport();loadLogs();lastLogFrame='';update()});
 handler('BTN_LOG_BACK',()=>openMenu('DIAGNOSTICS'));
 handler('BTN_ADVANCED_BACK',()=>{stop('Left advanced tests');return ui.open('DIAGNOSTICS')});
 async function checkConnection(startCapture){
   if(!valid())throw Error('Open Advanced tests before starting a connection check');
   if(pending||capture.active)throw Error('Stop previous recording or wait for current read');
   lastError='';exported='';
   if(!reader.diag.available){connectionState='TASU unavailable';throw Error(reader.diag.error||'TASU provider unavailable; no BDC request sent')}
   const token=++generation;pending=true;connectionState='Identifying BDC (22 F1 50)';update();
   try{
     await reader.identify();
     if(token!==generation||!valid())return;
     connectionState='BDC identified; checking 22 E3 B8';update();
     const t=Date.now(),raw=await reader.stalk();
     if(token!==generation||!valid())return;
     connectionState='BDC and E3B8 read OK';
     if(startCapture){capture.start();capture.raw(raw,Date.now()-t);lastRead=Date.now()}
   }catch(e){if(token===generation){connectionState=reader.index?'BDC OK; E3B8 failed':'BDC identification failed';lastError=String(e.message||e);log.warn(lastError)}}
   finally{pending=false;update()}
 }
 handler('BTN_CHECK',()=>checkConnection(false));
 handler('BTN_START',()=>checkConnection(true));
 handler('BTN_STOP',()=>{stop('Stopped manually');update()});
 function buildReport(){
   return {app:'light_flasher',version:VERSION,at:new Date().toISOString(),guard:guard.snapshot(),
     bdcIndex:reader.index,identityReply:reader.identityReply,connectionState,lastError,
     tasuAvailable:reader.diag.available,tasuError:reader.diag.error||null,trace:reader.trace.slice(),
     physicalActuation:flash.trace.some(x=>x.tx.startsWith('3101')),manualFlash:{status:flash.status,trace:flash.trace.slice(),cleanupUnconfirmed:flash.cleanupUnconfirmed,config:flash.config,fastTest:flash.fast,stepsCompleted:flash.stepsCompleted,cyclesCompleted:flash.config?Math.floor(flash.stepsCompleted/flash.config.steps.length):0,elapsedMs:flash.elapsedMs,timing:Timing.summarize(flash.trace),release:Release.summarize(flash.trace,flash.cleanupUnconfirmed)},combinedSignal:lastCombined,capture:capture.snapshot(),flmFeedback:feedback.slice(),decodedFeedback:feedback.map(Feedback.sampleState),overrideReadiness:Feedback.limits,backgroundMonitor:monitor.snapshot(),leverTrigger:lever.snapshot(),leverObservation:leverSignal(),feedbackStatus};
 }
 function writeReport(file,report){
   fs.writeFileSync(file+'.tmp',JSON.stringify(report,null,2));fs.renameSync(file+'.tmp',file);
 }
 function saveFlashAttempt(attempt){
   const stamp=attempt.endedAt.replace(/[^0-9]/g,'');
   const file=path.join(ctx.dataDir,'light-flasher-run-v'+VERSION+'-'+stamp+'-'+process.pid+'-'+attempt.id+'.json');
   const report=buildReport();report.flashAttempt=attempt;
   if(!attempt.newTrace){
     report.physicalActuation=false;
     report.manualFlash={status:'No fresh actuator run',trace:[],cleanupUnconfirmed:flash.cleanupUnconfirmed,config:attempt.requested,stepsCompleted:0,elapsedMs:0,timing:Timing.summarize([]),release:Release.summarize([],flash.cleanupUnconfirmed)};
   }
   writeReport(file,report);
   log.info('Flash attempt saved: '+file);
   return file;
 }
 function saveReport(){
   if(pending)throw Error('Wait for the read to finish before saving');
   stop('Saved');const file=path.join(ctx.dataDir,'light-flasher-diagnostics.json');
   writeReport(file,buildReport());exported=file;update();
 }
 handler('BTN_SAVE',saveReport);
 handler('BTN_BACK',()=>{stop('Left service');return ui.open('OPTIONS')});
 async function sampleFeedback(label){
   if(!validFeedback())throw Error('Open Advanced tests before reading FLM feedback');
   if(pending||capture.active)throw Error('Another read is in progress');
   if(!reader.diag.available)throw Error('TASU unavailable');
   pending=true;lastError='';exported='';
   const token=++generation,sample={label,at:new Date().toISOString(),before:lastCombined,after:null,results:[],complete:false};
   feedback.push(sample);if(feedback.length>12)feedback.shift();
   feedbackStatus='Reading '+label+'; wait for completion';update();
   const allowed=()=>token===generation&&validFeedback();
   try{
     await reader.flmFeedback(allowed,z=>{sample.results.push({...z,at:new Date().toISOString(),combinedSignal:lastCombined});update()});
     sample.complete=allowed()&&sample.results.filter(x=>x.kind==='feedback').length===6;
   }finally{
     sample.after=lastCombined;sample.endedAt=new Date().toISOString();
     feedbackStatus=sample.complete?'Sample complete; electrical readback only':'Sample incomplete; inspect replies or errors';
     pending=false;update();
   }
 }
 handler('BTN_FEEDBACK',()=>{
   if(lastCombined!=='AUS'&&lastCombined!=='EIN')throw Error('Wait for current OEM light status');
   if(Date.now()-lastLightAt>2500)throw Error('OEM light status stale');
   return sampleFeedback(lastCombined==='EIN'?'OEM steady high beam on':'OEM high beam off');
 });
 settings.onChange(()=>{syncLever();persistBackground();if(!valid()&&capture.active)stop('Left advanced tests');if(flash.running||settings.get('manualFlash')!==true)flash.cancel();update()});
 ui.onVisible(()=>{if(mainVisible())monitor.seeMain();else if(!runScreenAllowed())flash.cancel();persistBackground();if((capture.active||pending&&!flash.running)&&!ui.isVisible('ADVANCED'))stop('Left advanced tests');update()});
 if(ctx.app&&ctx.app.on)ctx.app.on('shutdown',()=>{closing=true;flash.cancel();stop('Shutdown')});
 process.on('SIGTERM',()=>{closing=true;flash.cancel();stop('Shutdown');if(flashTask){const timer=setTimeout(()=>process.exit(1),10000);flashTask.catch(()=>{}).then(()=>{clearTimeout(timer);process.exit(0)});}else process.exit(0)});
 guard.init(ctx.signals,log,v=>{lastCombined=v&&v.statusMainBeam_headlightFlasher;lastLightAt=Date.now();leverObservation.observe(lastCombined,lastLightAt);observeBackground();capture.status(v);feedLever();if(ui.isVisible('DIAGNOSTICS'))update()}).catch(e=>log.warn(String(e)));
 reader.init().catch(e=>log.warn(String(e)));
 setInterval(()=>{tick().catch(e=>log.warn(String(e)))},250);
 update();
}});
