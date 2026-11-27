'use strict';
/**
 * Start-up intro for the parked KOMBI layouts (0.7.0). Original artwork,
 * drawn entirely by one GPU effect: no textures, no third-party images.
 *
 * Sequence (seconds, u_t driven by the app ~30 Hz):
 *   0.00-0.55  a row of small sparkles twinkles near the top
 *   0.45-0.95  they gather into one magenta sparkle
 *   0.85-1.85  the sparkle bursts into a radiant fan of light
 *   1.70-4.80  montage of three original scenes, slow zoom, crossfades:
 *              synthwave sunset, neon grid, ocean night
 *   4.60-5.40  dissolve into a violet haze, then black
 *   5.20-6.60  the layout's own dial contours draw themselves in white,
 *              a glowing emblem (rounded frame + sparkle) pops up in the
 *              centre, magenta turning white
 *   6.70-7.30  the intro fades out over the layout (its needles sweep)
 *
 * Area: x 8..1912, y 48..596 - the top telltale row and the bottom strip stay
 * free. While it plays, the centre (Waze / lyrics / BMW map) is covered;
 * afterwards the layer is dropped. Coordinates are normalised (fp16-safe).
 */
const RECT = { x: 8, y: 48, w: 1904, h: 548 };
const DURATION_MS = 7300;
const SWEEP_AT_MS = 6400;        // needle sweep starts under the fade-out
const ASPECT = RECT.w / RECT.h;
const glsl = (n) => { const s = (Math.round(n * 100000) / 100000).toString(); return /[.e]/.test(s) ? s : s + '.0'; };

/** Panel pixel -> intro coordinates (y down, centred, units of height). */
function toIntro(x, y) { return [((x - RECT.x) / RECT.w - 0.5) * ASPECT, (y - RECT.y) / RECT.h - 0.5]; }

/**
 * outlines: arrays of panel-pixel points [[x,y],...] (one polyline per
 * dial). They are revealed one after another along their length.
 */
function introShader(outlines) {
    const segs = [];
    (outlines || []).forEach((pts) => {
        const p = pts.map((q) => toIntro(q[0], q[1]));
        let total = 0; const len = [];
        for (let i = 1; i < p.length; i++) { const l = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); len.push(l); total += l; }
        let acc = 0;
        for (let i = 1; i < p.length; i++) {
            segs.push('  seg(p,vec2(' + glsl(p[i - 1][0]) + ',' + glsl(p[i - 1][1]) + '),vec2(' + glsl(p[i][0]) + ',' +
                glsl(p[i][1]) + '),' + glsl(acc / total) + ',' + glsl((acc + len[i - 1]) / total) + ',rev);');
            acc += len[i - 1];
        }
    });
    return `#version 100
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform float u_t;
uniform vec4 u_accent;
float lineD;
float lineOn;
float win(float t,float a,float b,float c,float d){return smoothstep(a,b,t)*(1.0-smoothstep(c,d,t));}
float ease(float x){x=clamp(x,0.0,1.0);return x*x*(3.0-2.0*x);}
float sparkle(vec2 q,float s){
  q/=s;
  float r=length(q);
  float core=exp(-r*r*6.0);
  float rays=exp(-abs(q.x)*7.0)*exp(-abs(q.y)*0.9)+exp(-abs(q.y)*7.0)*exp(-abs(q.x)*0.9);
  return core+rays*0.75;
}
void seg(vec2 p,vec2 a,vec2 b,float t0,float t1,float rev){
  vec2 ab=b-a;
  float k=clamp(dot(p-a,ab)/dot(ab,ab),0.0,1.0);
  float d=length(p-(a+ab*k));
  float t=mix(t0,t1,k);
  if(d<lineD){lineD=d;lineOn=step(t,rev);}
}
vec3 sunset(vec2 p,float t){
  float h=0.14;
  vec3 c=mix(vec3(0.16,0.04,0.30),vec3(0.96,0.36,0.56),smoothstep(-0.5,0.02,p.y));
  c=mix(c,vec3(1.0,0.63,0.30),smoothstep(-0.04,h,p.y));
  vec2 sc=vec2(0.35,-0.10);
  float d=length(p-sc);
  float yy=p.y-sc.y;
  float cut=yy<0.0?1.0:step(clamp(0.1+yy*2.4,0.1,0.85),fract(yy*15.0-t*0.6));
  vec3 sun=mix(vec3(1.0,0.92,0.45),vec3(1.0,0.30,0.55),smoothstep(-0.3,0.25,p.y-sc.y));
  c=mix(c,sun,(1.0-smoothstep(0.29,0.3,d))*cut);
  c+=vec3(1.0,0.45,0.4)*exp(-d*4.0)*0.25;
  float hill=h-0.05-0.035*sin(p.x*2.3+0.8)-0.02*sin(p.x*6.1);
  vec3 g=vec3(0.07,0.02,0.11);
  float refl=(1.0-smoothstep(0.0,0.45,abs(p.x-sc.x)))*step(0.55,fract((p.y-h)*34.0))*(1.0-smoothstep(h,0.5,p.y));
  g+=vec3(1.0,0.45,0.5)*refl*0.35;
  c=mix(c,vec3(0.10,0.03,0.16),step(hill,p.y)*(1.0-step(h,p.y)));
  return mix(c,g,step(h,p.y));
}
vec3 grid(vec2 p,float t){
  vec3 c=mix(vec3(0.02,0.02,0.09),vec3(0.36,0.06,0.42),smoothstep(-0.5,0.0,p.y));
  float st=step(0.995,sin(p.x*97.0)*sin(p.y*131.0+1.7));
  c+=vec3(0.8)*st*(1.0-smoothstep(-0.3,0.0,p.y));
  float mtn=-0.02-0.06*abs(sin(p.x*1.7))-0.03*abs(sin(p.x*4.3+1.0));
  c=mix(c,vec3(0.05,0.0,0.10),step(mtn,p.y));
  c+=vec3(1.0,0.2,0.8)*exp(-abs(p.y)*30.0)*0.7;
  if(p.y>0.0){
    float z=0.16/(p.y+0.004);
    float gx=abs(fract(p.x*z*3.0)-0.5);
    float gz=abs(fract(z*1.6+t*1.4)-0.5);
    float fade=smoothstep(0.0,0.2,p.y);
    float w=0.035+0.05*(1.0-fade);
    c=vec3(0.03,0.0,0.08)+vec3(0.1,0.9,1.0)*(1.0-smoothstep(0.0,w,gx))*fade+vec3(1.0,0.2,0.85)*(1.0-smoothstep(0.0,w,gz))*fade;
    c+=vec3(1.0,0.2,0.8)*exp(-p.y*25.0)*0.5;
  }
  return c;
}
vec3 ocean(vec2 p,float t){
  float h=0.06;
  vec3 c=mix(vec3(0.03,0.10,0.22),vec3(0.20,0.55,0.66),smoothstep(-0.5,h,p.y));
  vec2 mc=vec2(-0.95,-0.22);
  float d=length(p-mc);
  c=mix(c,vec3(0.96,0.97,0.9),1.0-smoothstep(0.085,0.09,d));
  c+=vec3(0.6,0.8,0.9)*exp(-d*5.0)*0.3;
  if(p.y>h){
    float w=sin(p.x*7.0+t*1.6+sin(p.y*28.0)*1.2)*0.5+0.5;
    vec3 s=mix(vec3(0.01,0.08,0.14),vec3(0.04,0.28,0.36),w*smoothstep(0.5,h,p.y));
    float glint=exp(-abs(p.x-mc.x)*5.0)*step(0.75,sin(p.y*110.0+p.x*13.0+t*5.0))*(1.0-smoothstep(h,0.45,p.y));
    c=s+vec3(0.9,0.95,1.0)*glint*0.8;
  }
  return c;
}
void main(){
  vec2 p=(v_uv-vec2(0.5))*vec2(${glsl(ASPECT)},1.0);
  float t=u_t;
  vec3 col=vec3(0.0);
  // 1. row of sparkles, 2. gathering into one
  float gather=ease((t-0.45)/0.45);
  float rowA=win(t,0.05,0.2,0.85,0.95);
  for(int i=0;i<7;i++){
    float fi=float(i)-3.0;
    vec2 c=vec2(fi*0.075*(1.0-gather),-0.30);
    float tw=0.75+0.25*sin(t*14.0+fi*1.9);
    col+=vec3(1.0,mix(1.0,0.45,gather),mix(1.0,0.85,gather))*sparkle(p-c,mix(0.012,0.016,gather)*tw)*rowA*(1.0-gather*0.86);
  }
  float one=win(t,0.6,0.75,0.9,1.15);
  col+=vec3(1.0,0.35,0.8)*sparkle(p-vec2(0.0,-0.30),0.03+0.02*one)*one*1.4;
  // 3. radiant burst
  float b=ease((t-0.85)/0.5);
  float burstA=win(t,0.85,1.0,1.65,1.95);
  vec2 q=p-vec2(0.0,mix(-0.30,-0.05,b));
  float r=length(q);
  float ang=atan(q.y,q.x);
  float fan=pow(abs(sin(ang*9.0+t*0.8)),6.0)*(1.0-smoothstep(0.0,1.6*b+0.05,r));
  vec3 burst=mix(vec3(1.0,0.3,0.78),vec3(0.45,0.3,1.0),smoothstep(0.0,1.2,r));
  col+=(burst*(fan*0.9+exp(-r*3.0/(b+0.05))*1.1)+vec3(1.0,0.9,0.95)*sparkle(q,0.06*b+0.02))*burstA;
  // 4. montage of three scenes with slow zoom
  float m=t-1.7;
  float wA=win(m,0.0,0.3,0.95,1.2);
  float wB=win(m,0.95,1.2,1.95,2.2);
  float wC=win(m,1.95,2.2,3.0,3.2);
  if(wA>0.0) col=mix(col,sunset(p*(1.0-0.05*m),m),wA);
  if(wB>0.0) col=mix(col,grid(p*(1.0-0.04*(m-1.0))+vec2(0.0,0.02),m),wB);
  if(wC>0.0) col=mix(col,ocean(p*(1.0-0.05*(m-2.0)),m),wC);
  // 5. violet haze, then black
  float haze=win(t,4.55,4.85,5.05,5.4);
  vec3 hz=vec3(0.55,0.22,0.72)*(0.75+0.25*sin(p.x*2.5+t*1.5))+vec3(0.9,0.5,0.8)*exp(-length(p)*1.5)*0.5;
  col=mix(col,hz,haze);
  col*=1.0-smoothstep(5.05,5.4,t)*(1.0-haze);
  // 6. dial contours draw in, emblem pops up
  float rev=ease((t-5.2)/0.8);
  lineD=9.0; lineOn=0.0;
${segs.join('\n')}
  float cont=step(5.2,t)*lineOn;
  float lineA=(1.0-smoothstep(0.0022,0.0042,lineD))+exp(-lineD*70.0)*0.35;
  col+=mix(vec3(0.9,0.95,1.0),u_accent.rgb,0.15)*lineA*cont;
  float e=ease((t-5.45)/0.35);
  float eA=step(5.45,t);
  vec2 eq=(p-vec2(0.0,-0.02))/(0.6+0.4*e);
  float bd=length(max(abs(eq)-vec2(0.075),0.0))-0.035;
  vec3 ec=mix(vec3(1.0,0.28,0.72),vec3(0.96,0.97,1.0),ease((t-6.0)/0.4));
  float frame=(1.0-smoothstep(0.0035,0.0065,abs(bd)))+exp(-abs(bd)*45.0)*0.45;
  col+=ec*(frame+sparkle(eq,0.035)*0.9)*e*eA;
  float alpha=smoothstep(0.0,0.15,t)*(1.0-smoothstep(6.7,7.3,t));
  gl_FragColor=vec4(min(col,vec3(1.0)),alpha);
}`;
}
module.exports = { introShader, toIntro, RECT, DURATION_MS, SWEEP_AT_MS, ASPECT };
