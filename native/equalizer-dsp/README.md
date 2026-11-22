# Equalizer PCM DSP 0.2.2

Gemeinsamer Hintergrunddienst für tatsächlich angeschlossene PCM-Audioquellen. Sieben parametrische Peaking-Filter verarbeiten die Audiosamples vor deren Ausgabe. Die Standardeinstellung ist Bypass.

## Verarbeitung

- Sieben unabhängige Biquad-Filter nach dem [W3C Audio EQ Cookbook](https://www.w3.org/TR/audio-eq-cookbook/).
- Je Band 20–20.000 Hz, −12 bis +12 dB und Q 0,3–6. Startfrequenzen: 100, 200, 500, 1.000, 2.000, 5.000 und 10.000 Hz.
- Getrennter Filterzustand pro Kanal, Mono/Stereo, S16LE bei 44,1 / 48 / 88,2 / 96 kHz.
- Vorverstärkung −24 bis 0 dB. Automatischer Headroom zieht die Summe aller positiven Band-Gains ab; das ist eine konservative Reserve gegen Übersteuerung. Bei vielen Anhebungen wird der Gesamtpegel entsprechend kleiner.
- Ausgangssättigung verhindert Integer-Überlauf. Tatsächlich begrenzte Samples werden als `clippedSamples` gezählt. Das ist keine zuschaltbare Kompressorfunktion.
- Filterwechsel übernehmen den jüngsten realen Eingang als Vorlauf und überblenden 25 ms lang.
- Begrenzte PCM-Blöcke, maximal acht Quellen, Backpressure und bitgenauer Bypass.
- Konfiguration wird atomar gespeichert; Revisionen verhindern das Überschreiben zwischenzeitlicher Änderungen anderer Clients.

## Anbindung

Der MGU Store installiert dieses Tool als Abhängigkeit von Equalizer und Video Hub. Die Unit läuft unter Root mit Gruppe `12202` (OAP-App-Gruppe). Nur lokale Unix-Sockets in `/run/mgu-equalizer-dsp`, kein HTTP-Server und kein Netzwerksocket:

| Socket | Protokoll |
| --- | --- |
| `control.sock` | Eine JSON-Zeile, `op: status` oder `op: set` mit vollständigem `config` und `expectedRevision`; Antwort `{ok,data}` bzw. `{ok:false,error}` |
| `pcm.sock` | JSON-Zeile `{protocol:1,format:"s16le",sampleRate:44100,channels:2,source:"app-name"}`; JSON-Bestätigung; danach je Block 4 Byte LE-Länge und PCM-Daten; Antwort im selben Blockformat |

### Nativer Snapshot (Layout 1)

Zusätzlich schreibt der Dienst beim Start und nach jedem erfolgreichen `set` die aktive Konfiguration als `carplay.snapshot` in dasselbe Laufzeitverzeichnis. Das Format ist ein festes, versioniertes Binärlayout (204 Byte, Little Endian, Magic `MGEQSNP1`, Layout 1, CRC-32) und in `snapshot.js` beschrieben. Geschrieben wird atomar (temporäre Datei, `fsync`, `rename`), Modus `0640`. Ein Schreibfehler ist nicht fatal; er erscheint im Status unter `nativeSnapshot.error`, die Socket-Clients arbeiten unverändert weiter.

Die Datei ist die Schnittstelle zum **Offline-Prototyp** der CarPlay-Live-Filterung (`experiments/carplay_alsa`). Kein installierter Prozess liest sie bisher; `stockCarPlayRouted` bleibt `false`.

Der Client in `kit/runtime/dsp-client.js` stellt `request()` und den Stream-Transform `PcmFilter` bereit. Er überträgt pro Quelle einen ausstehenden Block. Bei fehlendem Dienst, einer unterbrochenen Verbindung oder Zeitüberschreitung gibt er den noch nicht ausgegebenen Originalblock genau einmal aus und wechselt für diesen Stream auf unveränderte Weiterleitung. Ein neuer Wiedergabestart versucht erneut die DSP-Verbindung.

Video Hub 0.1.1 ist konkret angebunden: `ffmpeg → PcmFilter → aplay`. Sein Menü **Audio EQ** kann den DSP während der Wiedergabe bedienen. Das Beenden der App, ein Fokusverlust und die vorhandenen Fahrzeugbewegungsregeln stoppen die Wiedergabe weiterhin.

**Stock-CarPlay, Radio, Bluetooth und andere BMW-Medienquellen sind noch nicht in diesen PCM-Pfad eingebunden.** Ein laufender Dienst oder ein gespeichertes Filterprofil bedeutet nicht, dass diese Quellen gefiltert werden. Der Status benennt dies ausdrücklich. Die tatsächliche ALSA-Ausgabe ins Fahrzeug benötigt wie bisher eine kompatible Audioquelle/-route und muss an der MGU geprüft werden.

Es wird kein AudioManager-/CarPlay-Prozess gepatcht, keine ALSA-Standardroute überschrieben und kein bestehender AVB-Stream umgeleitet.

## Fahrzeugdiagnose für weitere Quellen

Auf der MGU, z. B. über Phone Terminal, während die gewünschte Quelle spielt:

```sh
node /var/opt/mgu-equalizer-dsp/current/probe.js
```

Die Ausgabe enthält Audio-Gerätenamen, relevante Prozessnamen, ALSA-Konfigurationsnamen und geladene Audiobibliotheken. Der Probe startet keinen Ton, verändert keine Audiokonfiguration und liest keine Prozessumgebungen, Schlüssel, VINs oder vollständigen Kommandozeilen aus. Er dient zur Ermittlung einer möglichen zusätzlichen PCM-Anbindung; ein vorhandener ALSA-Geräteeintrag allein belegt diese noch nicht.

## Prüfungen

```sh
node tests/equalizer_dsp.test.js
node tests/equalizer_snapshot.test.js
node tests/equalizer_video_pipe.test.js
node tests/equalizer_node8_smoke.js
```

Der erste Test misst die tatsächlich verarbeiteten Samples aller sieben Bänder bei 44,1 und 48 kHz. Die Socket-Tests prüfen den echten Hintergrunddienst und den Client. Der separate Node-8-Test prüft Zielruntime, Unix-Sockets, Konfigurationsänderung und +6-dB-Verarbeitung. GitHub Actions führt diese Prüfungen aus. In einer Umgebung, die `listen()` mit EPERM sperrt, kann der lokale DSP-Test nur die Kernprüfungen ausführen und meldet die Socket-Prüfungen ausdrücklich als übersprungen.

Es liegen noch keine Messungen zur CPU-Last, Latenz oder hörbaren Ausgabe auf dem G21 vor. Die Filterkern-Tests messen digitale Samples; sie ersetzen keinen Fahrzeugtest.

## Laufzeitverhalten in 0.2.2

Bei schnellen Einstellungsänderungen beendet der Prozessor die laufende 25-ms-Überblendung und übernimmt danach die jüngste wartende Konfiguration. PCM-Formate werden pro Socket ausgehandelt. Die Schnittstelle bleibt auf S16LE mit den bisherigen Abtastraten und Kanalzahlen begrenzt.

`frames` zählt empfangene beziehungsweise verarbeitete Frames auch im Bypass. `filteredFrames` und `lastFilteredAt` beziehen sich auf Blöcke mit aktivem Filter oder einem laufenden Übergang zum oder vom Filter. Diese Zähler messen Software-Verarbeitung. Geräteausgabe und akustische Wiedergabe erfordern eigene Nachweise. Die Snapshot-Datei bleibt ein atomarer 204-Byte-Datensatz mit Layout 1 und CRC-32.
