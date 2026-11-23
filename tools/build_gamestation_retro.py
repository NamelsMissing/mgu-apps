#!/usr/bin/env python3
"""Build the GameStation libretro tool using Zig 0.14.1 and GNU strip."""
from pathlib import Path
import argparse
import shlex
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / 'native/gamestation-retro'
SOURCES = ROOT / 'tools/retro_sources'
CORES = {
    'gba': ('gpsp_libretro.so', '5819380', ['HAVE_DYNAREC=0']),
    'a26': ('stella2014_libretro.so', '7d1361e', []),
    'a78': ('prosystem_libretro.so', '8a88014', []),
    'pce': ('mednafen_pce_fast_libretro.so', '4cf066e', ['HAVE_CHD=0']),
    'vb': ('mednafen_vb_libretro.so', 'd5ae54c', []),
    'ws': ('mednafen_wswan_libretro.so', '4b01295', []),
    'ngp': ('mednafen_ngp_libretro.so', 'a50d5ac', []),
    'ps1': ('pcsx_rearmed_libretro.so', '0f544ce',
            ['DYNAREC=lightrec', 'BUILTIN_GPU=peops', 'HAVE_CHD=1',
             'HAVE_PHYSICAL_CDROM=0', 'USE_ASYNC_GPU=0', 'USE_ASYNC_SPU=0']),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--zig', default='zig')
    parser.add_argument('--jobs', type=int, default=4)
    parser.add_argument('--core', choices=CORES, help='rebuild just one core and the worker')
    args = parser.parse_args()
    compiler = [args.zig, 'cc', '-target', 'x86_64-linux-gnu.2.17']
    cpp = compiler.copy()
    cpp[1] = 'c++'
    selected = [args.core] if args.core else list(CORES)
    with tempfile.TemporaryDirectory(prefix='gamestation-retro-') as directory:
        work = Path(directory)
        for name in selected:
            output, revision, switches = CORES[name]
            source = work / name
            source.mkdir()
            with tarfile.open(SOURCES / (name + '.tar.gz')) as archive:
                archive.extractall(source, filter='data')
            makefile = []
            cc = compiler
            if name == 'ps1':
                makefile = ['-f', 'Makefile.libretro']
                cc = [*compiler, '-Wno-error=date-time']
                # Zig's glibc target does not provide GCC's private __cpu_model symbol.
                frontend = source / 'frontend/main.c'
                frontend.write_text(frontend.read_text().replace('#if DO_CPU_CHECKS\n', '#if 0\n'))
            subprocess.run(['make', *makefile, '-j' + str(args.jobs), 'platform=unix',
                            'CC=' + shlex.join(cc), 'CXX=' + shlex.join(cpp),
                            'GIT_VERSION= ' + revision, *switches], cwd=source, check=True)
            subprocess.run(['strip', '--strip-unneeded', '-o', work / (name + '.so'), source / output],
                           check=True)
        subprocess.run([*compiler, '-std=c99', '-O2', '-Wall', '-Wextra', '-Werror', '-s',
                        '-o', work / 'mgu-gamestation-retro', NATIVE / 'runner.c', '-ldl'], check=True)
        for name in [*(key + '.so' for key in selected), 'mgu-gamestation-retro']:
            dest = NATIVE / name
            dest.write_bytes((work / name).read_bytes())
            dest.chmod(0o755 if name == 'mgu-gamestation-retro' else 0o644)


if __name__ == '__main__':
    main()
