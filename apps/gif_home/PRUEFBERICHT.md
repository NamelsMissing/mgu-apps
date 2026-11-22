# Prüfbericht GIF Home 0.4.0

- Entwicklungsbranch `dev/gif-home-0.4.0`
- Implementierungscommit `9f0677e3e2c0ab118589e8be31b4495d7bba3e0a`
- Basis `c0a42f5604b5fc33ebe1f349c24cd956f14c43dc`
- Prüfstand 22. November 2026

Die lokale Abnahme umfasst App-Logik, HTTP, Smartphone-Oberfläche und die
generierte Widget-Paketstruktur. Die Fahrzeugabnahme steht aus.

## Fehleranalyse

- **Phone upload.** Version 0.3.1 erzeugte den QR-Code nach dem Öffnen des
  lokalen Listeners. Der Code prüfte keine Freigabe über den BMW-Input-Pfad
  und filterte IPv4-Link-Local-Adressen heraus. Ein einzelner erfolgreicher
  Upload beendete außerdem die Sitzung. Video Hub registriert seinen
  Telefonport über eine eigene, regelmäßig überprüfte Regel auf
  `wlan_bridge`. Für GIF Home wurde dieser Ablauf für Port 18883 ergänzt.
  Die konkrete Ursache des ursprünglich beobachteten Safari-Timeouts bleibt
  am Fahrzeug zu bestätigen.
- **Randabdunklung.** Der App-Kit-Code schreibt das erzeugte PNG per
  RHMI-Asset-Handle in `BackgroundImage1` des
  `LT_Table_OnlineApps_DriveRecorderWidget`. In Original und Neutral sind
  alle Pixel eines einfarbigen Cover-Test-GIFs RGBA `(62, 120, 170, 255)`.
  Damit fallen PNG-Alpha, App-Maske und Skalierung als Ursache für eine
  Abdunklung in diesem Test aus. Contain kann gleichmäßig dunkle Balken
  erzeugen. Die eigentliche Layout-Definition liegt im BMW-HMI, außerhalb
  des Checkouts. `background` ist eine boolesche Layout-Zelle und lässt
  sich für den Vergleich abschalten. Die Kit-Quellen erwähnen auch Wetter
  und News. Es gibt hier kein überprüfbares alternatives Widget-Layout mit
  einem entsprechenden Bildkanal für die große Kachel. Der bekannte
  Drive-Recorder-Kanal bleibt die Grundlage.

Messpunkte im erzeugten PNG mit flacher Eingangsfarbe, jeweils mittig an der
genannten Seite. Alle Stichproben sind opak.

| Modus | Links und rechts | Oben und unten | Mitte |
| --- | --- | --- | --- |
| Original / Neutral | 62, 120, 170 | 62, 120, 170 | 62, 120, 170 |
| Kompensation aus 0.3.1 | 87, 151, 203 | 120, 207, 255 | 87, 151, 203 |
| Erweiterte Kompensation | 70, 136, 193 | 72, 139, 197 | 64, 125, 177 |

Die erweiterte Kurve skaliert RGB gemeinsam und begrenzt den Effekt nahe Weiß.
Der alte Vergleichsmodus zeigt die bisherige, teils sättigende Kurve. Die
Messung erfasst das PNG vor dem HMI-Compositor. Seine mögliche Abdunklung pro
Seite und die Wirkung von `background` am Fahrzeug sind noch offen.

## Netzwerk und Firewall

Der Server prüft den ausgewählten privaten Zielhost, das lokale Subnetz und
den Token. Der Loopback-Healthcheck liefert lediglich die Kennung der App
und den Status der aktiven Wi-Fi-Sitzung. Der privilegierte Helper beschränkt
seine Regel auf `wlan_bridge`, private oder Link-Local-IPv4-Quellen und TCP
18883. Er fügt die Regel in `ip filter input` vor blockierenden Regeln ein
und räumt anhand seines eigenen Tags auf. Der Statusdienst läuft ausschließlich
auf `127.0.0.1:18983`. Eine Prüfung alle 2,5 Sekunden erkennt entfernte Regeln.
Sitzungsende und fehlender Healthcheck lösen das Entfernen aus. Die systemd-Unit
hat zusätzlich einen Cleanup beim Stoppen.

Der QR-Code erscheint nach Listener-Start, IP-Auswahl und gegebenenfalls
gemeldeter Firewall-Bereitschaft. Der Status für die Telefonverbindung benötigt
eine gültige, verarbeitete HTTP-Anfrage eines mobilen Browsers. Ports 18878 und
18879 der bestehenden GameStation- und Video-Hub-Dienste werden nicht genutzt.
Die Tests prüfen die Regelverwaltung mit einem injizierten nft-Backend und
führen Probe, Statusabfrage und App-HTTP über echte lokale TCP-Sockets aus.

## Änderungen je Datei

| Datei | Änderung |
| --- | --- |
| `apps/gif_home/main.js` | Verbindet App-Kit-Menüs, große und kleine Widget-Kachel, Wiedergabe, API, QR- und Diagnosestatus. |
| `apps/gif_home/upload.js` | Private IP-Auswahl, Listener-Status, geschützte Sitzungen, Zeit- und Größenlimits, API und Helper-Status. |
| `apps/gif_home/phone_page.js` | Lokale mobile Galerie, Auswahl, Upload, Gruppen, Wiedergabe, Statusabgleich und Diagnoseexport. |
| `apps/gif_home/library.js` | Atomare Speicherung, GIF-IDs, Limits, Gruppen, Migration und Schutz vorhandener Daten bei Metadatenfehlern. |
| `apps/gif_home/playback.js` | Fünf Wiedergabemodi, Shuffle-Bag, Wechselzeit, Pause, Wiederanlauf und Decoder-Fallback. |
| `apps/gif_home/diagnostics.js` | Begrenztes persistentes Ereignisprotokoll, Tokenfilter und Löschen. |
| `apps/gif_home/gif.js` | Begrenzte Decoder-Arbeitsspeicherstrukturen, strengere Validierung und tatsächliche positive Frame-Delays. |
| `apps/gif_home/widget_tone.js` | Vier Vergleichsmodi einschließlich vierseitiger Korrektur mit Highlight-Roll-off. |
| `apps/gif_home/app.json` | Version, OAP-Speicherbudget, Navigation und Darstellungsoptionen. |
| `apps/gif_home/README.md` | Einrichtung, Betriebsabläufe, Grenzen, Migration und Build. |
| `mgu-repo.json` | GIF Home 0.4.0 und Abhängigkeit vom nativen Helper. |
| `README.md` | Version und ausstehende Fahrzeugprüfung im Katalog. |
| `native/gif-net/component.json` | Deployment-Dateien, Unit, Aktivierung und Dienstregistrierung. |
| `native/gif-net/firewall.js` | Prüfung, Wiederherstellung und Bereinigung der eigenen nft-Regel. |
| `native/gif-net/server.js` | GIF-Home-Healthcheck und Loopback-Statusdienst. |
| `native/gif-net/mgu-gif-net` | Dienststart, Signalbehandlung und geordneter Shutdown. |
| `native/gif-net/mgu-gif-net.service` | systemd-Lebenszyklus und Stop-Cleanup. |
| `tests/gif_home_library.test.js` | Dateien, Migration, Persistenz, Gruppen, GIF-Fehler und Wiedergabemodi. |
| `tests/gif_home_network.test.js` | Echtes HTTP, Token, Verlängerung, Abbruch, Portkonflikt und simuliertes nft-Backend. |
| `tests/gif_home_widget_tone.test.js` | Flanken, RGB-Verhältnisse, Alpha, Weiß und Highlight-Reserve. |
| `tests/test_gif_home_widget.py` | Generiertes ID7-Widget, Store-Ressourcen und Helper-Abhängigkeit. |

## Testergebnisse

- **Node.js 8.17.0.** Syntaxprüfung der App und des Helpers und alle drei
  GIF-Home-JavaScript-Tests bestanden. Getestet wurden unter anderem mehrere
  Uploads pro Sitzung, Tokens und TTL, Abbruch und erneuter Upload,
  Mehrfachlöschung, Metadatenfehler, alle fünf Modi, Shuffle-Zyklus,
  Pause, Zeitsprünge und Fortsetzen des gespeicherten GIFs.
- **Node.js 24.** Die drei GIF-Home-Suiten und die Netzwerkregressionen für
  Video Hub, GameStation und Phone Terminal bestanden. Im vollständigen
  Repository-Durchlauf bestanden 182 von 187 Tests. Die fünf Fehlschläge in
  `equalizer_snapshot.test.js`, `light_flasher_recovery.test.js` und
  `light_flasher_ui.test.js` traten mit denselben Assertions auch auf dem
  unveränderten Basiscommit auf.
- **Python.** 16 Tests und fünf Subtests bestanden, einschließlich der vier
  GIF-Home-Widget- und Paketprüfungen.
- **App-Kit-PC-Vorschau.** Original, Neutral und beide Korrekturen als
  384 × 256 PNGs erzeugt. Cover und Contain durchlaufen. Alle fünf
  integrierten GIFs unter Node.js 8 dekodiert und die RGBA-Frames und
  Gesamtdauern bytegenau gegen Version 0.3.1 verglichen.
- **Browser-Durchlauf.** Die App-Kit-Vorschau und den echten GIF-Home-Server
  im selben lokalen Test verwendet. Beide QR-Codes direkt aus den
  gerenderten PNGs dekodiert. Im Chromium-Mobilprofil Upload zweier GIFs,
  Vorschau, Aktivierung in der MGU-App, Gruppenanlage, Gruppenzuweisung,
  Gruppenwiedergabe, Sitzungsverlängerung, authentifizierten Logexport und
  bestätigte Mehrfachlöschung geprüft.
- **Build.** Das vorhandene `tools/build_gif_home.py` bleibt der
  Store-Einstiegspunkt. Der Original-Build stoppte am fehlenden
  `oap-sdk/index.js`. Mit einem isolierten SDK-Platzhalter für den
  PC-Strukturtest erzeugte der Builder beide Archivformen. Das Store-Archiv
  enthielt alle neuen JavaScript-Module, `resources.pack` und die ID7-
  StartWidget-Ressourcen. Die lokale Vorschau verwendete den vorhandenen
  App-Kit-HU-Stub. Die so erzeugten Archive sind Testartefakte.

## Offene Fahrzeugabnahme

1. **Store und MGU.** Mit dem BMW-SDK bauen, die Store-Aktualisierung von
   0.3.1 samt nativem Helper durchführen und den Widget-Start nach einem
   MGU-Neustart prüfen.
2. **iPhone und Firewall.** Mit echtem iPhone und Safari über Wireless
   CarPlay und gegebenenfalls den lokalen Fahrzeug-WLAN-Zugang koppeln.
   IP, Subnetz, Interface, ersten gültigen Request, Firewall-Reload,
   Sessionablauf und Regellöschung kontrollieren. Die Firmware muss Safari
   zum ausgewählten lokalen MGU-Ziel routen können.
3. **Widget-Compositor.** Das flache Test-GIF im großen Home-Tile mit
   identischem Cover vergleichen. Links, rechts, oben und unten separat
   messen, `background` umschalten und die sichtbare Wirkung der vier
   Modi protokollieren.
4. **Last und Wechsel.** Wechsel zwischen unterschiedlich großen GIFs,
   Residenzzeit sichtbarer RHMI-Assets, Frametiming bei 1–6 fps,
   Speicherbedarf und mögliche Schwarzbilder am realen Display prüfen.
   Höhere Refresh-Raten bleiben wegen der PNG- und RHMI-Kosten deaktiviert.
