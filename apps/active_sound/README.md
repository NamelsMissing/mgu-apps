# Active Sound 0.3.2 — MGU / iDrive 7

Active Sound Design für die MGU: Die echte Motordrehzahl und das Motormoment steuern einen virtuellen Motor. 21 synthetisierte Motorklänge, jeder einzeln einstellbar, alle eigene Synthese (keine Aufnahmen, keine Samples, keine Markennamen).

| Gruppe | Motoren |
| --- | --- |
| Sport | Inline-6 Turbo (Standard), V8 Biturbo, Inline-4 Turbo, Inline-5 Turbo |
| Race | V8 Flat-Plane, V10 Racing, Flat-6 NA, Twin Rotor, Formula V6 Hybrid |
| Classic / Luxury | V8 Muscle (Kompressor), Flat-4 Rumble, V-Twin, V12 GT |
| Diesel | Diesel Inline-4, Diesel Inline-6, Diesel V6 Biturbo, Diesel V8 Biturbo, Straight-Pipe Diesel (Pickup-V8), Big Rig Diesel (Lkw-R6 mit Motorbremse) |
| Electric | EV Pulse (folgt der Geschwindigkeit), Jet Turbine |

## Wie der Klang entsteht

- **Zündimpuls-Synthese** (`synth.js`): Eine Kurbelwellenphase läuft mit der virtuellen Drehzahl; jeder Zündzeitpunkt (eigene Zündabstände, z. B. ungleich bei Flat-4 und V-Twin) stößt den Auspuff seiner Zylinderbank an.
- **Auspuffmodell (ab 0.3.0)**: je Bank ein Rohr als Laufzeitglied mit gedämpfter, invertierter Reflexion am offenen Ende (Länge je Motor 1,6–4,8 m), danach Resonatoren. Die Abgastemperatur steigt unter Last über Sekunden und kühlt im Schub ab; heißeres Gas verschiebt die Rohrresonanzen nach oben. V- und Boxermotoren haben zwei Bänke in Stereo, der Crossplane-V8 mit der Bankfolge L R L L R L R R (das Blubbern). Jeder Zylinder zündet minimal früher/später und klingt etwas heller/dumpfer; dazu leises Ventiltrieb-Ticken. Dazu Motorordnungen, Ansauggeräusch, Turbo (Spool, Pfeifen, Schubumluft), Kompressor-/E-Motor-Heulen, Diesel-Nageln, Schubknallen und Drehzahlbegrenzer. Pegel je Profil automatisch angeglichen, weicher Begrenzer, nie über 0,95 Vollaussteuerung.
- **Mapping** (`mapping.js`): reale Drehzahl Leerlauf…Abregeldrehzahl → Leerlauf…Redline des Profils (Einstellung „Real redline“, Standard 5000 für den 318d). Last = Moment (`FES.statusActualValueTorque2`) / „Max torque“ (Standard 400 Nm), sonst aus der Längsbeschleunigung.
- **Stille-Regeln**: Motor aus (auch Auto-Start-Stopp) oder keine frische Drehzahl seit 5 s → Ausblenden. Demo-Daten (Auto antwortet nicht) bleiben stumm, außer Einstellung „Demo data“ = „On, with sound“.

## Einstellungen pro Motor (ab 0.2.0)

Seite **Tune** im Auto und Bereich **TUNE** auf dem Handy, je Regler 0–200 % in 25-%-Schritten (100 % = wie entworfen), gespeichert pro Motor in `active-sound.json`. Über 100 % wird eine fehlende Eigenschaft ergänzt (z. B. Pops beim Diesel, Turbo beim Sauger-V8), 0 % schaltet sie ab.

| Regler | Wirkung |
| --- | --- |
| Pops & crackle | Knistern im Schiebebetrieb (Gas weg über Leerlauf) |
| Exhaust resonance | Klingen und Dröhnen des Auspuffrohrs (Reflexion 0–100 %) |
| Bangs | Einzelne Fehlzündungs-Knaller beim Gaswegnehmen/Schalten, im Schub und am Begrenzer |
| Exhaust bass | Tiefe und Druck des Auspuffs |
| Rasp | Rauheit und Helligkeit |
| Idle lope | Unrunder Leerlauf |
| Intake roar | Ansauggeräusch unter Last |
| Turbo whistle / Blow-off | Turbopfeifen / Schubumluftventil |
| Whine | Kompressor- bzw. E-Motor-Heulen |
| Diesel clatter | Einspritznageln |
| Engine brake | Nur Diesel: Motorbremse („Jake Brake“), bellendes Stakkato im Schub |

Elektro und Turbine haben nur Bass, Rasp und Whine. Pops, Bangs und Motorbremse laufen über einen eigenen, helleren Signalweg, damit sie bei geschlossener Drosselklappe nicht im gedämpften Kabinenklang untergehen. Die Pegelangleichung der Profile bezieht sich auf den Werkszustand, Einstellungen werden also nicht wieder herausgerechnet. „Engines“ markiert eingestellte Motoren mit TUNED; „Reset sound“ setzt den aktuellen Motor zurück.

## Erster Test im Auto (28.11.2026, G21, 0.3.1)

- Läuft: App startet, Drehzahl, Geschwindigkeit und **Motormoment** (`FES.statusActualValueTorque2`) kommen an (Leerlauf 890 rpm, 4 Nm).
- Headunit ohne `aplay`/`ffmpeg` bestätigt. Seit 0.3.2 gilt dann immer die Handy-Ausgabe, egal was unter „Sound output“ gespeichert ist.
- BMWs Tastenleiste lag über der Button-Zeile der Seite. Seit 0.3.2 blendet die App alle ihre Leistenbuttons aus (`ctx.hideButton`), weil die Seite sie selbst zeichnet.
- „Port helper mgu-sound-net not running“: Das Werkzeug **Active Sound Phone Port** war im Auto nicht aktiv. Im MGU Store prüfen, ob es installiert ist (sonst installieren); ist es installiert, die Headunit neu starten. Ohne den Helfer erreicht das Handy die Seite über das Auto-WLAN nicht.

## Klangbalance und Handy-Lautsprecher (0.3.1)

Bis 0.3.0 bestanden Leerlauf und Teillast fast nur aus dem tiefen Zündgrundton (Diesel-R6 bei 1000–2000 U/min: 83–97 % der Energie unter 100 Hz). Das klang wie ein elektrisches Summen; das Diesel-Nageln wurde vom Kabinenfilter abgeschnitten. Seit 0.3.1:
- Verbrennungsgeräusch je Zündung (breitbandig um 1,4 kHz), Nageln und Ventiltrieb laufen am Kabinenfilter vorbei; der Kabinenfilter geht nie unter ~1 kHz.
- Zündimpulse bleiben bei Teillast kräftiger, die glatten Motorordnungen wirken vor allem bei hoher Drehzahl, der Tiefbass-„Thump“ hängt an der Last.
- Leerlauf etwa 12–16 dB leiser als Volllast (vorher ~24 dB).
- Ergebnis Diesel-R6 bei 1000/2000 U/min: 58 % / 50 % unter 100 Hz, Rest in Mitten und Höhen.
- **Handy-Seite „Plays through“**: *Phone speaker* schneidet unter ~140 Hz ab (kleine Lautsprecher verzerren dort nur) und erzeugt die Obertöne des Zündtons, damit der tiefe Takt hörbar bleibt; *Car / headphones* gibt das volle Spektrum aus. Standard: Demo-Seite = Phone speaker, Auto-Seite = Car / headphones; die Wahl merkt sich der Browser.

## Demo ohne Auto: Fahrzeugmodell (ab 0.3.0)

`vehicle.js` simuliert für Handy-Demo und WAV-Export ein Auto: Drehmomentkurve (Diesel früh flach, Turbo mit Plateau, Sauger steigend), Turboloch, 6–12 Gänge mit Sport-Schaltlogik (Zugkraftunterbrechung beim Schalten → Knaller/Blow-off, Kickdown, im Schub Gang halten), anfahrende Kupplung, Trägheit, Luft- und Rollwiderstand, Motorbremse, Bremse, Begrenzer. Fahrzeugdaten je Motor (z. B. Lkw 18 t, 12 Gänge; V-Twin als Motorrad). Auf dem Handy: Gaspedal-Fläche (höher drücken = mehr Gas), Bremse, Auto-Fahrt. Im Auto wird das Modell nicht benutzt, dort kommen Drehzahl und Moment vom echten Motor.

## Wo der Ton herauskommt

1. **Handy (Standard)**: Seite *Phone*, QR-Code scannen (Handy im Auto-WLAN), auf dem Handy **TAP TO START SOUND**. Das Handy rechnet denselben Synthesizer (AudioWorklet) und spielt ihn ab; mit CarPlay- oder Bluetooth-Audio kommt er aus den Fahrzeuglautsprechern. Das Auto schickt nur Drehzahl und Last (~16×/s); ohne Daten für 1,5 s blendet das Handy aus. Braucht das Root-Tool **Active Sound Phone Port** (`mgu-sound-net` 0.1.0, öffnet TCP 18885 auf `wlan_bridge`, nur solange die App lauscht; eigener nft-Tag).
2. **Headunit**: live PCM über den Equalizer-DSP (falls installiert) an `aplay` oder `ffmpeg` (ALSA-Standardgerät), wie die Equalizer-Testmusik. Auf der bisher untersuchten MGU fehlen beide Programme → Status „Unavailable“. BMW-Audio-Routing und SmartX werden nicht angefasst.
3. **WAV-Export** (Setup → Export): 30-s-Demofahrt durch das Fahrzeugmodell (Leerlauf, Gasstoß, Volllast durch die Gänge, Schub, Teillast, Kickdown, Bremsen) mit den Einstellungen des Motors als `active-sound-<motor>.wav` (~5 MB) im App-Datenordner, z. B. per Phone Terminal/SFTP auf USB-Stick.

Bedienung: Seite *Sound* (Drehzahlmesser des virtuellen Motors, Status), *Engines* (Antippen wählt), *Tune*, *Phone*, *Setup*. iDrive-Liste: Sound an/aus, nächster/vorheriger Motor, Lautstärke, Export, Tuning zurücksetzen.

## Offen am Auto

- Handy-Route: Erreicht das iPhone über das CarPlay-WLAN Port 18885? Spielt Safari-Audio bei Wireless CarPlay über die Lautsprecher, Latenz?
- Signale am G21: `statusActualValueTorque2` vorhanden und plausibel; Drehzahl-Benachrichtigungsrate im Leerlauf.
- Pegel im Fahrzeug, Zusammenspiel mit BMW-eigenem ASD und Warntönen.

## Tests

```sh
node tests/active_sound.test.js
python3 tools/build_store_app.py active_sound
```
Geprüft am PC: Klangbalance (Leerlauf/Teillast mit Anteil über 200 Hz, Pegelabstand zu Volllast, Handy-Lautsprecher-Modus), alle Profile (auch mit allen Reglern auf 0 % und 200 %), Stereo der Bänke, Erhitzung des Auspuffs, Fahrzeugmodell (0–100, Gänge, Schub, Bremsen, Schaltunterbrechung) (endlich, begrenzt, ähnliche Lautheit, Zündfrequenz als stärkste Linie), Ausblenden, Mapping, getakteter Player mit Fake-`aplay`, WAV-Header, Tuning (Bereinigung, Pops/Bangs und Motorbremse messbar lauter im Schub, Live-Änderung ohne Filter-Reset), Handy-Server (Token, Health, Größenlimit), Worklet in simuliertem AudioWorklet-Scope, Firewall-Helfer. Zusätzlich Handy-Seite in Headless-Chrome: AudioWorklet lädt und erzeugt Ton.

Lizenz: GPL-3.0-only wie das Repo; `qr_vendor.js` MIT (siehe `QR_VENDOR_LICENSE.txt`).
