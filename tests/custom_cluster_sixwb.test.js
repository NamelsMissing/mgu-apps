'use strict';
const assert = require('assert');
const {buildDials,updateDials,POSITIONS,SIZE,DRAW_SIZE} = require('../apps/custom_cluster/sixwb_dials');
class Canvas {
    constructor(w,h){this.d = new Uint8Array(w*h*4);}
    clear(){return this;} circle(){return this;} arc(){return this;} line(){return this;} text(){return this;}
}
const ops=[],refs=[];
let next=0;
const cr={
    image(o){const r=++next;ops.push(['image',r,o]);return r;},
    effect(o){const r=++next;ops.push(['effect',r,o]);return r;},
    pixels(r,rects,bytes){ops.push(['pixels',r,bytes.length]);return bytes.length===SIZE*SIZE*4;},
    uniform(r,n,v){ops.push(['uniform',r,n,v]);}
};
const data={speed:0,rpm:790};
const needles=buildDials(cr,'panel',data,{sixwbTheme:'comfort'},[1,1,1,1],'#fff',r=>refs.push(r),Canvas);
// Default 0.6.7: cover plate + face + needle per side.
assert.deepStrictEqual(refs,[1,2,3,4,5,6]);
assert.ok(ops.filter(x=>x[0]==='effect'&&/u_color/.test(x[2].fs)&&x[2].w===404).every(x=>
    x[2].y>=48&&x[2].y+x[2].h<600),'cover plates bounded');
assert.strictEqual(needles.length,2);
assert.equal(ops.filter(x=>x[0]==='pixels').length,2);
assert.ok(ops.filter(x=>x[0]==='image'||x[0]==='effect').every(x=>
    x[2].visible===false && x[2].contend===false && (x[2].x+x[2].w<=416||x[2].x>=1504)));
assert.ok(POSITIONS.every(p=>p.y+DRAW_SIZE<600));
const before=ops.length;updateDials(cr,needles,data);assert.equal(ops.length,before);
updateDials(cr,needles,{speed:0,rpm:1500});
assert.deepStrictEqual(ops[ops.length-1],['uniform',6,'u_fraction',[0.3]]);
assert.throws(()=>updateDials(cr,needles,{speed:NaN,rpm:1500}),/Invalid real speed/);
{
    const r2=[];let n2=0;
    const cr2={image(){return ++n2;},effect(){return ++n2;},pixels(){return true;},uniform(){}};
    buildDials(cr2,'panel',data,{sixwbTheme:'comfort',coverOriginal:false},[1,1,1,1],'#fff',r=>r2.push(r),Canvas);
    assert.deepStrictEqual(r2,[1,2,3,4],'cover can be disabled');
}
console.log('6WB parked dial layer and real-value needle tests passed');
