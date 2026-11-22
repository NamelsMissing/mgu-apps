'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const app=require('../apps/light_flasher/app.json');
const src=require('fs').readFileSync(require('path').join(__dirname,'../apps/light_flasher/main.js'),'utf8');
const screen=name=>app.screens.find(s=>s.name===name);
test('main is compact; settings separate',()=>{
 assert.deepEqual(screen('MAIN').items.map(x=>x[1]),['FLASH_CONFIG','BTN_FLASH','BTN_FLASH_STOP','FLASH_STATUS','BTN_RECOVER','BTN_OPTIONS']);
 assert.equal(screen('MAIN').settings,undefined);assert.equal(screen('OPTIONS').settings,true);
 assert.equal(app.settings.filter(x=>!x.hidden).length,9);
});
test('raw logs absent from UI while reports retain traces',()=>{
 assert.ok(app.screens.every(s=>s.items.every(x=>x[0]!=='scroll'&&x[1]!=='DIAG_LOG')));
 assert.ok(!src.includes("ui.text('DIAG_LOG'"));
 for(const key of ['trace:flash.trace.slice()','trace:reader.trace.slice()','saveFlashAttempt(attempt)','writeReport(file,buildReport())'])assert.ok(src.includes(key));
});
test('advanced diagnostics are reachable through Service',()=>{
 assert.match(src,/const valid=\(\)=>!closing&&ui.isVisible\('ADVANCED'\)/);
 for(const id of ['BTN_ADVANCED'])assert.ok(screen('DIAGNOSTICS').items.some(x=>x[1]===id));
 assert.ok(screen('OPTIONS').items.some(x=>x[1]==='BTN_DIAG'));
});
test('all manifest buttons have registered handlers',()=>{
 for(const s of app.screens)for(const item of s.items)if(item[0]==='button')assert.ok(src.includes("handler('"+item[1]+"'"),item[1]);
});
test('all service screens suppress automatic triggering',()=>{
 assert.match(src,/const serviceVisible=\(\)=>ui.isVisible\('DIAGNOSTICS'\)\|\|ui.isVisible\('ADVANCED'\)\|\|ui.isVisible\('LOGS'\)/);
 assert.match(src,/const leverScreenOk=\(\)=>!serviceVisible\(\)&&/);
});
