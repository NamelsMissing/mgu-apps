# GameStation Retro Cores 0.1.0

The MGU Store deploys this tool under `/var/opt/mgu-gamestation-retro/current/`. GameStation starts one child for the selected cartridge and closes it on quit or failure. Its paused process waits for a frame request. There are no units, boot services, network sockets or persistent changes to uninstall. The tool targets Linux x86-64 and glibc 2.17 or later.

The child loads one allowlisted sibling library. An eight-byte little-endian header gives the ROM and optional initial SRAM lengths, followed by those bytes. The child replies with a 24-byte timing header. One eight-byte controller request advances one frame. The child replies with a 24-byte header, RGBA image, interleaved S16_LE stereo PCM and optionally new cartridge SRAM. The app keeps one request in flight, validates sizes and times out a stalled child. It checks the vehicle and focus gate between requests. The child accesses gpSP cartridges through an anonymous file descriptor, with an unlinked-file fallback.

| Core | Pinned upstream source | Build |
|---|---|---|
| gpSP | [5819380](https://github.com/libretro/gpsp/tree/5819380c2ffb0900219d700a382ee68c464ebb99) | Portable interpreter, built-in GPL BIOS replacement |
| Stella 2014 | [7d1361e](https://github.com/libretro/stella2014-libretro/tree/7d1361e407e63f29e52892655069e5fb4096e691) | Atari 2600 cartridge core |
| ProSystem | [8a88014](https://github.com/libretro/prosystem-libretro/tree/8a88014287c7a01cd568067e5a557d0a2b2a051f) | Atari 7800 cartridge core |
| Beetle PCE Fast | [4cf066e](https://github.com/libretro/beetle-pce-fast-libretro/tree/4cf066e22533186d0cfad85a0fec2aced93e4e29) | PC Engine HuCard frontend, CHD disabled |
| Beetle VB | [d5ae54c](https://github.com/libretro/beetle-vb-libretro/tree/d5ae54c8e23b573a3b34e888b2d48a588027e92c) | Standard 2D video frontend |
| Beetle WonderSwan | [4b01295](https://github.com/libretro/beetle-wswan-libretro/tree/4b01295838ea89e3f1355bbe4cb5cf98aa6108cd) | WonderSwan and Color cartridges |
| Beetle NGP | [a50d5ac](https://github.com/libretro/beetle-ngp-libretro/tree/a50d5ac288a81f2104ddf43195a4efdd15c72227) | Cartridge frontend with flash-file writes disabled |

The worker is GPL-2.0-only. Each library carries the upstream license alongside it. Exact source archives, including individual third-party notices, are in `tools/retro_sources`. Rebuild with `python3 tools/build_gamestation_retro.py` using Python 3.12+, Zig 0.14.1, GNU make and GNU strip. Run `node tests/gamestation_retro.test.js` on Linux x86-64 to exercise the real child and seven synthetic cartridges. No commercial ROMs or manufacturer firmware are supplied.
