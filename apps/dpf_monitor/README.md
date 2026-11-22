# DPF Monitor 0.2.8 — BMW G21 B47 / D83BX7C0

Read-only iDrive 7 DPF monitor built with the `cauliflowermossgrape/idrive7-apps` kit and installable through MGU Store.

## Verification and localization

The configured DIDs were checked offline against the uploaded `D83BX7C0.prg`: result types, byte counts and scaling come from the `SG_FUNKTIONEN` table. UI text and numeric formatting are in English.

Offline navigation regression test (no car, no SDK):

```powershell
node tests/g21_car_ui_smoke.test.js
```

**Remaining uncertainty:** The `L/H` column of these PRG rows reads `High`, and the kit assumes network-order response bytes. Actual responses, routing and regeneration-state bits still require a vehicle test.

## What changed in 0.2.0

The owner-supplied `D83BX7C0.prg` (BMW DDE / B47) was inspected offline. Its `SG_FUNKTIONEN` table gives UDS service `0x22` DIDs, result types and scaling for soot mass, ash mass, exhaust differential pressure, DPF temperature, distance since last successful regeneration, successful regeneration count and average regeneration interval.

The app contains those DID configurations in `dpf-dids.js` and automatically attempts read-only reads through `kit/diag.js` + `kit/dids.js` when its screen is visible.

**Important:** Current in-car screenshots show valid soot and ash values but no live differential pressure, exhaust temperature or distance reply. Those remaining DIDs/routing are not verified in this vehicle. A genuine absent value is shown as `--`, never replaced by test data.

## Settings and behavior

- The last two experimental settings are removed. Live requests cannot be disabled and artificial DPF data are not generated.
- The app sends UDS `0x22` `ReadDataByIdentifier` requests to candidate DDE address `0x12`. Reads are sequential; polling runs while the screen is visible. If the candidate address is silent, one read-only functional engine-speed request (`01 0C`) tries to locate the engine ECU address.
- **Live page**: soot, differential pressure, exhaust temperature, distance since last completed regeneration. **History page**: up to 50 timestamped snapshots of actual valid live DDE readings, stored locally at most once every three minutes and preserved across restarts/normal updates. No regeneration event dates/durations are invented.
- Stale readings older than 45 seconds are hidden. When the DDE is silent, the status explains the unanswered request instead of displaying fabricated measurements.

## What is not yet implemented

- **Regeneration active = yes/no** is intentionally **unknown**. `0x44BB` is labeled `Regenerationsanforderung` in the PRG, but its raw value is not enough to prove the filter is actively regenerating.
- The PRG contains a diagnostic job `STATUS_REGENERATION_CSF` whose result `STAT_REGENERATION_LAEUFT_WERT` is 0 for inactive and 1 for active. However, it uses UDS `0x2C` to define a temporary data identifier. The exact extraction from the related status word must be verified before any active-regeneration indication is shipped.
- Data validation, asynchronous error handling in the car and diagnostic routing for this MGU firmware are not confirmed.
- No automatic regeneration start, service reset, coding, flash or ECU write is included.

See [DDE_D83BX7C0.md](DDE_D83BX7C0.md) for DID definitions and validation steps.

## Install / test on Windows

Put `dpf_monitor` in `idrive7-apps-main\apps\`. Keep the BMW `oap-sdk\` only on the build machine or let MGU Store's headunit builder provide it.

```powershell
py .\kit\tools\check_signals.py
py .\kit\tools\build.py dpf_monitor
node .\kit\tools\emu.js dpf_monitor
```

Open `http://localhost:8077/`. The emulator lacks a DDE transport, so it cannot show live measurements or verify real DIDs.

For in-car verification, test with ignition on and the DDE awake, then compare values against ISTA / Tool32. Avoid running this alongside ECU programming.

Do not commit the binary PRG file, BMW SDK, private keys, VIN or vehicle-specific logs.
