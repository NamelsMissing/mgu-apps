# MGU GameStation 0.4.0

GameStation runs retro games offline on BMW iDrive 7 with the MGU Node.js 8 OAP runtime. The BMW screen renders the games. The app-menu icon uses 98 × 81 visible artwork centred in its 140 × 140 transparent canvas. Phones provide controls and ROM management over the car's local Wi-Fi. Bring your own legally obtained ROMs. Pong is built in.

## Compatibility

Local tests use original synthetic programs. BMW installation, input, render timing and speaker output still need validation on a head unit for this version.

| System | Core and formats | Video | Emulator PCM | Controllers | Storage | BMW test |
|---|---|---|---|---|---|---|
| NES | nes-js, `.nes` | 256 × 240 | Mono | 2 | Cartridge battery RAM | Open |
| SNES | jssnes, `.sfc`, `.smc` | 512 × 208 | Stereo, 32 kHz | 2 | Cartridge battery RAM | Open |
| Game Boy / Color | serverboy.js, `.gb`, `.gbc` | 160 × 144 | Stereo, about 44.15 kHz | 1 | Cartridge battery RAM | Open |
| Arcade | Original Pong | Vector graphics | Silent | 2 or CPU opponent | Last played | Open |
| CHIP-8 / Super-CHIP | GameStation interpreter, `.ch8`, `.sc8` | 64 × 32 / 128 × 64 | Mono sound timer, 48 kHz | 1, 16-key phone keypad | 3 full-state slots | Open |
| Master System | jsmoo, `.sms` | 256 pixels wide | PSG mono, 48 kHz | 2, buttons 1/2 and console Pause | — | Open, experimental |
| Game Gear | jsmoo, `.gg` | 160 × 144 | PSG stereo, 48 kHz | 1, buttons 1/2 and Start | — | Open, experimental |
| Mega Drive / Genesis | mdcore MVP WebAssembly, `.md`, `.gen` | 256 or 320 pixels wide | Stereo, rate from core | 2, three-button pads | Header-declared SRAM | Open, experimental |

The Sega 8-bit path uses NTSC, direct cartridge boot and the standard Sega mapper. PAL timing, alternate mappers, FM sound, link cable and Sega 8-bit battery RAM are outside this implementation. Super-CHIP is selected by the `.sc8` suffix. CHIP-8 interpreter quirks vary across ROMs. The tests exercise selected opcodes, graphics and timers. Mega Drive emulation inherits the compatibility limits of mdcore 0.1.0 and exposes three-button controllers. Generic `.bin`, `.smd` and firmware dumps are outside the ROM registry.

## Installation and controls

1. Install **MGU GameStation** from the `NamelsMissing/mgu-apps` MGU Store source on `main`. The catalog declares `idrive7-renderd`, `mgu-inputgate`, **GameStation Phone Port** (`mgu-game-net`) and **GameStation PCM Output** (`mgu-gamestation-audio`).
2. Open the app while parked. **Games** shows console counts, ROMs, refresh, delete and Continue. **Arcade** starts Pong without an upload. **Playing** offers Pause, Resume and Quit. Settings provide fit-to-stage and integer scaling in renderer coordinates.
3. Open **Controllers** and choose iDrive alone, one phone, two phones, or iDrive P1 plus phone P2. One-player systems use P1. Pair each phone using its own QR code over BMW Wi-Fi. The app prefers the IPv4 address of `wlan_bridge` and can discover a unique BMW hotspot address. If no such address is visible to OAP, it reports that in Controllers. The firewall helper keeps the port scoped to its existing BMW interface.
4. Open **Games** on a paired phone to upload, list, replace or delete ROMs. Uploads are capped at 8 MiB, expire after 60 seconds and run one at a time. The server identifies the format by its supported suffix and checks the applicable cartridge header or size before publishing the file.
5. Open **Diagnostics** for frame time, memory, FPS, connectivity, renderer setting, storage and audio status. Use Older and Newer to browse the bounded log. The newest page follows new events. Copy or download the text from the paired phone's Games panel.

The phone page selects the active console's controls and reconnects automatically. Input expires after 1.6 seconds of silence. The slot becomes available after 2.5 seconds. The iDrive game control maps tilt to directions, press to A, double press to Start, and long press to Select where applicable. Clockwise and counterclockwise steps are configurable in Settings. Choose one of two CHIP-8 iDrive presets or use all sixteen keys on the phone.

## Safety and storage

A game requires a valid Vehicle2 speed reading at or below 0.5 km/h from the last five seconds, plus a visible and focused game screen. An invalid signal immediately invalidates the previous reading. Loss of the gate stops audio, clears controls and saves battery RAM when available. The App Settings overlay and other pages hold the session. Sessions cap catch-up at two emulated frames and pause on errors and sustained frame overload. The original save directories and Continue data stay in place.

Deleting a ROM preserves `data/saves/<system>/<file>.sav` and all save states. A later import under the same name can find the same battery file. Save states are currently available for CHIP-8 and Super-CHIP from **Diagnostics**. Each slot is tied to the ROM SHA-256 and has a checksum and format version. Loading returns the game to a paused state. Files are written atomically in the application data directory. Only used console folders are created.

## Experimental game audio

GameStation takes samples directly from each emulator. The OAP process mixes to stereo, resamples in blocks to 48 kHz and applies game volume. The short-lived `mgu-gamestation-audio` child receives S16_LE PCM on stdin and dynamically loads `libasound.so.2` in its own process. The helper uses nonblocking ALSA and drops late excess samples. The emulator thread performs no ALSA calls. The child closes on mute, pause, focus loss, vehicle lock, game switch or quit. EOF or 160 ms without PCM also stops it. The requested driver buffer is 64 ms. The device supplies the negotiated buffer and period sizes. [Helper lifecycle](../../native/gamestation-audio/README.md)

Output is off by default. On a head unit with a verified dedicated ALSA playback source accessible to the OAP user, put the exact endpoint name on a single line in `audio-device.txt` in GameStation's app data directory. Enable **Game audio (experimental)** in Settings and choose **Game volume**. No BMW device name is built in. The helper rejects known reserved endpoints and ambiguous default or raw hardware aliases. **Play test tone** in Diagnostics is deliberately started by the operator, lasts at most one second and has a Stop control. It is available only with the same vehicle and focus gate.

Diagnostics reports the process state, selected device, format, pending Node bytes, negotiated ALSA buffer/period, ALSA's reported queue delay, underruns, discarded blocks and samples, helper errors, and the reported front BMW source. Acoustic end-to-end latency requires measurement on the target. GameStation only calls the AudioManager list methods. The ALSA endpoint therefore needs a usable route already provided by the target system. Closing the child releases GameStation's PCM handle without a global source switch or restoration that could overwrite a manual source choice.

### BMW audio reference comparison

| Reference | Audio path and source handling | Implication for GameStation |
|---|---|---|
| [RideTube](https://github.com/JustAnotherPU/ridetube/tree/29490dc/native/jap-ridetube-d) | Daemon uses SOME/IP CommandControl and BMW MediaPlayer, connects a fixed source/sink profile, and passes complete M4A files to `playFile`. It observes player time and releases by stopping playback and disconnecting, including stale-link handling. | Complete-file playback suits prerecorded media. Per-frame PCM would need a different transport. Firmware service IDs and cleanup assumptions are product-specific. |
| [Moonride PCM](https://github.com/JustAnotherPU/moonride/blob/1a8e89f/native/mgu-moonlight/src/audio.cpp) and [routing](https://github.com/JustAnotherPU/moonride/blob/1a8e89f/apps/jap_moonride/main.js) | Opus decoding feeds stereo 48 kHz S16_LE to a dynamically loaded ALSA backend. It recovers underruns, measures device/pending delay and drops late or full blocks. The app makes a firmware-specific source available and manages a separate AudioManager connection. | Continuous ALSA playback is the closest fit. Emulators already generate PCM. Moonride's selected source and measured SmartX periods need validation on the actual installation before reuse. |
| [MGU Media Client](https://github.com/leschi/mgu-media-client/blob/4cfaa8d/apps/media/oapmedia.js) | Discovers `OAPGenericMedia` and the front media sink, remembers the prior connection, plays a local path and only restores a prior connection if the sink is free. | Named source discovery and ownership checks are relevant to a future reserved route. `playFile` uses file-level playback. |
| [BMW AirPlay](https://github.com/pllanaio/bmw-airplay/blob/4604be3/apps/pllana_airplay/audio_route.js) | GStreamer sends PCM to a configured SmartX ALSA sink. The router checks a source/sink/connection tuple, releases its own connection and conditionally restores a uniquely identified available prior source. | Separating PCM from source ownership is useful. The endpoint and an app-owned connection depend on the target. |
| [Audio Diagnostics](../mgu_audio_diagnostics/README.md), [Equalizer](../equalizer/README.md), [Video Hub](../mgu_video_hub/README.md) | Diagnostics reads ALSA and SmartX metadata, the Equalizer provides explicit PCM filtering and a BMW MediaPlayer WAV test, and Video Hub already uses a child process to feed PCM to `aplay`. | The shared DSP socket filters PCM and leaves output to the client. The repository's native probe found `libasound.so.2` and the SmartX plugin on an x86-64 MGU while `aplay` was absent. This supports a small native child over an external `aplay` dependency or an in-process addon tied to the Node ABI. [Native probe](../../experiments/mgu_alsa/README.md) |

## Performance baseline

An x86-64 workstation running Node.js 8.17 measured 180 post-warmup synthetic frames per core in separate processes. RSS includes Node and emulator state. Timing includes the emulation and PCM extraction without the BMW renderer or ALSA device.

| System | Mean ms/frame | Process RSS |
|---|---:|---:|
| NES | 8.6 | 35 MiB |
| SNES | 36.2 | 35 MiB |
| Game Boy / Color | 10.4 | 70 MiB |
| Pong | <0.1 | 27 MiB |
| CHIP-8 | <0.1 | 27 MiB |
| Master System | 4.0 | 41 MiB |
| Game Gear | 4.5 | 42 MiB |
| Mega Drive | 0.6 | 33 MiB |

Removing SNES per-instruction diagnostic allocation lowered the synthetic frame cost from about 55 to 36 ms. This SNES case still misses a 60 Hz frame budget. The frame cap keeps video catch-up bounded and the PCM output stays aligned to the emulated frame duration. The measured host values are not head-unit predictions.

## Further platform investigations

- **Mega Drive**. The published mdcore v0.1.0 Wasm runs headlessly under modern Node but fails to decode under Node.js 8.17. The bundled MIT C source is built for the original WebAssembly feature set with Zig 0.14.1. That binary runs in Node 8 with no imports or browser APIs. It uses a 16 MiB linear memory and exports framebuffer, PCM, pad and SRAM functions. A separate x86-64 native probe also ran 600 synthetic frames with scripted input and video/PCM output. No second service is needed for the checked Node 8 path. [mdcore v0.1.0](https://github.com/andrewnakas/mdcore/tree/v0.1.0)
- **Atari 2600**. Javatari's AGPL-3.0 blocks direct bundling under GameStation's GPL-2.0 terms. Stella's GPL-2.0 native source is a candidate for a future headless port and license review. No Atari entry is shipped. [Javatari license](https://github.com/ppeccin/javatari.js/blob/f954960/license.txt) · [Stella license](https://github.com/stella-emu/stella/blob/master/License.txt)
- **Atari 7800, GBA and PC Engine**. EmulatorJS identifies ProSystem, mGBA and Beetle PCE as candidate cores. EmulatorJS is GPL-3.0 and has a browser runtime. mGBA's standalone license is MPL-2.0 and Beetle PCE's repository license is GPL-2.0. No ProSystem license grant was verified for the specific distributed core. Each build would need a source and dependency audit plus standalone input, video, PCM and performance tests before registration. SG-1000 would require a separate variant, mapper and video compatibility checks in the Sega adapter. [EmulatorJS core mapping](https://github.com/EmulatorJS/EmulatorJS/blob/5a65bde/data/src/consts.js) · [mGBA license](https://github.com/mgba-emu/mgba/blob/master/LICENSE) · [Beetle PCE license](https://github.com/libretro/beetle-pce-libretro/blob/master/COPYING)

## Source and local verification

GameStation uses GPL-2.0. See [NOTICE](NOTICE) and the accompanying licenses for MIT and GPL components. Contact points between the app and cores live in `core_registry.js` and `session.js`. Cores are lazy-loaded. Each session consumes the latest RGBA picture and the completed PCM block, and enables storage operations only for available capabilities. `tools/vendor_gamestation_sega.py` and `tools/vendor_gamestation_genesis.py` regenerate the new vendor builds. jsSMS was reviewed as a reference candidate and its GPL-3.0 implementation was excluded. No commercial game code or BIOS archives are included.

```sh
node tests/gamestation.test.js
node tests/gamestation_app.test.js
node tests/gamestation_net.test.js
GAMESTATION_NATIVE_AUDIO=1 node tests/gamestation_audio.test.js
python3 tools/build_store_app.py mgu_gamestation
```

The SDK-independent tests pass on Node.js 8.7, 8.17 and 24. They cover generated cartridges, adapters, saves, UI targets, speed/focus gates, the firewall contract and PCM conversion/lifecycle. A local Chromium run also exercised simultaneous WebSockets, upload, log download and reconnection. A local ALSA `null` run exercised the native binary, 48 kHz stereo negotiation, graceful stop, watchdog and device errors. The Store builder produced the local `.mgu` and `.tgz` with BMW OAP SDK 24.10.2. The SDK stays outside source control. Actual vehicle acceptance requires testing installation, BMW menu and renderer, two phones over BMW Wi-Fi, all input paths and interruption from Radio, Bluetooth, CarPlay, guidance and the voice assistant. Measure per-core load and end-to-end audio delay on that target before enabling output as a default.
