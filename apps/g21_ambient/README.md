# G21 Ambient Lighting 0.4.5

iDrive 7 MGU app with one RGB color and brightness control, six favorites, driving-mode previews, and vehicle diagnostics. The native Settings tab includes the duration of the temporary RAM01 test.

## Color and saved looks

**Color** offers direct presets, a touch palette, and sliders for RGB and brightness. Select a number beside a slider to adjust it exactly. Turn the iDrive controller to adjust, press to save, or tilt left to cancel. Saved **Favorites** retain their RGB and brightness across updates. **Drive modes** can save or load a look for Sport, Comfort, Eco, or Adaptive. Following the vehicle mode updates the editor only.

**Apply BDC test** uses the BDC_G05 LIN commands (LIN 1: `2E DA5E`, LIN 2: `2E E3D1`) instead of RAM01. First run **Guided test**: capture the LIN buses, change the BMW-menu color, compare, and confirm that the LEDs visibly changed. Only a valid, changed individual NAD (1..26; never broadcast) can be selected under **BDC test**. The write requires fresh speed 0, two presses within eight seconds, and a duration of 1..10 seconds. ECU acknowledgment and physical light effect are separate. Unknown retrofit hardware remains preview-only. These BDC commands are PRG-documented, but actual vehicle control remains unverified.

The native HMI fallback uses **Next page**, **Previous**, **Next**, **Select**, and **Settings**. Move the outline with Previous/Next and select the outlined control. During numeric editing those buttons adjust the value.

## Diagnostics

- **Overview → Start Diagnostics** now reads BDC at `0x40` with `22 DA5F` and `22 E3D1`, without automatically contacting RAM01. The progress line shows the current step and Cancel stops the sequence.
- **RAM01** is retained as a legacy manual diagnostic view (not used by the Color Apply button). It displays the latest identity request and reply, timing, NRC, last positive reply, and complete details of the latest manual `2E E311` attempt. `7F 2E 31` means Request Out Of Range. The rejected request alone leaves the exact unsupported field or variant unresolved.
- **LIN 1 / LIN 2** show the respective request, timing, response status, raw response pages, a paginated record table, and the latest successfully decoded sample. The documented BDC_G05 format contains 26 ten-byte records and one addressing-method byte. Fields with an unverified interpretation are shown raw. Older values are marked stale when access is lost or newer data cannot be decoded.
- **Compare → Capture Reference** reads and saves both buses. Change the color manually in the original BMW menu, let the lights settle, and select **Compare**. Compare matches the bus and NAD, records changes to RGBW and brightness, and identifies missing, added, replaced, invalid, or duplicate records.
- **Guided test** walks through baseline, BMW menu change, control measurement, and visual check. Yes/No/Not checked records your observation of the BMW-menu change. The observation belongs to that test and stays separate from the experimental RAM01 write result.
- **BDC test** lists verified LIN/NAD targets and permits a guarded single-target write; the physical effect is recorded separately. NRC 31 locks out another write to that target until a connection reset.
- **Menu 11 plan** continues to show a read-only, offline preview of the desired or factory values for iDrive color 11.

## Live Log and QR export

The **Log** tab shows 13 chronological lines and the current range. Swipe or use **OLDER**, **NEWER**, and **LATEST**. With the renderer, the iDrive controller can focus the console and scroll by turning the knob. The log follows new entries at the end and preserves the view while you read older entries. **Clear Log** clears the in-app buffer only. The buffer holds up to 640 events or 96 KiB of messages, with an eviction count.

**Export Log** freezes a diagnostic report for scanning. Choose **Export text** for a readable report or **Export JSON** for structured records. Scan each numbered QR page and copy each full scan, including its header, to a text file. Pages may be out of order. Both formats are generated locally and can be reconstructed offline:

```sh
python3 tools/ambient_qr_reassemble.py scans.txt -o ambient-report.txt
python3 tools/ambient_qr_reassemble.py scans-json.txt -o ambient-report.json
```

The report contains allowlisted diagnostic requests and replies, timings, comparisons, and the retained log. It excludes application settings and the general SDK logfile. A reconstruction checks the page count and report hash.

## Vehicle verification

On the reported G21, RAM01 identity `0F 25 90` was returned and the attempted color write produced `7F 2E 31`. In a separate reported run, both BDC reads returned the expected 261 data bytes. Which controller drives the retrofitted cabin LEDs or illuminated grille still needs vehicle evidence. [Issue 8](https://github.com/NamelsMissing/mgu-apps/issues/8)

See the [technical verification report](../../docs/g21-ambient-diagnostics-0.4.4.md) and [changelog](CHANGELOG.md).
