#!/usr/bin/env python3
"""Generate self-contained, readable Node8-compatible bundles from upstream cores.

python3 tools/vendor_retro_cores.py /path/to/serverboy.js/src /path/to/jssnes/src /path/to/nes-js/src

serverboy.js: GPL-2.0, https://github.com/danShumway/serverboy.js
jssnes: MIT, https://github.com/deepneko/jssnes
nes-js: MIT, https://github.com/takahirox/nes-js
"""
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parents[1] / 'apps/mgu_gamestation'
boy = pathlib.Path(sys.argv[1])
snes = pathlib.Path(sys.argv[2])
nes_mit = pathlib.Path(sys.argv[3])


def pack(modules, output, title, root_module, transform):
    with (root / output).open('w', encoding='utf-8') as dst:
        dst.write("'use strict';\n/* " + title + " - original source embedded below; see corresponding license. */\n")
        dst.write('(function () {\nvar registry = Object.create(null), cache = Object.create(null);\n')
        if output == 'snes_vendor.js':
            dst.write('// Isolate upstream diagnostic globals; Node8 does not expose globalThis.\nvar globalThis = Object.create(null);\n')
            dst.write('// Upstream emits per-instruction debug logs; silence them in the game loop.\n')
            dst.write('var console = {log:function(){},warn:function(){},error:function(){},trace:function(){}};\n')
        dst.write('function load(id) { if (!registry[id]) throw Error("Missing core module: " + id);\n')
        dst.write('if (cache[id]) return cache[id].exports; var m={exports:{}}; cache[id]=m;\n')
        dst.write('registry[id](m,m.exports,function(p){var parts=id.split("/");parts.pop();\n')
        dst.write('p.split("/").forEach(function(part){if(part==="..")parts.pop();else if(part!==".")parts.push(part);});\n')
        dst.write('return load(parts.join("/").replace(/\\.js$/, ""));});return m.exports;}\n')
        for name, file in modules:
            src = transform(file.read_text(encoding='utf-8'))
            # Keep committed vendored sources deterministic and whitespace-clean.
            src = '\n'.join(line.rstrip(' \t') for line in src.split('\n'))
            dst.write('\nregistry[' + repr(name) + '] = function(module,exports,require) {\n')
            dst.write(src)
            dst.write('\n};\n')
        if output == 'nes_vendor.js':
            dst.write('module.exports = {Nes:load("Nes").Nes,Rom:load("Rom").Rom,Joypad:load("Joypad").Joypad};\n})();\n')
        else:
            dst.write('module.exports = load(' + repr(root_module) + ');\n})();\n')
    print(output, (root / output).stat().st_size, 'bytes')


boyfiles = [(file.relative_to(boy).with_suffix('').as_posix(), file)
            for file in sorted(boy.rglob('*.js')) if file.name != 'bundle.js']
def game_boy_compat(source):
    source = source.replace('loadRom : function (ROM) {', 'loadRom : function (ROM, frameCycles) {')
    source = source.replace('_that.gameboy = new GameBoyCore(ROM);',
                            '_that.gameboy = new GameBoyCore(ROM);\n'
                            '        _that.gameboy.frameCycles = frameCycles;\n'
                            '        if (frameCycles) _that.gameboy.initializeTiming();')
    source = source.replace('this.baseCPUCyclesPerIteration = this.clocksPerSecond / 1000 * settings[6];',
                            'this.baseCPUCyclesPerIteration = this.frameCycles || this.clocksPerSecond / 1000 * settings[6];')
    source = source.replace('this.stopEmulator |= 1;         //End current loop.',
                            'this.stopEmulator |= 1;         //End current loop.\n'
                            '                this.frameDone = true;         //A stopped CPU still completes a silent host frame.')
    source = source.replace(
        '    this.audioBuffer[this.audioDestinationPosition++] = (this.downsampleInput >>> 16)',
        '    if (this.onAudioSample) this.onAudioSample((this.downsampleInput >>> 16) * this.downSampleInputDivider - 1,\n'
        '        (this.downsampleInput & 0xFFFF) * this.downSampleInputDivider - 1);\n'
        '    this.audioBuffer[this.audioDestinationPosition++] = (this.downsampleInput >>> 16)')
    return source.replace(
        '        while(!_that.gameboy.frameDone) {',
        '        // A halted or broken LCD/frame clock must return control to the OAP app.\n'
        '        let iterations = 0;\n'
        '        while(!_that.gameboy.frameDone) {\n'
        "            if (iterations++ >= 6) throw new Error('Game Boy frame timed out');")


pack(boyfiles, 'gb_vendor.js', 'serverboy.js Game Boy and Color / GPL-2.0',
     'interface', game_boy_compat)

needed = ['CPU', 'PPU', 'APU', 'MMU', 'DSP', 'DSP1', 'SNES']
snfiles = [(name, snes / (name + '.js')) for name in needed]


def compat(source):
    # The OAP console suppresses upstream debug output. Avoid allocating a trace
    # record and formatting ROM-specific watchpoints on every CPU instruction.
    if '    // Record this instruction in the ring buffer' in source:
        start = source.index('    // Record this instruction in the ring buffer')
        end = source.index('    this.cycles++;\n\n    this.execute(opcode, opPC, opPB);', start)
        source = source[:start] + source[end:]
    # Carry instruction cycles across scanline boundaries to keep the APU time
    # from growing by up to one complete CPU instruction per scanline.
    source = source.replace('    this.cpu.reset(); // Then CPU starts execution',
                            '    this.cpu.reset(); // Then CPU starts execution\n'
                            '    this.scanlineDebt = 0;\n'
                            '    this.apuTargetCycles = this.apu.cycles;')
    source = source.replace('        let lineCycles = 0;', '        let lineCycles = this.scanlineDebt;')
    source = source.replace('        // Render visible lines\n        if (line < 224)',
                            '        // Carry instruction cycles past the scanline boundary into the next line.\n'
                            '        this.scanlineDebt = lineCycles - cyclesPerScanline;\n\n'
                            '        // Render visible lines\n        if (line < 224)')
    # Keep the upstream DSP clock continuous while its reset flag forces silence.
    deps = []
    def imported(match):
        deps.append((match.group(1), match.group(2)))
        return ''
    source = re.sub(r"^import\s*\{\s*(\w+)\s*\}\s*from\s*['\"]\.\/(\w+)\.js['\"];\s*$",
                    imported, source, flags=re.M)
    exported = re.findall(r'^export class (\w+)', source, re.M)
    source = re.sub(r'^export class (\w+)', r'class \1', source, flags=re.M)
    source = source.replace(
        '        if (this.flg & 0x80) return;',
        '        if (this.flg & 0x80) {\n'
        '            if (this.samplePos < this.sampleBufferL.length) {\n'
        '                this.sampleBufferL[this.samplePos] = 0;\n'
        '                this.sampleBufferR[this.samplePos++] = 0;\n'
        '            }\n'
        '            return;\n'
        '        }')
    source = source.replace('globalThis._snesMMU?.apu', '(globalThis._snesMMU && globalThis._snesMMU.apu)')
    # Upstream debug print assumes a particular commercial ROM is loaded.
    source = source.replace('data[0x2766D].toString(16)', '(data[0x2766D] || 0).toString(16)')
    source = source.replace('this.rom[0x2766D].toString(16)', '(this.rom[0x2766D] || 0).toString(16)')
    source = ''.join('const ' + var + " = require('./" + dep + "')." + var + ';\n'
                     for var, dep in deps) + source
    source += '\n' + '\n'.join('exports.' + name + ' = ' + name + ';' for name in exported) + '\n'
    return source


pack(snfiles, 'snes_vendor.js', 'jssnes SNES / MIT', 'SNES', compat)


def nes_compat(source):
    # Muting PCM must not stop APU timers, IRQs or DMC reads.
    source = source.replace('if((this.cycle % this.samplePeriod) === 0)',
                            'if(this.mixSamples !== false && (this.cycle % this.samplePeriod) === 0)')
    deps = []
    def imported(match):
        names = [x.strip() for x in match.group(1).split(',')]
        deps.append((names, match.group(2)))
        return ''
    source = re.sub(r"^import\s*\{([^}]+)\}\s*from\s*['\"]\.\/(\w+)\.js['\"];\s*$",
                    imported, source, flags=re.M)
    exports = []
    def export_names(match):
        exports.extend([x.strip() for x in match.group(1).split(',')])
        return ''
    source = re.sub(r'^export\s*\{([^}]+)\};', export_names, source, flags=re.M)
    intro = ''.join('const {' + ','.join(names) + "} = require('./" + dep + "');\n"
                    for names, dep in deps)
    source = intro + source
    source += '\n' + '\n'.join('exports.' + name + ' = ' + name + ';' for name in exports)
    return source


nesfiles = [(file.stem, file) for file in sorted(nes_mit.glob('*.js'))]
pack(nesfiles, 'nes_vendor.js', 'nes-js NES / MIT', 'Nes', nes_compat)
