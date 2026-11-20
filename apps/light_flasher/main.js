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
const VERSION='0.1.16';
mgu.run({async start(ctx){
 const {ui,settings,log}=ctx, capture=new Capture(),reader=new Reader(ctx.signals,log);
 const monitor=new Monitor(Date.now,ctx.app&&ctx.app.startReason);
 monitor.setEnabled(settings.get('backgroundMonitor')===true);
 if(ui.isVisible('MAIN'))monitor.seeMain();
 log.info('Light Flasher startup: '+JSON.stringify(monitor.snapshot()));
 let lastCombined=null, lastRead=0, pending=false, generation=0, exported='', closing=false, connectionState='Not checked', lastError='';
 const feedback=[];let feedbackStatus='No FLM samples recorded';
 let flashExport='',flashExportError='',flashAttempt=0;
 // Migrate retired interval choices explicitly; preserve valid saved settings.
 if(['20','40','60','80'].includes(String(settings.get('interval'))))settings.set('interval','100');
 const lever=new LeverTrigger(Date.now);lever.setEnabled(settings.get('leverTrigger')===true);
 const bgFile=path.join(ctx.dataDir,'light-flasher-background.json');let lastBg='',bgError='';
 const persistBackground=()=>{try{const lv=lever.snapshot();const bg={...monitor.snapshot(),lever:{enabled:lv.enabled,background:settings.get('leverBackground')===true,state:lv.state,triggers:lv.triggers,rejected:lv.rejected,lastPulseMs:lv.lastPulseMs,events:lv.events}};const raw=JSON.stringify(bg);if(raw!==lastBg){fs.writeFileSync(bgFile+'.tmp',JSON.stringify({...bg,version:VERSION,pid:process.pid,writtenAt:new Date().toISOString()},null,2));fs.renameSync(bgFile+'.tmp',bgFile);lastBg=raw;}bgError='';}catch(e){bgError=String(e.message||e);}};
 persistBackground();
 const enabled=()=>settings.get('enabled')===true;
 const guard=new Guard(Date.now,()=>{});
 const getConfig=()=>config(settings.get('pattern'),settings.get('interval'),settings.get('hold'));
 const marker=path.join(ctx.dataDir,'manual-flash-pending.json');
 const journal={exists:()=>fs.existsSync(marker),mark:()=>fs.writeFileSync(marker,JSON.stringify({at:new Date().toISOString()}),{flag:'wx'}),clear:()=>fs.unlinkSync(marker)};
 const flash=new ManualFlash(reader.diag,log,undefined,Date.now,journal);let lastLightAt=0,flashTask=null;
 const stop=(why)=>{generation++;capture.stop(why);};
 // Passive observation only, independent of the parked actuator guard.
 const lightProviderAvailable=()=>!!(guard.speedSub&&guard.speedSub.available);
 const observeBackground=()=>{monitor.observe(Date.now()-lastLightAt<=2500?{statusMainBeam_headlightFlasher:lastCombined}:null,lightProviderAvailable(),ui.isVisible('MAIN'));persistBackground();};
 const update=()=>{
   const g=guard.snapshot(),c=capture.snapshot(),bg=monitor.snapshot();
   const fastOk=v=>v===true?'confirmed':v===false?'NOT confirmed':'not checked';
   const timing=Timing.summarize(flash.trace),gaps=timing.startDispatchGaps;
   const release=Release.summarize(flash.trace,flash.cleanupUnconfirmed);
   const returnState=release.locked?'LOCKED: check normal lamps':release.acknowledged?'STOP / default session acknowledged':release.attempted?'return not confirmed':'not tested';
   if(ui.isVisible('MAIN')){
     let cfgText;try{const cfg=getConfig();cfgText=(settings.get('fastTest')===true?'FAST TEST | ':'')+cfg.label+' | '+cfg.intervalMs+' ms requested | '+cfg.durationMs/1000+' s'}catch(e){cfgText='Invalid settings: select 100 ms or above'}
     ui.text('FLASH_CONFIG',cfgText);
     ui.text('FLASH_STATUS',(flash.running?flash.status:flash.cleanupUnconfirmed?(flash.status.startsWith('LOCKED: recovery')?flash.status:'LOCKED: previous cleanup not confirmed - use Restore normal lights'):flash.status)+' | '+(g.blockedBy||'P / stationary')+' | OEM beam '+(lastCombined||'unknown')+(lastError?' | '+lastError:''));
     const lv=lever.snapshot();ui.text('LEVER_STATUS','Lever'+(leverBackground()?' (also closed)':'')+': '+(settings.get('leverTrigger')===true?lv.reason+' | triggers '+lv.triggers+(lv.rejected?' | ignored '+lv.rejected:''):'off (enable in settings)'));
     ui.text('FLASH_RESULT',(gaps?'Actual START gap '+gaps.meanMs+' ms | ':'')+returnState+(flashExportError?' | Save error: '+flashExportError:flashExport?' | Log saved':''));
   }
   if(!ui.isVisible('DIAGNOSTICS'))return;
   ui.text('DIAG_STATE','TASU: '+(reader.diag.available?'available':(reader.diag.error||'unavailable'))+' | '+(g.blockedBy||'P / stationary')+' | diagnostics '+(enabled()?'ON':'OFF')+'\nOEM beam '+(lastCombined||'unknown')+' | Background '+(bg.enabled?'ON':'OFF')+' / '+bg.startReason+' | BDC '+(reader.index||'not checked')+'\n'+(lastError?'ERROR: '+lastError:connectionState));
   ui.text('DIAG_RESULT','Last flash: '+flash.status+'\nReturn: '+returnState+'\n'+(gaps?'START gap '+gaps.minMs+'-'+gaps.maxMs+' ms, mean '+gaps.meanMs+' ms (not optical timing)':'No timing sample yet')+(flash.fast?'\nFast test: PWM 0 off L '+fastOk(flash.fast.offVerified.left)+' / R '+fastOk(flash.fast.offVerified.right)+(timing.pwm0OffResponses?', off reply mean '+timing.pwm0OffResponses.meanMs+' ms':'')+(timing.startResponses?', on reply mean '+timing.startResponses.meanMs+' ms':''):'')+'\n'+(flashExportError?'Auto-save failed: '+flashExportError:flashExport?'Flash log: '+flashExport:'No new flash export'));
   ui.text('DIAG_CAPTURE',c.reason+' | Reads '+c.rawCount+' | Errors '+c.failures+' | '+feedbackStatus);
   const f=feedback[feedback.length-1],d=f?Feedback.sampleState(f):null;
   const electrical=d?Object.entries(d.sides).map(([side,x])=>side+' CH8: '+x.highBeam.pwmPercent+'% / '+x.highBeam.currentMa+' mA | CH7: '+x.lowBeam.pwmPercent+'%').join('\n'):'No FLM readback yet';
   ui.text('DIAG_LOG',electrical+'\n'+flash.trace.slice(-8).map(x=>x.side+' '+x.tx+' => '+(x.rx||x.error||'waiting')+(x.requestMs===undefined?'':' ('+x.requestMs+' ms)')).join('\n')+'\n'+reader.trace.slice(-6).map(x=>x.tx+' => '+(x.rx||x.error||'waiting')).join('\n')+'\n'+c.events.slice(-12).map(e=>e.ms+' ms '+e.kind+' '+JSON.stringify(e.value)).join('\n')+(exported?'\nSaved: '+exported:'')+(bgError?'\nBackground log error: '+bgError:''));
 };
 const safe=()=>!closing&&enabled()&&!guard.reason();
 const valid=()=>safe()&&ui.isVisible('DIAGNOSTICS');
 const validFeedback=()=>safe()&&ui.isVisible('DIAGNOSTICS');
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
 const flashAllowed=()=>!closing&&settings.get('manualFlash')===true&&ui.isVisible('MAIN')&&!guard.reason()&&lastCombined==='AUS'&&Date.now()-lastLightAt<=2500;
 // Background lever mode: same P/stationary/OEM-off guard, but no visible menu needed.
 // Never while the diagnostics page is open (shared TASU, read-only tests).
 const leverBackground=()=>settings.get('leverBackground')===true;
 const leverScreenOk=()=>ui.isVisible('MAIN')||(leverBackground()&&!ui.isVisible('DIAGNOSTICS'));
 const backgroundRunAllowed=()=>!closing&&settings.get('manualFlash')===true&&settings.get('leverTrigger')===true&&leverBackground()&&!ui.isVisible('DIAGNOSTICS')&&!guard.reason()&&lastCombined==='AUS'&&Date.now()-lastLightAt<=2500;
 let runNeedsMain=true;
 const leverAllowed=()=>!closing&&settings.get('manualFlash')===true&&settings.get('leverTrigger')===true&&leverScreenOk()&&!guard.reason()&&!pending&&!capture.active&&!flash.running&&!flash.cleanupUnconfirmed;
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
     const background=source==='lever'&&leverBackground();attempt.background=background;
     const runAllowed=background?backgroundRunAllowed:flashAllowed;runNeedsMain=!background;
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
     flashTask=null;pending=false;lever.runEnded();finishAttempt();update();
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
 handler('BTN_DIAG',()=>{if(flash.running)throw Error('Stop manual flash first');return ui.open('DIAGNOSTICS')});
 async function checkConnection(startCapture){
   if(!valid())throw Error('Enable diagnostic mode and park in P: '+(guard.reason()||'diagnostic mode/page not enabled'));
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
 handler('BTN_BACK',()=>{stop('Left diagnostics');return ui.open('MAIN')});
 async function sampleFeedback(label){
   if(!validFeedback())throw Error('Enable diagnostics and park in P');
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
 settings.onChange(()=>{monitor.setEnabled(settings.get('backgroundMonitor')===true);lever.setEnabled(settings.get('leverTrigger')===true);persistBackground();if(!enabled())stop('Disabled');if(flash.running||settings.get('manualFlash')!==true)flash.cancel();update()});
 ui.onVisible(()=>{if(ui.isVisible('MAIN'))monitor.seeMain();else if(runNeedsMain||ui.isVisible('DIAGNOSTICS'))flash.cancel();persistBackground();if((capture.active||pending&&!flash.running)&&!ui.isVisible('DIAGNOSTICS'))stop('Left diagnostics');update()});
 if(ctx.app&&ctx.app.on)ctx.app.on('shutdown',()=>{closing=true;flash.cancel();stop('Shutdown')});
 process.on('SIGTERM',()=>{closing=true;flash.cancel();stop('Shutdown');if(flashTask){const timer=setTimeout(()=>process.exit(1),10000);flashTask.catch(()=>{}).then(()=>{clearTimeout(timer);process.exit(0)});}else process.exit(0)});
 guard.init(ctx.signals,log,v=>{lastCombined=v&&v.statusMainBeam_headlightFlasher;lastLightAt=Date.now();observeBackground();capture.status(v);feedLever()}).catch(e=>log.warn(String(e)));
 reader.init().catch(e=>log.warn(String(e)));
 setInterval(()=>{tick().catch(e=>log.warn(String(e)))},250);
 update();
}});
