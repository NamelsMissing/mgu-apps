'use strict';
const assert=require('assert');
const EventEmitter=require('events');
const L=require('../apps/custom_cluster/layout_panels');
class Canvas {
    constructor(w,h){this.d=new Uint8Array(w*h*4);this.labels=[];}
    clear(){return this;} circle(){return this;} arc(){return this;}
    line(){return this;} fillRect(){return this;} roundRect(){return this;}
    drawImage(){return this;} text(s){this.labels.push(String(s));return this;}
}
function fixture(){
    const layers=new Map(),ops=[];let next=0;
    function add(kind,o){const r=++next;layers.set(r,{kind,o:Object.assign({},o)});ops.push([kind,r]);return r;}
    return {layers,ops,image:o=>add('image',o),effect:o=>add('effect',o),
        pixels(r,rects,p){ops.push(['pixels',r]);const o=layers.get(r).o;return p.length===o.iw*o.ih*4;},
        uniform(r,n,v){ops.push(['uniform',r,n,v.slice()]);},set(r,o){ops.push(['set',r]);Object.assign(layers.get(r).o,o);}};
}
for(const layout of Object.keys(L.NAMES)){
    const cr=fixture(),refs=[];
    const parts=L.buildLayout(cr,'panel',{speed:0,rpm:790},{layout},[.4,.2,1,1],'#6633ff',r=>refs.push(r),Canvas);
    // cover + face + progress + readout per side (Minimal: no progress)
    assert.equal(refs.length,layout==='minimal'?6:8,layout);
    for(const {o} of cr.layers.values()){
        assert.equal(o.visible,false);assert.equal(o.contend,false);
        assert.ok(o.x+o.w<=416||o.x>=1504,layout+' centre clearance');
        assert.ok(o.y+o.h<600,layout+' bottom clearance');
        assert.ok(o.y>=48,layout+' top telltale row clearance');
        assert.ok(o.x>=0&&o.x+o.w<=1920,layout+' panel width');
    }
    const plain=fixture(),plainRefs=[];
    L.buildLayout(plain,'panel',{speed:0,rpm:790},{layout,coverOriginal:false},[.4,.2,1,1],'#6633ff',r=>plainRefs.push(r),Canvas);
    assert.equal(plainRefs.length,layout==='minimal'?4:6,layout+' without cover');
    const before=cr.ops.length;
    L.updateLayout(cr,parts,{speed:0,rpm:790},[.4,.2,1,1],'#6633ff');
    assert.equal(cr.ops.length,before,'unchanged values do not upload');
    L.updateLayout(cr,parts,{speed:0,rpm:1500},[.4,.2,1,1],'#6633ff');
    assert.ok(cr.ops.slice(before).some(x=>x[0]==='pixels'),'RPM update');
    if(layout!=='minimal')assert.ok(cr.ops.slice(before).some(x=>x[0]==='uniform'&&x[2]==='u_fraction'&&Math.abs(x[3][0]-0.25)<1e-9),'progress uniform');
    const mid=cr.ops.length;
    L.updateLayout(cr,parts,{speed:0,rpm:1500,stage:'P',oil:91.6,coolant:88},[.4,.2,1,1],'#6633ff');
    assert.ok(cr.ops.slice(mid).filter(x=>x[0]==='pixels').length===2,'gear + temperature update both readouts');
    assert.throws(()=>L.updateLayout(cr,parts,{speed:NaN,rpm:1500},[.4,.2,1,1],'#6633ff'),/Invalid live speed/);
    L.drawLayoutPreview(new Canvas(1600,520),{x:38,y:86,w:1042,h:398},{speed:0,rpm:790},{layout},'#6633ff',Canvas);
}
const side=L.SIDES[0],ticks=L.ticks('oem',side);
assert.deepStrictEqual(ticks,[0,20,40,60,100,140,200,260]);
assert.equal(L.fraction('oem',side,0),0);
assert.equal(L.fraction('oem',side,260),1);
assert.ok(L.face('oem',side,'#6633ff',Canvas).labels.includes('140'));
assert.equal(L.gearText({stage:'P'}),'P');
assert.equal(L.gearText({stage:'D',gear:4}),'D4');
assert.equal(L.gearText({stage:'D',gear:4,gearGuessed:true}),'D');
assert.equal(L.gearText({}),'--');
assert.equal(L.infoText(L.SIDES[1],{oil:91.6,coolant:88}),'OIL 92\u00b0  H2O 88\u00b0');
assert.equal(L.infoText(L.SIDES[1],{oil:NaN}),'OIL --  H2O --');
// Generated progress shaders: one seg() call per path segment, GLSL float literals.
for(const layout of ['oem','g80','sport','classic'])for(const s of L.SIDES){
    const fs=L.progressShader(layout,s),n=L.path(layout,s).length-1;
    assert.equal((fs.match(/\n  seg\(/g)||[]).length,n,layout+' segments');
    assert.ok(!/[^0-9.]\d+,|vec2\(\d+,/.test(fs.replace(/#version 100/,'')),layout+' float literals');
}
assert.equal(L.progressShader('minimal',L.SIDES[0]),null);
console.log('All five shared side-layout paths, preview and geometry checks passed');
