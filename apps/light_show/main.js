'use strict';
const mgu = require('./kit/mgu');
const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const Link = require('./link');
const Guard = require('./guard');
const Journal = require('./journal');
const Engine = require('./engine');
const F = require('./flm-control');
const {ChannelLabels, PRESETS} = require('./channel-labels');
const {ShowConfig, PATTERNS, PWM, DURATION, GAP, CYCLES} = require('./flm-show');

mgu.run({
    async start(ctx) {
        const {ui,settings,log} = ctx;
        const journal = new Journal(ctx.dataDir);
        const names = new ChannelLabels(ctx.dataDir);
        const show = new ShowConfig(ctx.dataDir);
        const observationsPath = path.join(ctx.dataDir,'light-show-observations.json');
        let observations=[];
        try {
            const raw=JSON.parse(fs.readFileSync(observationsPath,'utf8'));
            if(Array.isArray(raw)) observations=raw.filter(x=>x&&typeof x==='object').slice(-100);
        } catch(e) { if(e.code!=='ENOENT')log.warn('Observation read: '+e.message); }
        let engine,link,guard,selectedOutput=null,selectedSide='left';
        let labelSide='left',labelChannel=1,editDraft='',charIndex=0;
        let lastStatus='',lastShowStatus='',lastDiagnostic='',hiddenTimer=null,lastResult='';
        let confirmationReturn='DIAGNOSTICS',labelReturn='DIAGNOSTICS',flmReturn='MAIN';
        const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ0123456789 -_';
        const flmConfig=()=>F.settings(Number(settings.get('flmPwm')),Number(settings.get('flmSeconds')));
        const openConfirmation=(dest)=>{confirmationReturn=dest;return ui.open('CONFIRM_LIGHTS');};
        const ensureIdle=()=>{if(engine.run)throw new Error('Stop the active lighting test first');};
        const onFailure=(e)=>{log.warn('Light Show UI: '+(e.message||e));ui.text('STATUS','ERROR: '+(e.message||e));};
        const observed=(side,c)=>names.status(observations,side,c);
        const label=(side,c)=>names.label(side,c)+' ('+(side==='left'?'L':'R')+c+')';
        const eligible=(side)=>names.eligible(observations,side);
        const describe=(st)=>st==='visible'?'VISIBLE, no noise':st==='noise'?'NOISE - excluded':st==='not-visible'?'no visible effect':'not yet observed';
        const selectorDescription=(v)=>{
            if(v==='OFF')return 'Dark pause';
            if(v==='BOTH')return 'Both: '+label('left',show.state.left)+' + '+label('right',show.state.right);
            const side=v[0]==='L'?'left':'right';
            return label(side,Number(v.slice(1)));
        };
        const planLines=(plan)=>{
            const lines=[];
            plan.steps.forEach((step,i)=>{
                const components=[];
                if(step.left)components.push(label('left',step.left));
                if(step.right)components.push(label('right',step.right));
                lines.push((i+1)+'. '+(components.join(' + ')||'Dark pause')
                    + (components.length?' | '+plan.pwm+'% / '+plan.seconds+'s':'')
                    + ' | dark gap '+plan.gapMs+'ms');
            });
            return lines.join('\n');
        };
        function updateShow() {
            const s=show.state;
            let planSummary;
            try {const p=show.plan(names,observations);
                planSummary=p.steps.length+' pulses / bounded (no rapid strobe)';
            } catch(e) {planSummary='NOT READY: '+e.message;}
            ui.text('SHOW_INFO','Effect: '+s.pattern+' | '+planSummary+
                '\nLeft: '+label('left',s.left)+' | Right: '+label('right',s.right)+
                '\nPWM '+s.pwm+'%, pulse '+s.seconds+'s, gap '+s.gapMs+'ms, repeats '+s.cycles);
            [['BTN_SHOW_PATTERN','Effect: '+s.pattern],
             ['BTN_SHOW_LEFT','Left: '+label('left',s.left)],
             ['BTN_SHOW_RIGHT','Right: '+label('right',s.right)],
             ['BTN_SHOW_PWM','Brightness: '+s.pwm+'%'],
             ['BTN_SHOW_SECONDS','Pulse: '+s.seconds+' s'],
             ['BTN_SHOW_GAP','Dark interval: '+s.gapMs+' ms'],
             ['BTN_SHOW_CYCLES','Repeats: '+s.cycles]]
                .forEach(row=>ui.text(row[0],row[1]));
        }
        function updateCustom() {
            ui.text('CUSTOM_INFO','Each step cycles through your visibly confirmed channels, both chosen sides or dark pause.\nA custom effect uses these four steps in order.');
            for(let i=0;i<4;i++)
                ui.text('BTN_CUSTOM_'+(i+1),'Step '+(i+1)+': '+selectorDescription(show.state.custom[i]));
        }
        function updateLabelChannels() {
            ui.text('LABEL_SIDE',labelSide==='left'?'Left FLM02 - select LED to name':'Right FLM02 - select LED to name');
            for(let c=1;c<=15;c++){
                const id='BTN_LABEL_CH_'+c.toString(16).toUpperCase().padStart(2,'0');
                ui.text(id,'Channel '+c+': '+names.label(labelSide,c)+' ['+describe(observed(labelSide,c))+']');
            }
        }
        function updateManualChannels() {
            ui.text('FLM_SIDE',selectedSide==='left'?'Left FLM02 (all 15 channels)':'Right FLM02 (all 15 channels)');
            for(let c=1;c<=15;c++){
                const id='BTN_FLM_CH_'+c.toString(16).toUpperCase().padStart(2,'0');
                ui.text(id,'Channel '+c+': '+names.label(selectedSide,c)+' ['+describe(observed(selectedSide,c))+']');
            }
        }
        function updateEditor(note) {
            ui.text('LABEL_EDIT_INFO',(labelSide==='left'?'Left':'Right')+' FLM02 channel '+labelChannel+
                '\nObserved: '+describe(observed(labelSide,labelChannel))+
                '\nUse preset or character editor; names do not verify an LED.');
            ui.text('LABEL_DRAFT','Name draft: '+(editDraft||'(empty)')+(note?'\n'+note:''));
            ui.text('LABEL_CHAR','Next character: '+alphabet[charIndex]);
        }
        function updateOverview() {
            const lines=['USER OBSERVATIONS / NOT AN ECU LAMP MEASUREMENT',
                'Animation uses only channels with a saved visible/no-noise observation and confirmed cleanup.',
                'Right channel 13 had unusual noise and is excluded.',''];
            for(const side of ['left','right']){
                lines.push(side==='left'?'LEFT / FLM02_L':'RIGHT / FLM02_R');
                for(let c=1;c<=15;c++)lines.push(
                    '  '+c+'  '+names.label(side,c)+' — '+describe(observed(side,c)));
                lines.push('');
            }
            ui.text('CHANNEL_OVERVIEW_TEXT',lines.join('\n'));
        }
        const changed=()=>{
            if(engine && engine.run && ['STARTING','RUNNING'].includes(engine.state)){
                const why=guard.reason();
                if(why||!link.available)engine.stop(why||'FLM connection lost');
            }
            refresh();
        };
        guard=new Guard(Date.now,changed);
        link=new Link(ctx.signals,log,changed);
        engine=new Engine({link,guard,journal,log,changed:refresh});
        function refresh() {
            if(!engine)return;
            const s=engine.status(),line=s.state+': '+s.note+
                (s.state==='RUNNING'?' | '+s.remainingSeconds+'s remaining':'');
            if(lastStatus!==line){lastStatus=line;ui.text('STATUS',line);}
            const showLine=s.state==='RUNNING' && s.control.route==='flm_show'
                ? 'Running step '+(s.control.stepIndex||'?')+'/'+s.control.stepsCount+' | '+s.note
                : 'Show: '+s.state+' | '+s.note;
            if(lastShowStatus!==showLine){lastShowStatus=showLine;ui.text('SHOW_PROGRESS',showLine);}
            if(ui.isVisible('OUTPUT_OBSERVE')){
                ui.text('OBSERVE_STATUS',line+
                    '\nFLM02 replies are not physical lamp measurements.'+
                    (journal.pending()?'\nRecovery lock pending; inspect normal lights before continuing.':''));
                ui.text('OBSERVE_RECORDED',lastResult||'Record visible output or noise after the test.');
            }
        }
        function diagnostics() {
            const s=engine.status(),g=guard.snapshot();
            const lines=[
                'Light Show 0.3.0 - FLM02-only animation engine',
                'State: '+s.state+' | '+s.note,
                'TASU: '+(link.available?'available':'unavailable')+
                    ' | BDC index: '+(link.index||'not read'),
                'Speed: '+(g.speedKmh==null?'unknown':g.speedKmh.toFixed(2))+
                    ' km/h | gear: '+(g.stage||'unknown')+' | blocked: '+(g.blockedBy||'no'),
                'Recovery lock: '+(journal.pending()?'PENDING':'clear'),
                'Route: '+s.control.route+' | stopped: '+s.stopConfirmed+
                    ' | commands sent: '+s.sent,
                'Cleanup: '+JSON.stringify(s.cleanup),
                'Active/test PWM: '+settings.get('flmPwm')+'% / '+settings.get('flmSeconds')+'s',
                'Show: '+JSON.stringify(show.state),
                'Original fault: '+(engine.originalFault||'none'),
                'Channel observations:'
            ];
            for(const side of ['left','right']){
                lines.push(side.toUpperCase()+':');
                for(let c=1;c<=15;c++)
                    lines.push('  '+c+' '+names.label(side,c)+': '+describe(observed(side,c)));
            }
            lines.push('','Recent observations:');
            observations.slice(-30).reverse().forEach(x=>lines.push(
                x.at+' '+x.prg+' '+x.result+' | cleanup='+x.cleanupConfirmed));
            lines.push('','Headlamp module reads:');
            engine.headlamps.forEach(x=>lines.push(x.side+' '+x.name+' '+(x.index||'?')+' '+(x.highBeamRaw||'')));
            lines.push('','Recent UDS messages:');
            link.trace.slice(-25).forEach(x=>lines.push(x.at+' ['+P.hex([x.address])+'] '+x.tx+' => '+(x.rx||x.error||'')));
            return lines.join('\n');
        }
        function saveLog() {
            try {
                let preview=null,previewError=null;
                try {preview=show.plan(names,observations);}catch(e){previewError=e.message;}
                const report={app:'light_show',version:'0.3.0',at:new Date().toISOString(),
                    physicalEffectVerified:false, status:engine.status(),
                    guard:guard.snapshot(),flmSettings:flmConfig(),
                    showSettings:show.state,showPlan:preview,showPlanError:previewError,
                    channelMappings:names.snapshot(observations),
                    recoveryPending:journal.pending(),bdcIndex:link.index,
                    headlamps:engine.headlamps,originalFault:engine.originalFault,
                    individualObservations:observations,
                    outputSamples:engine.outputSamples,trace:link.trace};
                const target=path.join(ctx.dataDir,'light-show-diagnostics.json');
                fs.writeFileSync(target+'.tmp',JSON.stringify(report,null,2));
                fs.renameSync(target+'.tmp',target);
                ui.text('DIAG_TEXT',diagnostics()+'\n\nSaved: '+target);
            }catch(e){
                log.warn('Diagnostic export failed: '+e.message);
                ui.text('DIAG_TEXT',diagnostics()+'\n\nExport ERROR: '+e.message);
            }
        }
        function openShow(){updateShow();return ui.open('SHOW_SETUP');}
        function previewShow(){
            try {
                const p=show.plan(names,observations);
                ui.text('SHOW_PREVIEW_TEXT','FLM02 SHOW PREVIEW (NO LIGHT COMMANDS)\n'+
                    'Pattern: '+p.pattern+'\nPWM '+p.pwm+'%, pulse '+p.seconds+
                    's, dark interval '+p.gapMs+'ms\n'+planLines(p));
            }catch(e){ui.text('SHOW_PREVIEW_TEXT','Cannot start: '+e.message+
                '\nTest channels and record visible / no unusual noise first.');}
            return ui.open('SHOW_PREVIEW');
        }
        function startShow(){
            try {
                ensureIdle();
                const plan=show.plan(names,observations);
                return engine.playFlmShow(plan);
            } catch(e) {onFailure(e);return Promise.resolve();}
        }
        const handler=(id,fn)=>ui.onClick(id,()=>Promise.resolve().then(fn).catch(onFailure));
        handler('BTN_SHOW_SETUP',openShow);
        handler('BTN_SHOW_BACK',()=>ui.open('MAIN'));
        handler('BTN_SHOW_PATTERN',()=>{ensureIdle();show.cycle('pattern',PATTERNS);updateShow();});
        handler('BTN_SHOW_LEFT',()=>{ensureIdle();show.nextChannel('left',eligible('left'));updateShow();});
        handler('BTN_SHOW_RIGHT',()=>{ensureIdle();show.nextChannel('right',eligible('right'));updateShow();});
        [['BTN_SHOW_PWM','pwm',PWM],['BTN_SHOW_SECONDS','seconds',DURATION],
         ['BTN_SHOW_GAP','gapMs',GAP],['BTN_SHOW_CYCLES','cycles',CYCLES]]
            .forEach(([id,key,opts])=>handler(id,()=>{ensureIdle();show.cycle(key,opts);updateShow();}));
        handler('BTN_SHOW_CUSTOM',()=>{
            ensureIdle();
            if(show.state.pattern!=='custom')show.set({pattern:'custom'});
            updateCustom();return ui.open('CUSTOM_EDITOR');
        });
        handler('BTN_CUSTOM_BACK',openShow);
        for(let i=0;i<4;i++)handler('BTN_CUSTOM_'+(i+1),()=>{
            ensureIdle();show.nextCustom(i,eligible('left'),eligible('right'));updateCustom();
        });
        handler('BTN_SHOW_PREVIEW',previewShow);
        handler('BTN_PREVIEW_BACK',openShow);
        ['BTN_SHOW_START','BTN_PREVIEW_START'].forEach(id=>handler(id,startShow));
        ['BTN_STOP','BTN_SHOW_STOP','BTN_PREVIEW_STOP','BTN_DIAG_STOP','BTN_OUTPUT_STOP']
            .forEach(id=>handler(id,()=>engine.stop('Manual STOP')));
        handler('BTN_DIAG',()=>{lastDiagnostic=diagnostics();ui.text('DIAG_TEXT',lastDiagnostic);return ui.open('DIAGNOSTICS');});
        handler('BTN_EXPORT',saveLog);
        handler('BTN_HEADLAMPS',async()=>{await engine.inspectHeadlamps();ui.text('DIAG_TEXT',diagnostics());});
        handler('BTN_CHANNEL_OVERVIEW',()=>{updateOverview();return ui.open('CHANNEL_OVERVIEW');});
        handler('BTN_OVERVIEW_BACK',()=>ui.open('DIAGNOSTICS'));
        handler('BTN_OVERVIEW_LABEL',()=>{labelReturn='CHANNEL_OVERVIEW';return ui.open('LABEL_INDEX');});
        handler('BTN_OVERVIEW_TEST',()=>{flmReturn='CHANNEL_OVERVIEW';return ui.open('FLM_INDEX');});
        handler('BTN_FLM_HOME',()=>{flmReturn='MAIN';return ui.open('FLM_INDEX');});
        handler('BTN_FLM_DIAG',()=>{flmReturn='DIAGNOSTICS';return ui.open('FLM_INDEX');});
        handler('BTN_FLM_BACK',()=>ui.open(flmReturn));
        for(const side of ['left','right'])
            handler('BTN_FLM_'+side.toUpperCase(),()=>{
                selectedSide=side;updateManualChannels();return ui.open('FLM_CHANNELS');
            });
        handler('BTN_FLM_CHANNEL_BACK',()=>ui.open('FLM_INDEX'));
        for(let c=1;c<=15;c++){
            const id='BTN_FLM_CH_'+c.toString(16).toUpperCase().padStart(2,'0');
            handler(id,async()=>{
                ensureIdle();
                const opts=flmConfig();
                selectedOutput={route:'flm',side:selectedSide,channel:c,pwm:opts.pwm,seconds:opts.seconds,
                    label:label(selectedSide,c),prg:F.MODULES[selectedSide].name+'_KANAL_'+c};
                lastResult='';
                ui.text('OBSERVE_NAME',selectedOutput.label+'\n'+opts.pwm+'% / '+opts.seconds+
                    's | '+describe(observed(selectedSide,c)));
                await ui.open('OUTPUT_OBSERVE');
                await engine.testFlm(selectedSide,c,opts.pwm,opts.seconds);
                refresh();
            });
        }
        handler('BTN_OUTPUT_REPEAT',()=>{
            if(!selectedOutput)return;
            if(journal.pending())return openConfirmation('OUTPUT_OBSERVE');
            return engine.testFlm(selectedOutput.side,selectedOutput.channel,
                selectedOutput.pwm,selectedOutput.seconds);
        });
        handler('BTN_OUTPUT_CHECK_LIGHTS',()=>openConfirmation('OUTPUT_OBSERVE'));
        handler('BTN_OUTPUT_BACK',async()=>{await engine.stop('Leaving individual test');updateManualChannels();return ui.open('FLM_CHANNELS');});
        function observe(result) {
            if(!selectedOutput)return;
            if(engine.run){lastResult='Wait for the test to finish before saving.';refresh();return;}
            const s=engine.status();
            if(result==='visible, no unusual noise' && !(s.state==='IDLE' && s.stopConfirmed===true
                && s.sent>0 && s.control.route==='flm' && s.control.side===selectedOutput.side
                && s.control.channel===selectedOutput.channel && !journal.pending())) {
                lastResult='Cannot mark as verified: no completed FLM02 test with confirmed StopRoutine.';
                refresh();return;
            }
            const record={at:new Date().toISOString(),id:null,
                prg:selectedOutput.prg,label:selectedOutput.label,result,
                route:'flm',side:selectedOutput.side,channel:selectedOutput.channel,
                pwm:selectedOutput.pwm,seconds:selectedOutput.seconds,
                ecuState:s.state,ecuNote:s.note,cleanupConfirmed:s.stopConfirmed};
            const next=observations.concat([record]).slice(-100);
            fs.writeFileSync(observationsPath+'.tmp',JSON.stringify(next,null,2));
            fs.renameSync(observationsPath+'.tmp',observationsPath);
            observations=next;
            lastResult='Recorded: '+result+' | '+describe(observed(selectedOutput.side,selectedOutput.channel));
            refresh();
        }
        [['BTN_OUTPUT_VISIBLE','visible, no unusual noise'],
         ['BTN_OUTPUT_VISIBLE_NOISE','visible and unusual noise'],
         ['BTN_OUTPUT_NO_EFFECT','no visible effect, no noise'],
         ['BTN_OUTPUT_NOISE','unusual noise without visible light']]
            .forEach(([id,value])=>handler(id,()=>observe(value)));
        handler('BTN_LABEL_HOME',()=>{labelReturn='MAIN';return ui.open('LABEL_INDEX');});
        handler('BTN_LABEL_DIAG',()=>{labelReturn='DIAGNOSTICS';return ui.open('LABEL_INDEX');});
        handler('BTN_LABEL_INDEX_BACK',()=>ui.open(labelReturn));
        for(const side of ['left','right'])
            handler('BTN_LABEL_'+side.toUpperCase(),()=>{
                labelSide=side;updateLabelChannels();return ui.open('LABEL_CHANNELS');
            });
        handler('BTN_LABEL_CHANNEL_BACK',()=>ui.open('LABEL_INDEX'));
        for(let c=1;c<=15;c++){
            const id='BTN_LABEL_CH_'+c.toString(16).toUpperCase().padStart(2,'0');
            handler(id,()=>{
                ensureIdle();labelChannel=c;editDraft=names.name(labelSide,c);
                charIndex=0;updateEditor();return ui.open('LABEL_EDITOR');
            });
        }
        for(let i=0;i<PRESETS.length;i++)
            handler('BTN_LABEL_PRESET_'+(i+1),()=>{
                ensureIdle();editDraft=PRESETS[i];names.set(labelSide,labelChannel,editDraft);
                updateEditor('Saved preset: '+editDraft);
            });
        handler('BTN_LABEL_NEXT_CHAR',()=>{charIndex=(charIndex+1)%alphabet.length;updateEditor();});
        handler('BTN_LABEL_APPEND_CHAR',()=>{if(editDraft.length>=24)throw Error('Maximum 24 characters');
            editDraft+=alphabet[charIndex];updateEditor();});
        handler('BTN_LABEL_DELETE_CHAR',()=>{editDraft=editDraft.slice(0,-1);updateEditor();});
        handler('BTN_LABEL_CLEAR_DRAFT',()=>{editDraft='';updateEditor();});
        handler('BTN_LABEL_SAVE',()=>{
            ensureIdle();names.set(labelSide,labelChannel,editDraft);updateEditor('Name saved locally');
        });
        handler('BTN_LABEL_RESET',()=>{
            ensureIdle();editDraft='';names.set(labelSide,labelChannel,'');updateEditor('Default channel label restored');
        });
        handler('BTN_LABEL_CANCEL',()=>{updateLabelChannels();return ui.open('LABEL_CHANNELS');});
        handler('BTN_CLEAR_LOCK',()=>openConfirmation('DIAGNOSTICS'));
        handler('BTN_CANCEL_CLEAR',()=>ui.open(confirmationReturn));
        handler('BTN_CONFIRM_CLEAR',async()=>{
            await engine.acknowledgeNormalLights();return ui.open(confirmationReturn);
        });
        settings.onChange(()=>{
            if(engine.run)engine.stop('Manual FLM test settings changed');
            refresh();
        });
        ui.onVisible(()=>{
            clearTimeout(hiddenTimer);
            hiddenTimer=setTimeout(()=>{
                const pages=['MAIN','SHOW_SETUP','SHOW_PREVIEW','CUSTOM_EDITOR',
                    'DIAGNOSTICS','CHANNEL_OVERVIEW','LABEL_INDEX','LABEL_CHANNELS',
                    'LABEL_EDITOR','FLM_INDEX','FLM_CHANNELS','OUTPUT_OBSERVE','CONFIRM_LIGHTS'];
                if(!pages.some(name=>ui.isVisible(name))&&engine.run)engine.stop('App closed');
            },250);
        });
        if(ctx.app&&ctx.app.on)ctx.app.on('shutdown',()=>engine.stop('Head unit shutting down'));
        process.on('SIGTERM',()=>{engine.stop('App stopped').then(()=>process.exit(0));});
        guard.init(ctx.signals,log).catch(e=>log.warn('Light Show vehicle signals: '+e));
        let recoveryTried=false;
        const recover=()=>{
            if(!recoveryTried&&journal.pending()&&link.available&&!engine.run){
                recoveryTried=true;engine.stop('Recovering old or interrupted FLM02 show');
            }
        };
        link.init().then(recover).catch(e=>log.warn('Light Show diagnostic init: '+e));
        setInterval(()=>{changed();recover();},200);
        refresh();
    }
});
