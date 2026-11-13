# Static ELF findings: libNmeAudioDevice.so (2026-11-14)

## Input and reproducibility

Analysed the user-provided original binary **only offline** using `file`, `readelf -h/-d/-Ws/-V`, `objdump -d -C`, `nm -D`, and `strings`. The binary itself is **not** committed or distributed.

- File: `/usr/lib/cinemo/libNmeAudioDevice.so`
- SHA256: `69fce7fa375d09ed8ace592ecb3647a526b8e3c79c5a97751815c4fb8cfe9bde`
- GNU Build ID: `71e3eb2286cbd6872c89cf28f81c15e043e86035`
- Size: 347400 bytes; 64-bit x86-64 ELF shared object, stripped.
- NEEDED: `libasound.so.2` plus Cinemo, libc, C++ runtime and other libraries.
- ALSA imports use symbol versions `ALSA_0.9` / `ALSA_0.9.0rc4`. The binary's imported GLIBC symbols include versions up to `GLIBC_2.14`; the user measured `/lib/libc-2.27.so` on the HU.

## Verified instructions / symbol references

The following are **static machine-code observations**, not runtime measurements:

| Address (offset in ELF) | Observation |
|---|---|
| `0x36fd6` | synchronous playback path calls `snd_pcm_open` with the device name taken from runtime state |
| `0x3721f-0x37227` | the synchronous path requests `snd_pcm_hw_params_set_access(..., 3)` = `SND_PCM_ACCESS_RW_INTERLEAVED` |
| `0x37255-0x37264` | one format-selection case requests `snd_pcm_hw_params_set_format(..., 2)` = `SND_PCM_FORMAT_S16_LE` |
| `0x372b4-0x372ba` | sample rate is requested using `snd_pcm_hw_params_set_rate_near` with a value originating in the audio device's runtime state |
| `0x3b2c9` | asynchronous playback path calls `snd_pcm_open` |
| `0x3b384-0x3b39e` | asynchronous path reads the URL integer parameter `try_mmap_access` with a default argument of `0`; a nonzero result enters its MMAP branch |
| `0x3bb01-0x3bb10` | async fallback/ordinary path requests access code `3` = `RW_INTERLEAVED` |
| `0x3bc8a-0x3bc96` | async MMAP preference requests access code `0` = `MMAP_INTERLEAVED` |
| `0x3b3f0-0x3b3fa` | async format choice calls `snd_pcm_hw_params_set_format`; it supports multiple input-format selection cases |
| `0x3b44a-0x3b450` | async sample-rate selection calls `snd_pcm_hw_params_set_rate_near` |
| `0x33b58` | a playback write path calls `snd_pcm_writei` |
| `0x39527-0x39534` | async playback checks a stored mode flag and calls `snd_pcm_mmap_writei` or `snd_pcm_writei` |
| `0x39438` | async MMAP write call |
| `0x39534` | async RW write call |

`snd_pcm_hw_params_get_access`, `snd_pcm_hw_params_get_format`, `snd_pcm_hw_params_get_channels`, and `snd_pcm_hw_params_get_rate` are actual imported dynamic symbols, not just string constants. The library **does not import `snd_pcm_mmap_begin` or `snd_pcm_mmap_commit` directly**; this does not exclude indirect use in other libraries.

The `NmeSinkAsyncALSA` debug strings include `src/NmeAudioDevice/src/NmeSinkAsyncALSA.cpp`, `try_mmap_access`, both access negotiation modes, and both playback calls. The URL parameter's value for CarPlay is **not present** in the binary.

## Limits and consequences for the live EQ

- The car's existing `/proc/<carplay-pid>/maps` confirms that `CarPlayMain_CF_48_STEREO` SmartX connection and ringbuffer are mapped in the CarPlay process. **It does not reveal the `snd_pcm_open()` argument string, active ALSA PCM access mode, negotiated format, or actual writing branch.**
- AudioManager reporting `CarPlayMedia` -> `MediaSink_Front` shows a registered main route, **not** direct read/write access to its PCM.
- `CF_48_STEREO` suggests a 48kHz stereo endpoint by naming convention, **not measured ALSA format**. The source library has both S16 and other format cases and uses the actual runtime rate.
- An isolated mock test in `carplay_live_filter.c` proves that our 7-band filter can process the two intercepted calls on synthetic 48kHz S16 stereo input, **not** that it is ready to inject into production CarPlay.
- The user also reported intermittent OEM cluster music metadata/control loss. This increases the importance of not restarting, injecting, or overriding `carplay.service` (which reports `Restart=no`) before verified, reversible vehicle-side instrumentation.
- The current prototype's exact `smartx:CarPlayMain_CF_48_STEREO` match, negotiated format gate, absence of PCM data logging, opt-in defaults, and fail-open behavior must all be retained in any future implementation.

## Safe next observations

1. Inspect **existing** Cinemo/CarPlay journal lines (if logged) for the exact `snd_pcm_open()` path, `try_mmap_access`, PCM format/rate/channel negotiation, without enabling verbose logging or restarting services.
2. If existing logs don't expose negotiation, a purpose-built **read-only runtime format sampler** must be validated in a local harness and security-reviewed separately. Installing an ALSA preload hook into the live CarPlay service is not an acceptable diagnostic shortcut.
3. Only then test a control-plane connection from Equalizer to a native EQ runtime with latency benchmarks, call-mode coverage, and rollback. Do not claim a live installable equalizer until real CarPlay output has been verified.

## Useful offline verification

```sh
readelf -Ws --wide libNmeAudioDevice.so | grep -E 'snd_pcm_(writei|mmap_writei|hw_params_set_access|hw_params_get_access)'
objdump -d -C libNmeAudioDevice.so | grep -E 'call.*<snd_pcm_(writei|mmap_writei|hw_params_set_access)@plt>'
sha256sum libNmeAudioDevice.so
```
