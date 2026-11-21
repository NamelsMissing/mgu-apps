'use strict';
/*
 * G80-inspired 1920x720 instrument scene. Not an OEM BMW asset/skin.
 * IMPORTANT: the central map window is transparent; this shader must never
 * be presented as a verified substitute for speed, gear or warning displays.
 */
module.exports = `#version 100
precision highp float;
varying vec2 v_uv;
uniform vec4 u_values;    // speed, rpm, oil, coolant
uniform vec4 u_accent;    // selected tint
uniform vec4 u_options;   // always-open map window, gear, spare, OEM-style variant

float rect(vec2 p, vec2 c, vec2 halfSize) {
  vec2 d=abs(p-c)-halfSize;
  return 1.0-smoothstep(-1.8,1.8,max(d.x,d.y));
}
float ring(vec2 p,vec2 c,float radius,float width) {
  return 1.0-smoothstep(width-1.2,width+1.2,abs(length(p-c)-radius));
}
float segment(vec2 p,vec2 c,vec2 h) { return rect(p,c,h); }
float digit(vec2 p,float n) {
  float a=float(n!=1.0 && n!=4.0);
  float b=float(n!=5.0 && n!=6.0);
  float c=float(n!=2.0);
  float d=float(n!=1.0 && n!=4.0 && n!=7.0);
  float e=float(n==0.0 || n==2.0 || n==6.0 || n==8.0);
  float f=float(n!=1.0 && n!=2.0 && n!=3.0 && n!=7.0);
  float g=float(n!=0.0 && n!=1.0 && n!=7.0);
  float v=0.0;
  v=max(v,a*segment(p,vec2(14.,3.),vec2(10.,2.4)));
  v=max(v,b*segment(p,vec2(26.,15.),vec2(2.4,9.6)));
  v=max(v,c*segment(p,vec2(26.,39.),vec2(2.4,9.6)));
  v=max(v,d*segment(p,vec2(14.,51.),vec2(10.,2.4)));
  v=max(v,e*segment(p,vec2(2.,39.),vec2(2.4,9.6)));
  v=max(v,f*segment(p,vec2(2.,15.),vec2(2.4,9.6)));
  v=max(v,g*segment(p,vec2(14.,27.),vec2(10.,2.4)));
  return v;
}
float numeral(vec2 p,float value,float count,float scale) {
  vec2 q=p/scale;
  float n=clamp(floor(value+0.5),0.,9999.);
  float v=0.;
  for(int i=0;i<4;i++) {
    float pos=float(i);
    if(pos<count) {
      float power=pow(10.,count-pos-1.);
      if(pos==count-1. || n>=power)
        v=max(v,digit(q-vec2(pos*35.,0.),mod(floor(n/power),10.)));
    }
  }
  return v;
}
void main(){
  vec2 p=vec2(v_uv.x*1920.,v_uv.y*720.);
  float oem=step(0.5,u_options.w);
  vec3 bg=mix(vec3(0.007,0.014,0.028),vec3(0.009,0.012,0.017),oem);
  vec3 white=vec3(0.91,0.95,1.0);
  vec3 blue=u_accent.rgb;
  float shade=1.-0.35*length((p-vec2(960.,360.))/vec2(1100.,720.));
  vec3 color=bg*shade;
  float alpha=1.;

  // G80-inspired inward-canted twin dials. Native OEM telltales remain above
  // the panel slot; the factory gauges below are covered only in parked test.
  vec2 left=vec2(364.,370.), right=vec2(1556.,370.);
  vec2 ql=p-left, qr=p-right;
  float al=atan(ql.y,ql.x);
  float ar=atan(qr.y,qr.x);
  float angleL=mod(al+6.2831853,6.2831853);
  float angleR=mod(ar+6.2831853,6.2831853);
  float speed=clamp(u_values.x/260.,0.,1.);
  float rpm=clamp(u_values.y/5000.,0.,1.);
  float track=max(ring(p,left,258.,mix(3.1,2.0,oem)),ring(p,right,258.,mix(3.1,2.0,oem)));
  color=mix(color,mix(vec3(.11,.16,.25),vec3(.13,.14,.16),oem),track*.85);
  float progressL=step(0.22,angleL)*step(angleL,0.22+speed*5.65);
  float progressR=step(0.22,angleR)*step(angleR,0.22+rpm*5.65);
  float progress=max(ring(p,left,253.,mix(9.,5.,oem))*progressL,ring(p,right,253.,mix(9.,5.,oem))*progressR);
  color=mix(color,blue,progress*.97);
  for(int i=0;i<31;i++){
    float a=0.22+float(i)*5.65/30.;
    vec2 ray=vec2(cos(a),sin(a));
    float major=1.-step(0.5,mod(float(i),5.));
    vec2 tickL=left+ray*245.;
    vec2 tickR=right+ray*245.;
    float t=max(rect(p,tickL,vec2(major*5.+1.5,major*5.+1.5)),
                rect(p,tickR,vec2(major*5.+1.5,major*5.+1.5)));
    color=mix(color,white,t*(major*.62+.16));
  }

  // Main readouts are supplied only from actual SOME/IP values.
  float sp=numeral(p-vec2(250.,330.),u_values.x,3.,1.48);
  float rev=numeral(p-vec2(1432.,330.),u_values.y/1000.,2.,1.45);
  color=mix(color,white,clamp(max(sp,rev),0.,1.));
  float bottom=rect(p,vec2(960.,665.),vec2(910.,1.4));
  color=mix(color,blue,bottom*.55);
  // M signature bars: original abstract decoration, no copied BMW mark.
  float bars=0.;
  bars=max(bars,rect(p,vec2(88.,93.),vec2(8.,27.)));
  bars=max(bars,rect(p,vec2(109.,93.),vec2(8.,27.)));
  bars=max(bars,rect(p,vec2(130.,93.),vec2(8.,27.)));
  color=mix(color,blue,bars*(1.-oem));

  // OEM-inspired alternative: finer coloured shoulders and discreet lower
  // highlight. This is original shader artwork, not a BMW firmware recolor.
  float shoulders=max(ring(p,left,262.,1.8),ring(p,right,262.,1.8));
  color=mix(color,blue,shoulders*oem*.40);

  // The central native-map view stays transparent in EVERY colour and layout,
  // including Waze OFF. The BMW map can show below if the OEM slot is mapped.
  // Concurrent panel+map remains CAR-ONLY (not verified on this G21).
  float window=rect(p,vec2(960.,347.),vec2(334.,231.));
  alpha*=1.-window;
  float edge=rect(p,vec2(960.,347.),vec2(338.,235.))-window;
  color=mix(color,blue,clamp(edge,0.,1.)*.32);
  alpha=max(alpha,clamp(edge,0.,1.));
  gl_FragColor=vec4(color,clamp(alpha,0.,1.));
}`;
