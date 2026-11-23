'use strict';

const DIRECTIONS = ['up', 'down', 'left', 'right'];
const STANDARD = DIRECTIONS.concat(['a', 'b', 'select', 'start']);
const HEX_KEYS = Array.from({length: 16}, (_, i) => 'k' + i.toString(16));
const MAX_ROM = 8 * 1024 * 1024;

const platforms = [
    {id: 'nes', short: 'NES', title: 'Nintendo', tag: 'NES', extensions: ['.nes'],
        create: (...args) => new (require('./nes_core').NesGame)(...args), players: 2, buttons: STANDARD,
        video: [256, 240], audio: 'mono', battery: true,
        validate: validNes},
    {id: 'snes', short: 'SNES', title: 'Super Nintendo', tag: 'SNES', extensions: ['.sfc', '.smc'],
        create: (...args) => new (require('./snes_core').SnesGame)(...args), players: 2,
        buttons: STANDARD.concat(['x', 'y', 'l', 'r']), video: [512, 208], audio: 'stereo', battery: true,
        validate: bytes => bytes.length >= 0x8000 && [0, 512].includes(bytes.length % 1024)},
    {id: 'gb', short: 'GAME BOY', title: 'Game Boy / Color', tag: 'GB', extensions: ['.gb', '.gbc'],
        create: (...args) => new (require('./gb_core').GameBoyGame)(...args), players: 1, buttons: STANDARD,
        video: [160, 144], audio: 'stereo', battery: true, validate: bytes => bytes.length >= 0x8000 && bytes.length % 0x4000 === 0},
    {id: 'arcade', short: 'ARCADE', title: 'Built-in games', tag: 'ARC', extensions: [],
        create: (_, __, options) => new (require('./arcade').Pong)(options), players: 2, buttons: ['up', 'down']},
    {id: 'chip8', short: 'CHIP-8', title: 'CHIP-8 / Super-CHIP', tag: 'CH8', extensions: ['.ch8', '.sc8'],
        create: (...args) => new (require('./chip8_core').Chip8Game)(...args), players: 1,
        buttons: HEX_KEYS, video: [128, 64], audio: 'mono', states: true,
        validate: bytes => bytes.length >= 2 && bytes.length <= 3584},
    {id: 'sms', short: 'MASTER SYSTEM', title: 'Sega Master System', tag: 'SMS', extensions: ['.sms'],
        create: (...args) => new (require('./sega_core').SegaGame)(...args), players: 2,
        buttons: DIRECTIONS.concat(['a', 'b', 'start']), video: [256, 240], audio: 'mono',
        experimental: true, validate: bytes => validSega(bytes, [3, 4])},
    {id: 'gg', short: 'GAME GEAR', title: 'Sega Game Gear', tag: 'GG', extensions: ['.gg'],
        create: (...args) => new (require('./sega_core').SegaGame)(...args), players: 1,
        buttons: DIRECTIONS.concat(['a', 'b', 'start']), video: [160, 144], audio: 'stereo',
        experimental: true, validate: bytes => validSega(bytes, [5, 6, 7])},
    {id: 'genesis', short: 'MEGA DRIVE', title: 'Sega Mega Drive / Genesis', tag: 'MD', extensions: ['.md', '.gen'],
        create: (...args) => new (require('./genesis_core').GenesisGame)(...args), players: 2,
        buttons: DIRECTIONS.concat(['a', 'b', 'c', 'start']), video: [320, 240], audio: 'stereo', battery: true,
        experimental: true, validate: bytes => bytes.length >= 0x200 && bytes.length % 2 === 0 &&
            /^SEGA (MEGA DRIVE|GENESIS)/.test(bytes.toString('ascii', 0x100, 0x110))},
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

function validRom(kind, name, bytes) {
    return !!(byId[kind] && detect(name) === kind && Buffer.isBuffer(bytes) &&
        bytes.length <= MAX_ROM && byId[kind].validate(bytes));
}

module.exports = {platforms, byId, consoles, extensions, detect, validRom, MAX_ROM};
