# CarPlay DSP – native PCM filter experiment

This source tree contains the native seven-band peaking DSP and an isolated ALSA interposer for synthetic PCM tests. It builds on a development PC without BMW binaries. The managed MGU DSP component is the separate Node.js service 0.2.2. The prototype starts in bypass and ships without a vehicle installer. [Live DSP experiment](CARPLAY_LIVE_DSP.md)

The separate [ALSA_ROUTE_PROBE.md](ALSA_ROUTE_PROBE.md) describes an additional
**offline-only pass-through ALSA route detector**. Its mock test verifies that
the intended CarPlay PCM name can be identified while unrelated audio streams
remain untouched. The detector is not connected to the EQ filter and is not
safe to deploy in the vehicle without additional compatibility work.

## Offline test

```sh
gcc -std=c11 -Wall -Wextra -Werror -O2 -o test_eq_dsp eq_dsp.c test_eq_dsp.c -lm
./test_eq_dsp
```

The test checks bit-exact S16 bypass, left/right isolation, expected +6 dB
response at 44.1/48 kHz, headroom, parameter validation and crossfade.
It does **not** demonstrate that stock CarPlay audio is filtered.

## Evidence and remaining work

On the user's MGU, `/dev/shm/smartx_CarPlayMain_CF_48_STEREO_p_ringbuffer`
appeared during CarPlay music playback. `libNmeAudioDevice.so` imports and
calls both `snd_pcm_writei` and `snd_pcm_mmap_writei`. These facts identify
candidate PCM insertion points, but not the exact runtime branch or PCM
sample format. Before any vehicle test:

1. Confirm the actual CarPlay stereo format and write mode at runtime.
2. Determine a reversible, per-process insertion mechanism that cannot touch
   telephony, alerts, BMW audio or other SmartX streams.
3. ~~Implement configuration transfer from the existing DSP service without
   blocking an audio callback.~~ Done offline as the snapshot bridge, see
   [CARPLAY_LIVE_DSP.md](CARPLAY_LIVE_DSP.md); MGU timing still unmeasured.
4. Validate with dummy ALSA and stress/latency tests before parking-lot testing.
5. Keep playback fail-open and disabled by default, with a documented rollback.

Do **not** load this code into `/usr/bin/carplay` or modify MGU launch units.
