'use strict';

// All assets are embedded because the BMW source builder copies JavaScript,
// but does not expose arbitrary top-level HTML files to the installed OAP app.
// The page is a gamepad (works upright and sideways) plus a Games panel to add and
// delete games. Plain ES5 in the browser: older phones and in-car browsers work too.
const {platforms, extensions, byId} = require('./core_registry');
const romTypes = Object.keys(extensions);
const names = romTypes.reduce((out, id) => Object.assign(out, {[id]: byId[id].short}), {});
const suffix = romTypes.reduce((out, id) => {
    extensions[id].forEach(ext => { out[ext.slice(1)] = id; });
    return out;
}, {});
const buttons = platforms.reduce((out, p) => Object.assign(out, {[p.id]: p.buttons}), {});
const hexButtons = byId.chip8.buttons.map(key => '<button class="key hex" data-key="' + key + '">' +
    key[1].toUpperCase() + '</button>').join('');

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#07090d">
<title>GameStation Controller</title>
<style>
:root{color-scheme:dark;--bg:#07090d;--panel:#11151c;--edge:#262d38;--text:#eef3fa;--dim:#8d99aa;--p:#5ab8ff;--ok:#6fe0a6;--warn:#ffc261;--bad:#ff6b6b;--key:#1a212c;--keyd:#2c3a4f}
body.p2{--p:#ff6f9a}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;overscroll-behavior:none;touch-action:none;-webkit-user-select:none;user-select:none;display:flex;flex-direction:column;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
header{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--edge)}
.badge{font-weight:800;letter-spacing:.08em;background:var(--p);color:#05070a;border-radius:8px;padding:3px 9px;font-size:13px}
#now{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dim);font-size:13px}
#now b{color:var(--text);font-weight:600}
#status{font-size:12px;font-weight:700;letter-spacing:.06em;color:var(--warn);white-space:nowrap}
#status.good{color:var(--ok)}#status.bad{color:var(--bad)}
.hbtn{background:none;border:1px solid var(--edge);color:var(--text);border-radius:999px;padding:7px 13px;font:inherit;font-size:13px;font-weight:600}
#pad{flex:1;display:grid;grid-template-columns:1fr auto 1fr;grid-template-rows:auto 1fr auto;align-items:center;justify-items:center;padding:10px 12px 14px;gap:8px;min-height:0}
.shoulder{grid-row:1;width:100%;max-width:200px;height:46px;border-radius:12px 12px 22px 22px}
#left-shoulders,#right-shoulders{display:flex;align-items:center;gap:6px;grid-row:1;width:100%}
#left-shoulders{grid-column:1}#right-shoulders{grid-column:-2;justify-content:flex-end}
#dpad{grid-column:1;grid-row:2;position:relative;width:min(44vw,210px);height:min(44vw,210px);touch-action:none}
#dpad .arm{position:absolute;background:var(--key);border:1px solid #344055}
#dpad .h{left:0;right:0;top:33.3%;height:33.4%;border-radius:14px}#dpad .v{top:0;bottom:0;left:33.3%;width:33.4%;border-radius:14px}
#dpad .hub{position:absolute;left:33.3%;top:33.3%;width:33.4%;height:33.4%;background:var(--key)}
#dpad .glow{position:absolute;width:33.4%;height:33.4%;border-radius:12px;background:var(--p);opacity:0;transition:opacity .05s}
#dpad .glow.on{opacity:.55}
#g-up{left:33.3%;top:0}#g-down{left:33.3%;bottom:0}#g-left{left:0;top:33.3%}#g-right{right:0;top:33.3%}
#dpad .tri{position:absolute;color:#7f8ca0;font-size:18px;width:33.4%;height:33.4%;display:flex;align-items:center;justify-content:center;pointer-events:none}
#mid{grid-column:2;grid-row:2;display:flex;flex-direction:column;gap:12px;align-items:center}
#secondpad{display:grid;grid-template-columns:repeat(2,1fr);gap:4px}
#secondpad button{border-radius:7px;min-width:35px;min-height:32px}
@media (orientation:portrait){#secondpad{grid-template-columns:repeat(4,1fr)}}
.small{min-width:84px;height:38px;border-radius:19px;font-size:12px;letter-spacing:.08em}
#actions{grid-column:3;grid-row:2;position:relative;width:min(44vw,210px);height:min(44vw,210px)}
.face{position:absolute;width:36%;height:36%;border-radius:50%;font-size:21px}
#a{right:0;top:32%}#b{left:32%;bottom:0}#x{left:32%;top:0}#y{left:0;top:32%}
.playstation #a{left:32%;right:auto;top:auto;bottom:0}.playstation #b{left:auto;right:0;top:32%;bottom:auto}
#cbtn{left:0;top:32%}
#a,#b,#cbtn{background:#3a2440;border-color:#7c4a86}
.key{background:var(--key);border:1px solid #344055;color:var(--text);font-weight:800;font-family:inherit;touch-action:none;display:flex;align-items:center;justify-content:center}
.key.down{background:var(--p);border-color:var(--p);color:#05070a;transform:scale(.96)}
#hint{grid-column:1/4;grid-row:3;color:var(--dim);font-size:12px;text-align:center}
#games{position:fixed;top:0;left:0;right:0;bottom:0;background:var(--bg);display:none;flex-direction:column;touch-action:pan-y;-webkit-user-select:text;user-select:text;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
#games.open{display:flex}
#games header{justify-content:space-between}
#games h2{font-size:17px;margin:0}
#list{flex:1;overflow-y:auto;padding:6px 14px 20px;-webkit-overflow-scrolling:touch}
.sec{margin:16px 0 6px;color:var(--dim);font-size:12px;font-weight:700;letter-spacing:.1em}
.row{display:flex;align-items:center;gap:10px;padding:11px 12px;background:var(--panel);border:1px solid var(--edge);border-radius:12px;margin-bottom:7px}
.row .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .m{color:var(--dim);font-size:12px}
.del{background:none;border:1px solid #6b2b2b;color:var(--bad);border-radius:9px;padding:6px 11px;font:inherit;font-size:13px}
.empty{color:var(--dim);font-size:13px;padding:4px 2px}
form{background:var(--panel);border:1px solid var(--edge);border-radius:14px;padding:14px;margin-top:10px}
input[type=file]{width:100%;color:var(--text);margin:8px 0}
.go{background:var(--p);color:#05070a;border:0;border-radius:10px;padding:11px 16px;font:inherit;font-weight:700;width:100%}
#result{margin:10px 0 0;font-size:13px;color:var(--dim)}
@media (orientation:portrait){#pad{grid-template-columns:1fr 1fr;grid-template-rows:auto 1fr auto auto}#lbtn{grid-column:1}#rbtn{grid-column:2}#dpad{grid-column:1;grid-row:2}#actions{grid-column:2;grid-row:2}#mid{grid-column:1/3;grid-row:3;flex-direction:row}#hint{grid-column:1/3;grid-row:4}}
@media (orientation:landscape) and (max-height:430px){header{padding:6px 12px}#pad{padding:4px 10px 8px}.shoulder{height:38px}#dpad,#actions{width:min(40vh,200px);height:min(40vh,200px)}#hint{display:none}}
[hidden]{display:none!important}
#hexpad{grid-column:1/-1;grid-row:1/4;align-self:center;justify-self:center;display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.hex{position:static;width:clamp(38px,12vw,70px);height:clamp(38px,12vw,70px);border-radius:12px;touch-action:none}
#diag-log{width:100%;min-height:130px;color:var(--text);background:var(--panel);margin-top:10px}
</style></head><body>
<header><span class="badge">P<span id="player">1</span></span><span id="now">GameStation</span><span id="status">CONNECTING</span><button class="hbtn" id="pause" hidden>Pause</button><button class="hbtn" id="gameMenu" hidden>Game Menu</button><button class="hbtn" id="open">Games</button></header>
<main id="pad">
<div id="left-shoulders"><button class="key shoulder" id="lbtn" data-key="l">L</button><button class="key shoulder" data-key="l2">L2</button></div>
<div id="right-shoulders"><button class="key shoulder" data-key="r2">R2</button><button class="key shoulder" id="rbtn" data-key="r">R</button></div>
<div id="dpad"><div class="arm h"></div><div class="arm v"></div><div class="hub"></div>
<div class="glow" id="g-up"></div><div class="glow" id="g-down"></div><div class="glow" id="g-left"></div><div class="glow" id="g-right"></div>
<div class="tri" style="left:33.3%;top:0">&#9650;</div><div class="tri" style="left:33.3%;bottom:0">&#9660;</div><div class="tri" style="left:0;top:33.3%">&#9664;</div><div class="tri" style="right:0;top:33.3%">&#9654;</div></div>
<div id="mid"><div id="secondpad" aria-label="Second D-pad" hidden>
<button class="key" data-key="rUp" aria-label="Second pad up">↑</button>
<button class="key" data-key="rDown" aria-label="Second pad down">↓</button>
<button class="key" data-key="rLeft" aria-label="Second pad left">←</button>
<button class="key" data-key="rRight" aria-label="Second pad right">→</button></div><button class="key small" data-key="select">SELECT</button><button class="key small" data-key="start">START</button></div>
<div id="actions"><button class="key face" id="x" data-key="x">X</button><button class="key face" id="y" data-key="y">Y</button><button class="key face" id="cbtn" data-key="c">C</button><button class="key face" id="a" data-key="a">A</button><button class="key face" id="b" data-key="b">B</button></div>
<div id="hexpad" hidden>${hexButtons}</div>
<p id="hint">Join the car's Wi-Fi and keep this page open. Slide your thumb on the cross for diagonals.</p>
</main>
<section id="games"><header><h2>Games on the car</h2><button class="hbtn" id="close">Back to pad</button></header>
<div id="list"><div class="empty">Loading&hellip;</div>
<form id="upload"><b>Add a game you own</b><input type="file" id="rom" accept="${Object.keys(suffix).map(ext => '.' + ext).join(',')}" required>
<button class="go" type="submit">Upload to the car</button><p id="result">${romTypes.map(id => names[id] + ' (' + extensions[id].join(', ') + ')').join(' / ')}. Max 8 MiB / GBA 32 MiB.</p></form></div>
<div><button class="hbtn" id="refresh">Refresh games</button>
<button class="hbtn" id="log">Show diagnostic log</button>
<a class="hbtn" id="export" hidden>Download log</a></div>
<textarea id="diag-log" readonly hidden aria-label="Diagnostic log, select text to copy"></textarea></section>
<script>
(function(){'use strict';
var q=new URLSearchParams(location.search),token=q.get('t')||'',player=q.get('p')==='2'?2:1,keys={},ws=null,timer=null,state={},buzz=!!navigator.vibrate;
var $=function(id){return document.getElementById(id)};
$('player').textContent=String(player);if(player===2)document.body.className='p2';
var NAMES=${JSON.stringify(names)},EXT=${JSON.stringify(suffix)},BUTTONS=${JSON.stringify(buttons)};
function api(path){return path+(path.indexOf('?')<0?'?':'&')+'t='+encodeURIComponent(token)}
function send(obj){if(ws&&ws.readyState===1)ws.send(JSON.stringify(obj))}
function sendKeys(){send({type:'buttons',keys:Object.keys(keys).filter(function(k){return keys[k]})})}
function setKey(k,v){if(!!keys[k]===v)return;keys[k]=v;if(v&&buzz)navigator.vibrate(8);sendKeys()}
function release(){keys={};Array.prototype.forEach.call(document.querySelectorAll('.down,.glow.on'),function(el){el.classList.remove('down');el.classList.remove('on')});sendKeys()}
function show(){var s=$('status'),p=$('pause'),n=$('now');
 if(!ws||ws.readyState!==1){s.textContent='OFFLINE';s.className='bad';p.hidden=true;return}
 if(state.moving){s.textContent=state.lock==='nosignal'?'NO SPEED SIGNAL':'CAR MOVING';s.className='bad'}else if(state.paused){s.textContent='PAUSED';s.className=''}else{s.textContent='CONNECTED';s.className='good'}
 n.innerHTML='';if(state.title){var b=document.createElement('b');b.textContent=state.title;n.appendChild(b)}else n.textContent='Pick a game on the BMW screen';
 var allowed=BUTTONS[state.kind]||[],play=player===1?state.controllerMode!=='idrive'&&state.controllerMode!=='hybrid':
  state.players===2&&(state.controllerMode==='phones'||state.controllerMode==='hybrid');
 var enabled=!!state.title&&play&&!state.moving&&!state.paused;
 Array.prototype.forEach.call(document.querySelectorAll('[data-key]'),function(el){
  var key=el.getAttribute('data-key');el.hidden=!play||allowed.indexOf(key)<0;el.disabled=!enabled;
  var sega=state.kind==='sms'||state.kind==='gg';
  if(key==='a'||key==='b')el.textContent=state.kind==='a26'?'FIRE':
    sega?(key==='a'?'1':'2'):state.kind==='pce'?(key==='a'?'I':'II'):
    state.kind==='a78'?(key==='a'?'2':'1'):key.toUpperCase();
  if(key==='start')el.textContent=state.kind==='sms'||state.kind==='a78'?'PAUSE':
    state.kind==='a26'?'RESET':state.kind==='pce'?'RUN':state.kind==='ngp'?'OPTION':'START';
  if(key==='x')el.textContent=state.kind==='a78'?'RESET':'X';
  if(key==='y')el.textContent='Y';
  if(key==='l'||key==='r')el.textContent=key.toUpperCase();
  if(state.kind==='ps1'){
   var labels={a:'✕',b:'○',x:'△',y:'□',l:'L1',r:'R1'};
   if(labels[key])el.textContent=labels[key]
  }});
 $('pad').classList.toggle('playstation',state.kind==='ps1');
 $('secondpad').hidden=!play||allowed.indexOf('rUp')<0;
 $('dpad').hidden=!play||allowed.indexOf('up')<0;$('hexpad').hidden=!play||state.kind!=='chip8';
 $('actions').hidden=!play||allowed.indexOf('a')<0;
 $('mid').hidden=!play||allowed.indexOf('start')<0&&allowed.indexOf('select')<0;
 $('gameMenu').hidden=!state.title||!play||!state.gameMenu;
 p.hidden=!state.title||!play;p.textContent=state.paused?'Resume':'Pause'}
function connect(){ws=new WebSocket('ws://'+location.host+'/?t='+encodeURIComponent(token)+'&p='+player);
 ws.onopen=function(){release();clearInterval(timer);timer=setInterval(sendKeys,400);show()};
 ws.onmessage=function(e){try{var m=JSON.parse(e.data);if(m.type==='state'){if(state.kind!==m.kind||state.title!==m.title||m.paused||m.moving||state.controllerMode!==m.controllerMode)release();state=m;show()}}catch(_){}};
 ws.onclose=function(){clearInterval(timer);release();show();setTimeout(connect,1500)};
 ws.onerror=function(){};}
// Buttons: each follows its own finger (several at once).
Array.prototype.forEach.call(document.querySelectorAll('[data-key]'),function(b){var k=b.getAttribute('data-key');
 function on(e){e.preventDefault();try{b.setPointerCapture(e.pointerId)}catch(_){}b.classList.add('down');setKey(k,true)}
 function off(){b.classList.remove('down');setKey(k,false)}
 b.addEventListener('pointerdown',on);b.addEventListener('pointerup',off);b.addEventListener('pointercancel',off);b.addEventListener('lostpointercapture',off);
 b.addEventListener('contextmenu',function(e){e.preventDefault()})});
// D-pad: one touch area, direction from the thumb's position (8 ways, small dead zone).
(function(){var pad=$('dpad'),id=null,dirs=['up','down','left','right'];
 function apply(set){dirs.forEach(function(d){var v=set.indexOf(d)>=0;$('g-'+d).classList.toggle('on',v);setKey(d,v)})}
 function at(e){if(state.paused||state.moving)return [];var r=pad.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5,s=[];
  if(Math.sqrt(x*x+y*y)<.1)return s;var a=Math.atan2(y,x)*180/Math.PI;
  if(a>-157.5&&a<-22.5)s.push('up');if(a>22.5&&a<157.5)s.push('down');if(a>112.5||a<-112.5)s.push('left');if(a>-67.5&&a<67.5)s.push('right');return s}
 pad.addEventListener('pointerdown',function(e){e.preventDefault();id=e.pointerId;try{pad.setPointerCapture(id)}catch(_){}apply(at(e))});
 pad.addEventListener('pointermove',function(e){if(e.pointerId===id)apply(at(e))});
 function end(e){if(e.pointerId===id){id=null;apply([])}}
 pad.addEventListener('pointerup',end);pad.addEventListener('pointercancel',end);pad.addEventListener('lostpointercapture',end)})();
window.addEventListener('blur',release);document.addEventListener('visibilitychange',function(){if(document.hidden)release()});
$('gameMenu').addEventListener('click',function(){send({type:'gameMenu'})});
$('pause').addEventListener('click',function(){send({type:state.paused?'resume':'pause'})});
// Games panel: list, delete, upload.
function size(n){return n>=1048576?(n/1048576).toFixed(1)+' MB':Math.max(1,Math.round(n/1024))+' KB'}
function load(){fetch(api('/roms')).then(function(r){if(!r.ok)throw Error('HTTP '+r.status);return r.json()}).then(render).catch(function(e){
 var l=$('list'),f=$('upload');l.innerHTML='';var d=document.createElement('div');d.className='empty';d.textContent='Cannot load the list: '+e.message;l.appendChild(d);l.appendChild(f)})}
function render(data){var l=$('list'),f=$('upload');l.innerHTML='';
 Object.keys(NAMES).forEach(function(kind){var games=(data.games||{})[kind]||[],h=document.createElement('div');h.className='sec';h.textContent=NAMES[kind]+' \\u00b7 '+games.length;l.appendChild(h);
  if(!games.length){var e=document.createElement('div');e.className='empty';e.textContent='No games yet.';l.appendChild(e)}
  games.forEach(function(g){var r=document.createElement('div');r.className='row';var t=document.createElement('div');t.className='t';t.textContent=g.title;
   var m=document.createElement('div');m.className='m';m.textContent=size(g.size)+(g.saved?' \\u00b7 save':'');t.appendChild(m);
   var d=document.createElement('button');d.className='del';d.textContent='Delete';d.onclick=function(){
    if(!confirm('Delete '+g.title+' from the car?'))return;
    fetch(api('/delete?platform='+kind+'&name='+encodeURIComponent(g.name)),{method:'POST'}).then(function(r){return r.text().then(function(t){if(!r.ok)throw Error(t)})}).then(load).catch(function(e){alert(e.message)})};
   r.appendChild(t);r.appendChild(d);l.appendChild(r)})});
 l.appendChild(f)}
function upload(file,kind,replace){var res=$('result');res.textContent='Uploading\\u2026';
 return fetch(api('/rom?platform='+kind+'&name='+encodeURIComponent(file.name)+(replace?'&replace=1':'')),{method:'POST',body:file}).then(function(r){return r.text().then(function(t){
  if(r.status===409&&!replace&&t.indexOf('already exists')>=0){if(confirm('A game with this name is already on the car. Replace it?'))return upload(file,kind,true);res.textContent='Not uploaded.';return}
  if(!r.ok)throw Error(t);res.textContent=t;load()})}).catch(function(e){res.textContent=e.message})}
$('upload').addEventListener('submit',function(e){e.preventDefault();var file=$('rom').files[0];if(!file)return;
 var ext=(file.name.split('.').pop()||'').toLowerCase(),kind=EXT[ext];if(!kind){$('result').textContent='Unsupported file type .'+ext;return}upload(file,kind,false)});
$('open').addEventListener('click',function(){release();$('games').className='open';load()});
$('close').addEventListener('click',function(){$('games').className=''});
$('refresh').addEventListener('click',load);
$('log').addEventListener('click',function(){
 fetch(api('/diagnostics')).then(function(r){if(!r.ok)throw Error('HTTP '+r.status);return r.text()}).then(function(t){
  $('diag-log').value=t;$('diag-log').hidden=false;$('export').href=api('/diagnostics?download=1');$('export').hidden=false;
 }).catch(function(e){$('diag-log').value=e.message;$('diag-log').hidden=false})
});
show();connect();
})();
</script></body></html>`;

module.exports = HTML;
