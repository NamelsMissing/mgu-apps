#!/usr/bin/env python3
"""Reconstruct a text or JSON report from one or more files of copied QR scans."""

import argparse
import base64
import hashlib
import re
import sys
import zlib
from pathlib import Path

HEADER = re.compile(r"^AMBIENT1 ([a-f0-9]{16}) (text|json) (\d+)/(\d+)$")
PAYLOAD = re.compile(r"^[A-Za-z0-9+/]+={0,2}$")


def reconstruct(inputs):
    parts = {}
    report = None
    for source in inputs:
        lines = iter(source.splitlines())
        for header in lines:
            if not header.strip():
                continue
            match = HEADER.fullmatch(header.strip())
            body = next(lines, "").strip()
            if not match or not PAYLOAD.fullmatch(body):
                raise ValueError("Invalid QR header or payload")
            identifier, kind, index, total = match.groups()
            index, total = int(index), int(total)
            if not 1 <= index <= total:
                raise ValueError("Invalid page number")
            key = (identifier, kind, total)
            if report is not None and report != key:
                raise ValueError("Pages belong to different reports")
            report = key
            if index in parts and parts[index] != body:
                raise ValueError("Conflicting copies of a page")
            parts[index] = body
    if not report:
        raise ValueError("No QR pages found")
    identifier, _, total = report
    if len(parts) != total:
        raise ValueError(f"Received {len(parts)} of {total} pages")
    packed = "".join(parts[i] for i in range(1, total + 1)).encode("ascii")
    if hashlib.sha256(packed).hexdigest()[:16] != identifier:
        raise ValueError("Report hash mismatch")
    return zlib.decompress(base64.b64decode(packed, validate=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("scans", nargs="+", type=Path)
    parser.add_argument("-o", "--output", type=Path)
    args = parser.parse_args()
    try:
        report = reconstruct(p.read_text(encoding="utf-8") for p in args.scans)
        if args.output:
            args.output.write_bytes(report)
        else:
            sys.stdout.buffer.write(report)
    except (ValueError, OSError, zlib.error) as exc:
        parser.exit(1, f"Ambient QR: {exc}\n")


if __name__ == "__main__":
    main()
