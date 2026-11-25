"""Generate an original PlayStation GPU smoke-test ISO using pycdlib."""
import argparse
import io
import struct

import pycdlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', help='output ISO path')
args = parser.parse_args()

exe = bytearray(4096)
exe[:8] = b'PS-X EXE'
struct.pack_into('<IIII', exe, 16, 0x80010000, 0, 0x80010000, 2048)
struct.pack_into('<I', exe, 48, 0x801fff00)
ops = [
    0x3c081f80, 0x3c090300, 0xad091814, # display enable
    0x3c090800, 0x35290001, 0xad091814, # 320-pixel mode
    0x3c090200, 0x352900ff, 0xad091810, # red fill
    0xad001810, 0x3c0900f0, 0x35290140, 0xad091810, # (0,0), 320x240
    0x1000ffff, 0, # loop
]
struct.pack_into('<'+'I'*len(ops), exe, 2048, *ops)
cnf = b'BOOT = cdrom:\\TEST.EXE;1\r\nTCB = 4\r\nEVENT = 10\r\nSTACK = 801FFF00\r\n'
iso = pycdlib.PyCdlib()
iso.new(interchange_level=1, vol_ident='GAMESTATION_TEST')
iso.add_fp(io.BytesIO(exe), len(exe), iso_path='/TEST.EXE;1')
iso.add_fp(io.BytesIO(cnf), len(cnf), iso_path='/SYSTEM.CNF;1')
iso.write(args.output)
iso.close()
