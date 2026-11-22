# Changelog

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
