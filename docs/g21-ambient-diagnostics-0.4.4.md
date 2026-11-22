# Prüfbericht zu G21 Ambient Lighting 0.4.4

Ausgangspunkt ist der Main-Commit `08d32ccdc2b89fed2d822afb349843411f976462`. Die Ambient-App stand dort auf 0.4.3. Die Umsetzung liegt auf `dev/ambient-diagnostics`.

## Befunde und Korrekturen

| Pfad im Ausgangsstand | Befund und Ursache | Änderung in 0.4.4 |
| --- | --- | --- |
| `kit/runtime/diag.js` | Die bisherige physische Abfrage behandelte die TASU-Ereignisse für Ablehnungen und Transportfehler separat vom Antwortlistener. Ein Transportfehler konnte deshalb als UDS-Timeout erscheinen. Ein NRC 78 vom adressierten ECU konnte den Timer bereits vor der Filterung nach Dienst verlängern. | Die App verwendet eine neue, separat aufrufbare Variante mit ECU-, Dienst- und DID-Filter, Transportfehlern, Antwortfrist und absoluter Frist. Listener werden nach Abschluss, Abbruch und Verbindungsverlust entfernt. Die übrigen Aufrufer behalten ihren bisherigen API-Pfad. |
| `apps/g21_ambient/safe_diag.js` | LIN-Antworten wurden vor allem über ihre Länge gemeldet. Jeder vollständige Messlauf ersetzte die Vergleichsreferenz. Ein unvollständiger Lauf verwarf sie. Der RAM-Schreibversuch speicherte nur einen knappen Ergebnistext. | Referenz und Kontrollmessung sind getrennt. Die App behält pro Bus das letzte dekodierbare Ergebnis und markiert ältere Werte bei Bedarf. Jeder Vorgang speichert TX, RX, Dauer, Status und NRC. Die Sichtprüfung erhält eine eigene, zeitgestempelte Benutzerangabe. |
| `apps/g21_ambient/main.js` und `apps/g21_ambient/hmi.js` | Die gemeinsame Diagnoseseite bot keine getrennte Prüfung der beiden BDC-Abfragen, keine vollständige Rohdatenansicht und kein Live-Protokoll. | Getrennte Ansichten für Übersicht, RAM01, LIN 1, LIN 2, Vergleich, Assistent und Offline-Plan. Eigener Log-Tab mit Touch-, Drehregler- und nativer Rückfallbedienung. Text und JSON stehen als QR-Berichte zur Verfügung. |
| `apps/g21_ambient/logic.js` und `docs/ecu-prg-review-2026-11-03.md` | Die statische Prüfung zeigt Übereinstimmung zwischen dem bestehenden Encoder und der dokumentierten Argumentfolge. Aus der negativen ECU-Antwort lässt sich kein belegter Ersatzbefehl ableiten. | Der manuelle RAM-Test behält den vorhandenen Befehl und seine Freigaben. Der RAM-Tab zeigt jetzt den vollständigen Befehl und seine Antwort, inklusive der kodierten Parameter. |

## Diagnosekommunikation

**Start Diagnostics** sendet ausschließlich die bekannten Lesezugriffe `37:22 F150`, `40:22 DA5F` und `40:22 E3D1`. RAM01 und die beiden LIN-Busse lassen sich zusätzlich einzeln prüfen. Der geführte Test erfasst die Ausgangsmessung, wartet auf die manuelle Änderung im BMW-Menü, liest die Busse erneut aus und speichert die Sichtprüfung durch den Benutzer. Die manuelle RAM-Ansteuerung ist ein separater Vorgang mit aktuellem Stillstand, erwarteter RAM-Identität und bewusster Zweifachbestätigung.

Die App serialisiert Diagnoseoperationen. Der TASU-Aufruf hat eine Frist von 3 s. Die anschließende UDS-Antwortfrist beträgt für RAM 2,3 s und für BDC 4 s. Eine passende Pending-Antwort kann die Antwortfrist verlängern. Pro Anfrage bleiben insgesamt höchstens 7 s. Bei NRC 21 wiederholt die App eine BDC-Leseanfrage einmal. Nach Timeout, Transportfehler oder Abbruch gilt für das adressierte ECU ein Ruhefenster von 3 s. Eine noch ausstehende native Sendefunktion blockiert weitere Sends, während der App-Vorgang selbst fristgerecht endet. Ein Abbruch beendet das Warten und die restlichen Schritte. Ein bereits gesendeter Befehl lässt sich nicht zurückholen.

TASU liefert die ECU-Adresse und UDS-Nutzdaten, aber auf diesem Pfad keine Transaktions-ID. Positive Antworten werden nach Adresse, Dienst und gespiegelter DID zugeordnet. Eine negative UDS-Antwort enthält Dienst und NRC, jedoch keine DID. Serialisierung, Ruhefenster, zeitlich begrenzte Listener und Verbindungsrevisionen begrenzen die Mehrdeutigkeit. Eine verspätete identische Antwort, die während einer späteren passenden Anfrage eintrifft, bleibt technisch mehrdeutig. Die App sendet keine zusätzlichen Diagnose-Sessions, Security-Access-Befehle, Resets oder Codierungen.

Die Referenz `licht.zip` beschreibt für BDC_G05 bei `INNENLICHT_FI_LIN_1_LAYERING` und `INNENLICHT_FI_LIN_2_LAYERING` jeweils 261 Ein-Byte-Felder. Das sind 26 NAD-Slots mit je zehn Bytes und ein abschließendes Byte zur Adressierungsmethode. Das erste Slot-Byte beschreibt den Verbauort. Die Slotnummer liefert den NAD. Danach folgen Blau, Grün, Rot, Helligkeit und Weiß. Die vier Statusbytes und das abschließende Adressierungsbyte zeigt die App als Rohwerte. Eine Antwort der erwarteten Länge passt zu diesem Layout. Die genaue BDC-Variante und die tatsächliche Verkabelung am Fahrzeug bleiben damit offen.

Der Vergleich verwendet Bus und NAD als Schlüssel. Wechsel des Verbauorts, hinzugekommene oder fehlende Einträge, unbekannte Werte und doppelte Schlüssel werden separat dargestellt. Ein Ergebnis, das vor einer Unterbrechung entstand oder auf einen neueren erfolglosen Versuch folgt, kann weiterhin eingesehen werden und ist als älter oder veraltet gekennzeichnet.

## Warum RAM01 mit `7F 2E 31` antwortet

Der Encoder erzeugt `2E E3 11 00 ON BRIGHT R G B TIME`. Der TASU-Aufruf übergibt den Dienst `0x2E` separat und meldet neun Nutzbytes für DID und Argumente. Die Reihenfolge entspricht **ID, EIN_AUS, HELLIGKEIT, ROTWERT, GRUENWERT, BLAUWERT, ZEIT**. Die PRG-Referenz dokumentiert ID 0 für alle Module, Ein/Aus 0 oder 1, Helligkeit 0–100 und RGB 0–254. Die App lässt eine Dauer von 1–254 s zu. Für Aus setzt sie Helligkeit 0. Als Schreibquittung akzeptiert die App exakt `6E E3 11`.

Am berichteten Fahrzeug antwortete RAM01 auf F150 mit `0F 25 90`. Beim Schreiben kam `7F 2E 31` zurück. Das bestätigt die Ablehnung des konkreten Aufrufs als „Request Out Of Range“. Der NRC benennt kein einzelnes Feld. Die Unterstützung von E311 auf dieser Softwarevariante, die Zulässigkeit der Gruppenadresse ID 0 in der Fahrzeugkonfiguration und der tatsächliche Steuerpfad der Nachrüstbeleuchtung sind offene Hypothesen. Frühere abgelehnte Lesezugriffe auf E310/E311 stützen die Frage nach der Verfügbarkeit dieser Funktionen auf der Variante. Für eine konkrete Ursache fehlen eine fahrzeugbezogene Funktionsreferenz oder ein bekannter funktionierender Vergleichstrace.

Das Bild mit `Not checked` zeigt den Zustand vor den BDC-Messungen in dieser Sitzung. Separat wurden für beide BDC-Abfragen je 261 Nutzbytes gemeldet. Das bestätigt den Lesezugriff in jenem Lauf. Es bleibt offen, ob die aufgezeichneten Daten die sichtbare Nachrüstbeleuchtung abbilden oder ob ein separates Modul beteiligt ist.

## AutoHeat-Konsole und Export

Die Konsole übernimmt das Bedienkonzept von Heating Comfort mit 13 sichtbaren Zeilen und **OLDER**, **NEWER** und **LATEST**. Zeitstempel und Meldungen werden in festen Zeichenabständen gezeichnet. Der Umbruch erfolgt in der Anzeige. Der Export erhält die ursprünglichen Nachrichten. Beim manuellen Scrollen bleibt der sichtbare Ausschnitt verankert, während am Ende laufend neue Einträge sichtbar werden. Der Speicher hält bis zu 640 Ereignisse beziehungsweise 96 KiB Nachrichtentext. Der Export kennzeichnet verdrängte Einträge sowie die letzte manuelle Löschung. Clear Log betrifft ausschließlich den app-internen Puffer.

Der QR-Encoder entspricht der MIT-lizenzierten AutoHeat-Bibliothek. Die App erzeugt einen Textbericht und strukturierte JSON-Daten offline. Nummerierte QR-Seiten enthalten die komprimierten Nutzdaten. Das Rekonstruktionsskript prüft Anzahl, Kennung und Hash. Der Bericht enthält die freigegebenen Diagnoseanforderungen und Antworten, Vergleiche, den letzten Schreibversuch, Sichtprüfung und erhaltene Logereignisse. Allgemeine SDK-Logs, vollständige App-Einstellungen und VIN-Abfragen bleiben außerhalb des Exports.

## Verifikation

| Prüfung | Ergebnis |
| --- | --- |
| Gezielte Ambient-, Protokoll- und iDrive-Smoke-Tests mit `node --test tests/ambient*.test.js tests/controls.test.js tests/g21_car_ui_smoke.test.js` | 29 bestanden. Unter anderem positive und unbekannte RAM-Identität, Timeout, NRC 21/31, Schreibquittung ohne Sichtnachweis, fehlerhafte LIN-Länge, unterschiedliche Reihenfolge und doppelte Schlüssel, Abbruch, Antwortfilter, Einzelflug, Live-Log und QR-Rekonstruktion. |
| Gesamte JavaScript-Suite mit `node --test tests/*.test.js` | 179 von 185 bestanden. Die sechs Abweichungen sind unten aufgeführt und auf dem unveränderten Ausgangscommit reproduziert. |
| Python-Suite mit `python3 -m pytest -q tests` | 15 bestanden, zusätzlich sechs bestandene Subtests. Pytest meldet eine Deprecation-Warnung eines installierten Plugins. |
| Node 8.17.0 und Store-Paketierung | Syntaxprüfung aller Ambient-JavaScript-Dateien und der betroffenen Kit-Dateien bestanden. Software-Vorschau unter Node 8 für alle fünf App-Seiten gerendert. Store-Build mit OAP SDK 24.10.2 erzeugte `.tgz` und `.mgu`. |
| MGU-Emulator mit nativer Renderer-Emulation | Farbpresets und RGB-Touchbewegung, Diagnoseaufruf, Live-Log-Swipe, Sprung ans Ende, Drehregler-Scrollen und beide QR-Ansichten geprüft. Native Rückfallnavigation mit abgeschaltetem Touch-Routing geprüft. Der Emulator liefert keine Fahrzeugdiagnosedaten. |
| QR-Scanner und Rekonstruktion | Ein unabhängiger Decoder hat alle acht gerenderten Seiten pro Format gelesen. Automatisierte Tests prüfen bytegenaue Offline-Rekonstruktion bei beliebiger Seitenreihenfolge sowie Ablehnung unvollständiger Berichte. |

Bereits auf dem Ausgangscommit fehlschlagende Tests:

- `tests/equalizer_snapshot.test.js` erwartet für das zweite Snapshot-Layout 416 Bytes und bekommt 384.
- `tests/light_flasher_recovery.test.js` enthält zwei veraltete Quelltext-Erwartungen für Stillstands- beziehungsweise Recovery-Gates.
- `tests/light_flasher_ui.test.js` enthält zwei veraltete Erwartungen zur Service- und Settings-Navigation.
- `tests/wheelheat_ui.test.js` erwartet Version 0.5.3, während `main` bereits 0.5.4 enthält.

## Ausstehende Fahrzeugtests

1. Im Stand **Start Diagnostics** ausführen und die beiden BDC-Antworten, Rohdatenlängen und gültigen LIN-Datensätze dokumentieren.
2. Im Assistenten zwischen zwei gut unterscheidbaren Originalfarben wechseln und die Helligkeit gleich lassen. Den Übergang abwarten, anschließend vergleichen und angeben, welche Innenleuchten oder Nachrüstmodule sichtbar mitgewechselt haben. Den beleuchteten Kühlergrill separat beobachten.
3. Bei einem bewusst ausgelösten weiteren RAM01-Test TX, RX, Antwortdauer und sichtbares Ergebnis zusammen erfassen. Ein erfolgreicher BMW-Menüwechsel belegt keine erfolgreiche RAM-Ansteuerung.
4. Die genaue RAM-Softwarevariante und die dokumentierte Retrofit-Verkabelung mit den aufgezeichneten Daten abgleichen. Ein belegter Hersteller- oder Referenztrace derselben RAM-Variante kann zeigen, ob E311 und ID 0 für diese Konfiguration unterstützt werden.
5. Die QR-Seiten am MGU-Display mit einem Telefon scannen. Softwaredekodierung, vollständige Rekonstruktion und MGU-Bedienpfade wurden geprüft. Die tatsächliche Lichtwirkung und die optische Scanqualität im Fahrzeug stehen noch aus.
