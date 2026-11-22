'use strict';

// Run offline with: node tests/g21_car_ui_smoke.test.js
// These checks validate navigation and controls without claiming ECU tests.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = (app) => fs.readFileSync(path.join(root, 'apps', app, 'main.js'), 'utf8');
const spec = (app) => require(path.join(root, 'apps', app, 'app.json'));
const ambient = source('g21_ambient');
const ambientHmi = fs.readFileSync(path.join(root, 'apps', 'g21_ambient', 'hmi.js'), 'utf8');
const wheel = source('g21_wheelheat');
const dpf = source('dpf_monitor');

assert.match(dpf, /ctx\.onTab\(\(index\)/, 'DPF pages must receive header tab taps');
assert(!spec('dpf_monitor').settings.some(s => s.key === 'dde_live' || s.key === 'demo'),
    'DPF must always read real data and hide both test settings');
assert(!dpf.includes("settings.get('demo')"), 'DPF must never show synthetic readings');
assert.deepStrictEqual([...ambientHmi.matchAll(/const TABS = \[([^\]]+)\]/g)].map(m => m[1]),
    ["'Color', 'Favorites', 'Drive modes', 'Diagnostics'"],
    'Ambient has color, favorites, drive-mode and diagnostic pages');
assert.deepStrictEqual([...wheel.matchAll(/const TABS = \[([^\]]+)\]/g)].map(m => m[1]),
    ["'Comfort', 'Diagnostics', 'Log'"], 'WheelHeat includes live diagnostics and the session log');
assert.match(ambient, /ctx\.onTouch\(\(phase, x, y\)/, 'Ambient continuous sliders');
assert.match(ambient, /phase === 2/, 'Ambient slider must accept move events');
assert.match(ambient, /colorNotice = ctl\.info/, 'Ambient displays apply result');
assert(!wheel.includes('simTempEnabled'), 'no simulated temperature in live automation');
assert(!spec('g21_wheelheat').settings.some(s => /^(simTemp|ledAction|manualSeconds)/.test(s.key)));
assert.equal(spec('g21_wheelheat').mguAppStartType, 'autostart');
assert(!spec('g21_wheelheat').settings.some(s => s.key === 'liveControl'),
    'duplicate live-control consent must be removed');
assert(!spec('g21_wheelheat').settings.some(s => s.key === 'engineeringWrites'),
    'legacy manual-write opt-in must not enable new automation');
assert.equal(spec('g21_wheelheat').settings.find(s => s.key === 'autoEnabled').default, false);
assert(!('reset' in spec('g21_wheelheat').settings.find(s => s.key === 'autoEnabled')),
    'stored startup consent must survive updates');
assert.match(wheel, /ctl\.autoWrite\(data/, 'guarded live BDC command path present');
assert.match(wheel, /ctl\.motionKnown/, 'fresh speed guard present for in-motion automation');
assert.match(wheel, /ctl\.readbacks\[did\]/, 'BDC diagnostics must use actual ECU readbacks');
assert(!dpf.includes('Request (raw DID 44BB)'), 'unknown request not mislabelled as status');
assert(!dpf.includes('cv.roundRect(70, 451, 1450, 6'), 'fake DPF progress bar removed');
assert.match(dpf, /\['Overview', 'Details', 'History', 'Regeneration'\]/,
    'DPF keeps live overview, measurements and stored history on separate pages');
assert(!dpf.includes('No verified activity flag'), 'unverified regeneration badge removed');
assert.match(ambientHmi, /'Confirm temporary color' : 'Apply temporary color'/, 'Apply and confirmation share a control');
assert.match(ambient, /const updateRGB.*settings\.setMany/, 'slider changes must batch persistence');

// The pure planner emits one ON event followed by one OFF event.
const { ComfortAuto } = require(path.join(root, 'apps/g21_wheelheat/comfort_auto'));
const cfg = { autoEnabled: true, belowTemp: 8, coldDwell: 0, wheelAuto: true,
    wheelMins: 1, seatDriver: false, seatPassenger: false, seatLevel: 3, seatMins: 1 };
const auto = new ComfortAuto();
const start = 100000;
// Since 0.4.19 OFF is only scheduled after the BDC acknowledged ON.
const on = auto.step({ now: start, tempC: -5, tempAt: start, cfg })[0];
assert.equal(on.type, 'ON');
auto.acknowledge(on, true, start);
assert.equal(auto.step({ now: start + 60000, tempC: -5, tempAt: start, cfg })[0].type, 'OFF');
assert.equal(auto.step({ now: start + 61000, tempC: -5, tempAt: start, cfg }).length, 0);
const long = new ComfortAuto();
const longConfig = Object.assign({}, cfg, { wheelMins: 10 });
const first = long.step({ now: start, tempC: -5, tempAt: start, cfg: longConfig })[0];
assert.deepEqual([first.type, first.data.seconds], ['ON', 240]);
long.acknowledge(first, true, start);
const extend1 = long.step({ now: start + 228000, tempC: -5,
    tempAt: start, cfg: longConfig })[0];
assert.deepEqual([extend1.type, extend1.data.seconds], ['EXTEND', 240]);
long.acknowledge(extend1, true, start + 228000);
assert.equal(long.step({ now: start + 240000, tempC: -5,
    tempAt: start, cfg: longConfig }).length, 0, 'no repeated extension after ACK');
const extend2 = long.step({ now: start + 456000, tempC: -5,
    tempAt: start, cfg: longConfig })[0];
assert.deepEqual([extend2.type, extend2.data.seconds], ['EXTEND', 144]);
long.acknowledge(extend2, true, start + 456000);
assert.equal(long.step({ now: start + 600000, tempC: -5,
    tempAt: start, cfg: longConfig })[0].type, 'OFF');
console.log('OK: DPF tabs, Ambient drag/feedback, WheelHeat live gates and one-shot timer');
