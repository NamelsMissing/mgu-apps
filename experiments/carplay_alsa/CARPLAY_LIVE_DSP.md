# Live CarPlay DSP – isolated offline prototype

**Status: fake ALSA only.** The DSP daemon 0.2.2 publishes a snapshot for the offline tests. The native interposer is outside the Store component and no vehicle process uses it. [Integration report](../../docs/equalizer-audio-integration.md)

## Findings

- Recorded BMW AudioManager connection: `CarPlayMedia` (266) -> `MediaSink_Front` (1024). This demonstrates AudioManager routing, not a PCM capture API.
- CarPlay stereo SmartX candidate: `smartx:CarPlayMain_CF_48_STEREO`. It is not proven that all CarPlay music uses precisely this handle.
- From the user-supplied Cinemo `libNmeAudioDevice.so` binary, ALSA imports `snd_pcm_writei` and `snd_pcm_mmap_writei` as well as RW and MMAP interleaved access selection. `libNmeCarPlay.so` lists multiple PCM16/PCM24 configurations. **Runtime ALSA format and call mode on the car have not been measured.**

## What's now implemented

`carplay_live_filter.c` is a test-only interposer that:
- Watches only playback opening the exact named SmartX candidate, never PCM from any other ALSA handle.
- Starts **disabled**, even if a process were to load the library.
- Can be armed only from an explicit **in-process** test function, after a successful `snd_pcm_hw_params` negotiation of exactly 48 kHz stereo, using S16_LE (2), S24_LE (6, four bytes per sample), or S24_3LE (32, three bytes per sample) with either RW_INTERLEAVED (access 3) or MMAP_INTERLEAVED (access 0). There is **no remote/car controller that calls this function**.
- Uses the existing native 7-band `eq_dsp.c` for S16 and S24 PCM filtering while forwarding the underlying ALSA calls. The caller's PCM input buffer is untouched.
- Fails open for wrong format, non-target streams, oversized blocks, DSP errors, concurrent audio callbacks, and unsupported access mode; if RW and MMAP calls are unexpectedly mixed, filtering is disarmed.
- Handles short ALSA writes by restoring DSP state then advancing only by the accepted frames, without changing return values.
- Can be disarmed without restarting ALSA in mock tests.

**This is a code-level prototype, not a field-ready injection mechanism.** In particular, 48-kHz S16 and whether Cinemo uses exactly these exported write functions remain assumptions for testing. Potential CarPlay audio mixing, phone calls, notifications, mmap modes, and service stability are unverified. No MGU build artifact or installer is supplied.

## Snapshot bridge (roadmap step 3, implemented offline)

The interposer now follows the settings of the existing Node DSP service without any IPC on the audio path:

```
Equalizer app --control.sock--> mgu-equalizer-dsp 0.2.2
                                  | atomic write (tmp + fsync + rename)
                                  v
                    /run/mgu-equalizer-dsp/carplay.snapshot   (204 B, v1, CRC-32)
                                  | bridge thread / poll (non-realtime: open, read, validate)
                                  v
                    wait-free triple buffer (one atomic exchange per side)
                                  | consumed at the start of a target write
                                  v
                    audio thread: 25 ms crossfade into the new filter bank
```

- **Format**: `native/equalizer-dsp/snapshot.js` and `eq_snapshot.c` implement the same layout. CI writes fixtures from Node and checks that the C encoder produces byte-identical files and that the parser rejects corrupt, truncated, unknown-flag, out-of-range and symlinked files.
- **Audio thread**: no I/O, no allocation and no blocking lock. It never touches the bridge lock; it only exchanges the triple-buffer index and, on a change, rebuilds seven biquads and warms them with the stored history. The native path has not been timed on the MGU CPU. The callback still includes the original ALSA write and the bound applies only to DSP block size, not to driver scheduling.
- **Behaviour**: valid + enabled arms with a crossfade from exact bypass or reconfigures; valid + disabled (app Bypass) fades out and then disarms to bit-exact pass-through; a missing or corrupt file behaves like disabled. **Deleting the snapshot is therefore a rollback lever.** A reopened or renegotiated CarPlay stream inherits the newest configuration.
- **Bridge stop** publishes bypass and the next callback finishes the transition to pass-through.
- **Manual gate**: the bridge thread starts only through `mgu_cp_live_bridge_start()` or when the host process has `MGU_CP_LIVE_SNAPSHOT=<path>` set while opening the exact target PCM. Nothing in the repository sets this variable or loads the library.
- **Evidence**: `test_carplay_bridge.c` covers the cases above plus a concurrent producer/audio stress test, which CI also runs under ThreadSanitizer.

## Build and test on a development PC

```sh
cd experiments/carplay_alsa
mkdir -p build
cc -std=c11 -O2 -Wall -Wextra -Werror -fPIC -shared -o build/libfakealsa_live.so fake_alsa_live.c -lm
cc -std=c11 -O2 -Wall -Wextra -Werror -fPIC -shared -o build/libmgu_cp_live.so carplay_live_filter.c eq_dsp.c eq_snapshot.c -ldl -lm -pthread
cc -std=c11 -O2 -Wall -Wextra -Werror -o build/test_cp_live test_carplay_live.c -Lbuild -lfakealsa_live -lmgu_cp_live -lm -pthread -Wl,-rpath,'$ORIGIN'
cc -std=c11 -O2 -Wall -Wextra -Werror -o build/test_cp_bridge test_carplay_bridge.c -Lbuild -lfakealsa_live -lmgu_cp_live -lm -pthread -Wl,-rpath,'$ORIGIN'
cc -std=c11 -O2 -Wall -Wextra -Werror -o build/test_eq_snapshot test_eq_snapshot.c eq_snapshot.c eq_dsp.c -lm
LD_PRELOAD=./build/libmgu_cp_live.so ./build/test_cp_live
LD_PRELOAD=./build/libmgu_cp_live.so ./build/test_cp_bridge /tmp
mkdir -p build/fixtures && node ../../tests/equalizer_snapshot.test.js --fixture build/fixtures && ./build/test_eq_snapshot build/fixtures
```

The test verifies actual gain on 100-Hz stereo samples, exact-device isolation, default bypass, on-the-fly reconfiguration, short-write recovery, mode-specific RW/MMAP filtering, mismatch rejection, and fail-open on format mismatch, without BMW hardware.

## What must happen before real vehicle installation

1. **Read-only verification on the actual HU** of CarPlay audio PCM format (S16, S24 or other), 48-kHz frame rate, access mode (RW vs MMAP), thread/concurrency behavior, and source-name ownership. Observing a SHM pathname or ALSA symbols alone is insufficient.
2. Verify interception for the actual tested mode (including direct mmap_begin/commit paths if used) and verify latency, thread safety, partial writes, timeouts, and system stability in an isolated harness.
3. ~~Implement a bounded, versioned, realtime-safe snapshot bridge from the existing DSP control service to native EQ filters.~~ Done offline (see above). Still open: CPU cost on the MGU, and read access of the CarPlay process to `/run/mgu-equalizer-dsp` (currently `0770`, group 12202).
4. Conduct a parked-only, reversible test with an explicit manual enable gate; isolate alerts, phone and emergency channels. Include a documented rollback that restores unmodified CarPlay immediately on a fault.
5. Only after verified stock CarPlay music output should this become an optional MGU Store component, **disabled by default** and isolated to CarPlay music.

Equalizer 0.3.0 uses the separate `OapGenericMedia` MediaPlayer instance for local A/B files. The MediaPlayer contract provides file playback and transport controls. [Integration report](../../docs/equalizer-audio-integration.md)
