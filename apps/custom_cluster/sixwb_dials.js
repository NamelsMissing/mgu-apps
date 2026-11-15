'use strict';
// Original 6WB-inspired dial artwork for the *parked* renderer experiment.
// Two small pre-rendered RGBA faces plus two independent GPU needle effects.
// No full-panel shader, no stock takeover, no synthetic driving values.
const SIZE = 256;
const DRAW_SIZE = 320;
const POSITIONS = [
    { key: 'speed', x: 88, y: 190, max: 260, unit: 'km/h' },
    { key: 'rpm', x: 1512, y: 190, max: 5000, unit: 'x1000 rpm' }
];
const NEEDLE_FS = `#version 100
precision mediump float;
varying vec2 v_uv;
uniform float u_fraction;
uniform vec4 u_color;
void main() {
    vec2 p = v_uv - vec2(0.5);
    float a = radians(-145.0 + 290.0 * clamp(u_fraction,0.0,1.0));
    vec2 axis = vec2(sin(a), -cos(a));
    float along = dot(p, axis);
    float side = abs(p.x*axis.y - p.y*axis.x);
    float needle = (1.0-smoothstep(0.005,0.009,side)) *
        smoothstep(-0.035,-0.02,along) * (1.0-smoothstep(0.32,0.34,along));
    float cap = 1.0-smoothstep(0.023,0.029,length(p));
    gl_FragColor = vec4(mix(u_color.rgb,vec3(0.93),cap),max(needle,cap));
}`;

function face(pos, accent, theme, Canvas) {
    const cv = new Canvas(SIZE, SIZE).clear([0,0,0,0]);
    const c = SIZE/2, r = 123;
    const white = '#edf2f7', dim = '#9ba8b4';
    const bg = theme === 'sport' ? '#180d13' : theme === 'eco' ? '#081824' : '#10161e';
    const track = theme === 'sport' ? '#55242b' : theme === 'eco' ? '#214763' : '#3a4652';
    cv.circle(c,c,r,bg);
    cv.arc(c,c,119,122,-145,145,track);
    cv.arc(c,c,116,118,-145,145,accent);
    cv.arc(c,c,84,85,-145,145,'#34414d');
    const steps = pos.key === 'speed' ? 26 : 25;
    for(let i=0;i<=steps;i++) {
        const value = pos.max*i/steps;
        const major = pos.key === 'speed' ? i%4===0 || i===steps : i%5===0;
        const angle = (-145+290*i/steps)*Math.PI/180;
        const sx = Math.sin(angle), sy = -Math.cos(angle);
        const inner=major?101:108;
        cv.line(c+sx*inner,c+sy*inner,c+sx*113,c+sy*113,major?2:1,major?white:dim);
        if(major) {
            const label=pos.key==='speed'?String(Math.round(value)):String(Math.round(value/1000));
            cv.text(label,c+sx*91,c+sy*91+5,15,white,{align:'center',font:'num',literal:true});
        }
    }
    cv.text(pos.unit,c,192,17,dim,{align:'center',literal:true});
    cv.text('TEST',c,214,16,'#e4bd7a',{align:'center',font:'bold',literal:true});
    return Buffer.from(cv.d);
}

function fraction(pos,data) {
    const v=data[pos.key];
    if(typeof v!=='number'||!Number.isFinite(v)||v<0) throw Error('Invalid real '+pos.key);
    return Math.max(0,Math.min(1,v/pos.max));
}

// Track each allocated ref immediately so a partial construction is released.
// Pixel upload is once per face; only scalar needle uniforms are updated.
function buildDials(cr,target,data,options,accent,accentHex,track,CanvasOverride) {
    const Canvas=CanvasOverride || require('./kit/canvas').Canvas;
    const needles=[];
    const cover=options.coverOriginal!==false;
    POSITIONS.forEach((pos,i)=>{
        const pixels=face(pos,accentHex,options.sixwbTheme,Canvas);
        const common={target,klass:'overlay',contend:false,guide_hold:false,
            visible:false,x:pos.x,y:pos.y,w:DRAW_SIZE,h:DRAW_SIZE};
        // Same bounded cover plate as the shared side layouts (0.6.7).
        if(cover){
            const { COVERS, coverShader } = require('./layout_panels.js');
            const c=COVERS[i];
            const plate=cr.effect(Object.assign({},common,{x:c.x,y:c.y,w:c.w,h:c.h,z:i*3,fs:coverShader(c.inner)}));
            if(!plate) throw Error('6WB '+pos.key+' cover refused');
            track(plate);
            cr.uniform(plate,'u_color',[0.039,0.063,0.094,1]);
        }
        const faceRef=cr.image(Object.assign({},common,{z:i*3+1,iw:SIZE,ih:SIZE,sampling:'bilinear'}));
        if(!faceRef) throw Error('6WB '+pos.key+' face refused');
        track(faceRef);
        if(!cr.pixels(faceRef,null,pixels)) throw Error('6WB '+pos.key+' pixels refused');
        const needleRef=cr.effect(Object.assign({},common,{z:i*3+2,fs:NEEDLE_FS}));
        if(!needleRef) throw Error('6WB '+pos.key+' needle refused');
        track(needleRef);
        const v=fraction(pos,data);
        cr.uniform(needleRef,'u_fraction',[v]);
        cr.uniform(needleRef,'u_color',accent);
        needles.push({ref:needleRef,pos,last:v});
    });
    return needles;
}
function updateDials(cr,needles,data) {
    needles.forEach(n=>{
        const v=fraction(n.pos,data);
        if(Math.abs(v-n.last)>0.0001){
            cr.uniform(n.ref,'u_fraction',[v]);
            n.last=v;
        }
    });
}
module.exports={buildDials,updateDials,POSITIONS,SIZE,DRAW_SIZE,NEEDLE_FS,face};
