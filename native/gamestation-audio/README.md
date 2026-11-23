# GameStation PCM Output 0.1.0

The MGU Store installs the executable under `/var/opt/mgu-gamestation-audio/current/`. GameStation starts it as an unprivileged child for an opted-in active game or test tone. There are no services, socket listeners, additional user groups or persistent settings to remove. Stop GameStation before uninstalling the tool through the Store.

The binary targets Linux x86-64 with glibc 2.17 or later. It loads the existing `libasound.so.2` dynamically. The selected ALSA endpoint must accept signed 16-bit little-endian stereo at 48 kHz and be accessible to the OAP app's UID. The process opens only the supplied endpoint. It accepts raw PCM on stdin, emits small JSON status lines on stdout and reports errors on stderr. It drops queued PCM and closes on EOF, SIGTERM, underflow recovery failure or 160 ms without input. The negotiated ALSA buffer is capped at 120 ms. ALSA's reported delay covers the device interface. Measuring delay at the speakers requires the car.

Use a dedicated verified playback source. Known BMW media engine outputs, phone/voice and navigation endpoints, raw hardware names and the ambiguous `default` alias are refused. The helper has no AudioManager write methods.

Rebuild with Zig 0.14.1 using `make -C native/gamestation-audio dist`. For the local smoke test, run `GAMESTATION_NATIVE_AUDIO=1 node tests/gamestation_audio.test.js` on Linux x86-64 with the standard ALSA `null` plugin. The smoke test discards all samples and checks that the process also stops for a missing endpoint and when PCM stops arriving.
