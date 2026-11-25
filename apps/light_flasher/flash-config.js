'use strict';
// Supported requested intervals for the manual parked test. Existing saved keys retained.
const LABELS={alternate:'Alternate L/R',double:'Double L/R',triple:'Triple L/R',together:'Both together'};
const PATTERNS={alternate:[['left'],['right']],double:[['left'],['left'],['right'],['right']],triple:[['left'],['left'],['left'],['right'],['right'],['right']],together:[['left','right']]};
function config(pattern,interval,hold,fast=false){
 if(!Object.prototype.hasOwnProperty.call(PATTERNS,pattern))throw Error('Invalid flash pattern');
 const intervalMs=Number(interval),cycleMatch=/^cycles:(1|2|3|4|5|6|8|10|12|15|20)$/.exec(String(hold));
 const cycleCount=cycleMatch?Number(cycleMatch[1]):null,durationMs=cycleCount?30000:Number(hold);
 const standard=[100,150,200,300,500,1000],experimental=[20,40,60,80];
 if(experimental.includes(intervalMs)&&fast!==true)throw Error('Intervals below 100 ms require fast mode');
 if(!standard.includes(intervalMs)&&!(fast===true&&experimental.includes(intervalMs))||(!cycleCount&&![2000,3000,4000,5000].includes(durationMs)))throw Error('Invalid flash timing');
 return {pattern,label:LABELS[pattern],intervalMs,durationMs,cycleCount,steps:PATTERNS[pattern].map(x=>x.slice())};
}
module.exports={config};