'use strict';
// Interpret acknowledged diagnostic cleanup only; not proof of optical restoration.
function summarize(trace,locked){
 const rows=Array.isArray(trace)?trace:[];
 const ok=(r,rx)=>!r.error&&typeof r.rx==='string'&&r.rx.startsWith(rx);
 const sides={};
 for(const side of ['left','right']){
   const list=rows.filter(r=>r.side===side);
   const starts=list.filter(r=>r.tx.startsWith('3101A54B'));
   const stops=list.filter(r=>r.tx==='3102A54B');
   const sessions=list.filter(r=>r.tx==='1003');
   const defaults=list.filter(r=>r.tx==='1001');
   const startCount=starts.length,stopCount=stops.filter(r=>ok(r,'7102A54B')).length;
   let outstanding=false,stopFailure=false;
   for(const r of list){
     if(r.tx.startsWith('3101A54B'))outstanding=true;
     if(r.tx==='3102A54B'){if(ok(r,'7102A54B')){outstanding=false;stopFailure=false;}else stopFailure=true;}
   }
   sides[side]={startsAttempted:startCount,stopsAcknowledged:stopCount,stopConfirmed:!outstanding&&!stopFailure,defaultSessionAcknowledged:defaults.some(r=>ok(r,'5001')),sessionAttempted:sessions.length>0};
 }
 const attempted=Object.values(sides).some(x=>x.sessionAttempted||x.startsAttempted);
 const acknowledged=attempted&&!locked&&Object.values(sides).every(x=>x.stopConfirmed&&(!(x.sessionAttempted||x.startsAttempted)||x.defaultSessionAcknowledged));
 return {attempted,acknowledged,locked:!!locked,sides,physicalRestorationVerified:false};
}
module.exports={summarize};
