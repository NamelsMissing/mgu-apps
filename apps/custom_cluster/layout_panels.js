'use strict';
/*
 * Bounded side-instrument artwork for stationary tests. These are original
 * recreations, not BMW resources or native KOMBI palette edits.
 *
 * Per side (0.6.7):
 *   1. optional opaque cover plate over the original BMW dial area
 *      (x 8..412 / 1508..1912, y 48..596; centre map aperture and bottom
 *      strip stay free),
 *   2. one static 256-square face texture,
 *   3. one small changing readout texture (value, unit, gear or temperatures),
 *   4. one GPU progress effect lighting the scale up to the live value
 *      (not for Minimal).
 * At most eight layers in total. Only changed values are uploaded.
 */
const SIZE=256, DRAW=320, READ_W=160, READ_H=96;
// Inside the scale contour, above its start (tex y 78..160, x 60..196).
const READ_BOX={dx:75,dy:98,w:170,h:102};
const SIDES=[{key:'speed',x:88,y:190,max:260,unit:'km/h'},
    {key:'rpm',x:1512,y:190,max:6000,unit:'x1000 rpm'}];
// Cover plates: as large as possible without entering the nominal centre
// map aperture (x 416..1504), the top telltale row (y < 48) or the bottom
// strip (y >= 600). The real OEM telltale positions remain unverified.
const COVERS=[{x:8,y:48,w:404,h:548,inner:'right'},{x:1508,y:48,w:404,h:548,inner:'left'}];
const COVER_RGB=[0.039,0.063,0.094];
const NAMES={oem:'G21 RECREATION',g80:'G80 INSPIRED',sport:'M SPORT',classic:'CLASSIC',minimal:'MINIMAL'};
const DOT_FS=`#version 100
precision mediump float;
varying vec2 v_uv;
uniform vec4 u_color;
void main(){
  float a=1.0-smoothstep(0.36,0.48,length(v_uv-vec2(0.5)));
  gl_FragColor=vec4(u_color.rgb,a);
}`;
// Opaque plate with rounded corners. The edge facing the map fades out over
// 28 px so the map window is not framed by a hard black line.
// All shader maths stays in normalised units: KOMBI GPUs may implement
// mediump as fp16, where squared pixel distances would overflow.
function coverShader(inner){
    const fade=inner==='right'?'1.0-smoothstep(3.76,4.04,p.x)':'smoothstep(0.0,0.28,p.x)';
    return `#version 100
precision mediump float;
varying vec2 v_uv;
uniform vec4 u_color;
void main(){
  vec2 p=v_uv*vec2(4.04,5.48);
  vec2 q=abs(p-vec2(2.02,2.74))-vec2(1.76,2.48);
  float d=length(max(q,0.0))-0.26;
  float a=(1.0-smoothstep(-0.02,0.0,d))*(${fade});
  float shade=0.82+0.18*(1.0-v_uv.y);
  gl_FragColor=vec4(u_color.rgb*shade,a*u_color.a);
}`;
}
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const valid=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
const valueOf=(side,data)=>valid(data[side.key])?data[side.key]:null;
const radial=(f,r)=>{const a=(-145+290*f)*Math.PI/180;r=r||98;return [128+Math.sin(a)*r,128-Math.cos(a)*r];};
const PATHS={
 oem:[[182,220],[91,202],[42,161],[28,105],[67,55],[132,23],[225,13]],
 g80:[[182,218],[87,211],[37,149],[28,74],[84,29],[205,29]],
 sport:[[28,68],[228,68]]
};
// Progress band geometry (texture pixels) per layout.
const BAND={oem:4.2,g80:5.6,sport:8.5,classic:2.6};
const CLASSIC_STEPS=24;
function mirror(p,side){return side.key==='rpm'?[SIZE-p[0],p[1]]:p.slice();}
function path(layout,side){
    if(layout==='classic'){
        const ps=[];for(let i=0;i<=CLASSIC_STEPS;i++)ps.push(radial(i/CLASSIC_STEPS,113.5));
        return ps;
    }
    return PATHS[layout]?PATHS[layout].map(p=>mirror(p,side)):null;
}
function point(layout,side,f) {
    f=clamp(f,0,1);
    if(layout==='classic') return radial(f);
    const ps=PATHS[layout];
    if(!ps)return null;
    const t=f*(ps.length-1),i=Math.min(ps.length-2,Math.floor(t)),a=ps[i],b=ps[i+1],k=t-i;
    return mirror([a[0]+(b[0]-a[0])*k,a[1]+(b[1]-a[1])*k],side);
}
function label(side,n){return side.key==='speed'?String(Math.round(n)):String(Math.round(n/1000));}
function ticks(layout,side){
    if(side.key==='rpm')return [0,1000,2000,3000,4000,5000,6000];
    if(layout==='oem')return [0,20,40,60,100,140,200,260];
    return [0,40,80,120,160,200,240,260];
}
// Approximate positions of the G21 labels as seen on the supplied photo.
// Piecewise interpolation keeps the marker consistent with our own labels.
function fraction(layout,side,v){
    if(layout!=='oem'||side.key!=='speed')return clamp(v/side.max,0,1);
    const a=ticks(layout,side);
    v=clamp(v,0,side.max);
    let i=0;while(i<a.length-2&&v>a[i+1])i++;
    return (i+(v-a[i])/(a[i+1]-a[i]))/(a.length-1);
}
const glsl=n=>{const s=(Math.round(n*100000)/100000).toString();return s.indexOf('.')<0&&s.indexOf('e')<0?s+'.0':s;};
// GPU progress: lights the scale path from 0 up to u_fraction. The path is
// parameterised by segment index, exactly like point(), so labels, preview
// and the KOMBI layer agree. A short white head marks the current value.
function progressShader(layout,side){
    const ps=path(layout,side);
    if(!ps)return null;
    const n=ps.length-1, w=BAND[layout]||4;
    const calls=[];
    for(let i=0;i<n;i++)
        calls.push('  seg(p,vec2('+glsl(ps[i][0]/SIZE)+','+glsl(ps[i][1]/SIZE)+'),vec2('+
            glsl(ps[i+1][0]/SIZE)+','+glsl(ps[i+1][1]/SIZE)+'),'+glsl(i)+');');
    return `#version 100
precision mediump float;
varying vec2 v_uv;
uniform float u_fraction;
uniform vec4 u_color;
float bestD;
float bestT;
void seg(vec2 p,vec2 a,vec2 b,float i){
  vec2 ab=b-a;
  float k=clamp(dot(p-a,ab)/dot(ab,ab),0.0,1.0);
  float d=length(p-(a+ab*k));
  if(d<bestD){bestD=d;bestT=(i+k)/${glsl(n)};}
}
void main(){
  vec2 p=v_uv;
  bestD=99.0;
  bestT=0.0;
${calls.join('\n')}
  float band=1.0-smoothstep(${glsl((w-1)/SIZE)},${glsl((w+0.8)/SIZE)},bestD);
  float f=clamp(u_fraction,0.0,1.0);
  float lit=step(bestT,f)*step(0.002,f);
  float head=lit*(1.0-smoothstep(0.0,0.035,f-bestT));
  gl_FragColor=vec4(mix(u_color.rgb,vec3(0.97),head*0.85),band*lit*u_color.a);
}`;
}
function face(layout,side,accent,Canvas){
    if(!NAMES[layout])throw Error('Unsupported layout '+layout);
    const cv=new Canvas(SIZE,SIZE).clear([0,0,0,0]);
    const white='#e7edf5',dim='#8696a7',bg=layout==='classic'?'#141510':'#0a1018';
    const track='#2b3846',trackHi='#3c4b5c';
    if(layout==='classic'){
        cv.circle(128,128,122,bg);
        cv.arc(128,128,117,121,-145,145,'#49505a');
        // Unlit scale track; the live progress effect lights it in accent.
        cv.arc(128,128,112,115,-145,145,track);
        cv.arc(128,128,76,78,-145,145,'#343b42');
        for(let i=0;i<=26;i++){
            const a=(-145+290*i/26)*Math.PI/180;
            const major=i%Math.round(side.key==='speed'?4:26/6)===0||i===26;
            const x=Math.sin(a),y=-Math.cos(a);
            cv.line(128+x*(major?98:105),128+y*(major?98:105),128+x*110,128+y*110,major?2:1,major?accent:dim);
        }
        ticks(layout,side).forEach(v=>{
            const a=(-145+290*fraction(layout,side,v))*Math.PI/180;
            cv.text(label(side,v),128+Math.sin(a)*83,128-Math.cos(a)*83+4,14,white,{align:'center',literal:true});
        });
    }else if(layout==='oem'||layout==='g80'){
        cv.fillRect(6,6,244,236,bg);
        const ps=PATHS[layout].map(p=>mirror(p,side));
        for(let i=1;i<ps.length;i++){
            const a=ps[i-1],b=ps[i];
            cv.line(a[0],a[1],b[0],b[1],layout==='oem'?12:17,'#1c2631');
            cv.line(a[0],a[1],b[0],b[1],layout==='oem'?7:10,track);
            cv.line(a[0],a[1]-5,b[0],b[1]-5,1.5,white);
        }
        // Minor graduation between the labelled values (G21 shows a finer
        // scale than its labels). Approximate, never an exact OEM geometry.
        const n=layout==='oem'?(ps.length-1)*4:(ps.length-1)*3;
        for(let i=0;i<=n;i++){
            const p=point(layout,side,i/n);
            cv.line(p[0],p[1]-9,p[0],p[1]-6,1,trackHi);
        }
        // Ticks and labels point towards the dial centre, so labels never
        // sit on the lit progress band, whatever the contour direction.
        const c=mirror([140,128],side);
        ticks(layout,side).forEach(v=>{
            const p=point(layout,side,fraction(layout,side,v));
            const dx=c[0]-p[0],dy=c[1]-p[1],len=Math.hypot(dx,dy)||1,nx=dx/len,ny=dy/len;
            cv.line(p[0]+nx*6,p[1]+ny*6,p[0]+nx*13,p[1]+ny*13,1.8,white);
            cv.text(label(side,v),clamp(p[0]+nx*25,16,240),clamp(p[1]+ny*25+5,18,232),14,white,{align:'center',literal:true});
        });
        // Red zone of the rev counter (diesel: from 4500 rpm).
        if(side.key==='rpm'){
            const m=24;
            for(let i=0;i<m;i++){
                const a=point(layout,side,0.75+0.25*i/m),b=point(layout,side,0.75+0.25*(i+1)/m);
                cv.line(a[0],a[1]+6,b[0],b[1]+6,2,'#c8332b');
            }
        }
    }else if(layout==='sport'){
        cv.fillRect(10,30,236,204,bg);
        for(let i=0;i<12;i++)cv.fillRect(28+i*17,61,13,16,i%3===0?trackHi:track);
        // Readout occupies tex y 78..160; label and rule sit below it.
        cv.line(28,172,228,172,2,accent);
        cv.text(side.key==='rpm'?'RPM':'SPEED',128,198,20,white,{align:'center',literal:true});
    }else{
        cv.fillRect(15,58,226,150,bg);
        cv.line(28,68,228,68,3,accent);
        cv.text(side.key==='rpm'?'ENGINE':'SPEED',128,190,19,dim,{align:'center',literal:true});
    }
    cv.text(NAMES[layout]+' / TEST',128,251,11,'#e4bd7a',{align:'center',literal:true});
    return cv;
}
// Secondary live line: selector/gear on the speed side, oil and coolant
// temperature on the rev-counter side. Missing values are shown as '--'.
function gearText(data){
    const s=data.stage;
    if(s==='P'||s==='R'||s==='N')return s;
    if(s==='D'){
        const g=data.gear;
        return typeof g==='number'&&g>=1&&g<=10&&!data.gearGuessed?'D'+g:'D';
    }
    return '--';
}
function tempText(v){return typeof v==='number'&&Number.isFinite(v)&&v>-50&&v<200?String(Math.round(v))+'°':'--';}
function infoText(side,data){
    return side.key==='speed'?gearText(data):'OIL '+tempText(data.oil)+'  H2O '+tempText(data.coolant);
}
function readout(side,data,accent,Canvas){
    // Transparent background: the face behind is already dark, and labels
    // near the readout (Classic 120/3) are not cut by an opaque box.
    const cv=new Canvas(READ_W,READ_H).clear([0,0,0,0]);
    const v=valueOf(side,data);
    const str=v===null?'--':side.key==='speed'?String(Math.round(v)):(v/1000).toFixed(1);
    cv.text(str,80,38,34,'#f1f5fa',{align:'center',font:'num',literal:true});
    cv.text(side.unit,80,55,12,'#aab7c5',{align:'center',literal:true});
    const info=infoText(side,data);
    if(side.key==='speed')cv.text(info,80,82,22,info==='--'?'#6d7b89':accent,{align:'center',font:'bold',literal:true});
    else cv.text(info,80,79,14,'#d3dce6',{align:'center',literal:true});
    cv.fillRect(20,89,120,2,'#394651');
    if(v!==null)cv.fillRect(20,89,Math.round(120*clamp(v/side.max,0,1)),2,accent);
    return cv;
}
function valueKey(side,data){
    const v=valueOf(side,data);if(v===null)throw Error('Invalid live '+side.key);
    return [side.key==='speed'?Math.round(v):Math.round(v/100),Math.round(100*clamp(v/side.max,0,1)),
        infoText(side,data)].join(':');
}
function markerRect(layout,side,v){
    const p=point(layout,side,fraction(layout,side,v));
    return p?{x:side.x+Math.round(p[0]*DRAW/SIZE)-6,
        y:side.y+Math.round(p[1]*DRAW/SIZE)-6,w:12,h:12}:null;
}
function buildLayout(cr,target,data,options,accent,accentHex,track,CanvasOverride){
    const Canvas=CanvasOverride||require('./kit/canvas').Canvas, layout=options.layout;
    if(!NAMES[layout])throw Error('Unsupported panel layout '+layout);
    const cover=options.coverOriginal!==false;
    const parts=[];
    SIDES.forEach((side,i)=>{
        const common={target,klass:'overlay',contend:false,guide_hold:false,visible:false};
        const z=i*4;
        if(cover){
            const c=COVERS[i];
            const plate=cr.effect(Object.assign({},common,{x:c.x,y:c.y,w:c.w,h:c.h,z,fs:coverShader(c.inner)}));
            if(!plate)throw Error(layout+' cover refused');track(plate);
            cr.uniform(plate,'u_color',COVER_RGB.concat([1]));
        }
        const img=face(layout,side,accentHex,Canvas);
        const ref=cr.image(Object.assign({},common,{x:side.x,y:side.y,w:DRAW,h:DRAW,z:z+1,iw:SIZE,ih:SIZE,sampling:'bilinear'}));
        if(!ref)throw Error(layout+' face refused');track(ref);
        if(!cr.pixels(ref,null,Buffer.from(img.d)))throw Error(layout+' face pixels refused');
        const v=valueOf(side,data);if(v===null)throw Error('Invalid live '+side.key);
        let progress=0;
        const fs=progressShader(layout,side);
        if(fs){
            progress=cr.effect(Object.assign({},common,{x:side.x,y:side.y,w:DRAW,h:DRAW,z:z+2,fs}));
            if(!progress)throw Error(layout+' progress refused');
            track(progress);
            cr.uniform(progress,'u_color',accent);
            cr.uniform(progress,'u_fraction',[fraction(layout,side,v)]);
        }
        const read=cr.image(Object.assign({},common,{x:side.x+READ_BOX.dx,y:side.y+READ_BOX.dy,
            w:READ_BOX.w,h:READ_BOX.h,z:z+3,iw:READ_W,ih:READ_H,sampling:'bilinear'}));
        if(!read)throw Error(layout+' readout refused');track(read);
        if(!cr.pixels(read,null,Buffer.from(readout(side,data,accentHex,Canvas).d)))throw Error(layout+' readout pixels refused');
        parts.push({side,layout,read,progress,last:valueKey(side,data),lastValue:v,lastColor:accentHex,Canvas});
    });
    return parts;
}
function updateLayout(cr,parts,data,accent,accentHex){
    parts.forEach(p=>{
        const v=valueOf(p.side,data);if(v===null)throw Error('Invalid live '+p.side.key);
        const k=valueKey(p.side,data);
        if(k!==p.last||accentHex!==p.lastColor){
            if(!cr.pixels(p.read,null,Buffer.from(readout(p.side,data,accentHex,p.Canvas).d)))throw Error('readout update refused');
            p.last=k;
        }
        if(p.progress){
            if(v!==p.lastValue)cr.uniform(p.progress,'u_fraction',[fraction(p.layout,p.side,v)]);
            if(accentHex!==p.lastColor)cr.uniform(p.progress,'u_color',accent);
        }
        p.lastValue=v;p.lastColor=accentHex;
    });
}
// CPU version of the progress effect for the iDrive preview.
function drawProgress(cv,layout,side,f,x,y,scale,color){
    const ps=path(layout,side);
    if(!ps||!(f>0.002))return;
    const n=ps.length-1,t=clamp(f,0,1)*n,w=Math.max(2,(BAND[layout]||4)*2*scale);
    for(let i=0;i<n&&i<t;i++){
        const a=ps[i],b=ps[i+1],k=Math.min(1,t-i);
        const e=[a[0]+(b[0]-a[0])*k,a[1]+(b[1]-a[1])*k];
        cv.line(x+a[0]*scale,y+a[1]*scale,x+e[0]*scale,y+e[1]*scale,w,color);
    }
    const i=Math.min(n-1,Math.floor(t)),k=t-i,a=ps[i],b=ps[i+1];
    cv.circle(x+(a[0]+(b[0]-a[0])*k)*scale,y+(a[1]+(b[1]-a[1])*k)*scale,w*0.6,'#f4f7fa');
}
// Preview uses the same side artwork and readout, not an independent mockup.
let previewCache=null;
function drawLayoutPreview(cv,box,data,options,accentHex,CanvasOverride){
    const Canvas=CanvasOverride||require('./kit/canvas').Canvas;
    const size=Math.min(box.h-64,box.w*.28), cy=box.y+box.h*.53;
    cv.roundRect(box.x,box.y,box.w,box.h,16,'#0a1018');
    cv.text(NAMES[options.layout]+' / HMI PREVIEW',box.x+25,box.y+34,20,'#c0cbd6',{literal:true});
    const cacheKey=options.layout+'|'+accentHex;
    if(!previewCache||previewCache.key!==cacheKey||previewCache.Canvas!==Canvas)
        previewCache={key:cacheKey,Canvas,faces:SIDES.map(side=>face(options.layout,side,accentHex,Canvas))};
    SIDES.forEach((side,i)=>{
        const cx=box.x+box.w*(i===0?.20:.80),x=Math.round(cx-size/2),y=Math.round(cy-size/2);
        const f=previewCache.faces[i];
        cv.drawImage(f.d,SIZE,SIZE,x,y,size,size);
        const v=valueOf(side,data);
        if(v!==null)drawProgress(cv,options.layout,side,fraction(options.layout,side,v),x,y,size/SIZE,accentHex);
        const r=readout(side,data,accentHex,Canvas);
        cv.drawImage(r.d,READ_W,READ_H,x+size*READ_BOX.dx/DRAW,y+size*READ_BOX.dy/DRAW,
            size*READ_BOX.w/DRAW,size*READ_BOX.h/DRAW);
    });
    const mx=box.x+box.w/2, mw=box.w*.25;
    cv.roundRect(mx-mw/2,cy-size*.40,mw,size*.80,8,'#12263a');
    cv.text('BMW / WAZE',mx,cy,22,'#dce7f0',{align:'center',literal:true});
    cv.text('MAP WINDOW',mx,cy+27,16,'#8cabc5',{align:'center',literal:true});
}
module.exports={buildLayout,updateLayout,drawLayoutPreview,drawProgress,face,readout,point,path,markerRect,
    progressShader,coverShader,infoText,gearText,NAMES,SIDES,COVERS,SIZE,DRAW,READ_W,READ_H,ticks,fraction,DOT_FS};
