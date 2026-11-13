'use strict';
const fs = require('fs');
const path = require('path');
const F = require('./flm-control');
const PATTERNS = Object.freeze(['alternate','double','triple','together','cross','wave','custom']);
const PWM = Object.freeze([20,40,60,80,100]);
const DURATION = Object.freeze([1,2,3]);
const GAP = Object.freeze([500,750,1000]);
const CYCLES = Object.freeze([1,2,3]);
const DEFAULT = Object.freeze({pattern:'alternate', left:7, right:7,
    pwm:60, seconds:1, gapMs:500, cycles:2,
    custom:['L7','R7','L5','R5']});
function selector(str) {
    if (str === 'BOTH' || str === 'OFF') return str;
    if (!/^[LR]([1-9]|1[0-5])$/.test(String(str))) throw new Error('Invalid custom target');
    return str;
}
function validate(state) {
    if (!state || PATTERNS.indexOf(state.pattern) < 0 ||
        !PWM.includes(state.pwm) || !DURATION.includes(state.seconds) ||
        !GAP.includes(state.gapMs) || !CYCLES.includes(state.cycles)) throw new Error('Invalid show settings');
    F.channelNumber(state.left); F.channelNumber(state.right);
    if (!Array.isArray(state.custom) || state.custom.length !== 4) throw new Error('Exactly 4 custom steps required');
    state.custom.forEach(selector);
    return state;
}
function allowedTarget(selectorName, left, right, labels, observations) {
    if (selectorName === 'OFF') return { left: null, right: null };
    if (selectorName === 'BOTH') return { left, right };
    const side = selectorName[0] === 'L' ? 'left' : 'right';
    const channel = Number(selectorName.slice(1)); F.channelNumber(channel);
    if (!labels.allowed(observations, side, channel))
        throw new Error('Channel ' + selectorName + ' has no safe visible observation');
    return side === 'left' ? {left: channel, right: null} : {left: null, right: channel};
}
function makePlan(state, labels, observations) {
    validate(state);
    const left=state.left,right=state.right;
    if (!labels.allowed(observations,'left',left) || !labels.allowed(observations,'right',right))
        throw new Error('First record visible, noise-free tests for selected left/right channels');
    const L='L'+left,R='R'+right,B='BOTH';
    const recipe = {
        alternate:[L,R], double:[L,L,R,R], triple:[L,L,L,R,R,R],
        together:[B], cross:[L,R,B], wave:[L,B,R], custom:state.custom
    }[state.pattern];
    const steps=[];
    for(let i=0;i<state.cycles;i++) for(const token of recipe) steps.push(allowedTarget(token,left,right,labels,observations));
    const lampSeconds = steps.reduce((n,s)=>n+((s.left?1:0)+(s.right?1:0))*state.seconds,0);
    const totalMs = steps.length * (state.seconds*1000+state.gapMs);
    if(lampSeconds===0)throw new Error('Custom show needs at least one confirmed active LED channel');
    if(steps.length>20 || lampSeconds>36 || totalMs>55000)
        throw new Error('Show exceeds limited test budget; reduce cycles, duration or steps');
    return { route:'flm_show', pattern:state.pattern, pwm:state.pwm,
        seconds:state.seconds, gapMs:state.gapMs, steps };
}
class ShowConfig {
    constructor(dir) {
        this.file=path.join(dir,'light-show-effect-config.json');
        this.state=Object.assign({}, DEFAULT, {custom:DEFAULT.custom.slice()});
        try {
            const obj=JSON.parse(fs.readFileSync(this.file,'utf8'));
            validate(obj);
            this.state={pattern:obj.pattern,left:obj.left,right:obj.right,pwm:obj.pwm,
                seconds:obj.seconds,gapMs:obj.gapMs,cycles:obj.cycles,custom:obj.custom.slice()};
        } catch(e) { if(e.code!=='ENOENT')this.loadError=String(e.message||e); }
    }
    set(change) {
        const next=Object.assign({},this.state,change);
        if(change.custom)next.custom=change.custom.slice();
        validate(next);
        fs.writeFileSync(this.file+'.tmp',JSON.stringify({version:1,...next},null,2));
        fs.renameSync(this.file+'.tmp',this.file);
        this.state=next;
    }
    cycle(field,options) {
        const idx=options.indexOf(this.state[field]);
        this.set({[field]:options[(idx+1)%options.length]});
    }
    nextChannel(side,available) {
        if(!available.length)throw new Error('No visibly confirmed '+side+' channels yet');
        const idx=available.indexOf(this.state[side]);
        this.set({[side]:available[(idx+1)%available.length]});
    }
    nextCustom(index, eligibleLeft, eligibleRight) {
        if(!Number.isInteger(index)||index<0||index>3)throw new Error('Invalid show step');
        const options=['OFF','BOTH'].concat(eligibleLeft.map(n=>'L'+n),eligibleRight.map(n=>'R'+n));
        if(options.length===2)throw new Error('No recorded visible FLM02 channels');
        const custom=this.state.custom.slice();
        const current=options.indexOf(custom[index]);
        custom[index]=options[(current+1)%options.length];
        this.set({custom});
    }
    plan(labels, observations) { return makePlan(this.state,labels,observations); }
}
module.exports={ShowConfig,PATTERNS,PWM,DURATION,GAP,CYCLES,DEFAULT,makePlan,validate,selector};
