# MGU Audio Diagnostics 0.1.3

Lesende Audiobestandsaufnahme für iDrive 7. Die App fragt den AudioManager ab und liest ausgewählte Metadaten aus `/proc` und `/dev/shm`. PCM-Geräte, Audiodateien und SmartX-Ringbuffer-Inhalte werden dabei nicht geöffnet.

- **Überblick** zeigt ALSA, SmartX, den erkannten CarPlay-Prozess und soweit zugänglich dessen gemappte Audiobibliotheken. `/proc/asound` kann die ausgehandelten Parameter eines Kernel-Playback-Geräts melden. Dessen Zuordnung zu einem CarPlay-Stream bleibt offen.
- **SmartX-Kanäle** zeigt vorhandene Endpunkte und Dateirechte. Ein Eintrag kann auch ohne laufendes Audio vorhanden sein.
- **AudioManager** zeigt Quellen, Senken und aktuelle Verbindungen. Fehlende Antworten und eine leere Verbindungsliste sind im JSON unterscheidbar.
- **DSP & Dienste** zeigt Bypass, explizit verbundene PCM-Clients, Formate, Raten, Kanäle sowie Frame- und Clipping-Zähler. Die originale CarPlay-Aushandlung bleibt als unbestätigt markiert.
- **Diagnose-Log** hält die letzten 40 Zustandsänderungen und scrollt bei neuen Einträgen ans Ende. **Log leeren** setzt die Anzeige zurück. **Log als Text speichern** erzeugt eine private Textdatei zum Kopieren etwa über Phone Terminal oder SFTP. Das Log nutzt keine BMW-Zwischenablage.
- **JSON exportieren** speichert `mgu-audio-diagnostics.json` im privaten App-Datenordner. Der Bericht enthält ausgewählte Bibliotheksnamen und niemals vollständige Maps, Audiodaten, Kommandozeilen, Schlüssel oder Medientitel.

Auf `main` im MGU Store aktualisieren. Zum Vergleich im Stand den Bericht einmal mit aktiver CarPlay-Musik und einmal ohne Wiedergabe erfassen. Die historische Beobachtung `CarPlayMedia (266) → MediaSink_Front (1024)` bestätigt einen AudioManager-Eintrag. Die neue Version ermittelt aktuelle IDs und Zustände aus den verfügbaren Antworten. [Prüfbericht](../../docs/equalizer-audio-integration.md)
