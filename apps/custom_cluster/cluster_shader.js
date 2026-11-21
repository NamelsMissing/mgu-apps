'use strict';
// Center-slot visual design. Fully transparent outside the instruments: Waze keeps its
// own video layer below us. GLSL ES 1.00; no cluster firmware or CarPlay patch writes.
module.exports = `#version 100
precision highp float;
varying vec2 v_uv;
uniform vec4 u_values;  // speed km/h, rpm, oil C, coolant C
uniform vec4 u_style;   // layout (1 sport, 2 classic, 3 minimal), live, spare, spare
uniform vec4 u_accent;

float box(vec2 p, vec2 c, vec2 h) {
  vec2 d = abs(p - c) - h;
  return 1.0 - smoothstep(-1.0, 1.0, max(d.x, d.y));
}
float ring(vec2 p, vec2 c, float r, float w) {
  float d = abs(length(p-c)-r);
  return 1.0-smoothstep(w-1.3,w+1.3,d);
}
float disk(vec2 p, vec2 c, float r) {
  return 1.0-smoothstep(r-1.5,r+1.5,length(p-c));
}
float seg(vec2 p, vec2 c, vec2 h) { return box(p,c,h); }
float digit(vec2 p, float n) {
  // 28x54-pixel seven-segment display, n=0..9.
  float a = float(n!=1.0 && n!=4.0);
  float b = float(n!=5.0 && n!=6.0);
  float c = float(n!=2.0);
  float d = float(n!=1.0 && n!=4.0 && n!=7.0);
  float e = float(n==0.0 || n==2.0 || n==6.0 || n==8.0);
  float f = float(n!=1.0 && n!=2.0 && n!=3.0 && n!=7.0);
  float g = float(n!=0.0 && n!=1.0 && n!=7.0);
  float v=0.0;
  v=max(v,a*seg(p,vec2(14.0,3.0),vec2(9.5,2.1)));
  v=max(v,b*seg(p,vec2(26.0,15.0),vec2(2.1,9.5)));
  v=max(v,c*seg(p,vec2(26.0,39.0),vec2(2.1,9.5)));
  v=max(v,d*seg(p,vec2(14.0,51.0),vec2(9.5,2.1)));
  v=max(v,e*seg(p,vec2(2.0,39.0),vec2(2.1,9.5)));
  v=max(v,f*seg(p,vec2(2.0,15.0),vec2(2.1,9.5)));
  v=max(v,g*seg(p,vec2(14.0,27.0),vec2(9.5,2.1)));
  return v;
}
float numberAt(vec2 p, float value, float count, float scale) {
  float n=clamp(floor(value+0.5),0.0,9999.0);
  vec2 q=p/scale;
  float a=0.0;
  for(int i=0;i<4;i++) {
    float pos=float(i);
    if(pos<count) {
      float power=pow(10.0,count-pos-1.0);
      if(pos==count-1.0 || n>=power)
        a=max(a,digit(q-vec2(pos*35.0,0.0),mod(floor(n/power),10.0)));
    }
  }
  return a;
}
void main() {
  vec2 p=vec2(v_uv.x*1088.0,v_uv.y*480.0);
  float mode=u_style.x;
  vec3 ink=vec3(0.90,0.94,0.99), accent=u_accent.rgb;
  vec4 outc=vec4(0.0);
  float deco=0.0, bg=0.0, bright=0.0;
  if(mode<1.5) { // M Sport: narrow strips above/below the map
    bg=max(box(p,vec2(544.0,29.0),vec2(520.0,26.0))*0.73,
           box(p,vec2(544.0,441.0),vec2(520.0,34.0))*0.75);
    float rpm=clamp(u_values.y/5000.0,0.0,1.0);
    for(int i=0;i<24;i++) {
      float x=88.0+float(i)*37.5;
      float cell=box(p,vec2(x,29.0),vec2(14.0,8.0));
      deco=max(deco,cell*(step(float(i)/24.0,rpm)*0.98+0.14));
    }
    bright=max(numberAt(p-vec2(210.0,409.0),u_values.x,3.0,0.95),
               numberAt(p-vec2(732.0,409.0),u_values.y,4.0,0.95));
  } else if(mode<2.5) { // Classic: two transparent ring instruments
    vec2 l=vec2(208.0,238.0), r=vec2(880.0,238.0);
    bg=max(disk(p,l,175.0),disk(p,r,175.0))*0.72;
    float speed=clamp(u_values.x/260.0,0.0,1.0);
    float rpm=clamp(u_values.y/5000.0,0.0,1.0);
    vec2 vl=p-l,vr=p-r;
    float al=mod(atan(vl.y,vl.x)+6.2831853,6.2831853);
    float ar=mod(atan(vr.y,vr.x)+6.2831853,6.2831853);
    // Progress around the dial; map remains visible in the space between.
    deco=max(ring(p,l,154.0,5.0)*(0.18+0.82*step(al/6.2831853,speed)),
             ring(p,r,154.0,5.0)*(0.18+0.82*step(ar/6.2831853,rpm)));
    bright=max(numberAt(p-vec2(155.0,208.0),u_values.x,3.0,1.0),
               numberAt(p-vec2(826.0,208.0),u_values.y,4.0,0.77));
  } else { // Minimal: leave almost all of the map visible
    bg=max(box(p,vec2(158.0,432.0),vec2(145.0,41.0)),
           box(p,vec2(918.0,432.0),vec2(152.0,41.0)))*0.72;
    bright=max(numberAt(p-vec2(65.0,407.0),u_values.x,3.0,0.95),
               numberAt(p-vec2(829.0,407.0),u_values.y,4.0,0.75));
    deco=max(box(p,vec2(190.0,399.0),vec2(60.0,1.5)),
             box(p,vec2(927.0,399.0),vec2(60.0,1.5)));
  }
  outc=vec4(vec3(0.015,0.025,0.045),bg);
  float inkA=clamp(bright,0.0,1.0);
  outc.rgb=mix(outc.rgb,ink,inkA);
  outc.a=max(outc.a,inkA);
  float decoA=clamp(deco,0.0,1.0);
  outc.rgb=mix(outc.rgb,accent,decoA);
  outc.a=max(outc.a,decoA);
  // Keep the native map's 504x368 guidance-safe area fully unobstructed.
  // This applies to Sport, Classic and Minimal, regardless of accent colour.
  float mapSafe=box(p,vec2(538.0,256.0),vec2(252.0,184.0));
  outc.a*=1.0-mapSafe;
  gl_FragColor=outc;
}`;
