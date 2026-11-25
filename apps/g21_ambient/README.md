# G21 Ambient Lighting 0.4.7

iDrive 7 MGU app with one RGB color and brightness control, six favorites, driving-mode previews, and vehicle diagnostics. The native Settings tab includes the duration of the temporary BDC LIN test and the **off-by-default experimental single-NAD test**.

## OEM BMW color slots (NEW in 0.4.7)

**Color → BMW original colors** opens **Diagnostics → BMW colors**, where the head unit reads `de.bmw.infotainment.misc.ComfortFunctionIuK.statusAmbientLightInteriorColour` and can manually choose `FARBAUSWAHL_1..12` through the `ambientLightInteriorColour` SOME/IP setter. These are the existing OEM BMW menu slots, **not arbitrary RGB colors**; the actual color assigned to a slot depends on the vehicle's coding and retrofit controller. Only press a different slot after an actual current BMW color status is received. The app does **not** automatically send a color on startup or when the drive mode changes.

The write only sets the menu slot, leaving mode, hue and brightness fields at BMW's documented "not filled" sentinel values; it never directly addresses LIN modules. A successful SOME/IP setter call is reported as **accepted**; only a matching subsequent original BMW status is reported as **readback matched**. Neither result alone proves that the LEDs have physically changed. If the interface is missing or not providing status, the app remains read-only; no unknown fallback commands are sent.

The optional `de.bmw.body.interiorillumination.AmbientLight` read-only interface shows profile/brightness when exposed by the car. If absent, the main color-slot function remains independent of it.

Original reference implementation: [cauliflowermossgrape/idrive7-apps – ambient_config/ambient.js](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/apps/ambient_config/ambient.js). Similar read-only probes: [sembsa/idrive7-ambient](https://github.com/sembsa/idrive7-ambient). The setter and live-status path in **this G21** still need an actual in-car test.

## Color and saved looks

**Color** offers direct presets, a touch palette, and sliders for RGB and brightness. Select a number beside a slider to adjust it exactly. Turn the iDrive controller to adjust, press to save, or tilt left to cancel. Saved **Favorites** retain their RGB and brightness across updates. **Drive modes** can save or load a look for Sport, Comfort, Eco, or Adaptive. Following the vehicle mode updates the editor only.

**Test RGB (BDC)** uses the BDC_G05 LIN commands (LIN 1: `2E DA5E`, LIN 2: `2E E3D1`) instead of RAM01. First run **Guided test**: capture the LIN buses, change the BMW-menu color, compare, and confirm that the LEDs visibly changed. Normally, only a valid changed individual NAD (1..26; never broadcast) can be selected under **BDC test**. After a successful BDC read that returns only RGB 255 sentinel values, no target is verified. In Settings, **Experimental single-NAD BDC test** can be explicitly enabled. The test then offers only individual NADs appearing in fresh, decoded BDC records with valid location fields; their actual presence and compatibility remain unverified. A two-press confirmation and a current stationary speed signal are required for either mode. The write requires fresh speed 0, two presses within eight seconds, and a duration of 1..10 seconds. ECU acknowledgment and physical light effect are separate. Unknown retrofit hardware remains preview-only. These BDC commands are PRG-documented, but actual vehicle control remains unverified.

The native HMI fallback uses **Next page**, **Previous**, **Next**, **Select**, and **Settings**. Move the outline with Previous/Next and select the outlined control. During numeric editing those buttons adjust the value.

## Diagnostics

- **Overview → Start Diagnostics** now reads BDC at `0x40` with `22 DA5F` and `22 E3D1`, without automatically contacting RAM01. The progress line shows the current step and Cancel stops the sequence.
- **BMW colors** replaces the irrelevant RAM01 tab. It shows the original BMW color slot, separate setter acceptance and readback state, optional live profile and brightness, plus 12 individually selectable BMW menu slots. RAM01 legacy diagnostics remain in source for historical logs but are not a color control.
- **LIN 1 / LIN 2** show the respective request, timing, response status, raw response pages, a paginated record table, and the latest successfully decoded sample. The documented BDC_G05 format contains 26 ten-byte records and one addressing-method byte. Fields with an unverified interpretation are shown raw. Older values are marked stale when access is lost or newer data cannot be decoded.
- **Compare → Capture Reference** reads and saves both buses. Change the color manually in the original BMW menu, let the lights settle, and select **Compare**. Compare matches the bus and NAD, records changes to RGBW and brightness, and identifies missing, added, replaced, invalid, or duplicate records.
- **Guided test** walks through baseline, BMW-menu change, **Compare after BMW change**, and then Yes/No visual confirmation. A successful LIN read is not the end of this wizard. In particular, response values 255 for RGB mean an invalid/undefined color, not a discovered LED controller. The observation is separate from BDC write effects.
- **BDC test** shows the Guided test progress, all selectable LIN/NADs, whether a target is verified or experimental, the current block reason, and the most recent action. If no targets are available, open Guided test or enable Experimental single-NAD mode (Settings) and take fresh LIN reads. The actual light effect remains a separate manual observation. NRC 31 locks out further writes to a rejected NAD until reconnect. Experimental mode does not prove a connected LIN slave.
- **Menu 11 plan** continues to show a read-only, offline preview of the desired or factory values for iDrive color 11.

## Live Log and QR export

The **Log** tab shows 13 chronological lines and the current range. Swipe or use **OLDER**, **NEWER**, and **LATEST**. With the renderer, the iDrive controller can focus the console and scroll by turning the knob. The log follows new entries at the end and preserves the view while you read older entries. **Clear Log** clears the in-app buffer only. The buffer holds up to 640 events or 96 KiB of messages, with an eviction count.

**Export Log** freezes a diagnostic report for scanning. Choose **Export text** for a readable report or **Export JSON** for structured records. Scan each numbered QR page and copy each full scan, including its header, to a text file. Pages may be out of order. Both formats are generated locally and can be reconstructed offline:

```sh
python3 tools/ambient_qr_reassemble.py scans.txt -o ambient-report.txt
python3 tools/ambient_qr_reassemble.py scans-json.txt -o ambient-report.json
```

The report contains allowlisted diagnostic requests and replies, timings, comparisons, OEM BMW slot state/readback, and the retained log. It excludes application settings and the general SDK logfile. A reconstruction checks the page count and report hash.

## Vehicle verification

On the reported G21, RAM01 identity `0F 25 90` was returned and the attempted color write produced `7F 2E 31`. In a separate reported run, both BDC reads returned the expected 261 data bytes. The retrofitted cabin LEDs follow the manual BMW color menu on the owner's G21, even though the observed BDC LIN status RGB fields stayed at sentinel 255 during a bronze-to-blue color change. This supports testing the OEM BMW menu slot interface first; successful software operation of the 0.4.7 setter remains unverified in that car. [Issue 8](https://github.com/NamelsMissing/mgu-apps/issues/8)

See the [technical verification report](../../docs/g21-ambient-diagnostics-0.4.4.md) and [changelog](CHANGELOG.md).
