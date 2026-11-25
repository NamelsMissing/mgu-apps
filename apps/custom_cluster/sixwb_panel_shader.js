'use strict';
/**
 * Original 6WB-inspired artwork for the guarded parked-only 1920x720 panel.
 * Unlike the factory 6WB this is NOT an instrument-cluster firmware skin.
 * The central BMW/Waze map area is kept transparent in every subtheme.
 */
module.exports = `#version 100
precision highp float;
varying vec2 v_uv;
uniform vec4 u_values;   // measured speed, engine rpm, oil, coolant
uniform vec4 u_accent;   // Comfort/Sport/ECO theme or Color Studio RGB
uniform vec4 u_options;  // map aperture, gear, spare, subtheme 0/1/2

float box(vec2 p,vec2 c,vec2 halfSize){
  vec2 d=abs(p-c)-halfSize;
  return 1.-smoothstep(-1.5,1.5,max(d.x,d.y));
}
float ring(vec2 q,float r,float w){
  return 1.-smoothstep(w-1.3,w+1.3,abs(length(q)-r));
}
float digit(vec2 p,float n){
  float a=float(n!=1. && n!=4.);
  float b=float(n!=5. && n!=6.);
  float c=float(n!=2.);
  float d=float(n!=1. && n!=4. && n!=7.);
  float e=float(n==0. || n==2. || n==6. || n==8.);
  float f=float(n!=1. && n!=2. && n!=3. && n!=7.);
  float g=float(n!=0. && n!=1. && n!=7.);
  float v=0.;
  v=max(v,a*box(p,vec2(14.,3.),vec2(10.,2.3)));
  v=max(v,b*box(p,vec2(26.,15.),vec2(2.3,9.5)));
  v=max(v,c*box(p,vec2(26.,39.),vec2(2.3,9.5)));
  v=max(v,d*box(p,vec2(14.,51.),vec2(10.,2.3)));
  v=max(v,e*box(p,vec2(2.,39.),vec2(2.3,9.5)));
  v=max(v,f*box(p,vec2(2.,15.),vec2(2.3,9.5)));
  v=max(v,g*box(p,vec2(14.,27.),vec2(10.,2.3)));
  return v;
}
float numeral(vec2 p,float value,float count,float scale){
  vec2 q=p/scale;
  float n=clamp(floor(value+0.5),0.,9999.);
  float v=0.;
  for(int i=0;i<4;i++){
    float pos=float(i);
    if(pos<count){
      float power=pow(10.,count-pos-1.);
      if(pos==count-1. || n>=power){
        v=max(v,digit(q-vec2(pos*34.,0.),mod(floor(n/power),10.)));
      }
    }
  }
  return v;
}
float tick(vec2 q,vec2 ray,float inR,float outR,float width){
  float longitudinal=dot(q,ray);
  float sideways=abs(q.x*ray.y-q.y*ray.x);
  return (1.-smoothstep(width,width+1.1,sideways)) *
         smoothstep(inR-1.,inR+1.,longitudinal) *
         (1.-smoothstep(outR-1.,outR+1.,longitudinal));
}
void main(){
  vec2 p=v_uv*vec2(1920.,720.);
  vec2 left=vec2(366.,363.),right=vec2(1554.,363.);
  vec2 ql=p-left,qr=p-right;
  float mode=clamp(floor(u_options.w+0.5),0.,2.);
  float sport=step(.5,mode)*(1.-step(1.5,mode));
  float eco=step(1.5,mode);
  vec3 tint=clamp(u_accent.rgb,0.,1.);
  vec3 bright=vec3(.88,.91,.93);
  vec3 bg=mix(vec3(.009,.012,.018),vec3(.012,.005,.008),sport*.65);
  bg=mix(bg,vec3(.006,.013,.021),eco*.70);
  float vignette=.88+.12*(1.-length((p-vec2(960.,360.))/vec2(1280.,950.)));
  vec3 color=bg*vignette;
  float alpha=1.;

  // Fully electronic 6WB-style round gauges with fine ticks and a needle.
  float track=max(ring(ql,257.,2.1),ring(qr,257.,2.1));
  color=mix(color,vec3(.19,.22,.26),track*.85);
  float innerTrack=max(ring(ql,214.,1.7),ring(qr,214.,1.7));
  color=mix(color,vec3(.12,.15,.19),innerTrack*.46);
  float speed=clamp(u_values.x/260.,0.,1.);
  float rev=clamp(u_values.y/5000.,0.,1.);
  float aL=mod(atan(ql.y,ql.x)+6.2831853,6.2831853);
  float aR=mod(atan(qr.y,qr.x)+6.2831853,6.2831853);
  float start=.60, sweep=5.10;
  float leftProgress=step(start,aL)*step(aL,start+speed*sweep);
  float rightProgress=step(start,aR)*step(aR,start+rev*sweep);
  float active=max(ring(ql,248.,sport>0.5?12.:7.)*leftProgress,
                   ring(qr,248.,sport>0.5?12.:7.)*rightProgress);
  color=mix(color,tint,active*.99);

  float majorTicks=0.,minorTicks=0.;
  for(int i=0;i<27;i++){
    float a=start+float(i)*sweep/26.;
    vec2 ray=vec2(cos(a),sin(a));
    float major=1.-step(.5,mod(float(i),2.));
    float t=max(tick(ql,ray,major>0.5?224.:236.,250.,major>0.5?1.9:.8),
                tick(qr,ray,major>0.5?224.:236.,250.,major>0.5?1.9:.8));
    majorTicks=max(majorTicks,t*major);
    minorTicks=max(minorTicks,t*(1.-major));
  }
  color=mix(color,bright,majorTicks*.90+minorTicks*.34);

  // White geometric digits and centre caps remain readable in any tint.
  float speedDigits=numeral(p-vec2(274.,334.),u_values.x,3.,1.45);
  float revDigits=numeral(p-vec2(1444.,342.),u_values.y,4.,1.04);
  color=mix(color,bright,clamp(max(speedDigits,revDigits),0.,1.));
  float cap=max(1.-smoothstep(9.,12.,length(ql)),
                1.-smoothstep(9.,12.,length(qr)));
  color=mix(color,tint,cap*.9);

  // Navigation opening reserved above all decorative graphics. The actual
  // map appears only if another BMW/Waze source supplies that underlying slot.
  float mapWindow=box(p,vec2(960.,347.),vec2(334.,231.));
  alpha*=1.-mapWindow;
  float border=box(p,vec2(960.,347.),vec2(339.,236.))-mapWindow;
  color=mix(color,tint,clamp(border,0.,1.)*.28);
  alpha=max(alpha,clamp(border,0.,1.));

  gl_FragColor=vec4(color,clamp(alpha,0.,1.));
}`;
