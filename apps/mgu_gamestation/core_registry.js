'use strict';

const fs = require('fs');
const path = require('path');

const DIRECTIONS = ['up', 'down', 'left', 'right'];
const STANDARD = DIRECTIONS.concat(['a', 'b', 'select', 'start']);
const HEX_KEYS = Array.from({length: 16}, (_, i) => 'k' + i.toString(16));
const MAX_ROM = 8 * 1024 * 1024;
const SECOND_PAD = ['rUp', 'rDown', 'rLeft', 'rRight'];

const LIBRETRO_CORES = {
    gba: 'gpSP 5819380', a26: 'Stella 2014 7d1361e', a78: 'ProSystem 8a88014', pce: 'Beetle PCE Fast 4cf066e',
    vb: 'Beetle VB d5ae54c', ws: 'Beetle WonderSwan 4b01295', ngp: 'Beetle NGP a50d5ac', ps1: 'PCSX ReARMed 0f544ce',
};

function native(id, short, title, extensions, players, buttons, validate, options) {
    return Object.assign({id, core: LIBRETRO_CORES[id] + ' / Native', short, title, tag: short, extensions, players, buttons, validate,
        create: (...args) => new (require('./retro_core').RetroGame)(id, ...args),
        audio: 'stereo', experimental: true}, options);
}

function createNes(bytes, paint, options) {
    const opts = options || {};
    // Prefer the native core for conventional iNES boards with the existing SRAM layout.
    const mapper = (bytes[6] >> 4) | (bytes[7] & 0xf0);
    if (!opts.preferJs && opts.canRun && process.platform === 'linux' && process.arch === 'x64' &&
        (bytes[7] & 12) === 0 && !(bytes[6] & 4) && bytes[8] <= 1 && [0, 1, 4].includes(mapper)) {
        const retro = require('./retro_core');
        const helper = opts.helper || retro.HELPER;
        try {
            fs.accessSync(helper, fs.constants.X_OK);
            fs.accessSync(path.join(path.dirname(helper), 'nes.so'), fs.constants.R_OK);
            return new retro.RetroGame('nes', bytes, paint, opts);
        } catch (_) { /* optional native component absent or unavailable */ }
    }
    return new (require('./nes_core').NesGame)(bytes, paint, opts);
}

const platforms = [
    {id: 'nes', core: 'nes-js / JS (vendored)', short: 'NES', title: 'Nintendo', tag: 'NES', extensions: ['.nes'],
        create: createNes, players: 2, buttons: STANDARD,
        video: [256, 240], audio: 'mono', battery: true,
        validate: validNes},
    {id: 'snes', core: 'jssnes / JS (vendored)', short: 'SNES', title: 'Super Nintendo', tag: 'SNES', extensions: ['.sfc', '.smc'],
        create: (...args) => new (require('./snes_core').SnesGame)(...args), players: 2,
        buttons: STANDARD.concat(['x', 'y', 'l', 'r']), video: [512, 208], audio: 'stereo', battery: true,
        validate: bytes => bytes.length >= 0x8000 && [0, 512].includes(bytes.length % 1024)},
    {id: 'gb', core: 'Serverboy / JS (vendored)', short: 'GAME BOY', title: 'Game Boy / Color', tag: 'GB', extensions: ['.gb', '.gbc'],
        create: (...args) => new (require('./gb_core').GameBoyGame)(...args), players: 1, buttons: STANDARD,
        video: [160, 144], audio: 'stereo', battery: true, validate: bytes => bytes.length >= 0x8000 && bytes.length % 0x4000 === 0},
    {id: 'arcade', core: 'Pong / JS (built-in)', short: 'ARCADE', title: 'Built-in games', tag: 'ARC', extensions: [],
        create: (_, __, options) => new (require('./arcade').Pong)(options), players: 2, buttons: ['up', 'down']},
    {id: 'chip8', core: 'CHIP-8 / JS (built-in)', short: 'CHIP-8', title: 'CHIP-8 / Super-CHIP', tag: 'CH8', extensions: ['.ch8', '.sc8'],
        create: (...args) => new (require('./chip8_core').Chip8Game)(...args), players: 1,
        buttons: HEX_KEYS, video: [128, 64], audio: 'mono', states: true,
        validate: bytes => bytes.length >= 2 && bytes.length <= 3584},
    {id: 'sms', core: 'jsmoo Sega / JS (vendored)', short: 'MASTER SYSTEM', title: 'Sega Master System', tag: 'SMS', extensions: ['.sms'],
        create: (...args) => new (require('./sega_core').SegaGame)(...args), players: 2,
        buttons: DIRECTIONS.concat(['a', 'b', 'start']), video: [256, 240], audio: 'mono',
        experimental: true, validate: bytes => validSega(bytes, [3, 4])},
    {id: 'gg', core: 'jsmoo Sega / JS (vendored)', short: 'GAME GEAR', title: 'Sega Game Gear', tag: 'GG', extensions: ['.gg'],
        create: (...args) => new (require('./sega_core').SegaGame)(...args), players: 1,
        buttons: DIRECTIONS.concat(['a', 'b', 'start']), video: [160, 144], audio: 'stereo',
        experimental: true, validate: bytes => validSega(bytes, [5, 6, 7])},
    {id: 'genesis', core: 'mdcore 0.1.0 / Wasm', short: 'MEGA DRIVE', title: 'Sega Mega Drive / Genesis', tag: 'MD', extensions: ['.md', '.gen'],
        create: (...args) => new (require('./genesis_core').GenesisGame)(...args), players: 2,
        buttons: DIRECTIONS.concat(['a', 'b', 'c', 'start']), video: [320, 240], audio: 'stereo', battery: true,
        experimental: true, validate: bytes => bytes.length >= 0x200 && bytes.length % 2 === 0 &&
            /^SEGA (MEGA DRIVE|GENESIS)/.test(bytes.toString('ascii', 0x100, 0x110))},
    native('gba', 'GBA', 'Game Boy Advance', ['.gba'], 1, STANDARD.concat(['l', 'r']),
        bytes => bytes.length >= 192 && bytes[0xb2] === 0x96, {battery: true, maxRom: 32 * 1024 * 1024}),
    native('a26', 'ATARI 2600', 'Atari 2600', ['.a26'], 2, DIRECTIONS.concat(['a', 'select', 'start']),
        bytes => bytes.length >= 1024 && bytes.length <= 1024 * 128 && bytes.length % 256 === 0, {tag: '2600'}),
    native('a78', 'ATARI 7800', 'Atari 7800', ['.a78'], 2, STANDARD.concat(['x']),
        bytes => bytes.length >= 128 + 4096 && bytes.toString('ascii', 1, 10) === 'ATARI7800' &&
            bytes.readUInt32BE(49) === bytes.length - 128, {tag: '7800'}),
    native('pce', 'PC ENGINE', 'PC Engine / TurboGrafx-16', ['.pce'], 2, STANDARD,
        bytes => bytes.length >= 8192 && [0, 512].includes(bytes.length % 8192), {battery: true, tag: 'PCE'}),
    native('vb', 'VIRTUAL BOY', 'Virtual Boy', ['.vb'], 1, STANDARD.concat(['l', 'r'], SECOND_PAD),
        bytes => bytes.length >= 256 && (bytes.length & (bytes.length - 1)) === 0, {battery: true, tag: 'VB'}),
    native('ws', 'WONDERSWAN', 'WonderSwan / Color', ['.ws', '.wsc'], 1,
        DIRECTIONS.concat(['a', 'b', 'start'], SECOND_PAD),
        bytes => bytes.length >= 65536 && bytes.length % 8192 === 0, {battery: true, tag: 'WS'}),
    native('ngp', 'NEO GEO POCKET', 'Neo Geo Pocket / Color', ['.ngp', '.ngc'], 1,
        DIRECTIONS.concat(['a', 'b', 'start']),
        bytes => bytes.length >= 32768 && bytes.toString('ascii', 0, 28).includes('SNK CORPORATION'), {tag: 'NGP'}),
    native('ps1', 'PLAYSTATION', 'PlayStation', ['.chd', '.iso'], 2,
        STANDARD.concat(['x', 'y', 'l', 'r', 'l2', 'r2']), null,
        {tag: 'PS1', battery: true, disc: true, maxRom: 800 * 1024 * 1024}),
];

function validNes(bytes) {
    if (bytes.length < 16 || bytes.toString('binary', 0, 4) !== 'NES\x1a' || !bytes[4]) return false;
    const trainer = bytes[6] & 4 ? 512 : 0;
    return bytes.length >= 16 + trainer + bytes[4] * 16384 + bytes[5] * 8192;
}

// Accept the ordinary Sega ROM header, optionally preceded by a 512-byte copier header.
function validSega(bytes, systems) {
    const skip = bytes.length % 8192 === 512 ? 512 : 0;
    const size = bytes.length - skip;
    return size >= 8192 && size <= 1024 * 1024 && size % 8192 === 0 &&
        [0x7ff0, 0x3ff0, 0x1ff0].some(offset => offset + 16 <= size &&
            bytes.toString('ascii', skip + offset, skip + offset + 8) === 'TMR SEGA' &&
            systems.includes(bytes[skip + offset + 15] >> 4));
}

const byId = Object.create(null);
const extensions = Object.create(null);
platforms.forEach(spec => {
    byId[spec.id] = spec;
    if (spec.extensions.length) extensions[spec.id] = spec.extensions;
});
const consoles = Object.keys(extensions);

function detect(name) {
    const lower = String(name).toLowerCase();
    const matches = consoles.filter(id => extensions[id].some(ext => lower.endsWith(ext)));
    return matches.length === 1 ? matches[0] : null;
}

function maxRom(kind) { return byId[kind] && byId[kind].maxRom || MAX_ROM; }

function validRom(kind, name, bytes) {
    return !!(byId[kind] && byId[kind].validate && detect(name) === kind && Buffer.isBuffer(bytes) &&
        bytes.length <= maxRom(kind) && byId[kind].validate(bytes));
}

module.exports = {platforms, byId, consoles, extensions, detect, validRom, maxRom, MAX_ROM};
