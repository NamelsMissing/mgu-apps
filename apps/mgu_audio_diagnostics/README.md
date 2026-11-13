# MGU Audio Diagnostics 0.1.0

Installierbare, **rein lesende** MGU-App für iDrive 7. Sie ist nicht der Musikplayer und spielt noch keinen Ton ab.

## Installation

Im MGU Store die Quelle `NamelsMissing/mgu-apps` auf `main` aktualisieren, **MGU Audio Diagnostics** auswählen und installieren. Der Store baut die App mit dem MGU-SDK. Benötigt Renderer, Inputgate und den vorhandenen DSP-Dienst 0.2.0.

## Funktionen

- Übersicht: Architektur, ALSA-Bibliothek, SmartX-Plugin, Anzahl der Shared-Memory-Kanäle und DSP-Erreichbarkeit
- SmartX-Kanäle: Kanalnamen und Berechtigungen, Klassifizierung als reservierte CarPlay-, Telefonie- oder Medienkanäle
- Dienste & DSP: Prozessnamen sowie aktueller DSP-/Bypass-Status und echte PCM-Framezahlen
- Diagnose exportieren: Datei `mgu-audio-diagnostics.json` im App-Datenordner; keine VIN, Zugangsdaten, Ringbufferdaten oder Prozesskommandozeilen

**Wichtig:** Die App öffnet keine ALSA-Geräte, überschreibt keine Audiokanäle und ändert weder CarPlay noch AudioManager oder systemd. Sie ist auch nicht der getrennte experimentelle native `mgu-audio-probe`, der einen stummen ALSA-Null-Test ausführen kann. Das Programm liegt weiterhin unter [experiments/mgu_alsa](../../experiments/mgu_alsa).

Das vollständige Routing von Testmusik zu BMW-Lautsprechern ist noch nicht identifiziert. Diese App hilft, die Umgebung direkt im iDrive zu dokumentieren; ein hörbarer Audio-Test wird dadurch nicht vorgetäuscht.

## Tests

```sh
node --check apps/mgu_audio_diagnostics/main.js
node tests/mgu_audio_diagnostics.test.js
python3 tools/build_store_app.py mgu_audio_diagnostics
```

Der Store-Build benötigt das BMW-SDK auf der MGU; die Node-Tests sind offline. Bisher keine Fahrzeugbestätigung der neuen App.
