#!/bin/sh
# Build mgu-sound-pcm for the MGU (Linux x86-64, glibc >= 2.17) with the host's gcc.
# glibc217.S replaces crt1.o and pins the few symbols whose default version is newer than 2.17;
# the script refuses the result if any other symbol needs a version above GLIBC_2.17.
set -eu
cd "$(dirname "$0")"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
gcc -c -o "$tmp/start.o" glibc217.S
gcc -c -std=c99 -O2 -Wall -Wextra -Werror -fno-stack-protector -fno-pie -U_FORTIFY_SOURCE \
    -include symver.h -o "$tmp/pcm.o" pcm_output.c
gcc -nostartfiles -no-pie -o mgu-sound-pcm "$tmp/start.o" "$tmp/pcm.o" -Wl,--no-as-needed /lib/x86_64-linux-gnu/libdl.so.2 -Wl,--as-needed -s
bad=$(objdump -T mgu-sound-pcm | grep -o 'GLIBC_[0-9.]*' | sort -uV | awk -F'[_.]' '$3 > 17 || $2 > 2')
if [ -n "$bad" ]; then echo "needs newer glibc: $bad" >&2; rm -f mgu-sound-pcm; exit 1; fi
objdump -T mgu-sound-pcm | grep -o 'GLIBC_[0-9.]*' | sort -uV | tr '\n' ' '; echo
