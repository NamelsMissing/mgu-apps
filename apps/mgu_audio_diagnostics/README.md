# MGU Audio Diagnostics 0.1.1

MGU-Store-App fuer iDrive 7. Nur lesende Audio-/DSP-Diagnose. Kein PCM-Geraet wird geoeffnet, kein CarPlay-Dienst geaendert.

## Was die App zeigt

- Ueberblick: ALSA, SmartX, vorhandene Kanaele und DSP-Dienst.
- SmartX-Kanaele: lesende Metadaten und Dateirechte. Die Anzahl der vorhandenen Kanaele ist **nicht** die Anzahl aktiver Streams.
- **AudioManager (neu 0.1.1):** Abfragen `getListMainSources`, `getListMainSinks` und `getListMainConnections` der GENIVI-CommandControl-Schnittstelle. Die Befehle sind rein lesend; falls BMW sie nicht freigibt, erscheint eine entsprechende Meldung. Ein MainConnection-Datensatz beweist noch nicht, dass sich PCM aus der Verbindung abgreifen laesst.
- DSP & Dienste: Bypass, PCM-Frameanzahl, verbundene PCM-Clients und expliziter Hinweis, dass Stock-CarPlay nicht am DSP haengt.
- Export: `mgu-audio-diagnostics.json` im App-Datenordner mit strukturierten, begrenzten AudioManager-Namen/IDs, ohne Audio, Kommandozeilen, VIN, Zugangsdaten oder Shared-Memory-Inhalte.

Die Oberflaeche benutzt wegen fehlender Umlaute im Renderer ASCII-Bezeichnungen und kuerzere Spalten.

## Naechster Test im Fahrzeug

1. Bei stehendem Fahrzeug CarPlay-Musik starten.
2. MGU Audio Diagnostics oeffnen, `Neu einlesen` waehlen und die Seite `AudioManager` aufrufen.
3. `Diagnose exportieren` waehlen und die neue JSON senden. Falls die AudioManager-Methode nicht unterstuetzt wird, liefert `audioManager.errors` die jeweilige Diagnose.

Diese App ersetzt weder einen AudioManager-registrierten Medienplayer noch den separaten [ALSA Null-Diagnoseplayer](../../experiments/mgu_alsa). Der vorhandene Equalizer 0.2.3 bleibt unveraendert.

## Installation

Im MGU Store die Quelle `NamelsMissing/mgu-apps` auf `main` aktualisieren und MGU Audio Diagnostics auf 0.1.1 aktualisieren.

GENIVI-Methodendokumentation: https://genivi.github.io/AudioManager/classam_1_1IAmCommandReceive.html
