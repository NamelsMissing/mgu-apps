# Live CarPlay DSP – isolated offline prototype

**Status: implemented and tested only with fake ALSA. NOT installed in the car.** The existing Equalizer 0.2.4 and its live DSP daemon remain unchanged. This prototype does not modify `carplay.service`, inject into `/usr/bin/carplay`, change the BMW AudioManager, or register an audio stream. It does not yet provide audible live EQ on the user's MGU.

## Findings

- Recorded BMW AudioManager connection: `CarPlayMedia` (266) -> `MediaSink_Front` (1024). This demonstrates AudioManager routing, not a PCM capture API.
- CarPlay stereo SmartX candidate: `smartx:CarPlayMain_CF_48_STEREO`. It is not proven that all CarPlay music uses precisely this handle.
- From the user-supplied Cinemo `libNmeAudioDevice.so` binary, ALSA imports `snd_pcm_writei` and `snd_pcm_mmap_writei` as well as RW and MMAP interleaved access selection. `libNmeCarPlay.so` lists multiple PCM16/PCM24 configurations. **Runtime ALSA format and call mode on the car have not been measured.**

## What's now implemented

`carplay_live_filter.c` is a test-only interposer that:
- Watches only playback opening the exact named SmartX candidate, never PCM from any other ALSA handle.
- Starts **disabled**, even if a process were to load the library.
- Can be armed only from an explicit **in-process** test function, after a successful `snd_pcm_hw_params` negotiation of exactly 48 kHz, 2-channel, S16_LE (format code 2). There is **no remote/car controller that calls this function**.
- Uses the existing native 7-band `eq_dsp.c` for actual S16 PCM filtering while forwarding the underlying ALSA calls. The caller's PCM input buffer is untouched.
- Fails open for wrong format, non-target streams, oversized blocks, DSP errors, concurrent audio callbacks, and unsupported MMAP; MMAP disables the experiment.
- Handles short ALSA writes by restoring DSP state then advancing only by the accepted frames, without changing return values.
- Can be disarmed without restarting ALSA in mock tests.

**This is a code-level prototype, not a field-ready injection mechanism.** In particular, the 48-kHz S16 format and write mode are assumptions for testing, and the `mgu_cp_live_arm()` in-process API is not connected to the existing Node DSP's live settings. Potential CarPlay audio mixing, phone calls, notifications, mmap modes, and service stability are unverified. No MGU build artifact or installer is supplied.

## Build and test on a development PC

```sh
cd experiments/carplay_alsa
mkdir -p build
cc -std=c11 -O2 -Wall -Wextra -Werror -fPIC -shared -o build/libfakealsa_live.so fake_alsa_live.c -lm
cc -std=c11 -O2 -Wall -Wextra -Werror -fPIC -shared -o build/libmgu_cp_live.so carplay_live_filter.c eq_dsp.c -ldl -lm -pthread
cc -std=c11 -O2 -Wall -Wextra -Werror -o build/test_cp_live test_carplay_live.c -Lbuild -lfakealsa_live -lmgu_cp_live -lm -pthread -Wl,-rpath,'$ORIGIN'
LD_PRELOAD=./build/libmgu_cp_live.so ./build/test_cp_live
```

The test verifies actual gain on 100-Hz stereo samples, exact-device isolation, default bypass, on-the-fly reconfiguration, short-write recovery, MMAP rejection and fail-open on format mismatch, without BMW hardware.

## What must happen before real vehicle installation

1. **Read-only verification on the actual HU** of CarPlay audio PCM format (S16, S24 or other), 48-kHz frame rate, access mode (RW vs MMAP), thread/concurrency behavior, and source-name ownership. Observing a SHM pathname or ALSA symbols alone is insufficient.
2. Rework/extend PCM interception for the actual tested mode (especially MMAP) and verify latency, thread safety, partial writes, timeouts, and system stability in an isolated harness.
3. Implement a bounded, versioned, realtime-safe snapshot bridge from the existing DSP control service to native EQ filters; never block ALSA callbacks on Node, JSON, sockets, file I/O or locks.
4. Conduct a parked-only, reversible test with an explicit manual enable gate; isolate alerts, phone and emergency channels. Include a documented rollback that restores unmodified CarPlay immediately on a fault.
5. Only after verified stock CarPlay music output should this become an optional MGU Store component, **disabled by default** and isolated to CarPlay music.

The standalone BMW OAP media source `OAPGenericMedia` (1046) is also under investigation as a safer future test-music playback route; its registration in AudioManager alone does not grant PCM write access.
