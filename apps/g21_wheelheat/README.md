# Heating Comfort / AutoHeating

**Status: Stable** · **Platform: BMW MGU / iDrive 7**

Automatically control the seat and steering-wheel heating on a compatible BMW. The app also provides manual controls and a diagnostics view.

## Features

| Feature | Description |
| --- | --- |
| Automatic heating | Starts a heating cycle when the saved settings and vehicle conditions allow it. |
| Temperature settings | Choose when automatic heating should activate. |
| Heating duration | Configure the heating period and repeat-cycle delay. |
| Manual stop | Stop the app's active heating cycle. |
| Diagnostics | View heating commands, ECU responses and session logs in a scrollable console. |
| QR logs | Export current-session diagnostic information locally using QR codes. |

## Control-unit detection (0.5.x, experimental)

Heating Comfort no longer assumes the G21 layout (background: issue #2, a G05 with separate seat modules). Once the diagnostic connection is up, it reads
the standard BMW identification `22 F150` (read-only, no VIN, no serial numbers) from these addresses:

| Address | Control unit | Used for |
| --- | --- | --- |
| `0x40` | BDC | steering wheel `D074`, seat heating `E432` / `E430` on cars without seat modules |
| `0x6D` / `0x6E` | SMFA / SMBF (seat modules) | detection, seat level and experimental heating control via `D714` |
| `0x78` | IHKA | detection and read-only seat level `D8DB` (cross-check) |

Route per channel:

| Route | When | Automatic heating |
| --- | --- | --- |
| **BDC** | BDC seat DID readable **and** the matching seat module confirmed absent | yes (normal BDC readback gate) |
| **Seat module** | seat module answers | levels 1–3 with the matching experimental setting and verified FAS_G11 or BFS_G11 configuration. Other variants provide diagnostics. |
| **Conflict** | BDC seat DID readable **and** seat module answers | no (architecture not confirmed) |
| **Unresolved** | seat module not identified yet, or BDC seat DID not readable | no, detection retries |
| **Not available** | NRC 0x31 | no |

- A missing reply is not proof that a control unit is missing. A seat module counts as absent only
  after it stayed silent in two detection runs at least 20 s apart while the BDC answered. A module
  that answered once stays "present". Busy/offline errors never count.
- Unresolved routes are retried: up to 5 runs per ignition (20–30 s apart), then every 10 min; a new
  ignition starts again. Confirmed-absent modules are not polled again.
- On the first start after install or after a BDC change, the one-time plan waits up to 60 s after
  ignition ON for the seat routes (two detection runs). Afterwards it plans with what is known.
- Seat ON/EXTEND is checked against the route again right before every write. If a route stops being
  verified during a session, the app cancels the schedule and requests a guarded OFF through the
  same control unit that acknowledged ON.
- The steering wheel is only left out on NRC 0x31; otherwise the normal BDC readback gate decides.

The profile is saved in the app settings. On the next start only the BDC identification is read
again; a complete profile of the same BDC is reused, an incomplete one is completed, a different BDC
starts from scratch. 0.5.1 profiles are migrated and always re-detected (0.5.1 could treat a silent
seat module as missing). Diagnostics → **RE-DETECT ECUs** forces a new detection.

Diagnostics tab: the steering wheel is read from the BDC (`D074`); BDC seat DIDs are only read where
the route can use them. Seats on a seat module show the module's own `D714` value; the IHKA line
shows `D8DB` left/right separately and compares it with the seat modules without guessing the driver
side. Missing, stale, invalid or unreadable values are never shown as OFF. Variants other than
`FAS_G11`, `BFS_G11` and `IHKA_G05` are captured raw only. The QR log contains the last 10 complete
`D714` / `D8DB` replies (ECU address, SGBD index/variant, state, decoded values if valid).

The DIDs come from the SGBDs. Grot110 confirmed both seat readbacks in Heating Comfort 0.5.2 and
manually tested SMFA level 2, OFF and the renewable timeout on a 2021 G05. See
[issue #2](https://github.com/NamelsMissing/mgu-apps/issues/2)
and [the diagnostic definitions](../../docs/sgbd-seat-heating.md).

The "Test next ignition ON" switch also works while the app is already running, and it applies
to exactly one ignition.

## Experimental seat-module heating (0.5.3)

For the driver, enable **Driver seat heating** and **Experimental SMFA driver heating**.
For the passenger, enable **Passenger seat heating** and **Experimental SMBF passenger heating**.
Both experimental switches default to off. Select the desired **Seat heating level** (1–3) and
duration. Each seat requires a verified BDC_G05 profile with NRC 0x22 for its BDC seat path and
the matching module (`FAS_G11` for the driver or `BFS_G11` for the passenger) with 2-circuit heating coded.

The first request requires a fresh, valid OFF reading. The app renews the same acknowledged level
about once per minute when the remaining duration needs it. Every renewal and OFF checks the module's
identity and current level. If the module reports a different level, the app relinquishes control.
A manual selection of the same level produces the same readback. Changing the configured level
ends the current seat-heating cycle, and the new setting applies at the next eligible start.
Commands and acknowledgements are tracked independently for each seat.

The app's automatic sequence for all three levels has been tested in simulation for both seats.
Grot's vehicle test confirmed the driver's level-2 command. The passenger's control and timeout
behavior still need a vehicle test.

The app requests OFF when its configured duration ends, when the user presses STOP or when the
setting is disabled. OFF requires fresh vehicle speed and an active ignition. If the app cannot
send OFF, shutdown depends on the module. Grot observed an approximately 120-second timeout at
the driver's SMFA.

## Install and enable

1. Add `NamelsMissing/mgu-apps` to **MGU Store** and select the **main** branch.
2. Install **G21 Heating Comfort** (`g21_wheelheat`).
3. Open the app and enable **Automatic heating on cold startup** in Settings.
4. Adjust the temperature, duration and repeat-cycle settings.

The app package includes the MGU **autostart** setting. This allows the process to start with the head unit, but it does **not** mean heating always turns on: the saved enable switch and required vehicle checks must also pass.

## Important limitations

- Automatic heating needs valid vehicle signals and a response from the body control unit (BDC).
- An accepted command or a timer in the app does not by itself prove that the seat or steering wheel physically heated.
- Automatic heating can attempt activation while driving when its checks pass. The vehicle ECU can still reject a request. Manual diagnostic writes retain the standstill restriction.
- The Diagnostics tab displays the latest valid ECU response. Switching heating ON/OFF manually is not treated as unstable readback; raw replies are retained in the session log.
- Available functions and ECU data may differ across BMW models and firmware.
- Settings are intended to persist across app restarts and updates. Use the Log view to troubleshoot any saving or autostart problems.
- QR logs are generated locally; they do not need an internet connection.

**Safety:** Test and configure the app while parked. Do not assume a heating request was successful without checking the actual vehicle behavior.

For Store setup and update details, see [Store Installation](../../STORE_INSTALLATION.md).
