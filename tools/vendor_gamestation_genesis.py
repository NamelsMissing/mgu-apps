#!/usr/bin/env python3
"""Build the vendored mdcore v0.1.0 sources for the Node.js 8 WebAssembly engine."""
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'tools/gamestation_mdcore'
OUTPUT = ROOT / 'apps/mgu_gamestation/mdcore.wasm'
EXPORTS = """
md_init md_rom_buffer md_load md_reset md_run_frame md_set_input md_framebuffer
md_width md_height md_is_pal md_fps_x1000 md_audio md_audio_frames md_audio_rate_x1000
md_ram md_sram md_sram_size
""".split()

# Zig 0.14.1 provides Clang/LLD 19. Target the original Wasm features only.
command = [sys.argv[1] if len(sys.argv) == 2 else 'zig', 'cc', '-target',
           'wasm32-freestanding', '-mcpu=mvp', '-O3', '-nostdlib', '-ffreestanding',
           '-fno-builtin-memcpy', '-fno-builtin-memset', '-Wl,--no-entry', '-Wl,--export-memory',
           '-Wl,--initial-memory=16777216', '-Wl,--max-memory=16777216',
           '-Wl,-z,stack-size=262144', '-Wl,--strip-all']
command += ['-Wl,--export=' + symbol for symbol in EXPORTS]
command += ['-o', str(OUTPUT)] + [f + '.c' for f in ('md', 'm68k', 'z80', 'vdp', 'sound', 'libc')]
subprocess.run(command, cwd=SOURCE, check=True)
