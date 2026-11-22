# Light Flasher 0.1.25 – Prüfbericht zur Startlatenz

Ausgangsstand ist `main` bei `c0a42f5604b5fc33ebe1f349c24cd956f14c43dc` mit App-Version 0.1.24. Das Video liefert als Arbeitshypothese rund 2,1 s zwischen optischem Ende der OEM-Lichthupe und erstem sichtbaren App-Flash. Es liegen keine synchronisierten Fahrzeuglogs vor, mit denen sich die 2,1 s aufteilen oder bestätigen lassen.

## Was der Code belegt

| Abschnitt | Befund |
| --- | --- |
| OEM-Signal | SOME/IP-Notifications gelangen direkt in den Signalkallback. Der 500-ms-Getter ist ein zusätzlicher Pfad zur Auffrischung und zur Erfassung auf Fahrzeugen mit fehlenden Notifications. Für eine ausschließlich per Getter erfasste Flanke kommen die Wartezeit bis zum nächsten Read und seine Laufzeit hinzu. Kurze Impulse können zwischen zwei Reads liegen. |
| OFF-Bestätigung | 0.1.24 bestätigt 400 ms nach empfangenem AUS frühestens beim nächsten Aufruf der Erkennung. Ohne weiteres Signal wartet sie auf den 250-ms-Tick und dessen Event-Loop-Ausführung. 0.1.25 setzt den Timer beim gültigen AUS. Ein erneutes EIN, ungültiger Zustand, Providerverlust oder eine inzwischen fehlende Freigabe verwirft den Kandidaten. |
| Datei und UI | 0.1.24 serialisiert den Hintergrundstatus und schreibt Änderungen synchron, teilweise vor der Triggerentscheidung. Das blockiert den JavaScript-Thread. Die Dauer auf der MGU ist unbekannt. 0.1.25 schreibt den Diagnosehintergrundstatus mit asynchronem Write und Rename, einem ausstehenden Schreibvorgang und zusammengefassten Änderungen. Die Anzeige wird über den bestehenden UI-Tick aktualisiert. Die Sicherheitsmarkierung vor Sessionwechsel bleibt synchron und wird separat gemessen. |
| FLM-Vorbereitung | Je Seite folgen F150-Identität und D6DB-OFF-Rücklesung, anschließend je Seite die erweiterte Diagnosesitzung. Jedes Ergebnis wird vor dem nächsten Schritt abgewartet. Beide Seiten werden auch bei einem einseitigen Muster vorbereitet. Die sechs Wartezeiten addieren sich vor dem ersten START. |
| TASU und Konkurrenz | TASU-Dispatch läuft über die gemeinsame native Aufrufkette des Prozesses. Ein Bus- oder ECU-Timeout, ein kurzfristig belegter TASU-Dienst und die Wartezeit in der Aufrufkette sind verschiedene Ereignisse. Der Startpfad weist Busy ohne Retry unmittelbar zurück. App-interne Aufnahmen, Diagnosearbeiten, laufende Muster und ausstehendes Cleanup sperren den Trigger. Blockierte Hebelzüge werden verworfen. Für externe Diagnoseclients lässt sich eine mögliche Kollision am Fahrzeug nur über die TASU-Antworten und ein zeitlich korreliertes Protokoll feststellen. |
| Autostart | Vor Providerbereitschaft ist der Hebelstart gesperrt. Ein Verbindungswechsel verwirft den Signalzustand und verlangt wieder eine stabile OFF-Phase. Hintergrund und Vordergrund teilen sich die Erkennung. Der Hintergrundtrigger braucht seine explizite Freigabe, und die Service-Bildschirme bleiben passiv. |

Beim Polling ist höchstens ein Getter pro Feld offen. Trifft währenddessen eine Notification für das Feld ein oder ändert sich die Providerverbindung, wird das alte Getter-Ergebnis verworfen. Das Protokoll kennzeichnet Signalflanken als Notification oder Poll. Ohne Quellzeitstempel oder Sequenznummer lassen sich verspätete Notifications mit gültigem Wert und ein kurzer Wechsel des regulären Fernlichts weiterhin nicht sicher von einem Hebelimpuls unterscheiden. Die 400-ms-Bestätigung bleibt bis zur Fahrzeugvalidierung erhalten.

Die FLM-Abfolge bleibt seriell. Der generische TASU-Fehlerpfad liefert keine verlässliche Zuordnung für parallele Requests, und der Listener benutzt ECU-Adresse und UDS-Echo als Antwortfilter. Ein zuverlässiges Signal für ECU-Neustart, Fahrzeugwechsel und fremde Sitzungswechsel fehlt. Daher werden beide Identitäten weiterhin pro Start geprüft. Die beiden OFF-Prüfungen und die expliziten Sitzungswechsel bleiben erhalten. Nach jedem möglicherweise aktivierenden Versuch bleiben STOP und Rückkehr in die Standardsitzung vorgeschrieben. Bei unbestätigtem Cleanup bleibt der Wiederanlauf gesperrt.

`guard.js` erfasst Geschwindigkeit und Gang. Die Prüfungen auf aktuelle Geschwindigkeit, Stillstand und P sind wie in 0.1.24 auskommentiert. Der Hebelstart prüft weiterhin OEM OFF, die Providerbereitschaft und die bisherigen Freigaben. Vor dem tatsächlichen nativen TASU-Aufruf wird die Freigabe der regulären Anfragen erneut geprüft. Ausschließlich in P, im Stillstand und auf abgesperrtem Privatgelände testen.

## Reproduzierbarer Vergleich

Je TASU-Roundtrip-Zeit laufen 50 identische simulierte Hebelzüge pro Version. Die Phase des 250-ms-Ticks wird in 5-ms-Schritten variiert. Die Tabelle misst **empfangenes OEM AUS bis zum Dispatch des ersten UDS-START** in Millisekunden. Simuliert werden konstante Request/Reply-Zeiten, sofort zugestellte SOME/IP-Signale und Schreibzugriffe ohne Zeitkosten. Ein gesonderter Regressionstest hält eine asynchrone Hintergrundschreiboperation offen und prüft, dass START trotzdem zur erwarteten Zeit erreicht wird.

| TASU RTT | 0.1.24 Median | P95 | Max | 0.1.25 Median | P95 | Max |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 40 ms | 765,5 | 878 | 888 | 640 | 640 | 640 |
| 120 ms | 1.245,5 | 1.358 | 1.368 | 1.120 | 1.120 | 1.120 |
| 240 ms | 1.965,5 | 2.078 | 2.088 | 1.840 | 1.840 | 1.840 |

Der erste positive ECU-Reply liegt im Modell jeweils eine RTT nach dem Dispatch. Die simulierte Verbesserung beträgt 125,5 ms im Median und 238 ms beim P95. Die sechs unveränderten Vorbereitungsanfragen belegen bei 240 ms RTT zusammen 1.440 ms. Reale Unterschiede durch Polling, Timer-Jitter, Datenträger oder konkurrierende Diagnoseaktivität sind offen.

```sh
baseline=$(mktemp -d)
for file in main manual-flash lever-trigger; do
  git show "c0a42f5604b5fc33ebe1f349c24cd956f14c43dc:apps/light_flasher/$file.js" > "$baseline/$file.js"
done
LIGHT_FLASHER_BASELINE_DIR="$baseline" node --test tests/light_flasher*.test.js tests/autostart_background.test.js
```

Die Suite deckt sehr kurze, normale und lange Betätigungen, doppelte Impulse und unpassende Signalzustände, verspätete Getter, Reconnect, Autostart, konkurrierende Bedienung, blockierte Hintergrundschreibvorgänge, Busy, Timeout, Verbindungsverlust, Abbruch und die Cleanup-Sperre ab. Für die Plattform ist zusätzlich ein MGU-Lauf erforderlich.

## Fahrzeugmessung

1. Im Stillstand in P auf abgesperrtem Gelände prüfen. Für beide Versionen dieselben Einstellungen, denselben Kaltstartzustand und dieselbe Testfolge verwenden. Je 30 gültige Impulse im Vordergrund und mit explizit freigegebenem Hintergrundtrigger erfassen. Nach jedem Muster den Cooldown abwarten.
2. Mit 0.1.25 die automatischen Run-JSONs und den Hintergrundbericht exportieren. Im Hintergrundbericht Signalquelle und Hebelentscheidungen prüfen. In den Run-Berichten `startLatency` für OFF-Bestätigung, FLM-Identitäten, D6DB, Sicherheitsmarkierung, Sitzungen, START-Dispatch und Positive Response auswerten. 0.1.24 hat diese vollständige Instrumentierung noch nicht. Für einen direkten End-to-End-Vergleich die extern beobachtbaren Ereignisse für beide Versionen gleich erfassen.
3. Hebelbewegung und Lampenaustritt mit einer gemeinsamen Videozeitbasis oder einem synchronisierten Hebel- und Lichtsensor aufnehmen. Release-zu-LED und die Softwareintervalle einzeln als Median, P95 und Maximum auswerten. ECU-ACK zeigt die positive Diagnoseantwort. Die Lichtmessung liefert den Zeitpunkt des tatsächlichen Einschaltens.
4. Mit ausgeschaltetem Hintergrundtrigger, Provider-Neuverbindung, Dauerfernlicht, zwei kurzen Impulsen und Abbruch prüfen, dass kein unbeabsichtigtes Muster startet. Kommunikationsverlust und unbestätigtes Cleanup vorzugsweise am Prüfstand nachstellen. Danach Rückkehr zur normalen Lichtsteuerung sowie die Sperre bis zur bestätigten Wiederherstellung prüfen.

## Geänderte Dateien

- Erkennung und Hintergrundstatus in `lever-trigger.js`, `background-monitor.js`, `guard.js` und `main.js`.
- Monotone Zeitmessung und Diagnosepfad in `start-latency.js`, `manual-flash.js`, `tasu.js` und `kit/runtime/signals.js`.
- Diagnoseanzeige, Versionsstand und Dokumentation in `app.json`, `mgu-repo.json`, den beiden READMEs und diesem Bericht.
- Regressionen und Vergleichsmessung in `tests/light_flasher_latency.test.js`, `tests/light_flasher_lever.test.js`, `tests/light_flasher_recovery.test.js` und `tests/light_flasher_ui.test.js`.
