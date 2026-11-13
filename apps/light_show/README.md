# Light Show 0.2.4

## 0.2.4: FLM02 settings and BDC release diagnostics

**FLM02:** In Settings choose a test PWM of **20/40/60/80/100%** and a finite
duration of **1/2/3/5 seconds**. Default: 60% for 2 seconds. Only one LED
channel is requested at a time; an original FLM StopRoutine and default-session
request follow. No channel 0, infinite time or automatic sequencing is allowed.
100% / 5 seconds is experimental: keep the vehicle securely parked in P on
private property, with no people or traffic in the beam. The original START
framing, effective output, and thermal or motor effects remain unverified.

**Individual BDC tests:** The previous car log showed the individual OFF
acknowledgement (`6F E3 B5 03`) and default-session response (`50 01`), but
general OEM release was refused (`7F 2F 22`). That rejection is not fixed by
simply ignoring it. Version 0.2.4 records each cleanup result separately and
attempts an after-OFF readback. When Repeat finds a saved lock, it opens the
normal-light check directly. The observation screen also includes **Check
normal lights / clear BDC lock**. Only after checking all regular lights can
the operator manually clear the app's saved marker. **This does not establish
that the OEM ECU release actually succeeded.** An unverified alternate release
telegram is intentionally not attempted.

**Logs:** **Diagnostics → Save diagnostic log** writes
`light-show-diagnostics.json` under the app data directory, displaying the
actual path. Download it with the MGU Phone Terminal file-download function
or copy via SSH. It contains raw ECU requests/responses, PWM/time settings,
observations and cleanup acknowledgements.


Experimentelle Stroboskop-App für BMW MGU iDrive 7, angelehnt an
[das Reel von bmwneva](https://www.instagram.com/reel/DfR0l0HxKNS/).
Eigenständige Implementierung, kein Originalcode aus dem Reel.

## 0.2.3: FLM02-Kanäle gezielt untersuchen (experimentell)

Unter **Diagnostics → Experimental FLM02 LED channels** stehen die
Scheinwerfermodule **FLM02_L** (`0x43`, SGBD `0F26C0`) und **FLM02_R**
(`0x44`, `0F26D0`) zur Auswahl. Erst nach der Identitätsprüfung bietet
die App **15 Einzelkanäle je Seite** an. Für jeden Kanal gibt es nur einen
festen Versuch mit **20 % PWM und einer Sekunde Zeitbegrenzung**. Eine
Daueransteuerung, ein Befehl für alle Kanäle oder eine automatische
Kanalfolge sind nicht vorgesehen. Die tatsächliche Zuordnung zu
Fernlicht, Abblendlicht oder anderen LEDs ist **nicht bestätigt**.

Die BMW-Originaldateien `FLM02_L.prg` und `FLM02_R.prg` enthalten die
Routine `FLM_KANAL` (RID `A54B`) mit Feldern für Kanal, PWM und Zeit.
Den zugehörigen Stop-Befehl `31 02 A5 4B` konnten wir durch Offline-
Ausführung der Originalroutine gegen eine reine Aufzeichnungsschnittstelle
auf beiden Seiten bestätigen. Das **vollständige Starttelegramm** ist
dagegen nur aus den Argumenttabellen abgeleitet und **noch nicht unabhängig
verifiziert**. Auch eine positive Steuergeräteantwort oder ein quittierter
Stop belegen keine tatsächliche LED-Wirkung beziehungsweise vollständige
physische Rückgabe. Es werden keine ausdrücklichen Stellmotorbefehle gesendet;
unbeabsichtigte Stellbewegungen durch die Scheinwerferelektronik sind dennoch
nicht ausgeschlossen.

Die App speichert vor dem Wechsel in die FLM-Diagnosesitzung eine
Wiederherstellungsmarkierung. Nach dem Versuch wird zuerst die originale
FLM-StopRoutine, danach die Standardsitzung angefordert. Nur wenn beides
positiv quittiert wurde, wird die Sperre automatisch entfernt. Bei
Fehlern bleibt sie erhalten und weitere Versuche werden gesperrt. Eine
alte BDC-Stop-Sperre, die das Fahrzeug mit `NRC 22` nicht zurückgegeben hat,
wird durch diesen neuen Ansteuerungsweg **nicht** umgangen. Sie darf nach
Prüfung der normalen Fahrzeuglichter wie bisher in Diagnostics manuell
bestätigt werden.

**Erste Prüfung:** nur bei sicher abgestelltem Fahrzeug, in `P`, mit
Zündung und ohne Personen im Lichtkegel. Nach einem alten Fehlversuch zuerst
die normale Beleuchtung prüfen und die Sperre bewusst bestätigen. Dann
unter Diagnostics links **oder** rechts ein einziges FLM-Kanal-Testfeld
aufrufen, die Reaktion und ungewöhnliche Geräusche beobachten und direkt
protokollieren. Bei Motor-/Stellgeräuschen oder unerwartetem Verhalten sofort
**STOP** drücken und keine weiteren Tests auslösen. Vor einer Fahrt müssen
alle vorgeschriebenen Fahrzeugleuchten normal funktionieren. Die Funktion
ist ein **nicht fahrzeugvalidierter Diagnose-Prototyp**, keine einsatzfertige
Light-Show-Steuerung.

## 0.2.2: Jede Außenleuchte einzeln testen

Unter **Diagnostics → Individual light tests / 32 outputs** gibt es vier
Untergruppen für Front, Seite, Heck/Bremslicht und die hinteren Zusatzleuchten.
Die 32 einzeln auswählbaren BDC-Ausgänge stammen aus der Tabelle
`TAB_LICHT_AUSGANG_DIGITAL_ARG` in der vom Nutzer bereitgestellten
`BDC_G05.prg` (Revision 36.001). Dazu gehören:

- Fernlicht und Abblendlicht jeweils links/rechts;
- Tagfahrlicht, Positionslicht und Nebelscheinwerfer links/rechts;
- Blinker vorn, seitlich und hinten jeweils links/rechts;
- Schlusslichtkreise links/rechts, Bremslicht links/rechts sowie **die dritte
  Bremsleuchte `BL_M` (ID `0x23`)**;
- Bremskraftanzeige-Ausgänge `BFD_L` und `BFD_R`, Rückfahrlicht,
  Nebelschlusslicht und Kennzeichenbeleuchtung.

Jeder Test fordert genau **einen** diskreten BDC-Ausgang für **750 ms** an.
Danach werden explizit der Einzel-Ausgang OFF, die allgemeine IO-Rückgabe und
die Standardsitzung versucht. Es erfolgt keine Stellmotor-Ansteuerung durch die
App, allerdings lässt sich nicht ausschließen, dass die Steuergeräte auf
einen Lichtauftrag mit eigenen Stellbewegungen reagieren.

**Wichtig:** Das ist derselbe alte `E3B5`-Ausgangsweg, bei dem am getesteten G21
in Version 0.1.1 kein sichtbares Fernlicht beobachtet wurde. Die zusätzlichen
Ausgangskennungen sind aus der PRG-Tabelle belegt; ihre einzelnen Steuertelegramme
und physische Wirkung wurden noch nicht gegen das Fahrzeug verifiziert. Manche
Ausgänge können im G21 fehlen oder vom jeweiligen Steuergerät anders zugeordnet
werden. Es werden **keine** unbekannten FLM-LED-Kanäle oder Stellmotoren angesteuert.

Nach jeder Prüfung kann das Ergebnis direkt erfasst werden:
"visible, no unusual noise", "visible and unusual noise", "no visible effect,
no noise" oder "unusual noise without visible light". Diese Beobachtungen
werden lokal gespeichert und mit **Diagnostics → Save diagnostic log**
exportiert. Die App bewertet bestätigte ECU-Antworten weiterhin nicht als
Sichtnachweis. Nach einer abgelehnten Rückgabe wird der nächste Test gesperrt;
die normale Fahrzeugbeleuchtung muss geprüft werden, bevor die gespeicherte
Sperre manuell zurückgesetzt werden darf.

## 0.2.1: Scheinwerfermodule auslesen

Der Nutzer bestätigt jetzt sichtbares Fernlicht über den neuen Weg, berichtet aber
bei jedem Einschalten Stellgeräusche, die bei normaler Lichthupe nicht auftreten.
Die Ursache des Geräusches und eine Beteiligung der Höhenregelung sind noch nicht
messtechnisch bestätigt. Die App sendet keine ausdrücklichen Stellmotorbefehle.

Unter **Diagnostics → Read headlamp modules / LED mapping** liest 0.2.1 die
Identität der beiden Scheinwerfermodule und bei passender FLM02-L/R-Identität
die Zuordnung der Fernlicht-LED-Ausgänge. Unbekannte Varianten werden nur
identifiziert. Diese Prüfung sendet ausschließlich Leseanfragen, keine
Sitzungswechsel, Licht- oder Stellmotorbefehle. Die Ergebnisse erscheinen in
Diagnostics und im Export. Kanalwerte werden roh angezeigt und noch nicht zur
Ansteuerung verwendet. Diese Version behebt die Stellgeräusche noch nicht.

## Tatsächlicher Teststand

Im gemeldeten G21-Test von **0.1.1** entstand **kein sichtbarer Lichteffekt**,
weder mit laufendem noch mit abgestelltem Motor. Der BDC bestätigte zwar die
Ausgangsbefehle und meldete nach dem ersten Einschalten für Fernlicht links den
Statuswechsel `0` → `1`. Das ist kein Nachweis, dass eine LED leuchtet.
Die allgemeine IO-Rückgabe wurde mit `NRC 22` abgelehnt. Nur das manuelle
Bestätigen in Diagnostics löschte die gespeicherte Startsperre; dadurch wurde
die Lichtansteuerung nicht repariert.

**0.2.0 ergänzte einen anderen Ansteuerungsweg, dessen Lichtwirkung inzwischen mit Stellgeräuschen gemeldet wurde:**
die zeitbegrenzte BMW-Leuchtenfunktion `D542`. Sie fordert beide Leuchten gemeinsam
an und verwendet Zeit `0` als eigenen Stop-Auftrag. Dieser Weg benutzt keine
allgemeine `E3B5`-IO-Rückgabe. Das abwechselnde Links-/Rechts-Blinken bleibt im
alten Diagnoseweg verfügbar, ist am gemeldeten G21 aber weiterhin ohne Wirkung.

## Update und erster Test

1. Nach Freigabe beziehungsweise Veröffentlichung von 0.2.3 im MGU Store
   die Quelle `NamelsMissing/mgu-apps`, Kanal **main**, aktualisieren
   und **Light Show 0.2.3** installieren. Ein lokaler Build allein ist noch
   keine Veröffentlichung im Store.
2. Zündung einschalten und im Stand **P** wählen. Ein laufender Motor ist keine
   Startbedingung der App.
3. Falls noch eine Startsperre aus 0.1.1 besteht: normale Beleuchtung mit den
   Fahrzeugschaltern prüfen und in **Diagnostics → Normal lights checked – reset
   saved stop lock** bestätigen. Das entfernt nur die gespeicherte Sperre.
4. **Light pair: High beam** wählen und **2-second test: both selected lights**
   drücken. Dieser Knopf fordert einmal zwei Sekunden Fernlicht über die neue
   Leuchtenfunktion an, unabhängig von der eingestellten Show-Dauer.
5. Die tatsächlichen Scheinwerfer beobachten. Erst wenn beide sichtbar reagieren,
   die Muster mit **Light control: Both lights – timed function (new test)** und
   **Start vehicle lights** testen.
6. Der alte Weg **Diagnostics → Individual light tests / 32 outputs** ist
   am getesteten G21 weiterhin ohne sichtbare Wirkung und kann eine
   gespeicherte BDC-Sperre auslösen. Für die neue, noch unbestätigte
   FLM-Diagnose siehe die gesonderten Hinweise zu 0.2.3 oben.
7. Bei ausbleibender Reaktion oder Fehler **Diagnostics** öffnen und das neue
   Protokoll mit **Save diagnostic log** speichern.

**Preview on screen** ist ausschließlich eine Bildschirmvorschau. Eine bestehende
Show wird vor dem Öffnen beendet. Die App installiert keinen Hintergrunddienst
und startet beim Booten keine Show.

## Funktionen und Grenzen

- Zeitbegrenzte gemeinsame Leuchtenfunktion: beide zusammen, Doppel- und Dreifachblitz.
- Getrennter alter Ausgangsweg mit sechs Links-/Rechts-Mustern für Diagnosezwecke
  sowie 32 einzelne Außenlicht-Ausgänge mit kurzer Prüfzeit und Beobachtungsprotokoll.
- Experimenteller FLM02-Routinentest mit einem Kanal je Seite, festem PWM,
  kurzer Dauer, explizitem Stop und Beobachtungsprotokoll. LED-Zuordnung
  und Starttelegramm sind noch unbestätigt.
- Auswahl Fernlicht, Tagfahrlicht, Standlicht oder Nebelscheinwerfer vorn.
  Die neue Standlichtfunktion kann auch hintere Leuchten einschließen;
  Nebelscheinwerfer müssen vorhanden sein.
- Musterschritt 100 / 150 / 200 / 300 / 500 ms; Show-Dauer 5 / 15 / 30 / 60 Sekunden.
  Jeder normale Einschaltauftrag im neuen Weg enthält höchstens 500 ms
  Aktivierungszeit, der einzelne Funktionstest höchstens zwei Sekunden.
- Stop bei Bewegung, Verlust von P, veralteter Geschwindigkeit, Verbindungsverlust,
  Verlassen der App oder Änderung der Einstellungen.
- Native Touch-/Controller-Bedienung, separate Vorschau und Diagnoseexport
  `light-show-diagnostics.json` im App-Datenordner.

Jeder Diagnosebefehl wird abgewartet. Langsame Antworten verlangsamen das Muster;
es werden keine verspäteten Impulse nachgeholt. Die App zeigt bestätigte Befehle
und BDC-Statuswerte an. Sie misst nicht die physische Helligkeit. Auch ein
bestätigter Stop-Auftrag ist zunächst eine Protokollbestätigung.

## Protokoll und Offline-Prüfung

Für den bisherigen BDC-Weg wird ausschließlich BDC_G05, Adresse `0x40`,
SGBD-Index `0F2680`, zugelassen. Für den neuen Einzelkanaltest werden
zusätzlich die konkreten FLM02_L/R-Identitäten überprüft. Andere Varianten
werden abgewiesen. Eine G21-Modellbezeichnung ersetzt diese Prüfung nicht.

Die Telegramme wurden aus der eigenen `Ecu.zip / Ecu/BDC_G05.prg`, Revision
36.001, ermittelt und durch Ausführung der originalen Job-Bytecodes gegen eine
aufzeichnende Schnittstelle gegengeprüft. Dabei bestand keine Fahrzeugverbindung.
`protocol-evidence.json` enthält die PRG-Prüfsumme, 17 Referenzen für den alten
Ausgangsweg und 28 für die neue zeitbegrenzte Funktion. Die für die neue Prüfung
nötige Korrektur der 32-Bit-Vorzeichenbehandlung im lokalen Forschungsinterpreter
ist dort dokumentiert. Dieser Interpreter ist keine App-Abhängigkeit.

| Aktion | UDS-Nutzdaten |
| --- | --- |
| BDC identifizieren | `22 F1 50` |
| Temporäre Diagnosesitzung | `10 03` |
| Neue Fernlichtfunktion, zwei Sekunden | `2E D5 42 00 05 00 C8` |
| Stop-Auftrag derselben Funktion | `2E D5 42 00 05 00 00` |
| Leuchtenfunktionsstatus lesen | `22 D5 42` |
| Alter Ausgang Fernlicht links ein | `2F E3 B5 03 07 01 C0` |
| Diagnose-Bremslicht Mitte ein (aus der Ausgangstabelle abgeleitet) | `2F E3 B5 03 23 01 C0` |
| Diagnose-Bremslicht Mitte aus (aus der Ausgangstabelle abgeleitet) | `2F E3 B5 03 23 00 C0` |
| Alte allgemeine IO-Rückgabe, im Fahrzeug abgelehnt | `2F E3 B5 00 FF` |
| Standardsitzung anfordern | `10 01` |

Für den neuen FLM-Weg ist der **original aufgenommene Stop**
`31 02 A5 4B` dokumentiert. Die daraus und aus der PRG-Argumenttabelle
abgeleitete Start-Anfrage `31 01 A5 4B <KANAL> 14 01` ist **ein
unverifiziertes Kandidatentelegramm** (Hex `14` = 20). Die Datenlage steht
in `flm-evidence.json`; sie ersetzt keine Messung am Fahrzeug.

Für `D542` sind Funktion und Zeit jeweils zwei Bytes mit höchstwertigem Byte
zuerst; die Zeit ist in Hundertstelsekunden codiert. Es erfolgt kein automatischer
Wechsel zwischen den beiden Ansteuerungswegen nach einem Fehler.

## Stop und gespeicherte Startsperre

Stop setzt sofort das Abbruchsignal. Ein laufender Diagnosebefehl wird abgewartet,
dann folgt der zum gespeicherten Ansteuerungsweg passende Stop-Auftrag und
anschließend die Standardsitzung. Danach werden keine Einschaltbefehle nachgereicht.

Vor jedem Sitzungswechsel wird eine Wiederherstellungsmarkierung im App-Datenordner
gespeichert. Sie enthält jetzt auch Ansteuerungsweg und Leuchtenfunktion.
Schlägt das Speichern fehl, wird nicht angesteuert. Erst nach beiden positiven
Antworten für Stop und Standardsitzung wird die Markierung automatisch gelöscht.
Nach einem Neustart wird bei vorhandener Verbindung nur die passende Rückgabe
versucht. Eine alte Markierung aus 0.1.1 wird weiterhin mit der alten IO-Rückgabe
behandelt; sie wird beim Update nicht stillschweigend gelöscht.

Bei **Timed stop pending** oder **OEM release pending** bleiben neue Starts gesperrt.
Die manuelle Bestätigung in Diagnostics verlangt Stand/P, eine passende BDC-Identität,
eine positive Standardsitzungsantwort und die vorherige Lichtprüfung durch den
Nutzer. Sie bestätigt keine erfolgreiche physische Rückgabe.

Bei hartem Stromverlust kann die App keine Antwort mehr abwarten. Die neue Funktion
enthält zwar eine endliche Aktivierungszeit; die tatsächliche Rückfallreaktion und
der Stop-Auftrag müssen am Fahrzeug noch bestätigt werden.

## Quellcode und Build

[Repository](https://github.com/NamelsMissing/mgu-apps/tree/main/apps/light_show).
Der Diagnose-Transport liegt app-lokal in `tasu.js`; andere Apps werden nicht verändert.

```sh
node kit/tools/extract_sdk.js /pfad/zur/eigenen/javascript/app.js oap-sdk
python3 tools/build_store_app.py light_show
node kit/tools/test_light_show.js
```

Für einen optionalen USB-Katalog nach Build und Tests:

```sh
python3 kit/tools/package_light_show.py
```

Der erzeugte Katalog unter `dist/light-show-usb/mgu-repo` kann auf die oberste Ebene
eines USB-Sticks kopiert werden. Der Store muss USB-Kataloge unterstützen.
BMW-SDK-Dateien und vollständige PRGs werden nicht mitgeliefert. Der private Build
benutzt das eigene x_call-SDK; bei Installation aus dieser GitHub-Quelle ergänzt
der MGU Store das SDK aus der eigenen Firmware.

Die Vorschau kann ohne Fahrzeug geprüft werden:

```sh
node kit/tools/preview.js dist/light_show qa/light_show BTN_PREVIEW render
```

Das native Hauptmenü zeichnet die BMW-HMI. Der Emulator stellt native Menüs nur
eingeschränkt dar; ein erfolgreicher Vorschau-Test belegt keine Fahrzeugfunktion.

## Herkunft

MGU App Kit und TASU-Transport: cauliflowermossgrape/idrive7-apps (MIT), geprüfter
Basisstand `180537a0bdf39163046a6855e7928eb35bb47c7b`.
Store und USB-Format: robertnisipeanu/mgu-store.
Referenzanalyse: EdiabasX von emdzej, nicht Bestandteil der installierten App.
