# Changelog

## 0.4.7

- Add original BMW iDrive Ambient color slot control through the MGU ComfortFunctionIuK SOME/IP field setter (FARBAUSWAHL_1..12) and live status observer.
- Add a **BMW colors** diagnosis page with twelve manual original slots, current slot, optional AmbientLight profile/brightness, separate setter acknowledgement and readback, and clear unavailable/stale messages.
- Add a direct shortcut to BMW original colors from the Color editor and rename the existing BDC/LIN function to a separate experimental RGB test.
- Never perform OEM slot writes on app startup or driving-mode changes; block missing status, invalid slot, concurrent or excessively frequent writes.
- Keep the experimentally gated BDC single-NAD tests and Menu 11 offline plan unchanged; no full-RGB compatibility is claimed for aftermarket LIN hardware.
- Add automated tests for signal selection, setter rejection, readback, cooldown and MGU navigation.


## 0.4.6

- Correct silent BDC test lockout: clear Guided-test progress, target counts, explicit block reasons, and direct Guided test navigation.
- Allow opt-in experimental one-at-a-time BDC LIN testing for individual NADs present in fresh decoded LIN status records, even when RGB fields are sentinel 255.
- Keep new capability off by default; no guessed or broadcast NADs, no in-motion writes, short <=10-second pulses and explicit double confirmation.
- Make Color page Setup action navigate to BDC diagnostics when no target has been selected.


## 0.4.5

- Introduced PRG-documented BDC LIN 1/2 temporary RGB testing (DA5E/E3D1) with guarded, single-NAD writes only after guided comparison and visual confirmation.
- Routed Apply to BDC instead of RAM01; RAM01 remains a legacy manual read-only diagnostic view.
- Added fresh standstill gating, double confirmation, <=10 s test, NRC-31 target lockout, and independent ECU acknowledgment / operator-observed effect.
- Left FDL menu position 11 offline and read-only; no production retrofit light control is claimed until a car test.


## 0.4.4

- Added a read-only diagnostic sequence, dedicated RAM01 and two BDC LIN views, paginated raw responses, and a four-step guided test.
- Added explicit LIN reference capture and comparison by bus and NAD, with separate RGBW, brightness, topology and visual results.
- Added an AutoHeat-style live console with touch and controller scrolling, bounded retention, and offline multipage text and JSON QR exports.
- Added bounded TASU request tracking, explicit transport errors, cancellation on disconnect, preservation of older results, and full request/response logging.
- Kept the existing manual RAM01 test, color editor, saved looks, driving-mode previews, and offline Menu 11 plan.
