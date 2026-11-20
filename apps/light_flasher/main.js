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
const {LeverTrigger}=require('./lever-trigger');
const VERSION='0.1.19';
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
 const lever=new LeverTrigger(Date.now);const syncLever=()=>{lever.setRange(settings.get('leverMinMs'),settings.get('leverMaxMs'));lever.setEnabled(settings.get('leverTrigger')===true);};syncLever();
 const bgFile=path.join(ctx.dataDir,'light-flasher-background.json');let lastBg='',bgError='';
 const persistBackground=()=>{try{const lv=lever.snapshot();const bg={...monitor.snapshot(),lever:{enabled:lv.enabled,background:settings.get('leverBackground')===true,state:lv.state,triggers:lv.triggers,rejected:lv.rejected,lastPulseMs:lv.lastPulseMs,limits:lv.limits,rangeValid:lv.rangeValid,reason:lv.reason,events:lv.events}};const raw=JSON.stringify(bg);if(raw!==lastBg){fs.writeFileSync(bgFile+'.tmp',JSON.stringify({...bg,version:VERSION,pid:process.pid,writtenAt:new Date().toISOString()},null,2));fs.renameSync(bgFile+'.tmp',bgFile);lastBg=raw;}bgError='';}catch(e){bgError=String(e.message||e);}};
 persistBackground();
 // Read-only service operations are explicitly initiated from Advanced tests.
 const guard=new Guard(Date.now,()=>{});
 const getConfig=()=>config(settings.get('pattern'),settings.get('interval'),settings.get('hold'),settings.get('fastTest')===true);
 const sub100=()=>Number(settings.get('interval'))<100;
 const marker=path.join(ctx.dataDir,'manual-flash-pending.json');
 const journal={exists:()=>fs.existsSync(marker),mark:()=>fs.writeFileSync(marker,JSON.stringify({at:new Date().toISOString()}),{flag:'wx'}),clear:()=>fs.unlinkSync(marker)};
 const flash=new ManualFlash(reader.diag,log,undefined,Date.now,journal);let lastLightAt=0,flashTask=null;
 const stop=(why)=>{generation++;capture.stop(why);};
 // Passive observation only, independent of the parked actuator guard.
 const lightProviderAvailable=()=>!!(guard.speedSub&&guard.speedSub.available);
 const observeBackground=()=>{monitor.observe(Date.now()-lastLightAt<=2500?{statusMainBeam_headlightFlasher:lastCombined}:null,lightProviderAvailable(),ui.isVisible('MAIN'));persistBackground();};
 const serviceVisible=()=>ui.isVisible('DIAGNOSTICS')||ui.isVisible('ADVANCED');
 const menuVisible=()=>serviceVisible()||ui.isVisible('OPTIONS');
 const update=()=>{
   const locked=flash.cleanupUnconfirmed||journal.exists()&&!flash.running;
   if(ui.isVisible('MAIN')){
     let cfgText;try{const cfg=getConfig();cfgText=cfg.label+' | '+cfg.intervalMs+' ms | '+cfg.durationMs/1000+' s'+(settings.get('fastTest')===true?' | Fast':'')}catch(e){cfgText=String(e.message||e)}
     ui.text('FLASH_CONFIG',cfgText);
     let status=flash.running?'Working...':locked?'Locked - restore normal lights (P)':lastError?'Error - '+lastError:settings.get('manualFlash')!==true?'Flash control disabled':!reader.diag.available?'Waiting for connection':flash.status.startsWith('Pattern finished')?'Finished':flash.status.startsWith('Recovery acknowledged')?'Lights released':'Ready';
     if(flashExportError)status+=' | Report save failed';
     ui.text('FLASH_STATUS',status);
   }
   if(ui.isVisible('OPTIONS'))ui.text('LEVER_RANGE_STATUS',lever.rangeValid?'Lever hold: '+lever.opts.minOnMs+' - '+lever.opts.maxOnMs+' ms':'Invalid lever range: minimum must be below maximum');
   if(ui.isVisible('DIAGNOSTICS')){
     const timing=Timing.summarize(flash.trace),gaps=timing.startDispatchGaps;
     const release=Release.summarize(flash.trace,flash.cleanupUnconfirmed);
     ui.text('DIAG_STATE',(locked?'Locked - restore normal lights on main menu':reader.diag.available?'Connection available':'Connection unavailable')+(guard.recoveryReason()?' | Park in P for service':' | Parked'));
     ui.text('DIAG_RESULT',(lastError?'Error: '+lastError:release.acknowledged?'Cleanup acknowledged':flash.status)+(gaps?' | Actual START gap '+gaps.meanMs+' ms':'')+(flashExportError?' | Report save failed':exported?' | Report saved':flashExport?' | Auto report saved':'')+(bgError?' | Background log save failed':''));
   }
   if(ui.isVisible('ADVANCED')){
     const c=capture.snapshot();
     ui.text('DIAG_CAPTURE',connectionState+' | '+c.reason+' | Reads '+c.rawCount+' | Errors '+c.failures+' | '+feedbackStatus+(lastError?' | '+lastError:''));
   }
 };
 const safe=()=>!closing&&!guard.recoveryReason();
 const valid=()=>safe()&&ui.isVisible('ADVANCED');
 const validFeedback=()=>valid();
 const tick=async()=>{
   observeBackground();feedLever();
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
 const flashAllowed=()=>!closing&&settings.get('manualFlash')===true&&ui.isVisible('MAIN')&&!guard.reason()&&lastCombined==='AUS'&&Date.now()-lastLightAt<=2500&&(!(sub100()||runSub100)||(settings.get('fastTest')===true&&!guard.recoveryReason()&&lightProviderAvailable()));
 // Background lever mode: same P/stationary/OEM-off guard, but no visible menu needed.
 // Never while the diagnostics page is open (shared TASU, read-only tests).
 const leverBackground=()=>settings.get('leverBackground')===true;
 const leverScreenOk=()=>ui.isVisible('MAIN')||(leverBackground()&&!menuVisible());
 const backgroundRunAllowed=()=>!sub100()&&!closing&&settings.get('manualFlash')===true&&settings.get('leverTrigger')===true&&leverBackground()&&!menuVisible()&&!guard.recoveryReason()&&lightProviderAvailable()&&lever.rangeValid&&lastCombined==='AUS'&&Date.now()-lastLightAt<=2500;
 let runNeedsMain=true,runSub100=false;
 const leverAllowed=()=>!sub100()&&!closing&&settings.get('manualFlash')===true&&settings.get('leverTrigger')===true&&leverScreenOk()&&!guard.recoveryReason()&&lightProviderAvailable()&&lever.rangeValid&&!pending&&!capture.active&&!flash.running&&!flash.cleanupUnconfirmed;
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
     if(cfg.intervalMs<100&&source!=='button')throw Error('Sub-100 ms tests require an explicit button press while parked');
     runSub100=cfg.intervalMs<100;
     const background=source==='lever'&&leverBackground();attempt.background=background;
     const runAllowed=source==='lever'?()=>lever.rangeValid&&settings.get('leverTrigger')===true&&!guard.recoveryReason()&&lightProviderAvailable()&&(background?backgroundRunAllowed():flashAllowed()):flashAllowed;runNeedsMain=!background;
     if(!runAllowed())throw Error('Park securely in P, enable manual flash and switch OEM high beam OFF');
     attempt.outcome='started';
     task=flash.run({...cfg,fast:settings.get('fastTest')===true},runAllowed,update);
     await task;
     attempt.outcome='finished';
   }catch(e){attempt.error=String(e.message||e);lastError=attempt.error;attempt.outcome='failed or cancelled';log.warn(lastError)}
   finally{
     attempt.endedAt=new Date().toISOString();
     // Only attach this run's trace when ManualFlash actually started a new run.
     attempt.newTrace=!!task&&flash.trace!==previousTrace;
     try{flashExport=saveFlashAttempt(attempt)}catch(e){flashExportError=String(e.message||e);log.warn('Flash autosave: '+flashExportError)}
     flashTask=null;pending=false;runSub100=false;lever.runEnded();finishAttempt();update();
   }
 }
 handler('BTN_FLASH',()=>startFlash('button'));
 handler('BTN_FLASH_STOP',()=>{flash.cancel();update()});
 handler('BTN_RECOVER',async()=>{
   if(pending||capture.active||flash.running)throw Error('Stop other operations and wait for cleanup');
   if(!flash.cleanupUnconfirmed&&!journal.exists()){lastError='';flash.status='Already unlocked; no recovery needed';update();return;}
   const allowed=()=>!closing&&ui.isVisible('MAIN')&&!guard.recoveryReason()&&lightProviderAvailable()&&lastCombined==='AUS'&&Date.now()-lastLightAt<=2500;
   if(!allowed())throw Error('Park securely in P, switch OEM high beam OFF and wait for fresh signals');
   pending=true;runNeedsMain=true;lever.runStarted();lastError='';flashExport='';flashExportError='';
   const attempt={id:++flashAttempt,source:'recovery',at:new Date().toISOString(),requested:null,outcome:'not started',error:null};
   const previousTrace=flash.trace;let finishAttempt;
   flashTask=new Promise(resolve=>{finishAttempt=resolve});
   try{await flash.recover(allowed,update);attempt.outcome='recovery acknowledged'}
   catch(e){attempt.error=String(e.message||e);lastError=attempt.error;attempt.outcome='recovery failed';log.warn(lastError)}
   finally{
     attempt.endedAt=new Date().toISOString();attempt.newTrace=flash.trace!==previousTrace;
     try{flashExport=saveFlashAttempt(attempt)}catch(e){flashExportError=String(e.message||e);log.warn('Recovery autosave: '+flashExportError)}
     flashTask=null;pending=false;lever.runEnded();finishAttempt();update();
   }
 });
 const openMenu=name=>{if(flash.running||pending)throw Error('Wait for the current operation to finish');lastError='';return ui.open(name)};
 handler('BTN_OPTIONS',()=>openMenu('OPTIONS'));
 handler('BTN_OPTIONS_BACK',()=>openMenu('MAIN'));
 handler('BTN_DIAG',()=>openMenu('DIAGNOSTICS'));
 handler('BTN_ADVANCED',()=>openMenu('ADVANCED'));
 handler('BTN_ADVANCED_BACK',()=>{stop('Left advanced tests');return ui.open('DIAGNOSTICS')});
 async function checkConnection(startCapture){
   if(!valid())throw Error('Park securely in P and open Advanced tests: '+(guard.recoveryReason()||'advanced page not open'));
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
     physicalActuation:flash.trace.some(x=>x.tx.startsWith('3101')),manualFlash:{status:flash.status,trace:flash.trace.slice(),cleanupUnconfirmed:flash.cleanupUnconfirmed,config:flash.config,fastTest:flash.fast,stepsCompleted:flash.stepsCompleted,elapsedMs:flash.elapsedMs,timing:Timing.summarize(flash.trace),release:Release.summarize(flash.trace,flash.cleanupUnconfirmed)},combinedSignal:lastCombined,capture:capture.snapshot(),flmFeedback:feedback.slice(),decodedFeedback:feedback.map(Feedback.sampleState),overrideReadiness:Feedback.limits,backgroundMonitor:monitor.snapshot(),leverTrigger:lever.snapshot(),feedbackStatus};
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
   if(!validFeedback())throw Error('Park securely in P and open Advanced tests');
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
 ui.onVisible(()=>{if(ui.isVisible('MAIN'))monitor.seeMain();else if(runNeedsMain||menuVisible())flash.cancel();persistBackground();if((capture.active||pending&&!flash.running)&&!ui.isVisible('ADVANCED'))stop('Left advanced tests');update()});
 if(ctx.app&&ctx.app.on)ctx.app.on('shutdown',()=>{closing=true;flash.cancel();stop('Shutdown')});
 process.on('SIGTERM',()=>{closing=true;flash.cancel();stop('Shutdown');if(flashTask){const timer=setTimeout(()=>process.exit(1),10000);flashTask.catch(()=>{}).then(()=>{clearTimeout(timer);process.exit(0)});}else process.exit(0)});
 guard.init(ctx.signals,log,v=>{lastCombined=v&&v.statusMainBeam_headlightFlasher;lastLightAt=Date.now();observeBackground();capture.status(v);feedLever()}).catch(e=>log.warn(String(e)));
 reader.init().catch(e=>log.warn(String(e)));
 setInterval(()=>{tick().catch(e=>log.warn(String(e)))},250);
 update();
}});
