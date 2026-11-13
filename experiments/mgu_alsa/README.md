# MGU ALSA / SmartX native diagnostic (experimental)

**No vehicle audio playback.** This experiment is intentionally separate from the installed Equalizer 0.2.3 and its DSP service. It does not change CarPlay, Waze, systemd, SmartX configuration, or AudioManager routing.

This source builds a small Linux x86-64 C tool that uses the MGU's existing `libasound.so.2` at runtime (via `dlopen`) without requiring ALSA development headers.

## Commands

```sh
make
./mgu-audio-probe --status
./mgu-audio-probe --hints
./mgu-audio-probe --test-null
```

- `--status` (default) reports sound-card metadata and **only the file ownership and permissions** of named SmartX `/dev/shm/*_connection` endpoints. It does not read SmartX ringbuffers or open a PCM.
- `--hints` uses ALSA's documented `snd_device_name_hint` API to list PCM *names*. It does **not** call `snd_pcm_open`.
- `--test-null` opens the ALSA built-in `null` PCM and **verifies that the returned PCM type is NULL before writing** 48,000 stereo S16_LE frames (1 s, 48 kHz). All audio is discarded. If `null` is unavailable or incorrectly configured, the test aborts. The hardcoded PCM name cannot be overridden through CLI arguments.

No BMW/CarPlay/Android Auto/ringing/voice channel can be selected in this program. **Do not use a real SmartX endpoint as a substitute for `null`.**

## Vehicle evidence collected so far

MGU is `x86_64`, and `libasound.so.2` plus `libasound_module_pcm_smartx.so` are present, but `aplay` and `ffmpeg` are not installed. `AlsaRoutingAdapters` has the ringbuffer for `MediaSink_AudioOut_Front_CF_48_COMBINED_STEREO_MULTICHANNEL` mapped. The SmartX shared-memory group is `mgu_alsa` (917), and the `MediaSink` is managed by BMW's media engine. The visible hardware sound-card playback devices are for Bluetooth HFP. None of this establishes an available independent media source.

The DSP service (`mgu-equalizer-dsp`) has a separate socket and runs with group 12202. Changing that group's permissions or writing to BMW's SmartX ringbuffers is **not** part of this experiment.

## Building for the vehicle

MGU has no installed `gcc`/`cc`/`clang`. Cross-compile on an **x86-64 Linux build environment with a suitably old glibc**; modern workstation-built dynamically linked binaries may require a newer glibc and fail with `GLIBC_x.y not found`. Running this source under GitHub CI confirms function, but a CI-built binary is *not automatically MGU-compatible*.

The first on-MGU run should be `--status`, without root when possible. If the executable fails to start, collect the error; do not replace system libraries or use `LD_PRELOAD` to force loading. Run `--test-null` only while parked and after confirming the `null` PCM type check is present.

## What's still required for audible Night Drive music

An **AudioManager-registered, permitted dedicated entertainment media source** must be found or created, and its connection through SmartX/AVB to the car speakers verified. Merely opening the MediaSink or CarPlay PCM from a second process is unsafe, and neither the current app nor this tool does it. Once a safe route is identified, the existing test-music PCM generator can be piped through `mgu-equalizer-dsp` and a separately enabled output player. Neither system audio nor CarPlay is touched until then.

ALSA name hint API: https://alsa-project.org/alsa-doc/alsa-lib/group___hint.html

### Downloadable experimental x86-64 binary

The separate `legacy_x86_64` GitHub Actions job compiles with an older GCC container and attaches `mgu-audio-probe-x86_64-experimental` as a downloadable artifact. This is **not** installed through MGU Store and its compatibility with the car's glibc is not verified. Only execute after inspecting `ldd --version` (if available) and matching the required glibc versions shown in the workflow build log. Downloading a CI artifact requires opening the workflow run on GitHub. The safest initial test is `./mgu-audio-probe --status`; it performs no audio playback.
