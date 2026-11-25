# MGU GameStation 0.8.1

GameStation runs retro games offline on BMW iDrive 7 with the MGU Node.js 8 OAP runtime. The BMW screen renders the games. The app-menu icon uses 98 × 81 visible artwork centred in its 140 × 140 transparent canvas. Phones provide controls and ROM management over the car's local Wi-Fi. Bring your own legally obtained ROMs. Pong and the original Mineworks Tycoon mini-game are built in, requiring no ROM upload.

## New in 0.8.1: Mineworks Tycoon

GameStation now includes **Mineworks Tycoon**, an independent original offline mining-management mini-game, not a port or redistribution of the commercial iOS application Idle Miner Tycoon. Select **MINES** under Games, then **Mineworks Tycoon**; no ROM is necessary. Start with a copper shaft, earn money automatically, unlock silver/gold/crystal shafts, upgrade the elevator and warehouse, hire managers for a +50% shaft bonus, and activate a temporary 2x boost. The display uses inexpensive vector drawing, including animated miners and lift. Touch the shafts or surface lift/depot to select, then use the on-screen UPGRADE/MANAGER buttons. With iDrive or the phone pad, use UP/DOWN to select, A to upgrade, B to hire and START to boost. Set controller mode to **iDrive singleplayer** if the physical knob should be the player-one controller. GameStation saves Mineworks progress on pause/exit and periodically during active play; returning after time away grants 18% of base earning rate for at most 8 hours. All actions remain subject to the existing parked-only game guard. The game is locally tested but has not yet been validated on a BMW MGU.

Run the targeted test with `node tests/gamestation_mine.test.js`.

## Compatibility

The PC column records synthetic-program tests with the host build of MGU Store's renderer and Mesa offscreen rendering. BMW installation, gameplay, controls, performance and speaker output are pending for 0.8.0 on every system. PC smoke tests cover engine and picture transport, with controller and storage assertions where noted in the test files. They do not certify an entire commercial ROM library.

| System | Core and formats | Video | Emulator PCM | Controllers | Storage | PC picture test | BMW test |
|---|---|---|---|---|---|---|---|
| NES | FCEUmm or nes-js, `.nes` | 256 × 240 | Stereo native / mono JS | 2 | Cartridge battery RAM | RGBA replay | Pending |
| SNES | jssnes, `.sfc`, `.smc` | 512 × 208 | Stereo, 32 kHz | 2 | Cartridge battery RAM | RGBA replay | Pending |
| Game Boy / Color | serverboy.js, `.gb`, `.gbc` | 160 × 144 | Stereo, about 44.15 kHz | 1 | Cartridge battery RAM | RGBA replay | Pending |
| Arcade | Original Pong | Vector graphics | Mono synthesized effects | 2 or CPU opponent | Last played | Vector replay | Pending |
| Mineworks | Original idle mine-management mini-game | Vector graphics | Mono synthesized effects | 1 (iDrive, phone or touch) | Auto-save and up to 8 hours offline income | Node economy/drawing tests | Pending |
| CHIP-8 / Super-CHIP | GameStation interpreter, `.ch8`, `.sc8` | 64 × 32 / 128 × 64 | Mono sound timer, 48 kHz | 1, 16-key phone keypad | 3 full-state slots | RGBA replay | Pending |
| Master System | jsmoo, `.sms` | 256 × 192 in fixture | PSG mono, 48 kHz | 2, buttons 1/2 and console Pause | — | RGBA replay | Pending |
| Game Gear | jsmoo, `.gg` | 160 × 144 | PSG stereo, 48 kHz | 1, buttons 1/2 and Start | — | RGBA replay | Pending |
| Mega Drive / Genesis | mdcore MVP WebAssembly, `.md`, `.gen` | 256 or 320 pixels wide | Stereo, rate from core | 2, three-button pads | Header-declared SRAM | RGBA replay | Pending |
| Game Boy Advance | gpSP, `.gba` | 240 × 160 | Stereo | 1, L/R | Cartridge save RAM | RGBA replay | Pending |
| Atari 2600 | Stella 2014, `.a26` | TIA video | Stereo PCM transport | 2 joystick ports | — | RGBA replay | Pending |
| Atari 7800 | ProSystem, `.a78` with header | MARIA video | Stereo PCM transport | 2 joystick ports | — | RGBA replay | Pending |
| PC Engine / TurboGrafx-16 | Beetle PCE Fast, `.pce` HuCard | VDC video | Stereo | 2 | Backup RAM | RGBA replay | Pending |
| Virtual Boy | Beetle VB, `.vb` | 2D display | Stereo | 1, two phone D-pads | Cartridge SRAM where supported | RGBA replay | Pending |
| WonderSwan / Color | Beetle WonderSwan, `.ws`, `.wsc` | Landscape or portrait | Stereo | 1, two phone D-pads | Cartridge SRAM/EEPROM where supported | RGBA replay | Pending |
| Neo Geo Pocket / Color | Beetle NGP, `.ngp`, `.ngc` | 160 × 152 | Stereo | 1, Option | Flash persistence open | RGBA replay | Pending |
| PlayStation | PCSX ReARMed, single-disc `.chd` (v5) or `.iso` | Software GPU | Stereo | 2 digital pads | One 128 KiB memory card per image | Original ISO / RGBA replay | Pending |

The Sega 8-bit path uses NTSC, direct cartridge boot and the standard Sega mapper. PAL timing, alternate mappers, FM sound, link cable and Sega 8-bit battery RAM are outside this implementation. Super-CHIP is selected by the `.sc8` suffix. CHIP-8 interpreter quirks vary across ROMs. The tests exercise selected opcodes, graphics and timers. Mega Drive emulation inherits the compatibility limits of mdcore 0.1.0 and exposes three-button controllers. Generic `.bin`, `.smd` and firmware dumps are outside the ROM registry.

## Installation and controls

1. In MGU Store install or update **Renderer** to **mgu-render 0.6.25** and restart the head unit so the running daemon advertises native `pixmaps`. Then install or update **GameStation Retro Cores 0.3.0**, **GameStation PCM Output 0.2.0** and **MGU GameStation 0.8.1**. The catalog also declares `mgu-inputgate`, **GameStation Phone Port** and **GameStation PCM Output**. If another renderer is present, use Diagnostics to check the selected protocol and capability. A renderer provider accepted by the Store can still lack native pixmaps. [Renderer release](https://github.com/robertnisipeanu/mgu-store/tree/mgu-render%400.6.25/native/mgu-render)
2. Open the app while parked. **Games** shows console counts, ROMs, refresh, delete and Continue. **Arcade** starts Pong without an upload. **Playing** offers Pause, Resume and Quit. Settings provide fit-to-stage and integer scaling in renderer coordinates.
3. Open **Controllers** and choose iDrive alone, one phone, two phones, or iDrive P1 plus phone P2. One-player systems use P1. Pair each phone using its own QR code over BMW Wi-Fi. The app prefers the IPv4 address of `wlan_bridge` and can discover a unique BMW hotspot address. If no such address is visible to OAP, it reports that in Controllers. The firewall helper keeps the port scoped to its existing BMW interface.
4. Open **Games** on a paired phone to upload, list, replace or delete games. Uploads run one at a time. Cartridge uploads expire after 60 seconds and are capped at 32 MiB for GBA and 8 MiB for the other cartridge systems. PlayStation disc uploads stream to disk, expire after 15 minutes and are capped at 800 MiB per image. The server checks the file header or size before publishing it.
5. Open **Diagnostics** for frame time, memory, FPS, connectivity, renderer setting, storage and audio status. Use Older and Newer to browse the bounded log. The newest page follows new events. Copy or download the text from the paired phone's Games panel.

Virtual Boy and WonderSwan show their second directional pad on the phone. The phone page selects the active console's controls and reconnects automatically. Input expires after 1.6 seconds of silence. The slot becomes available after 2.5 seconds. The iDrive game control maps tilt to directions, press to A, double press to Start, and long press to Select where applicable. Clockwise and counterclockwise steps are configurable in Settings. Choose one of two CHIP-8 iDrive presets or use all sixteen keys on the phone.

For PlayStation, use a phone for the full digital pad, including L2 and R2. Use a Mode 2 CHD v5 from your own disc for games with multiple tracks, or a 2048-byte-sector ISO for a single data track. The core uses its built-in HLE BIOS. Game compatibility, JIT permissions and sustained performance still need verification on an MGU.

## Safety and storage

A game requires a valid Vehicle2 speed reading at or below 0.5 km/h from the last five seconds, plus a visible and focused game screen. An invalid signal immediately invalidates the previous reading. Loss of the gate stops audio, clears controls and writes in-game saves when available. The App Settings overlay and other pages hold the session. JavaScript and Wasm sessions cap catch-up at two frames. Native sessions send one request at a time and discard in-flight output after focus or speed loss. Sessions pause on errors and sustained overload. The original save directories and Continue data stay in place.

Deleting a ROM preserves `data/saves/<system>/<file>.sav` and all save states. A later import under the same name can find the same battery file. Save states are currently available for CHIP-8 and Super-CHIP from **Diagnostics**. Each slot is tied to the ROM SHA-256 and has a checksum and format version. Loading returns the game to a paused state. Files are written atomically in the application data directory. Only used console folders are created.

## Game audio

0.7.0 defaulted to audio off. With audio enabled, it still needed `audio-device.txt` and an external route already in place. An absent device file kept the PCM process closed. The cause on any specific head unit requires its runtime diagnostics.

**Game Audio Output → Auto** looks for the dedicated **GameStationMedia** profile described below. **Game Audio Enabled** defaults on for fresh settings. Existing settings, including an explicit mute and Game Volume, are preserved. **Previously configured PCM** reuses an existing dedicated `audio-device.txt` endpoint with operator-supplied routing. **Off** closes the output. Initial game volume is 30%. The vehicle's normal volume control remains available. The speaker test is under **Diagnostics → Audio diagnostics → Test Speaker**, or open Audio Diagnostics from Settings. The test sends a low-level reference tone for up to 0.8 seconds after routing and ALSA negotiation. Setup and test time together are bounded to nine seconds. It can be stopped and does not save a new volume.

Auto requires all of the following on the head unit:

- An integrator-provisioned, GameStation-exclusive AudioManager source named `GameStationMedia`. Its paired playback endpoint is `smartx:GameStationMedia_CF_48_STEREO`. This profile is **unconfirmed on stock BMW firmware** and the app does not provision it.
- One available `MediaSink_Front`, with the IDs and availability discovered through CommandControl instance 1. Both the source and front sink must be free.
- A successful nonblocking ALSA probe and an acknowledged new connection that subsequently reports `CS_CONNECTED`. Playback is then gated on the PCM helper's format acknowledgement.

The app requests `getListMainSources`, `getListMainSinks`, `getListMainConnections`, `connect` and `disconnect`. An already occupied or ambiguous route stops setup. On pause, focus loss, loss of a current standstill reading, game switch or exit, the PCM helper drops queued audio and the app releases its confirmed connection by matching the connection, source and sink IDs. A connect whose result is unknown blocks further connects until restart. IDs from a previous process do not establish ownership, so startup leaves those routes alone. Audio errors keep the game playable. Transient failures have bounded retries. No RoutingControlObserver writes, OEM source availability changes, shared CarLife/CarPlay/Android Auto paths or BMW MediaPlayer file loop are involved.

Core PCM is converted to 48 kHz stereo S16_LE with gain and clipping protection. Mono is mirrored to both channels. The resampler retains its phase across blocks and discards history when the stream stops or stalls. PCM follows emulated time and the image output limit only affects video. NES, Sega and Game Boy skip output work when muted, and native cores can skip conversion of their PCM replies. The helper negotiates a 64 ms target and drops late blocks, bounds the ALSA queue, and retries the current block once on a recoverable underrun. Pong synthesizes effects for paddle, wall and point events. Audio Diagnostics distinguishes generated samples, ALSA open, AudioManager route status, queued frames and frames accepted by ALSA. Audible output is a manual test.

In the x86-64 Node.js 8.17 smoke test, the ALSA `null` plugin negotiated a 64 ms buffer and a 16 ms period at 48 kHz stereo. It accepted 18,400 PCM frames of the generated test sequence in one run. A host microbenchmark for 32 kHz stereo conversion (12,000 blocks in each of three runs per version) had a median of 0.0153 ms per block in 0.7.0 and 0.0145 ms in 0.8.0. These measurements cover PCM handling and buffer negotiation. Acoustic latency and SmartX buffer behavior on the BMW remain open.

### BMW audio references

| Reference | Observed behavior and decision |
|---|---|
| [RideTube](https://github.com/JustAnotherPU/ridetube/blob/eb0973bd8f6a3b90b52af4710b093e6afb1ca384/native/jap-ridetube-d/ytd.js) | Loads BMW SOME/IP service descriptions, initialises CommandControl and MediaPlayer proxies, waits for availability, connects source 1046 to sink 1024 and plays complete files. It watches player state, position and errors, retries startup, issues STOP before disconnect and sweeps its configured source on startup or uncertain release. GameStation uses bounded setup and confirmed ownership, leaving source-wide sweeping and fixed IDs out of the PCM path. |
| [Moonride PCM](https://github.com/JustAnotherPU/moonride/blob/1a8e89f99ca17a95ff428b8959dcf379077143db/native/mgu-moonlight/src/audio.cpp) and [routing](https://github.com/JustAnotherPU/moonride/blob/1a8e89f99ca17a95ff428b8959dcf379077143db/apps/jap_moonride/main.js) | Streams through `plug:smartx:CarLifeMedia_CF_48_STEREO`, measures delay and recovers ALSA underruns. Its regional workaround advertises CarLifeMedia as available through RoutingControlObserver. The PCM worker is a useful model and the CarLife source remains reserved for its current owner. |
| [MGU Media Client](https://github.com/leschi/mgu-media-client/blob/4cfaa8dfa7193c39e268d2a45fd4357bf796fc00/apps/media/oapmedia.js) | Discovers OAPGenericMedia and the front sink by name, and uses BMW MediaPlayer. This establishes a file-player route on its tested system. |
| [BMW AirPlay](https://github.com/pllanaio/bmw-airplay/blob/4604be3b62909201d39de30c23bcba3081887b7b/apps/pllana_airplay/audio_route.js) | Uses a specific combined eight-channel SmartX endpoint and conditionally restores a previous route. That shared output and its channel profile are outside the GameStation PCM contract. |
| [Audio Diagnostics](../mgu_audio_diagnostics/README.md), [Equalizer](../equalizer/README.md), [Video Hub](../mgu_video_hub/README.md) | Provide read-only SmartX/ALSA evidence, an AudioManager ownership example for BMW MediaPlayer file playback, and a bounded media-child pattern. GameStation retains its own unprivileged native PCM worker. |

References were reviewed at the linked commits. RideTube, Moonride and BMW AirPlay carry GPLv3 licence texts and MGU Media Client uses MIT. GameStation's implementation uses its own source and the existing repository helpers.

## Game display modes

**Standard** keeps the two game panels. **Fullscreen** fills the app's content area, with a small Game Menu target. **Immersive** suppresses app navigation tabs and uses any additional vertical content area offered by native Full layout. BMW's status, back/home controls, Settings access, and the BMW app bar stay available. On a layout without this native capability, Immersive uses the regular full content area. There is no second renderer or additional pixel copy when changing mode.

**Game Scaling** offers Aspect Ratio, Integer Scaling, Fill / Crop (centred clipping) and Stretch (distorted aspect). Use **Start games in fullscreen** to apply the selected mode on launch. Changing display mode in Settings or leaving fullscreen from Game Menu preserves the current session and saves.

Open the menu by tapping the game area in native Full layout, using its **Game Menu** target, using the BMW **Game menu** app action or pressing **Game Menu** on a paired controller. The menu holds emulation and hands iDrive back to the app UI. Resume or close the menu to continue. An iDrive player holding gameplay controls can use BMW Back/Menu and re-enter the app. GameStation preserves every existing gameplay button mapping. Safety and error holds keep exit controls available.

## GPU video and performance

GameStation 0.6.0 selected the native protocol for its UI. Its client skipped pixel upload in that dialect and sent op 18 using the upstream field order. The native renderer therefore had neither a texture nor the right coordinates and ID. Pong uses vector operations which take neither of those paths. In the repair, one app connection owns chrome, input and the game texture. `X_READY` advertises pixmaps, `X_PIXMAP` defines the nearest-filtered texture, `X_PIXELS` uploads complete top-down RGBA updates, and native op 18 references the same ID. Game frames are opaque. The diagnostic pattern exercises premultiplication for transparent pixels. Quitting drops the texture and the app's staged pixels. Reconnection recreates resources when needed.

| Transport | Compatibility and trade-offs |
|---|---|
| Native pixmaps (used) | Supported by the existing MGU Store renderer. One reusable texture per picture, no color conversion for opaque frames, one bulk copy into the socket message. NES RGBA payload is about 7.0 MiB/s at 30 FPS and 14.1 MiB/s at 60 FPS. Renderer and head-unit throughput still need measurement. Other apps keep their own connections and resources. |
| Video Hub shared memory | The renderer supports I420 and, with its capability, NV12. This path would use smaller frame slots but needs RGB-to-YUV conversion, chroma subsampling, a ring and slot lifecycle. Its 15 FPS application pacing is independent of the renderer's protocol. There is no RGBA or positive per-slot presentation acknowledgement in this video protocol. |
| Separate renderer connection | An upstream connection can transport opaque RGBA but lacks the native UI and foreground contract. A second surface would need independent coordination of placement, chrome, input, focus and reconnect, with additional renderer resources. |

**Settings → Video FPS Limit** offers Auto, 60, 30 and 20 FPS. Auto stages up to 30 FPS and backs off toward 20 when the core exceeds its frame budget or the socket backs up. The setting limits image updates. The emulation clock and PCM use the core's timing. During load, the newest complete image takes precedence. Diagnostics reports effective emulation speed separately and pauses on sustained slow frames after a warm-up. Renderer capability, connection and image errors have separate messages.

Conventional iNES NROM, MMC1 and MMC3 cartridges can use native FCEUmm on Linux x86-64. Other ROM headers or mappers, missing helpers and failed native startup can use nes-js. The native helper verifies the expected save length before the first frame. A renderer change does not change the library, existing SRAM paths or CHIP-8 state slots.

Host measurements on one synthetic NES cartridge after warmup, without display or ALSA:

| Path | Mean time per frame | Measurement |
|---|---:|---|
| 0.6.0 nes-js / Node 8.17 | 8.12 ms | 360 frames, PCM extraction |
| 0.7.0 nes-js / Node 8.17 | 8.13 ms with PCM, 7.91 ms muted | 360 frames each |
| 0.7.0 x86-64 FCEUmm helper | 0.39 ms | 1,200 frame requests, full RGBA and PCM replies read via pipes, helper RSS 6.4 MiB |

A Node 8.17 sampling profile of the JS path attributed approximately 69% to the PPU (including pixel work), 19% to the CPU (including mapper and memory operations), 6% to the APU, 6% to tick or inlined work, and less than 1% to GC. The profile combined pixel writes with the PPU. Renderer enqueue time is measured separately at runtime. These results do not predict performance on the BMW or measure end-to-end latency there. In a 20-second Node 8.17 host soak with the native helper and a mock transport sink, the helper completed 1,200 frames and the client queued 600 images. App RSS sampled every 150 frames ranged from 38 to 71 MiB and ended at 57 MiB. Long-duration memory and display performance on the MGU are pending.

## Further platform investigations

- **Mega Drive**. The published mdcore v0.1.0 Wasm runs headlessly under modern Node but fails to decode under Node.js 8.17. The bundled MIT C source is built for the original WebAssembly feature set with Zig 0.14.1. That binary runs in Node 8 with no imports or browser APIs. It uses a 16 MiB linear memory and exports framebuffer, PCM, pad and SRAM functions. A separate x86-64 native probe also ran 600 synthetic frames with scripted input and video/PCM output. No second service is needed for the checked Node 8 path. [mdcore v0.1.0](https://github.com/andrewnakas/mdcore/tree/v0.1.0)
- **Nintendo 64 and Nintendo DS.** Host probes rendered original demo content using software cores. N64 still needs analog and C-button controls and a larger save buffer. DS needs phone stylus input and persistent saves. Their head-unit timing and memory budget are open.
- **PlayStation 2, PSP, GameCube and Wii.** PCSX2, PPSSPP and Dolphin are separate native emulator projects. Rendering backends, architecture requirements, storage and sustained performance would need testing on the target. Wii also needs controller mapping for pointer or motion input. The GameStation renderer receives software frames from its cores.
- **Pokémon Mini.** The PokeMini test core booted locally. Its GPL-3.0-or-later license calls for a separate compatibility review before combining it with this GPL-2.0 worker. [PokeMini license](https://github.com/libretro/PokeMini/blob/132111b/LICENSE)
- **SG-1000 and other cartridge platforms.** Future candidates can use the same native frontend after a compatible core and license review. [EmulatorJS core mapping](https://github.com/EmulatorJS/EmulatorJS/blob/5a65bde/data/src/consts.js)

## Source and local verification

GameStation uses GPL-2.0. See [NOTICE](NOTICE) and the accompanying licenses for MIT and GPL components. Contact points between the app and cores live in `core_registry.js` and `session.js`. Cores are lazy-loaded. Each session consumes the latest RGBA picture and the completed PCM block, and enables storage operations only for available capabilities. The native libraries, build recipe and exact sources are documented with the Store tool. [Native core sources](../../native/gamestation-retro/README.md) jsSMS was reviewed as a reference candidate and its GPL-3.0 implementation was excluded. No commercial game code or BIOS archives are included.

```sh
node tests/gamestation.test.js
node tests/gamestation_app.test.js
node tests/gamestation_net.test.js
GAMESTATION_NATIVE_AUDIO=1 node tests/gamestation_audio.test.js
node tests/gamestation_retro.test.js
python3 tools/build_store_app.py mgu_gamestation
```

The PC suite covers original programs, core adapters, saves, UI targets, fresh-speed/focus gates, the phone firewall contract and PCM conversion. For renderer replay set `MGU_RENDER_REPLAY` to a host build of MGU Store Renderer 0.6.25 and run `node tests/gamestation_gpu.test.js`. Include PlayStation by generating an original test ISO with `python3 tests/gamestation_ps1_fixture.py /tmp/gamestation-test.iso` (requires `pycdlib`) and setting `MGU_PS1_TEST_ISO` to that absolute path. The app package build requires BMW's `oap-sdk/index.js` and `package.json` outside source control.

### BMW acceptance (manual)

1. Install Renderer 0.6.25, restart the head unit, then install PCM Output 0.2.0, Retro Cores 0.3.0 and GameStation 0.8.0. The local Store build still requires the BMW OAP SDK.
2. Confirm a dedicated GameStationMedia mapping from the unit's integrator or collect the Audio Diagnostics log showing what the current firmware exposes. While parked and with the front media sink free, run **Test Speaker**. Verify actual device and BMW connection IDs, compare queued and ALSA-written frames, and manually confirm audible output and the vehicle volume control.
3. Play legal test programs for the systems in the compatibility table. Check mono centring, stereo channel placement, pitch and sync at 20, 30 and 60 FPS output, and compare underruns and delay. Play Pong and check all three effects. Exercise rapid pause/resume, firmware media-source changes, focus loss, loss of valid speed, restart, exited app and unavailable device. Confirm only GameStation's own link disappears and concurrent phone, CarPlay/Android Auto, voice guidance and warning sounds remain available.
4. Compare Standard, Fullscreen and Immersive in both BMW layouts. Test scaling and the menu via touch, the BMW action, iDrive navigation and the paired phone. With the phone disconnected, use BMW Back/Menu and reopen. Verify safety holds, return to Games and unchanged save data. Repeat the Diagnostics GPU-pattern checks and reload Zelda's battery save.
