'use strict';

// Original Mineworks mini-game (no commercial ROM, graphics or app assets).
const assert = require('assert');
const {Mineworks} = require('../apps/mgu_gamestation/mineworks');
const {Library} = require('../apps/mgu_gamestation/library');
const fs = require('fs'), os = require('os'), path = require('path');
let clock=1763930000000;
const game=new Mineworks({now:()=>clock});
assert.strictEqual(game.shafts[0],1);
const before=game.cash;
for(let i=0;i<60;i++)game.tick([{}],1);
assert(game.cash>before,'mining produces income');
game.cash=100000;
game.tick([{a:true}],1);
const level=game.shafts[0];
game.tick([{a:true}],1);
assert.strictEqual(game.shafts[0],level,'held A should only purchase once');
game.tick([{}],1);
game.tick([{b:true}],1);
assert.strictEqual(game.managers[0],true,'hire manager');
game.tick([{}],1);game.tick([{down:true}],1);
assert.strictEqual(game.selected,1);
game.tick([{}],1);game.tick([{a:true}],1);
assert.strictEqual(game.shafts[1],1,'unlock second shaft');
const saved=game.sram();
assert(saved.length<4096);
const restored=new Mineworks({now:()=>clock+3600000,save:saved});
assert(restored.cash>=game.cash,'offline gain');
assert.strictEqual(restored.shafts[1],1);
const invalid=new Mineworks({save:Buffer.from('{"v":1,"cash":-50}'),now:()=>clock});
assert.strictEqual(invalid.shafts[0],1);
const targets=[];
const cv=new Proxy({}, {get:(_,key)=>key==='target' ? (...args)=>targets.push(args) : ()=>{}});
game.draw(cv,0,0,900,450);
assert(targets.length>=8,'touch targets');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'mgu-mine-'));
try {
  const lib=new Library(folder);
  assert.strictEqual(lib.store('mine','mineworks',saved),true);
  assert(lib.loadSave('mine','mineworks').equals(saved));
  lib.remember('mine','mineworks');
  assert.strictEqual(lib.last().kind,'mine');
} finally {
  fs.readdirSync(folder).forEach(n=>{
    const p=path.join(folder,n);
    if(fs.statSync(p).isDirectory()){
      const wipe=p=>{fs.readdirSync(p).forEach(k=>{const q=path.join(p,k);if(fs.statSync(q).isDirectory())wipe(q);else fs.unlinkSync(q);});fs.rmdirSync(p);};
      wipe(p);
    }else fs.unlinkSync(p);
  });
  fs.rmdirSync(folder);
}
console.log('ok: Mineworks economy, input, offline save, touch controls and GameStation storage');
