# Sitzheizung: DIDs aus den SGBDs (FAS_G11, BFS_G11, IHKA_G05)

Stand 18.11.2026. Quellen: `Ecu.zip` des Nutzers (EDIABAS-PRGs vom 02.12.2022), nur die Tabellen
gelesen mit `tools/sgbd_tables.py`. Grot110s anschließende Fahrzeugtests stehen im Abschnitt unten.
Die BimmerLink- und BimmerCode-Daten selbst liegen nicht im Repo.

| Datei | MD5 | Adresse | SGBD-Index (`22 F150`) |
| --- | --- | --- | --- |
| `fas_g11.prg` | `ff005e2288d05e0c84459b0da1809f81` | `0x6D` SMFA (Fahrersitz) | `0F21F0` |
| `bfs_g11.prg` | `24214d438308628d4a278d171c55015c` | `0x6E` SMBF (Beifahrersitz) | `0F21F0` |
| `ihka_g05.prg` | `818700ebf0fc970b6c5f1478dfc41b88` | `0x78` IHKA4 | `0F2830` (G09: `0F2838` → `IHKA_G09`) |

Index-Zuordnung aus `apps/light_show/sgbd-index.js`. Für dieselben Adressen gibt es auch
`FAS_I20`/`BFS_I20` (`0F2CB0`) und `FAS_01`/`FAS_12`; deren PRGs sind hier nicht ausgewertet.
Heating Comfort 0.5.2 hat im G05 aus Issue #2 `FAS_G11` und `BFS_G11` erkannt.

`FAS_G11` und `BFS_G11` sind für alle Sitzheizungs-DIDs **identisch** (gleiche Tabellen).

## Sitzmodul SMFA / SMBF (`0x6D` / `0x6E`)

### `0xD714` SITZHEIZUNG — Services `2E;22`

„Ansteuerung und Statusabfrage der Sitzheizung.“

Antwort auf `22 D7 14` (Payload nach `62 D7 14`, je 1 Byte):

| Byte | Name | Typ | Bedeutung |
| --- | --- | --- | --- |
| 0 | `STAT_STUFE_WERT` | uint8 | Stufe 0…3, 255 = ungültig |
| 1 | `STAT_TEMP_KISSEN_WERT` | int8 | Temperatur Kissen °C, −40…127, −128 = ungültig |
| 2 | `STAT_PWM_KISSEN_WERT` | uint8 | PWM Kissen 0…100 %, 255 = ungültig |
| 3 | `STAT_TEMP_LEHNE_WERT` | int8 | Temperatur Lehne °C, −128 = ungültig |
| 4 | `STAT_PWM_LEHNE_WERT` | uint8 | PWM Lehne 0…100 %, 255 = ungültig |
| 5–7 | `STAT_DUMMY1..3_WERT` | uint8 | Reserve |

Schreiben `2E D7 14` + 7 Bytes:

| Byte | Name | Bedeutung |
| --- | --- | --- |
| 0 | `AKTION` | `TAB_SITZHEIZUNG_SITZKLIMA_AKTION`: 0 AUS, 1 STUFE1, 2 STUFE2, 3 STUFE3, 254 AUSGANG_DIREKT |
| 1 | `PWM_KISSEN` | 0…100 %, nur bei AUSGANG_DIREKT |
| 2 | `PWM_LEHNE` | 0…100 %, nur bei AUSGANG_DIREKT |
| 3 | `NTC_AUSWERTUNG` | 0/1, nur bei AUSGANG_DIREKT |
| 4–6 | `DUMMY1..3` | Reserve |

Unterschied zum BDC (`E432`/`E430`): **kein Dauer-Byte**. Wie lange eine per Diagnose gesetzte
Stufe hält (bis Session-Ende, bis Tastendruck, dauerhaft?) und ob dafür eine erweiterte
Diagnose-Session nötig ist, steht nicht in der SGBD. `AUSGANG_DIREKT` (PWM ohne Regelung) ist
ein Werkstatt-Testmodus und darf in der App nie benutzt werden.

### `0xD710` SCHALTER_SITZHEIZUNG — Service `22`

Byte 0 `STAT_SCHALTER_SITZHEIZUNG` (`TAB_STATUS_TASTE`): 0 nicht betätigt, 1 betätigt,
2 nicht vorhanden / nicht codiert, 0xFF ungültig. Bytes 1–3 Reserve.

### `0xD700` CONFIG_HW / `0xD701` CONFIG_CODIERT — Service `22`

25 Bytes, je 1 Byte pro Funktion. Für die Sitzheizung relevant ist **Byte 15**
`STAT_SITZHEIZUNG`:

- D700 (`TAB_CONFIG_HW_SITZHEIZUNG`): 0 nicht vorhanden, 1 1-Kreis, 2 2-Kreis, 0xFF ungültig
- D701 (`TAB_CONFIG_CODIERT_SITZHEIZUNG`): 0 nicht codiert, 1 1-Kreis, 2 2-Kreis, 0xFF ungültig

Passt zu Grot110s E-Sys-Wert `SHZ_TYP = 2_Kreis`. Byte 14 ist `STAT_SITZKLIMA` (Sitzlüftung).
Neuere Software (ab 18-07) hat zusätzlich `0xD7AF` CONFIG_CODIERT2 und `0xE2EF` CONFIG_HW2.

## IHKA4 (`0x78`, IHKA_G05)

Die IHKA hat **keinen** eigenen Schreib-DID für die Sitzheizung. Alle `SHZH_*`-Jobs gehören zur
Standheizung, nicht zur Sitzheizung.

### `0xD8DB` FUNKTIONSSTATUS_KLIMA — Service `22`

28 Bytes, je 1 Byte. Sitzheizung:

| Byte | Name | Bedeutung |
| --- | --- | --- |
| 19 | `STAT_KLIMA_SH_VORN_LINKS_STUFE_WERT` | Stufe 0…3, 255 = ungültig |
| 20 | `STAT_KLIMA_SH_VORN_RECHTS_STUFE_WERT` | Stufe 0…3, 255 = ungültig |
| 21 / 22 | `STAT_KLIMA_SL_VORN_LINKS/RECHTS_STUFE_WERT` | Sitzlüftung 0…3 |
| 23 / 24 | `STAT_KLIMA_SH_FKA_LINKS/RECHTS_STUFE_WERT` | Fond links/rechts (bei Byte 23 nennt der INFO-Text der SGBD „Sitzlüftung“, der Name „SH“ — widersprüchlich, nicht verwendet) |

Links/rechts = Fahrer/Beifahrer nur bei Linkslenker. Das ist vermutlich die Quelle der ISTA-Anzeige
„Sitzheizung vorne links/rechts“ aus Issue #2.

### `0xA126` TASTEN_KLIMA_BT — Routine `31 01` (Start)

Simuliert einen Tastendruck am Klimabedienteil. Argumente: `TASTE` (`TAB_TASTEN_KLIMA`,
u. a. `0x1B` SITZHEIZUNG_LI, `0x1C` SITZHEIZUNG_RE, `0x1D/0x1E` Sitzlüftung) und `AKTION`
(0 nicht gedrückt, 1 gedrückt). Die Antwort enthält den Status aller Tasten, u. a.
`STAT_TASTE_SH_LINKS_EIN` / `_RECHTS_EIN` (0 nicht gedrückt, 1 gedrückt, 2 nicht verbaut).

Das wäre ein zweiter möglicher Weg: Der virtuelle Tastendruck läuft durch die normale
Fahrzeuglogik (IHKA → Sitzmodul). Ein Druck schaltet aber nur eine Stufe weiter; die App müsste die
Stufe vorher über `D8DB` lesen und danach prüfen. Ob „gedrückt“ ohne „losgelassen“ hängen bleibt,
ist nicht beschrieben.

## Abgleich mit BimmerLink-Daten (18.11.2026)

Vom Nutzer entschlüsselte BimmerLink-Daten (`fas_g11`, `ihka_g05`, `bdc_g05`, `ecu-variants`)
bestätigen unabhängig von den PRGs, ohne Abweichung:

- Index-Zuordnung `6D 0F21F0` → `FAS_G11`, `78 0F2830` → `IHKA_G05` (Gruppen `G_FAS`, `G_KLIMA`).
- Byte-Positionen der Live-Werte: `D714` Stufe Byte 0, Temperatur Kissen Byte 1, Lehne Byte 3;
  `D8DB` Sitzheizung vorne links Byte 19, rechts Byte 20; `D701` Sitzheizung Byte 15.
- BimmerLink nutzt diese DIDs nur lesend. Schreibbefehle für die Sitzheizung enthalten die Daten nicht.

## Fahrzeugeigene Automatik per Codierung (BimmerCode-Daten, 18.11.2026)

BMW hat für G-Modelle selbst eine **automatische Sitz- und Lenkradheizung unterhalb einer
einstellbaren Außentemperatur** (Einstellung im iDrive). Sie ist in zwei Steuergeräten
freizuschalten. Laut BimmerCode braucht sie `BDC_BODY2` oder `BDC_BODY3` (G21 und Grot110s G05
haben `BDC_BODY3`).

| Steuergerät | Funktion | Werte | Speicherort (neueste CAFD-Version in den Daten) |
| --- | --- | --- | --- |
| HU_MGU (CAFD `00003E52`) | `AKT_AUTO_SITZE_FRONT` | 0/1 | `0x3000` Byte 49, Maske `0x07` |
| HU_MGU | `AKT_AUTO_SITZE_FOND` | 0/1 | – |
| HU_MGU | `AKT_AUTO_LENKRADHEIZUNG` | 0/1 | `0x3000` Byte 47, Maske `0x04` |
| BDC_BODY2/3 (CAFD `000017BC`, `00005FA9`, `00007083`) | `IKF_ENABLE` | 0 aus, 1 Fahrer, 2 Fahrer+Beifahrer, 3 alle | `0x3450` Byte 0, Maske `0x06` |
| BDC_BODY2/3 | `LHZ_CCM_IKF` | 0/1 (Lenkrad) | `0x3142` Byte 2, Maske `0x20` |

Verwandte Optionen:
- BDC `NACHLAUFZEIT_LENKRADHEIZUNG`: Lenkradheizung wird gespeichert und beim nächsten Start
  wiederhergestellt.
- Sitzmodul (`CFAS_S15` `00002259` / `CBFS_S15` `0000225A`, auch `CFAS/CBFS_PLX_1`) `SA_MEMORY_ZEIT`:
  wie lange die eingestellte Sitzheizungsstufe gespeichert bleibt — 0 min, 15 min, 24 h, unbegrenzt
  (`0x3011` Byte 0, Maske `0x18`).

Offen: Ob die Automatik am G05 mit Sitzmodulen die Sitze tatsächlich schaltet (der BDC fordert an,
SMFA/SMBF führen aus), ist nicht belegt; BimmerCode bietet die Headunit-Option ausdrücklich auch für
`x5g` an. Codierung ist Sache des Nutzers (BimmerCode/E-Sys), die App codiert nichts.

## Validierung in Heating Comfort (ab 0.5.2)

Geprüft gegen `fas_g11.prg` / `ihka_g05.prg` (alle Felder `unsigned char` bzw. `signed char`, je 1 Byte):
`D714` 8 Byte — Stufe 0…3 (255 ungültig), Temperaturen −40…127 °C (−128 ungültig), PWM 0…100 % (255
ungültig); `D8DB` 28 Byte — Byte 19/20 Stufe 0…3 (255 ungültig). Kürzere Antworten oder ungültige
Teilwerte werden als „partial“ gekennzeichnet; eine ungültige Stufe wird nie als Wert angezeigt.

## Folgerung für Heating Comfort

- **Lesen (risikoarm):** SMFA/SMBF `22 D714` Byte 0 oder IHKA `22 D8DB` Byte 19/20 zeigen die
  tatsächliche Stufe beim G05. Außerdem `22 D701` Byte 15 als „codiert ja/nein“.
- **Schalten:** Grot110 bestätigte am SMFA seines G05 Stufe 2, sofortiges Ausschalten mit Aktion 0
  und das Zurücksetzen des ungefähr 120 Sekunden langen Timers beim Wiederholen von Stufe 2.
  Die App verwendet die dokumentierten Aktionen für Stufen 1–3 an SMFA und SMBF. Der automatische
  Ablauf ist für alle drei Stufen auf beiden Seiten simuliert. Der Fahrzeugtest für SMBF steht aus.
  Details stehen in
  [Grots Testbericht](https://github.com/NamelsMissing/mgu-apps/issues/2#issuecomment-7012570156) und
  [seinem Timeout-Test](https://github.com/NamelsMissing/mgu-apps/issues/2#issuecomment-7022542927).
- BDC `E432`/`E430` bleibt der Weg für Autos ohne Sitzmodul (G21).
- **Alternative ohne App-Schreibbefehle:** die fahrzeugeigene Automatik per Codierung (siehe oben).
  Für G05-Nutzer mit Sitzmodulen ist das vermutlich der sicherste Weg zur automatischen
  Sitzheizung. Die App könnte die Codier-DIDs `22 3450` (BDC) später nur lesen und anzeigen, ob die
  Automatik aktiv ist; die Byte-Lage hängt aber von der CAFD-Version ab.
