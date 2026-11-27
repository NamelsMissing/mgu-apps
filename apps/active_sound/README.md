# Active Sound 0.1.0 — MGU / iDrive 7

Active Sound Design für die MGU: Die echte Motordrehzahl und das Motormoment steuern einen virtuellen Motor. 16 synthetisierte Motorklänge, alle eigene Synthese (keine Aufnahmen, keine Samples, keine Markennamen).

| Gruppe | Motoren |
| --- | --- |
| Sport | Inline-6 Turbo (Standard), V8 Biturbo, Inline-4 Turbo, Inline-5 Turbo |
| Race | V8 Flat-Plane, V10 Racing, Flat-6 NA, Twin Rotor, Formula V6 Hybrid |
| Classic / Luxury / Torque | V8 Muscle (Kompressor), Flat-4 Rumble, V-Twin, V12 GT, Diesel Inline-6 |
| Electric | EV Pulse (folgt der Geschwindigkeit), Jet Turbine |

## Wie der Klang entsteht

- **Zündimpuls-Synthese** (`synth.js`): Eine Kurbelwellenphase läuft mit der virtuellen Drehzahl; jeder Zündzeitpunkt (eigene Zündabstände, z. B. ungleich bei Flat-4 und V-Twin, Bankunterschiede beim Crossplane-V8) stößt Abgas-Resonatoren an. Dazu Motorordnungen, Ansauggeräusch, Turbo (Spool, Pfeifen, Schubumluft), Kompressor-/E-Motor-Heulen, Diesel-Nageln, Schubknallen und Drehzahlbegrenzer. Pegel je Profil automatisch angeglichen, weicher Begrenzer, nie über 0,95 Vollaussteuerung.
- **Mapping** (`mapping.js`): reale Drehzahl Leerlauf…Abregeldrehzahl → Leerlauf…Redline des Profils (Einstellung „Real redline“, Standard 5000 für den 318d). Last = Moment (`FES.statusActualValueTorque2`) / „Max torque“ (Standard 400 Nm), sonst aus der Längsbeschleunigung.
- **Stille-Regeln**: Motor aus (auch Auto-Start-Stopp) oder keine frische Drehzahl seit 5 s → Ausblenden. Demo-Daten (Auto antwortet nicht) bleiben stumm, außer Einstellung „Demo data“ = „On, with sound“.

## Wo der Ton herauskommt

1. **Handy (Standard)**: Seite *Phone*, QR-Code scannen (Handy im Auto-WLAN), auf dem Handy **TAP TO START SOUND**. Das Handy rechnet denselben Synthesizer (AudioWorklet) und spielt ihn ab; mit CarPlay- oder Bluetooth-Audio kommt er aus den Fahrzeuglautsprechern. Das Auto schickt nur Drehzahl und Last (~16×/s); ohne Daten für 1,5 s blendet das Handy aus. Braucht das Root-Tool **Active Sound Phone Port** (`mgu-sound-net` 0.1.0, öffnet TCP 18885 auf `wlan_bridge`, nur solange die App lauscht; eigener nft-Tag).
2. **Headunit**: live PCM über den Equalizer-DSP (falls installiert) an `aplay` oder `ffmpeg` (ALSA-Standardgerät), wie die Equalizer-Testmusik. Auf der bisher untersuchten MGU fehlen beide Programme → Status „Unavailable“. BMW-Audio-Routing und SmartX werden nicht angefasst.
3. **WAV-Export** (Setup → Export): 24-s-Demofahrt des gewählten Motors als `active-sound-<motor>.wav` (~4 MB) im App-Datenordner, z. B. per Phone Terminal/SFTP auf USB-Stick.

Bedienung: Seite *Sound* (Drehzahlmesser des virtuellen Motors, Status), *Engines* (Antippen wählt), *Phone*, *Setup*. iDrive-Liste: Sound an/aus, nächster/vorheriger Motor, Lautstärke, Export.

## Offen am Auto

- Handy-Route: Erreicht das iPhone über das CarPlay-WLAN Port 18885? Spielt Safari-Audio bei Wireless CarPlay über die Lautsprecher, Latenz?
- Signale am G21: `statusActualValueTorque2` vorhanden und plausibel; Drehzahl-Benachrichtigungsrate im Leerlauf.
- Pegel im Fahrzeug, Zusammenspiel mit BMW-eigenem ASD und Warntönen.

## Tests

```sh
node tests/active_sound.test.js
python3 tools/build_store_app.py active_sound
```
Geprüft am PC: alle Profile (endlich, begrenzt, ähnliche Lautheit, Zündfrequenz als stärkste Linie), Ausblenden, Mapping, getakteter Player mit Fake-`aplay`, WAV-Header, Handy-Server (Token, Health, Größenlimit), Worklet in simuliertem AudioWorklet-Scope, Firewall-Helfer. Zusätzlich Handy-Seite in Headless-Chrome: AudioWorklet lädt und erzeugt Ton.

Lizenz: GPL-3.0-only wie das Repo; `qr_vendor.js` MIT (siehe `QR_VENDOR_LICENSE.txt`).
