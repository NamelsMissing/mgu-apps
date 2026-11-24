'use strict';

// Mineworks: original offline mine-management mini-game for MGU GameStation.
// No commercial assets, Unity runtime, network or third-party code.
const W = 900, H = 450, MAX_CASH = 1e15;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const money = n => {
    if (n < 1000) return '$' + Math.floor(n);
    const units = ['K', 'M', 'B', 'T'];
    let i = -1;
    do { n /= 1000; i++; } while (n >= 1000 && i < units.length - 1);
    return '$' + (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + units[i];
};
const cleanLevel = n => Number.isInteger(n) && n >= 0 && n <= 100 ? n : 0;
const SHAFTS = [
    {name:'Copper', base:2.6, cost:14, unlock:0, color:'#c88d5e'},
    {name:'Silver', base:16, cost:145, unlock:380, color:'#b1c7dc'},
    {name:'Gold', base:110, cost:1650, unlock:3400, color:'#f1c75a'},
    {name:'Crystal', base:740, cost:19500, unlock:28000, color:'#82ddd0'},
];

class Mineworks {
    constructor(options) {
        const opts = options || {};
        this.now = opts.now || Date.now;
        this.width = W; this.height = H; this.title = 'Mineworks Tycoon';
        this.shafts = [1,0,0,0];
        this.managers = [false,false,false,false];
        this.elevator = 1; this.warehouse = 1;
        this.cash = 65; this.earned = 0;
        this.selected = 0; this.phase = 0;
        this.boostUntil = 0; this.boostCooldown = 0;
        this.sound = false; this.noteLeft = 0; this.notePhase = 0; this.noteHz = 0;
        this.samples = new Float32Array(800); this.prev = {};
        this.message = 'UP/DOWN: choose  A: upgrade  B: manager  START: boost';
        this.messageUntil = 0;
        if (opts.save) this.load(opts.save);
    }
    levelRate(i) {
        const level = this.shafts[i];
        return level ? SHAFTS[i].base * Math.pow(level, 1.3) * (this.managers[i] ? 1.5 : 1) : 0;
    }
    production() { return SHAFTS.reduce((sum, _, i) => sum + this.levelRate(i), 0); }
    elevatorRate() { return 5.5 * Math.pow(this.elevator, 1.43); }
    warehouseRate() { return 6.8 * Math.pow(this.warehouse, 1.43); }
    rate() { return Math.min(this.production(), this.elevatorRate(), this.warehouseRate()); }
    boost() { return this.phase < this.boostUntil ? 2 : 1; }
    selectedLevel() { return this.selected < 4 ? this.shafts[this.selected] : this.selected === 4 ? this.elevator : this.warehouse; }
    upgradeCost() {
        if (this.selected < 4) {
            const s=SHAFTS[this.selected], level=this.shafts[this.selected];
            return level ? Math.ceil(s.cost*Math.pow(1.32,level-1)) : s.unlock;
        }
        return Math.ceil((this.selected===4?30:37)*Math.pow(1.37,this.selectedLevel()-1));
    }
    managerCost() {
        if (this.selected>=4 || !this.shafts[this.selected] || this.managers[this.selected]) return 0;
        return Math.ceil(230*Math.pow(12,this.selected));
    }
    notice(s) { this.message=s; this.messageUntil=this.phase+190; }
    chirp(hz) { if (this.sound) { this.noteHz=hz; this.noteLeft=1900; } }
    upgrade() {
        const cost=this.upgradeCost();
        if (this.cash+1e-8<cost) return this.notice('Not enough cash: need '+money(cost));
        if (this.selected<4 && !this.shafts[this.selected] && this.selected>0 && !this.shafts[this.selected-1])
            return this.notice('Unlock the previous shaft first');
        this.cash-=cost;
        if (this.selected<4) this.shafts[this.selected]++;
        else if (this.selected===4) this.elevator++;
        else this.warehouse++;
        this.chirp(580);
        this.notice((this.selected<4?SHAFTS[this.selected].name:this.selected===4?'Elevator':'Warehouse')+' upgraded!');
    }
    hire() {
        if (this.selected>=4) return this.notice('Managers work inside mine shafts');
        if (!this.shafts[this.selected]) return this.notice('Unlock this shaft first');
        if (this.managers[this.selected]) return this.notice('Manager already hired');
        const cost=this.managerCost();
        if (this.cash<cost) return this.notice('Manager costs '+money(cost));
        this.cash-=cost; this.managers[this.selected]=true;
        this.chirp(720); this.notice('Manager hired: shaft +50%');
    }
    activateBoost() {
        if (this.phase<this.boostCooldown) return this.notice('Boost is recharging');
        this.boostUntil=this.phase+1800; this.boostCooldown=this.phase+7200;
        this.chirp(900); this.notice('2x mining boost for 30 seconds!');
    }
    tick(pads, delta) {
        const p=pads && pads[0] || {}, edge=key=>!!p[key]&&!this.prev[key];
        if (edge('up')) this.selected=(this.selected+5)%6;
        if (edge('down')) this.selected=(this.selected+1)%6;
        if (edge('left')) this.selected=(this.selected+5)%6;
        if (edge('right')) this.selected=(this.selected+1)%6;
        if (edge('a')) this.upgrade();
        if (edge('b')||edge('x')) this.hire();
        if (edge('start')) this.activateBoost();
        this.prev={up:!!p.up,down:!!p.down,left:!!p.left,right:!!p.right,
            a:!!p.a,b:!!p.b,x:!!p.x,start:!!p.start};
        const frames=clamp(Number(delta)||1,0.5,2);
        const gain=Math.min(1e11,this.rate()*this.boost()*frames/60);
        this.cash=clamp(this.cash+gain,0,MAX_CASH);
        this.earned=clamp(this.earned+gain,0,MAX_CASH);
        this.phase+=frames;
    }
    setAudioEnabled(enabled) { this.sound=!!enabled; if (!enabled) this.noteLeft=0; }
    releaseInput() { this.prev={}; this.noteLeft=0; }
    getAudioSamples() {
        if (!this.sound) return null;
        const a=this.samples; a.fill(0);
        const step=2*Math.PI*this.noteHz/48000;
        for (let i=0;i<a.length&&this.noteLeft>0;i++,this.noteLeft--) {
            this.notePhase+=step;
            a[i]=Math.sin(this.notePhase)*0.11*Math.min(1,this.noteLeft/350);
        }
        return {rate:48000,left:a};
    }
    sram() {
        return Buffer.from(JSON.stringify({v:1,at:this.now(),cash:this.cash,earned:this.earned,
            shafts:this.shafts,managers:this.managers,elevator:this.elevator,warehouse:this.warehouse}));
    }
    load(save) {
        try {
            if (!Buffer.isBuffer(save)||save.length>4096) return;
            const s=JSON.parse(save.toString('utf8'));
            if (!s||s.v!==1||!Array.isArray(s.shafts)||s.shafts.length!==4||
                !Array.isArray(s.managers)||s.managers.length!==4) return;
            const levels=s.shafts.map(cleanLevel);
            if (!levels[0]) return;
            if (![s.elevator,s.warehouse].every(x=>Number.isInteger(x)&&x>=1&&x<=100)) return;
            if (![s.cash,s.earned].every(x=>Number.isFinite(x)&&x>=0&&x<=MAX_CASH)) return;
            this.shafts=levels; this.managers=s.managers.map(Boolean);
            this.elevator=s.elevator; this.warehouse=s.warehouse;
            this.cash=s.cash; this.earned=s.earned;
            const seconds=clamp((this.now()-(Number(s.at)||this.now()))/1000,0,8*3600);
            const passive=Math.min(MAX_CASH-this.cash,this.rate()*seconds*0.18);
            this.cash+=passive; this.earned=clamp(this.earned+passive,0,MAX_CASH);
            if (seconds>60) this.notice('While away: +'+money(passive));
        } catch (_) { /* invalid saves start fresh */ }
    }
    stop() { this.releaseInput(); }
    draw(cv,x,y,w,h) {
        const sx=w/W,sy=h/H,fontScale=Math.min(sx,sy);
        const rect=(a,b,c,d,col,rad)=>cv.roundRect(x+a*sx,y+b*sy,c*sx,d*sy,(rad||0)*fontScale,col);
        const bar=(a,b,c,d,col)=>cv.fillRect(x+a*sx,y+b*sy,c*sx,d*sy,col);
        const circle=(a,b,r,col)=>cv.circle(x+a*sx,y+b*sy,r*fontScale,col);
        const line=(s,a,b,size,col,opts)=>cv.text(s,x+a*sx,y+b*sy,size*fontScale,col,Object.assign({literal:true},opts||{}));
        const target=(a,b,c,d,cb,id)=>cv.target(x+a*sx,y+b*sy,c*sx,d*sy,cb,id,8);
        rect(0,0,900,450,'#081522',10);
        rect(10,9,880,53,'#11283a',10);
        line('MINEWORKS',24,42,25,'#e8f4fd',{font:'bold'});
        line(money(this.cash),370,42,28,'#ffe28a',{font:'num'});
        line('+'+money(this.rate()*this.boost())+'/s',585,42,21,'#82ebc1');
        if (this.boost()>1) line('2X BOOST',763,42,19,'#ffc271',{font:'bold'});
        rect(10,72,555,358,'#11202d',9);
        rect(19,81,538,46,'#18384b',8);
        line('SURFACE',32,111,16,'#c1d4e8',{font:'bold'});
        rect(253,85,60,33,this.selected===4?'#367d76':'#283c52',6);line('LIFT',262,106,13,'#def1ff');
        rect(331,85,82,33,this.selected===5?'#367d76':'#40506a',6);line('DEPOT',341,106,13,'#def1ff');
        target(253,85,60,33,()=>{this.selected=4;},'MINE_ELEVATOR');
        target(331,85,82,33,()=>{this.selected=5;},'MINE_WAREHOUSE');
        bar(259,120,4,290,'#52758b');
        rect(245,150+(Math.sin(this.phase/28)+1)*106,27,22,'#f1c75a',3);
        rect(407+Math.sin(this.phase/55)*18,103,42,17,'#e0a565',3);
        circle(415+Math.sin(this.phase/55)*18,123,5,'#101820');
        circle(439+Math.sin(this.phase/55)*18,123,5,'#101820');
        for(let i=0;i<4;i++){
            const yy=137+i*69,s=SHAFTS[i],level=this.shafts[i],on=this.selected===i;
            rect(20,yy,531,60,on?'#2c4b5f':'#172c39',6);
            if(on)bar(20,yy,5,60,'#75e3d2');
            line('B'+(i+1),32,yy+24,15,'#86acc3',{font:'bold'});
            line(s.name,85,yy+22,20,level?'#ecf7ff':'#748492',{font:'bold'});
            if(!level)line('LOCKED '+money(s.unlock),90,yy+47,13,'#ceaa7c');
            else{
                line('Lv '+level+'  /  '+money(this.levelRate(i))+'/s',85,yy+47,14,'#9de3c6');
                rect(297,yy+15,210,32,'#293e4d',5);
                const off=(this.phase*(1+level*.03)+i*45)%190;
                circle(307+off,yy+31,8,s.color);
                rect(485,yy+17,15,23,s.color,3);
                if(this.managers[i])circle(525,yy+14,6,'#88e8b5');
            }
            target(20,yy,531,60,()=>{this.selected=i;},'MINE_LEVEL_'+i);
        }
        rect(578,72,312,358,'#142638',9);
        line('OPERATIONS',595,103,23,'#f2f9ff',{font:'bold'});
        const labels=SHAFTS.map(s=>s.name).concat(['Elevator','Warehouse']);
        line(labels[this.selected],596,139,25,'#ffd77d',{font:'bold'});
        line('LEVEL '+this.selectedLevel(),597,167,17,'#9cc6dd');
        line(this.selected<4?'Mine production':'Transport capacity',596,207,16,'#acbed0');
        line(money(this.selected<4?this.levelRate(this.selected):this.selected===4?this.elevatorRate():this.warehouseRate())+'/s',596,238,25,'#b3f5d7',{font:'num'});
        const upgrade='UPGRADE  '+money(this.upgradeCost());
        rect(593,256,279,47,this.cash>=this.upgradeCost()?'#27755f':'#435260',8);
        line(upgrade,609,287,18,'#ffffff',{font:'bold'});
        target(593,256,279,47,()=>this.upgrade(),'MINE_UPGRADE');
        const hire=this.managerCost();
        rect(593,315,279,47,hire&&this.cash>=hire?'#806337':'#34495b',8);
        line(this.selected>=4?'MANAGERS: SHAFTS ONLY':this.managers[this.selected]?'MANAGER ACTIVE':
            !this.selectedLevel()?'UNLOCK SHAFT FIRST':'HIRE MANAGER '+money(hire),603,346,16,'#ffffff',{font:'bold'});
        target(593,315,279,47,()=>this.hire(),'MINE_MANAGER');
        line('SELECT '+(this.selected+1)+'/6   A=UPGRADE  B=HIRE',594,388,14,'#a4b8cb');
        rect(593,399,279,25,this.phase<this.boostCooldown?'#354458':'#476d76',5);
        line(this.boost()>1?'BOOST ACTIVE':this.phase<this.boostCooldown?'BOOST RECHARGING':'START: 2X BOOST',609,417,14,'#e5f5ff');
        target(593,399,279,25,()=>this.activateBoost(),'MINE_BOOST');
        if(this.phase<this.messageUntil)line(this.message,23,445,14,'#fff1bc');
    }
}
module.exports={Mineworks,SHAFTS,money};
