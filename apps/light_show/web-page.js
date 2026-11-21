'use strict';
// The phone page. One HTML document with inline CSS/JS; the 3D car is car3d.js itself.
const fs = require('fs');
const path = require('path');

let car3d = '';
try { car3d = fs.readFileSync(path.join(__dirname, 'car3d.js'), 'utf8').replace(/^'use strict';\s*/, ''); }
catch (_) { car3d = 'window.Car3D=null;'; }

const CSS = `
:root{--bg:#07090d;--panel:#11151c;--line:#232a35;--text:#e9eef6;--dim:#8a95a6;--accent:#2f8bff;--ok:#36d07a;--warn:#ffb020;--bad:#ff4d4d}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--text);font:15px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{position:sticky;top:0;z-index:5;background:linear-gradient(#07090df2,#07090dd9);backdrop-filter:blur(8px);padding:12px 16px 8px;display:flex;align-items:center;gap:10px}
header h1{font-size:19px;margin:0;font-weight:650;letter-spacing:.2px;flex:1}
.pill{font-size:12px;padding:4px 10px;border-radius:99px;background:var(--panel);border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.pill.ok{color:var(--ok);border-color:#1e5b39}.pill.warn{color:var(--warn);border-color:#6a4b10}.pill.bad{color:var(--bad);border-color:#6a1d1d}
#stage{position:relative;height:250px;margin:0 8px;border-radius:18px;background:radial-gradient(ellipse at 50% 70%,#1a2433 0,#0b0f15 70%);overflow:hidden;touch-action:none}
#car-preview{width:100%;height:100%;display:block}
#runinfo{position:absolute;left:14px;right:14px;bottom:10px;font-size:13px;color:var(--dim)}
#bar{height:3px;background:#1d2532;border-radius:2px;margin-top:6px;overflow:hidden}#bar i{display:block;height:100%;width:0;background:var(--accent);transition:width .3s}
.main{display:flex;gap:10px;padding:12px 16px}
button{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px;cursor:pointer}
button:active{transform:scale(.98)}
button.primary{background:var(--accent);border-color:var(--accent);font-weight:650}
button.stop{background:#3a1012;border-color:#7a2025;color:#ffd6d6;font-weight:650}
button:disabled{opacity:.4}
.main button{flex:1;padding:14px;font-size:16px}
nav{display:flex;gap:6px;padding:0 16px 8px;position:sticky;top:52px;background:var(--bg);z-index:4}
nav button{flex:1;padding:9px;border-radius:10px;color:var(--dim)}nav button.on{color:var(--text);border-color:var(--accent);background:#0f1b2c}
section{padding:4px 16px 40px;display:none}section.on{display:block}
h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:18px 0 8px;font-weight:600}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:12px;text-align:left}
.card b{display:block;font-size:15px;margin-bottom:3px}.card span{font-size:12.5px;color:var(--dim)}
.card.on{border-color:var(--accent);background:#0f1b2c}
.chips{display:flex;flex-wrap:wrap;gap:6px}.chips button{padding:7px 11px;border-radius:99px;font-size:13.5px}.chips button.on{border-color:var(--accent);background:#0f1b2c}
.row{display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--panel);border:1px solid var(--line);border-radius:12px;margin-bottom:6px}
.row .dot{width:12px;height:12px;border-radius:50%;flex:none;box-shadow:0 0 8px currentColor}
.row .t{flex:1;min-width:0}.row .t b{display:block;font-weight:560;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row .t span{font-size:12px;color:var(--dim)}
.row.off{opacity:.45}
.row button{padding:7px 10px;font-size:13px;border-radius:9px}
.num{min-width:26px;text-align:center;font-weight:700;color:var(--accent)}
.st{font-size:11.5px;padding:2px 7px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}
.st.visible{color:var(--ok);border-color:#1e5b39}.st.noise{color:var(--bad);border-color:#6a1d1d}
.ask{display:flex;gap:6px;margin:-2px 0 8px 24px;flex-wrap:wrap}.ask button{font-size:12.5px;padding:6px 9px}
.note{font-size:13px;color:var(--dim);margin:6px 0}.note.warn{color:var(--warn)}.note.bad{color:var(--bad)}
.unit{display:flex;gap:10px;font-size:13.5px;padding:8px 0;border-bottom:1px solid var(--line)}.unit code{color:var(--dim);min-width:44px}.unit .s{margin-left:auto;font-size:12px}
label.sw{display:flex;align-items:center;gap:10px;margin:10px 0}
#toast{position:fixed;left:16px;right:16px;bottom:16px;background:#1b2330;border:1px solid var(--line);border-radius:12px;padding:12px;display:none;z-index:9}
`;

const SCRIPT = `
var $=function(s){return document.querySelector(s)};var T=new URLSearchParams(location.search).get('t');
var S=null,tab='shows',yaw=0.75,pitch=-0.32,drag=null,showAll=false;
function api(p,b){return fetch(p+'?t='+encodeURIComponent(T),b===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json()})}
function toast(m){var t=$('#toast');t.textContent=m;t.style.display='block';clearTimeout(toast.h);toast.h=setTimeout(function(){t.style.display='none'},3500)}
function act(p,b){return api(p,b).then(function(r){if(r&&r.ok===false)toast(r.error||'Refused');poll();return r}).catch(function(){toast('No connection to the car')})}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function poll(){api('/api/state').then(function(s){S=s;render()}).catch(function(){$('#conn').className='pill bad';$('#conn').textContent='Offline'})}
setInterval(poll,800);poll();
function render(){
 if(!S)return;var r=S.runner,g=S.guard;
 $('#conn').className='pill '+(r.busy?'warn':g.ok?'ok':'bad');$('#conn').textContent=r.busy?(r.state==='RUNNING'?'Playing':'Working'):g.ok?'Parked':'Not ready';
 var p=r.progress;$('#runtext').textContent=r.busy?(r.title+(r.note&&r.note!==r.title?' - '+r.note:'')+(p?' ('+p.step+'/'+p.steps+')':'')):(g.ok?r.note:g.reason);
 $('#bar i').style.width=p?Math.round(100*p.step/p.steps)+'%':'0';
 $('#go').disabled=r.busy||r.recoveryPending||!g.ok||!S.plan||!!S.plan.error;$('#stop').disabled=!r.busy&&!r.recoveryPending;
 if(tab==='shows')renderShows();if(tab==='lights')renderLights();if(tab==='car')renderCar();
}
function chips(el,list,cur,key,fmt){el.innerHTML=list.map(function(v){return '<button class="'+(v===cur?'on':'')+'" data-v="'+v+'">'+fmt(v)+'</button>'}).join('');
 Array.prototype.forEach.call(el.children,function(b){b.onclick=function(){var c={};c[key]=Number(b.dataset.v);save(c)}})}
function save(c){return act('/api/save',c)}
function renderShows(){
 var c=S.config;$('#effects').innerHTML=S.effects.map(function(e){return '<button class="card'+(e.id===c.effect?' on':'')+'" data-e="'+e.id+'"><b>'+esc(e.name)+'</b><span>'+esc(e.text)+'</span></button>'}).join('');
 Array.prototype.forEach.call($('#effects').children,function(b){b.onclick=function(){save({effect:b.dataset.e})}});
 chips($('#step'),S.options.stepMs,c.stepMs,'stepMs',function(v){return v+' ms'});
 chips($('#gap'),S.options.gapMs,c.gapMs,'gapMs',function(v){return v?v+' ms':'none'});
 chips($('#cycles'),S.options.cycles,c.cycles,'cycles',function(v){return v+'x'});
 chips($('#pwm'),S.options.pwm,c.pwm,'pwm',function(v){return v+'%'});
 var n=c.selection.length,pl=S.plan;
 $('#sel').innerHTML=n?n+' lights selected: '+c.selection.map(function(id){var l=S.lamps.find(function(x){return x.id===id});return esc(l?l.short:id)}).join(', '):'No lights selected yet. Test lights under <b>Lights</b> and add the ones you want.';
 $('#clear').hidden=!n;$('#clear').disabled=S.runner.busy;
 $('#plan').innerHTML=pl?(pl.error?'<div class="note bad">'+esc(pl.error)+'</div>':'<div class="note">'+pl.steps+' steps, about '+Math.round(pl.estimateMs/1000)+' s (the car can be slower)</div>'+pl.notes.map(function(x){return '<div class="note warn">'+esc(x)+'</div>'}).join('')):'';
}
function renderLights(){
 var groups={front:'Front',side:'Side',rear:'Rear'},h='',sel=S.config.selection;
 var canTest=S.guard.ok&&!S.runner.busy&&!S.runner.recoveryPending;
 Object.keys(groups).forEach(function(gk){var ls=S.lamps.filter(function(l){return l.group===gk&&(showAll||l.available)});if(!ls.length)return;h+='<h2>'+groups[gk]+'</h2>';
  ls.forEach(function(l){var i=sel.indexOf(l.id);
   h+='<div class="row'+(l.available?'':' off')+'"><span class="dot" style="color:'+l.hex+';background:'+l.hex+'"></span><div class="t"><b>'+esc(l.label)+'</b><span>'+(l.available?'<span class="st '+l.status+'">'+esc(l.statusText)+'</span> '+esc(l.module+(l.experimental?' - experimental':'')):esc(l.why))+'</span></div>';
   if(l.available)h+='<button data-a="test" data-id="'+l.id+'"'+(canTest?'':' disabled')+'>Test</button>';
   if(i>=0||(l.available&&l.status==='visible'))h+='<button data-a="sel" data-id="'+l.id+'">'+(i>=0?'Remove':'Add')+'</button>';
   h+='</div>';
   if(!S.runner.busy&&S.lastTested===l.id)h+='<div class="ask"><button data-a="obs" data-r="visible" data-id="'+l.id+'">Lit up, quiet</button><button data-a="obs" data-r="none" data-id="'+l.id+'">Nothing</button><button data-a="obs" data-r="noise" data-id="'+l.id+'">Lit + noise</button><button data-a="obs" data-r="silentNoise" data-id="'+l.id+'">Only noise</button><button data-a="name" data-id="'+l.id+'">Rename</button></div>';
  })});
 $('#lamps').innerHTML=h||'<div class="note">No lights available yet. Run the scan under <b>Car</b>.</div>';
 Array.prototype.forEach.call($('#lamps').querySelectorAll('button'),function(b){b.onclick=function(){var id=b.dataset.id,a=b.dataset.a;
  if(a==='test'){act('/api/test',{lamp:id})}
  if(a==='sel'){act('/api/toggle',{lamp:id})}
  if(a==='obs'){act('/api/observe',{lamp:id,result:b.dataset.r})}
  if(a==='name'){var v=prompt('Name for this light (empty = default)','');if(v!==null)act('/api/name',{lamp:id,name:v})}
 }});
}
function renderCar(){
 var p=S.profile,h='';
 if(!p)h='<div class="note">No scan yet. It runs by itself once the car is parked in P, or press the button. It only reads the identity of every control unit.</div>';
 else{h+='<div class="note">'+esc(p.summary)+' - '+new Date(p.at).toLocaleString()+'</div>';
  if(p.order)h+='<div class="note">Vehicle order: '+esc(p.order.hints.length?p.order.hints.join(', '):p.order.codes.length+' option codes')+'</div>';
  h+=p.units.filter(function(u){return u.light}).map(function(u){return '<div class="unit"><code>'+u.addressHex+'</code><div><b>'+esc(u.name||'Unknown '+(u.index||''))+'</b><br><span class="note">'+esc(u.light)+'</span></div><span class="s">'+esc(u.supportText||'')+'</span></div>'}).join('');
  h+='<h2>All control units</h2>'+p.units.map(function(u){return '<div class="unit"><code>'+u.addressHex+'</code><span>'+esc(u.name||u.index||'no identity')+'</span><span class="s note">'+esc(u.role||'')+'</span></div>'}).join('');}
 $('#units').innerHTML=h;$('#comm').checked=!!S.commOff;$('#comm').disabled=S.runner.busy;
 $('#scan').disabled=S.runner.busy||S.runner.recoveryPending||!S.guard.ok;
 $('#rec').innerHTML=S.runner.recoveryPending?'<div class="note warn">A previous run is not released yet. Press STOP.</div>':'';
}
document.querySelectorAll('nav button').forEach(function(b){b.onclick=function(){tab=b.dataset.t;document.querySelectorAll('nav button').forEach(function(x){x.classList.toggle('on',x===b)});document.querySelectorAll('section').forEach(function(s){s.classList.toggle('on',s.id===tab)});render()}});
$('#go').onclick=function(){act('/api/show',{})};$('#stop').onclick=function(){act('/api/stop',{})};
$('#clear').onclick=function(){save({selection:[]})};
$('#scan').onclick=function(){toast('Scanning - this takes a few seconds');act('/api/scan',{})};
$('#comm').onchange=function(){act('/api/commoff',{on:$('#comm').checked})};
$('#all').onchange=function(){showAll=$('#all').checked;render()};
var cv=$('#car-preview'),cx=cv.getContext('2d');
function frame(){var w=cv.clientWidth,h=cv.clientHeight,dp=window.devicePixelRatio||1;if(cv.width!==w*dp){cv.width=w*dp;cv.height=h*dp}
 cx.setTransform(dp,0,0,dp,0,0);cx.clearRect(0,0,w,h);if(!drag)yaw+=0.004;
 if(window.Car3D&&S){var act2=S.runner.active,sel=S.config.selection,lamps=S.lamps.filter(function(l){return l.available}).map(function(l){return{points:l.points,hex:l.hex,on:act2.indexOf(l.id)>=0,dim:sel.indexOf(l.id)<0}});
  Car3D.render({poly:function(p,c){cx.fillStyle='rgba('+c[0]+','+c[1]+','+c[2]+','+c[3]/255+')';cx.beginPath();cx.moveTo(p[0][0],p[0][1]);for(var i=1;i<p.length;i++)cx.lineTo(p[i][0],p[i][1]);cx.closePath();cx.fill();cx.strokeStyle=cx.fillStyle;cx.stroke()},
   dot:function(x,y,r,c){cx.fillStyle='rgba('+c[0]+','+c[1]+','+c[2]+','+c[3]/255+')';cx.beginPath();cx.arc(x,y,r,0,7);cx.fill()}},{x:0,y:0,w:w,h:h,yaw:yaw,pitch:pitch},lamps)}
 requestAnimationFrame(frame)}
requestAnimationFrame(frame);
cv.addEventListener('pointerdown',function(e){drag={x:e.clientX,y:e.clientY,yaw:yaw,pitch:pitch};cv.setPointerCapture(e.pointerId)});
cv.addEventListener('pointermove',function(e){if(!drag)return;yaw=drag.yaw+(e.clientX-drag.x)*0.01;pitch=Math.max(-0.9,Math.min(0.1,drag.pitch-(e.clientY-drag.y)*0.006))});
cv.addEventListener('pointerup',function(){drag=null});
`;

module.exports = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#07090d">
<title>Light Show</title><style>${CSS}</style></head><body>
<header><h1>Light Show</h1><span id="conn" class="pill">Connecting</span></header>
<div id="stage"><canvas id="car-preview"></canvas><div id="runinfo"><span id="runtext">Connecting to the car...</span><div id="bar"><i></i></div></div></div>
<div class="main"><button id="go" class="primary">Start show</button><button id="stop" class="stop">STOP</button></div>
<nav><button data-t="shows" class="on">Shows</button><button data-t="lights">Lights</button><button data-t="car">Car</button></nav>
<section id="shows" class="on"><h2>Effect</h2><div id="effects" class="grid"></div>
<h2>Lights in this show</h2><div id="sel" class="note"></div><button id="clear" hidden>Clear lights</button>
<h2>Step time</h2><div id="step" class="chips"></div><h2>Pause between steps</h2><div id="gap" class="chips"></div>
<h2>Repeat</h2><div id="cycles" class="chips"></div><h2>Headlamp LED brightness</h2><div id="pwm" class="chips"></div><div id="plan"></div>
<div class="note">Only in P, standing still, on private ground. Don't look into the headlights. Lights take part in a show only after you tested them and they lit up without noise.</div></section>
<section id="lights"><label class="sw"><input type="checkbox" id="all"> Show unavailable lights too</label><div id="lamps"></div></section>
<section id="car"><button id="scan" class="primary" style="width:100%">Scan control units</button><div id="rec"></div>
<label class="sw"><input type="checkbox" id="comm"> Test option: headlamp modules ignore the car's own light messages during a show (28 02 01, like BimmerLight)</label>
<div class="note">Supported = tested in a car. From BMW data = telegram from the BMW PRG, not yet tested in a car: test each light once while you watch.</div>
<div id="units"></div></section>
<div id="toast"></div>
<script>${car3d}</script><script>${SCRIPT}</script></body></html>`;
