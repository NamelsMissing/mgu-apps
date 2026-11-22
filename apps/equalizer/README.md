# Equalizer DSP 0.3.0 für iDrive 7

Der Equalizer hat sieben parametrische Bänder für verbundene PCM-Clients, eine getrennte BMW-Klangsteuerung und einen lokalen A/B-Test über den originalen BMW MediaPlayer. Für die laufende originale CarPlay-Musik ist der PCM-Eingriffspunkt am Fahrzeug noch nicht nachgewiesen.

## Installation

Im MGU Store die Quelle **NamelsMissing/mgu-apps** auf **main** aktualisieren und **Equalizer DSP** installieren. Der Store installiert den PCM-Dienst **0.2.2** und die Renderer-Abhängigkeiten. Das App-Paket wird auf der MGU mit deren SDK gebaut. Die Filterkonfiguration gehört dem Hintergrunddienst und bleibt beim Schließen der Oberfläche erhalten. Der Dienst startet über systemd. Der Store liefert den experimentellen CarPlay-Interposer nicht mit.

## BMW-A/B-Test mit Night Drive

1. Im Stand und bei niedriger Lautstärke im DSP-Tab **BMW Original** wählen. Die App benötigt ein aktuelles Stillstandssignal. Das Original läuft auch ohne DSP-Dienst. Die 32-sekündige, lokal synthetisierte Testmusik wird als 44,1-kHz-Stereo-WAV bereitgestellt.
2. Für **BMW DSP** ein Band verändern, etwa 100 Hz um 6 dB anheben, und **DSP EIN** wählen. Die App rendert eine gefilterte Datei mit der gespeicherten DSP-Revision. Bypass, neutrale Profile, Revisionswechsel und Verbindungsfehler führen zu einer Meldung. In diesen Fällen startet die DSP-Version nicht.
3. Die beiden Versionen nacheinander anhören. Über **BMW-Test stoppen** den aktuellen Versuch beenden. Das Verlassen des DSP-Tabs, das Ausblenden der App oder der Verlust der Stillstandsbestätigung beendet den Versuch ebenfalls. Der Test setzt keine Verstärkerlautstärke.

Die App liest die IDs für `OAPGenericMedia` und `MediaSink_Front` aus dem AudioManager und reicht die temporäre Datei an `OapGenericMedia.playFile` weiter. Eine bereits belegte OAP-Quelle oder eine mehrdeutige Medienroute führt zum Abbruch. Beim Stoppen gibt die App nur die eindeutig von ihr angelegte Verbindung frei. Sie überlässt dem BMW-System zuerst die Wiederherstellung der vorherigen Route. Bei freier Senke versucht sie die zuvor eindeutig bekannte Medienverbindung wiederherzustellen. Eine neu gewählte Quelle hat Vorrang. Ob die vorherige Quelle auch mit ihrer alten Wiedergabeposition fortsetzt, hängt vom Fahrzeug ab.

Eine fortschreitende BMW-Playerposition bestätigt die Wiedergabe im Player. Ob das Signal aus den Lautsprechern kommt, muss am G21 geprüft werden. Die öffentliche Vergleichsimplementierung führt WAV als unterstütztes Format. Die Zugriffsrechte der konkreten G21-Firmware für `playFile` und die temporäre Datei sind ebenfalls Teil der Abnahme. [Prüfbericht](../../docs/equalizer-audio-integration.md)

**WAV exportieren** speichert `night-drive-original.wav` und `night-drive-dsp.wav` im privaten App-Datenordner. Beide Dateien sind jeweils etwa 5,65 MB groß. Sie können für einen Vergleich kopiert und auf einem geeigneten Player abgespielt werden. Die bisherige **Testmusik**-Taste verwendet weiterhin den experimentellen ALSA-Standardweg über `aplay` oder `ffmpeg`. Der neue BMW-Test benötigt beide Programme nicht.

## DSP und Profile

| Parameter | Bereich |
| --- | --- |
| Gain | −12 bis +12 dB |
| Mittenfrequenz | 20 bis 20.000 Hz |
| Q | 0,3 bis 6 |
| Vorverstärkung | −24 bis 0 dB |

Ein Band und einen Parameter wählen, mit **− / +** einstellen und mit **DSP übernehmen** speichern. **DSP EIN** und **BYPASS EIN** übernehmen den Zustand sofort, einschließlich vorbereiteter DSP-Änderungen. Die Frequenzkurve zeigt den eingestellten Filterverlauf einschließlich Vorverstärkung und Auto-Headroom. Die automatische Pegelreserve zieht die Summe positiver Bandanhebungen ab. Dadurch kann die Ausgabe leiser werden.

Unter **Profile** gibt es drei Vorlagen und drei eigene Plätze. **Vorschau laden** bereitet die Änderung vor. **Übernehmen** schreibt sie in den Dienst. Gespeicherte DSP-Profile lassen sich über **Profil bearbeiten** umbenennen oder löschen. Ältere Zuordnungen und BMW-Profile bleiben lesbar.

Unter **BMW-Klang** lassen sich die vorhandenen OEM-Regler zuordnen. Für jeden Regler im BMW-Menü Mitte, Minimum, Maximum und erneut Mitte einstellen und jeweils unter **Einrichten** erfassen. Die App akzeptiert nur eine eindeutige Zuordnung und prüft Schreibvorgänge durch Rücklesen. Welche Regler die BMW-Firmware anbietet und auf welche Quellen sie wirken, ist fahrzeugabhängig.

## PCM-Quellen und Diagnose

Die Diagnose zeigt die vom AudioManager gemeldete BMW-Medienroute, den DSP-Zustand, kürzlich verarbeitete PCM-Quellen, Framezähler und Fehler. **DSP LIVE** setzt aktuelle Filterverarbeitung voraus. Für Lautsprecherausgabe und direkte Anbindung von CarPlay, Radio oder Bluetooth gibt es einen eigenen Verifizierungsstatus. **Diagnose exportieren** schreibt `equalizer-diagnostics.json` in den App-Datenordner.

Video Hub **0.2.0** kann seine eigene Decoder-Ausgabe vor dem Übergang an ALSA durch den Dienst schicken. Bei Verlust des DSP-Sockets reicht sein Client die PCM-Daten unverändert weiter. Die lokale Prüfung misst diesen PCM-Pfad bis zum Test-Sink. Die ALSA-Ausgabe am G21 steht zur Abnahme aus. [DSP-Dienst](../../native/equalizer-dsp/README.md)

## Entwicklung

```sh
node kit/tools/test_equalizer.js
node tests/equalizer_dsp.test.js
node tests/equalizer_bmw_music.test.js
node tests/equalizer_music_export.test.js
node tests/equalizer_video_pipe.test.js
python3 tests/equalizer_store.test.py
python3 tools/build_store_app.py equalizer
node kit/tools/test_equalizer_ui.js
```

Der Store-Build benötigt ein lokal bereitgestelltes BMW-SDK, beispielsweise aus dem App-Donor `x_call@4.25.3`. Der UI-Test verwendet eine erzeugte App-Quellstruktur und einen Mock für BMW. Der Unix-Socket-Test betreibt den echten DSP-Dienst mit synthetischen Samples.
