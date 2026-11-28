# Active Sound PCM Output 0.1.0 (`mgu-sound-pcm`)

Live-Tonausgabe der Headunit für [Active Sound](../../apps/active_sound/README.md). Der MGU Store installiert das Programm unter `/var/opt/mgu-sound-pcm/current/`. Active Sound startet es als normales Kind ohne Root nur, solange Ton läuft. Dienste, offene Ports oder Einstellungen gibt es nicht.

- Abgeleitet von `mgu-gamestation-audio` 0.2.0 (GPL-2.0-only, siehe `LICENSE`): rohes PCM S16_LE, Stereo, 48 kHz auf stdin, Ausgabe über das `libasound.so.2` der Headunit (zur Laufzeit geladen), JSON-Statuszeilen auf stdout, Ende bei EOF, SIGTERM oder 160 ms ohne Eingabe, ALSA-Puffer höchstens 120 ms (Ziel 64 ms). `--probe <Endpunkt>` handelt nur das Format aus und schließt sofort.
- Akzeptiert ausschließlich `[plug:]smartx:<Quelle>_CF_48_STEREO`. Abgelehnt werden `default`, `dmix`, `hw:`/`plughw:` sowie alles mit CarPlay, Android Auto, Telefon/HFP, Sprache, Navigation/Ansagen, Warn-/Gong-/PDC-Tönen, Radio/Tuner, Bluetooth/A2DP, Notruf oder `OapGenericMedia` im Namen.
- Welche BMW-Medienquelle benutzt wird, entscheidet die App über den AudioManager (`hu_route.js`): nur eine vorhandene, verfügbare Quelle, nur bei freien Frontlautsprechern, nur die eigene bestätigte Verbindung wird wieder getrennt.

## Bau

`./build.sh` mit dem gcc des Bauhosts. `glibc217.S` ersetzt `crt1.o` und bindet `__libc_start_main` und die `dl*`-Funktionen an ihre GLIBC_2.2.5-Versionen, `symver.h` macht dasselbe im C-Code. Das Skript bricht ab, wenn das Ergebnis eine Version über GLIBC_2.17 braucht (gleicher Stand wie das Zig-Build von `mgu-gamestation-audio`: `libc.so.6`, `libdl.so.2`). Lokal geprüft mit einem ALSA-Alias `pcm.smartx` auf das Null-Gerät: 48.000 Frames pro Sekunde geschrieben, keine Verluste. Ob die SmartX-Endpunkte des G21 Ton auf die Lautsprecher bringen, ist offen.
