'use strict';
const fs = require('fs');
const path = require('path');
const F = require('./flm-control');
// Everything remains FLM02-only; no multi-channel same-module concurrency.
// Timing is an approximate requested pulse window after the START reply.
const PATTERNS = Object.freeze(['alternate','double','triple','together','cross','wave','custom']);
const PWM = Object.freeze([20,40,60,80,100]);
const PULSE = Object.freeze([200,300,400,500,750,1000,1500,2000,3000]);
const GAP = Object.freeze([100,150,200,300,500,750,1000]);
const CYCLES = Object.freeze([1,2,3]);
const MAX_CHANNELS = 30;
const MAX_STEPS = 90;
const MAX_SHOW_MS = 120000;
const DEFAULT = Object.freeze({ pattern:'alternate', playlist:['L7','R7'],
    pwm:60, pulseMs:500, gapMs:200, cycles:2 });
function selector(str) {
    if (str==='OFF') return str;
    if (typeof str!=='string' || !/^[LR]([1-9]|1[0-5])$/.test(str))
        throw new Error('Invalid FLM02 channel identifier');
    return str;
}
function validate(s) {
    if (!s || !PATTERNS.includes(s.pattern) || !PWM.includes(s.pwm)
        || !PULSE.includes(s.pulseMs) || !GAP.includes(s.gapMs) || !CYCLES.includes(s.cycles)
        || !Array.isArray(s.playlist) || s.playlist.length<1 || s.playlist.length>MAX_CHANNELS+10)
        throw new Error('Invalid FLM02 effect settings');
    const unique = new Set();
    let channelCount=0;
    for (const tok of s.playlist) {
        selector(tok);
        if(tok==='OFF')continue;
        if(unique.has(tok))throw new Error('Playlist cannot contain duplicate channels; use Double or Triple effect');
        unique.add(tok);channelCount++;
    }
    if(!channelCount || channelCount>MAX_CHANNELS)throw new Error('Choose 1 to 30 FLM02 channels');
    return s;
}
function allowed(token, labels, observations) {
    if(token==='OFF')return;
    const side=token[0]==='L'?'left':'right', channel=Number(token.slice(1));
    if(!labels.allowed(observations,side,channel))
        throw new Error(token+' is not marked visible/no-noise after a confirmed FLM02 stop');
}
function single(token) {
    if(token==='OFF')return {left:null,right:null};
    const side=token[0]==='L'?'left':'right',channel=Number(token.slice(1));
    return side==='left'?{left:channel,right:null}:{left:null,right:channel};
}
function pair(left,right) {
    return {left:left?Number(left.slice(1)):null,right:right?Number(right.slice(1)):null};
}
function makePlan(s,labels,observations) {
    validate(s);
    s.playlist.forEach(tok=>allowed(tok,labels,observations));
    const pool=s.playlist;
    const active=pool.filter(t=>t!=='OFF');
    const sideL=active.filter(t=>t[0]==='L');
    const sideR=active.filter(t=>t[0]==='R');
    let recipe;
    if(s.pattern==='double'||s.pattern==='triple'){
        const n=s.pattern==='double'?2:3;
        recipe=pool.flatMap(tok=>Array.from({length:n},()=>single(tok)));
    } else if(s.pattern==='wave'){
        recipe=pool.concat(pool.slice(0,-1).reverse()).map(single);
    } else if(s.pattern==='together'||s.pattern==='cross'){
        // Pair only one channel per module at a time. No simultaneous
        // same-module activation: BMW FLM_KANAL may override previous channel.
        const R=s.pattern==='cross'?sideR.slice().reverse():sideR;
        recipe=[];
        const len=Math.max(sideL.length,R.length);
        for(let i=0;i<len;i++) recipe.push(pair(sideL[i],R[i]));
    } else if(s.pattern==='custom'||s.pattern==='alternate'){
        recipe=pool.map(single);
    } else throw new Error('Unknown FLM02 pattern');
    if(!recipe.length||!recipe.some(step=>step.left||step.right))throw new Error('Empty animation');
    const steps=[];
    for(let k=0;k<s.cycles;k++)for(const step of recipe)
        steps.push({left:step.left,right:step.right});
    const estimated=steps.length*(s.pulseMs+s.gapMs);
    if(steps.length>MAX_STEPS||estimated>MAX_SHOW_MS)
        throw new Error('Show too long: max '+MAX_STEPS+' steps / 120s; reduce channels, repeats or timing');
    return {route:'flm_show',pattern:s.pattern,pwm:s.pwm,
        pulseMs:s.pulseMs,seconds:Math.ceil(s.pulseMs/1000),gapMs:s.gapMs,
        steps, selectedChannels:active.slice(), requestedTimingNote:
        'Pulse duration counted after FLM START response; diagnostic latency prevents exact physical millisecond timing'};
}
function fromOld(x){
    // Migrate 0.3.0 effect settings without erasing user's chosen channels.
    if(!x||!x.pattern||!F.channelNumber)return {...DEFAULT,playlist:DEFAULT.playlist.slice()};
    let list=[];
    for(const token of x.custom||[])if(typeof token==='string'&&/^[LR]([1-9]|1[0-5])$/.test(token)&&!list.includes(token))list.push(token);
    for(const token of ['L'+x.left,'R'+x.right])
        if(/^[LR]([1-9]|1[0-5])$/.test(token)&&!list.includes(token))list.push(token);
    if(!list.length)list=DEFAULT.playlist.slice();
    const migrated={pattern:PATTERNS.includes(x.pattern)?x.pattern:DEFAULT.pattern,
        playlist:list,pwm:PWM.includes(x.pwm)?x.pwm:DEFAULT.pwm,
        pulseMs:PULSE.includes(x.seconds*1000)?x.seconds*1000:DEFAULT.pulseMs,
        gapMs:GAP.includes(x.gapMs)?x.gapMs:DEFAULT.gapMs,
        cycles:CYCLES.includes(x.cycles)?x.cycles:DEFAULT.cycles};
    validate(migrated);
    return migrated;
}
class ShowConfig {
    constructor(dir) {
        this.file=path.join(dir,'light-show-effect-config.json');
        this.state={...DEFAULT,playlist:DEFAULT.playlist.slice()};
        try {
            const raw=JSON.parse(fs.readFileSync(this.file,'utf8'));
            const data=raw&&raw.pulseMs!==undefined ? raw : fromOld(raw);
            validate(data);
            this.state={pattern:data.pattern,playlist:data.playlist.slice(),
                pwm:data.pwm,pulseMs:data.pulseMs,gapMs:data.gapMs,cycles:data.cycles};
        } catch(e) {if(e.code!=='ENOENT')this.loadError=String(e.message||e);}
    }
    set(change) {
        const state={...this.state,...change};
        if(change.playlist)state.playlist=change.playlist.slice();
        validate(state);
        fs.writeFileSync(this.file+'.tmp',JSON.stringify({version:2,...state},null,2));
        fs.renameSync(this.file+'.tmp',this.file);
        this.state=state;
    }
    cycle(key,options) {
        const pos=options.indexOf(this.state[key]);
        this.set({[key]:options[(pos+1)%options.length]});
    }
    toggle(token,labels,observations) {
        selector(token);
        if(token==='OFF')throw new Error('Use Add dark pause for OFF');
        const playlist=this.state.playlist.slice();
        const at=playlist.indexOf(token);
        if(at>=0)playlist.splice(at,1);
        else {allowed(token,labels,observations);playlist.push(token);}
        if(!playlist.some(x=>x!=='OFF'))throw new Error('Playlist needs at least one channel');
        this.set({playlist});
    }
    appendOff() {
        const playlist=this.state.playlist.slice();
        if(playlist.length>=MAX_CHANNELS+10)throw new Error('Playlist full');
        playlist.push('OFF');this.set({playlist});
    }
    undo() {
        if(this.state.playlist.length<=1)throw new Error('Cannot remove last LED');
        const playlist=this.state.playlist.slice();playlist.pop();
        if(!playlist.some(x=>x!=='OFF'))throw new Error('Playlist needs an LED');
        this.set({playlist});
    }
    clear() {this.set({playlist:DEFAULT.playlist.slice()});}
    plan(labels,observations){return makePlan(this.state,labels,observations);}
}
module.exports={ShowConfig,PATTERNS,PWM,PULSE,GAP,CYCLES,DEFAULT,
    MAX_CHANNELS,MAX_STEPS,makePlan,validate,selector,fromOld};
