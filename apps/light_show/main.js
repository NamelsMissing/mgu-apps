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
const {ShowConfig, PATTERNS, PWM, PULSE, GAP, CYCLES} = require('./flm-show');

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
        let poolSide='left',lastLabelTestStatus='No test performed yet';
        let lastStatus='',lastShowStatus='',lastDiagnostic='',hiddenTimer=null,lastResult='';
        let confirmationReturn='DIAGNOSTICS',labelReturn='DIAGNOSTICS',flmReturn='MAIN';
        let darkReturn='MAIN', darkChecked=false;
        const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ0123456789 -_';
        const flmConfig=()=>F.settings(Number(settings.get('flmPwm')),Number(settings.get('flmSeconds')));
        const openConfirmation=(dest)=>{confirmationReturn=dest;return ui.open('CONFIRM_LIGHTS');};
        const ensureIdle=()=>{if(engine.run)throw new Error('Stop the active lighting test first');};
        const onFailure=(e)=>{
            const msg=String(e&&e.message||e);
            log.warn('Light Show UI: '+msg);
            ui.text('STATUS','ERROR: '+msg);
            if(ui.isVisible('POOL_CHANNELS'))ui.text('POOL_SIDE','Cannot select this LED: '+msg);
            if(ui.isVisible('PLAYLIST'))ui.text('POOL_INFO','Playlist: '+msg);
            if(ui.isVisible('SHOW_SETUP'))ui.text('SHOW_INFO','Cannot start or change show: '+msg);
            if(ui.isVisible('LABEL_EDITOR')){
                lastLabelTestStatus='TEST/NAME ERROR: '+msg;
                updateEditor();
            }
        };
        const observed=(side,c)=>names.status(observations,side,c);
        const label=(side,c)=>names.label(side,c)+' ('+(side==='left'?'L':'R')+c+')';
        const eligible=(side)=>names.eligible(observations,side);
        const describe=(st)=>st==='visible'?'VISIBLE, no noise':st==='noise'?'NOISE - excluded':st==='not-visible'?'no visible effect':'not yet observed';

        const tokenLabel=(token)=>{
            if(token==='OFF')return 'Dark pause';
            const side=token[0]==='L'?'left':'right';
            return label(side,Number(token.slice(1)));
        };
        const planLines=(plan)=>plan.steps.map((step,i)=>{
            const active=[];
            if(step.left)active.push(label('left',step.left));
            if(step.right)active.push(label('right',step.right));
            return (i+1)+'. '+(active.join(' + ')||'Dark pause')+
                (active.length?' | approx. '+plan.pulseMs+'ms / '+plan.pwm+'%':'')+
                ' | gap requested '+plan.gapMs+'ms';
        }).join('\n');
        function selectedLines() {
            return show.state.playlist.map((tok,i)=>String(i+1).padStart(2,'0')+'. '+tokenLabel(tok)).join('\n');
        }
        function updateShow(){
            const st=show.state;
            let summary;
            try {const p=show.plan(names,observations);
                summary=p.steps.length+' steps | up to '+Math.round(p.steps.length*(p.pulseMs+p.gapMs)/1000)+' s nominal';
            }catch(e){summary='Not ready: '+e.message;}
            ui.text('SHOW_INFO','Pattern: '+st.pattern+' | '+summary+
                '\n'+st.playlist.filter(tok=>tok!=='OFF').length+' selected LEDs (max 30).'+
                '\nTASU is not precise: 200 ms is an approximate ON window, not measured light.');
            ui.text('SHOW_SELECTED','Selected order:\n'+selectedLines());
            [
                ['BTN_SHOW_PATTERN','Pattern: '+st.pattern],
                ['BTN_SHOW_POOL','Choose LEDs / order ('+st.playlist.length+' steps)'],
                ['BTN_SHOW_PWM','Brightness: '+st.pwm+'%'],
                ['BTN_SHOW_PULSE','ON: approx. '+st.pulseMs+' ms'],
                ['BTN_SHOW_GAP','Dark gap: requested '+st.gapMs+' ms'],
                ['BTN_SHOW_CYCLES','Cycles: '+st.cycles]
            ].forEach(([id,msg])=>ui.text(id,msg));
        }
        function updatePool() {
            ui.text('POOL_STATUS','LED playlist (up to 30 distinct channels):\n'+selectedLines()+
                '\nTap Left/Right to add a tested LED; tap again to remove.\n'+
                'Channel 13 right is blocked because an unusual noise was recorded.');
            ui.text('POOL_INFO','Steps follow the order you add LEDs. Same-module LEDs run one after another.'+
                '\nTogether pairs only LEFT and RIGHT channels; exact simultaneity not guaranteed.');
        }
        function updatePoolChannels(){
            const side=poolSide,sel=new Set(show.state.playlist);
            ui.text('POOL_SIDE',(side==='left'?'LEFT':'RIGHT')+' - tap to add/remove\n'+
                'Only observed-visible/no-noise channels may be added.');
            for(let ch=1;ch<=15;ch++){
                const tok=(side==='left'?'L':'R')+ch;
                ui.text('BTN_POOL_CH_'+ch.toString(16).toUpperCase().padStart(2,'0'),
                    (sel.has(tok)?'REMOVE ':'ADD ')+tokenLabel(tok)+' ['+describe(observed(side,ch))+']');
            }
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
                '\nTEST this channel here, record its result, then assign a meaningful name.');
            ui.text('LABEL_DRAFT','Name draft: '+(editDraft||'(empty)')+(note?'\n'+note:''));
            ui.text('LABEL_CHAR','Next character: '+alphabet[charIndex]);
            ui.text('LABEL_TEST_STATUS',lastLabelTestStatus);
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
                'Light Show 0.3.2 - FLM02 playlist with OEM dark-stage preparation',
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
                const report={app:'light_show',version:'0.3.2',at:new Date().toISOString(),
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
                    'Pattern: '+p.pattern+'\nPWM '+p.pwm+'%, requested pulse '+p.pulseMs+
                    'ms (approximate), requested dark gap '+p.gapMs+'ms\n'+planLines(p));
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
        const openDarkGuide=(previous)=>{
            darkReturn=previous;
            darkChecked=false;
            ui.text('DARK_PREP_STATUS',
                'No lamp OFF command has been sent. Use the BMW light controls while parked.');
            return ui.open('DARK_PREP');
        };
        handler('BTN_DARK_MAIN',()=>openDarkGuide('MAIN'));
        handler('BTN_DARK_SHOW',()=>openDarkGuide('SHOW_SETUP'));
        handler('BTN_DARK_VERIFY_P',()=>{
            if(engine.run)throw new Error('Stop the FLM test or show before checking darkness');
            const why=guard.reason();
            darkChecked=!why;
            ui.text('DARK_PREP_STATUS',why
                ? 'Vehicle NOT READY: '+why+'. No lights have been switched off.'
                : 'Vehicle reports P and standstill. You must still switch off OEM lights manually and visually check them. This check DOES NOT measure lamp state.');
        });
        handler('BTN_DARK_CONTINUE',()=>{
            if(engine.run)throw new Error('Stop active lighting tests first');
            if(!darkChecked||guard.reason()){
                ui.text('DARK_PREP_STATUS','Select Check P / standstill first. Lights are not switched off automatically.');
                return;
            }
            return openShow();
        });
        handler('BTN_DARK_IDENTIFY',()=>{
            if(engine.run)throw new Error('Stop current light test first');
            labelReturn='DARK_PREP';
            return ui.open('LABEL_INDEX');
        });
        handler('BTN_DARK_BACK',()=>ui.open(darkReturn));

        handler('BTN_SHOW_PATTERN',()=>{ensureIdle();show.cycle('pattern',PATTERNS);updateShow();});
        [['BTN_SHOW_PWM','pwm',PWM],['BTN_SHOW_PULSE','pulseMs',PULSE],
         ['BTN_SHOW_GAP','gapMs',GAP],['BTN_SHOW_CYCLES','cycles',CYCLES]]
            .forEach(([id,key,opts])=>handler(id,()=>{ensureIdle();show.cycle(key,opts);updateShow();}));
        handler('BTN_SHOW_POOL',()=>{updatePool();return ui.open('PLAYLIST');});
        handler('BTN_POOL_BACK',openShow);
        [['BTN_POOL_LEFT','left'],['BTN_POOL_RIGHT','right']].forEach(([id,side])=>
            handler(id,()=>{poolSide=side;updatePoolChannels();return ui.open('POOL_CHANNELS');}));
        handler('BTN_POOL_CHANNEL_BACK',()=>{updatePool();return ui.open('PLAYLIST');});
        for(let ch=1;ch<=15;ch++){
            const id='BTN_POOL_CH_'+ch.toString(16).toUpperCase().padStart(2,'0');
            handler(id,()=>{
                ensureIdle();
                const token=(poolSide==='left'?'L':'R')+ch;
                show.toggle(token,names,observations);
                updatePoolChannels();
            });
        }
        handler('BTN_POOL_ADD_PAUSE',()=>{ensureIdle();show.appendOff();updatePool();});
        handler('BTN_POOL_UNDO',()=>{ensureIdle();show.undo();updatePool();});
        handler('BTN_POOL_RESET',()=>{ensureIdle();show.clear();updatePool();});
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
                charIndex=0;lastLabelTestStatus='Press TEST to identify this LED before naming it.';
                updateEditor();return ui.open('LABEL_EDITOR');
            });
        }
        for(let i=0;i<PRESETS.length;i++)
            handler('BTN_LABEL_PRESET_'+(i+1),()=>{
                ensureIdle();editDraft=PRESETS[i];names.set(labelSide,labelChannel,editDraft);
                updateEditor('Saved preset: '+editDraft);
            });

        handler('BTN_LABEL_TEST',async()=>{
            ensureIdle();
            if(journal.pending())throw new Error('Stop lock pending: check normal lights in Diagnostics first');
            const opts=flmConfig();
            selectedOutput={route:'flm',side:labelSide,channel:labelChannel,pwm:opts.pwm,
                seconds:opts.seconds,label:label(labelSide,labelChannel),
                prg:F.MODULES[labelSide].name+'_KANAL_'+labelChannel};
            lastLabelTestStatus='Running '+labelSide+' channel '+labelChannel+
                ' / '+opts.pwm+'% for '+opts.seconds+' s; STOP available.';
            updateEditor();
            await engine.testFlm(labelSide,labelChannel,opts.pwm,opts.seconds);
            const st=engine.status();
            lastLabelTestStatus=st.state+': '+st.note+
                (st.stopConfirmed?'\nStopRoutine confirmed':'\nStop not confirmed: do not repeat');
            updateEditor();
        });
        handler('BTN_LABEL_STOP',()=>engine.stop('STOP from name editor'));
        [['BTN_LABEL_RESULT_VISIBLE','visible, no unusual noise'],
         ['BTN_LABEL_RESULT_NO_EFFECT','no visible effect, no noise'],
         ['BTN_LABEL_RESULT_VISIBLE_NOISE','visible and unusual noise'],
         ['BTN_LABEL_RESULT_NOISE','unusual noise without visible light']]
            .forEach(([id,value])=>handler(id,()=>{
                if(!selectedOutput||selectedOutput.side!==labelSide||selectedOutput.channel!==labelChannel)
                    throw new Error('Press TEST on this LED first');
                observe(value);
                lastLabelTestStatus=lastResult;
                updateEditor();
            }));
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
                const pages=['MAIN','SHOW_SETUP','SHOW_PREVIEW','DARK_PREP','PLAYLIST','POOL_CHANNELS',
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
