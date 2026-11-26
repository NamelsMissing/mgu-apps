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

- A seat module is treated as absent after two detection runs at least 20 s apart with no module
  reply and a responsive BDC. Gateway NRC 0x25 counts as a missing reply only when the BDC reports
  a valid status for the corresponding seat. A directly identified module stays present.
- Unresolved routes are retried: up to 5 runs per ignition (20–30 s apart), then every 10 min; a new
  ignition starts again. Confirmed-absent modules are not polled again.
- Each selected seat can wait for route detection throughout the two-minute ignition start window.
  A detected heating channel can start while the other channels are still being checked.
- Seat ON/EXTEND is checked against the route again right before every write. If a route stops being
  verified during a session, the app cancels the schedule and requests a guarded OFF through the
  same control unit that acknowledged ON.
- The steering wheel is only left out on NRC 0x31; otherwise the normal BDC readback gate decides.

The profile is saved in the app settings. On the next start only the BDC identification is read
again; a complete profile of the same BDC is reused, an incomplete one is completed, a different BDC
starts from scratch. 0.5.1 profiles are migrated and always re-detected (0.5.1 could treat a silent
seat module as missing). Cached seat-module entries inferred solely from gateway NRC 0x25 are
re-detected. Diagnostics → **RE-DETECT ECUs** forces a new detection.

While an automatic wheel cycle runs, the Comfort tab periodically shows the BDC status and its
reported heating current. If the controller reported OFF before the start and again on two fresh,
consecutive zero-current readings after the acknowledgment, one guarded retry is allowed within
the start window. The original deadline still controls switch-off.

Diagnostics tab: the steering wheel is read from the BDC (`D074`); BDC seat DIDs are only read where
the route can use them. Seats on a seat module show the module's own `D714` value; the IHKA line
shows `D8DB` left/right separately and compares it with the seat modules without guessing the driver
side. Missing, stale, invalid or unreadable values are never shown as OFF. Variants other than
`FAS_G11`, `BFS_G11` and `IHKA_G05` are captured raw only.

The DIDs come from the SGBDs. Grot110 confirmed both seat readbacks in Heating Comfort 0.5.2 and
manually tested SMFA level 2, OFF and the renewable timeout on a 2021 G05. See
[issue #2](https://github.com/NamelsMissing/mgu-apps/issues/2)
and [the diagnostic definitions](../../docs/sgbd-seat-heating.md).

The "Test next ignition ON" switch also works while the app is already running, and it applies
to exactly one ignition.

## Experimental seat-module heating

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

**Safety:** Test and configure the app while parked. Do not assume a heating request was successful without checking the actual vehicle behavior.

For Store setup and update details, see [Store Installation](../../STORE_INSTALLATION.md).

## AutoHeat startup and diagnosis (0.5.5)

The 26 November G21 log entered the old blocked branch because the first vehicle state arrived
after the drive was already ON. The planner also initialized its one-shot flag to true,
so the log showed a completed-looking state without a command. The background service now
distinguishes the plan from the command reservation and from readback-confirmed activation.

A live OFF-to-drive-ready transition establishes a vehicle session. For an AUTOSTART that first
sees drive-ready ON, the app can also use a persisted, vehicle-reported OFF after the previous
session, subject to the saved minimum OFF duration. The first live ON is the end of the measured
interval. The BMW signals available to this app do not expose an exact ON timestamp during
head-unit downtime, a unique vehicle-session ID, or an independent remote-start indicator.
Without usable OFF evidence the service waits for a valid cycle. Diagnostic-only wake and
missing signals do not establish drive readiness. The one-shot test is an explicit exception
to the parking duration. Engine RPM and vehicle speed are not used as evidence of a new cycle.

A separate atomic journal records the cycle, manual cancellation and each heater's write
reservation. On an AUTOSTART restart within the original two-minute window, already reserved
channels are skipped, including uncertain writes. An explicitly transient ECU rejection can be
retried after another valid read. The retry delays are 2, 5, 10, 20 and 30 seconds. The existing
wheel recovery after two explicit OFF readings is bounded to one attempt.

On the supplied profile, D074 is the wheel state/current source, E432/E430 report each BDC seat
state and level, and D714 is used for identified, separately controlled seat modules. D8DB on
identified IHKA_G05 can show front left/right requested levels independently of whether seat
modules are present. It does not confirm physical current or authorize a write, and no
driver-side inference is made from that data. NRC 25 and unreadable responses are unknown states.

Use **AutoHeat status / readback** on Diagnostics and **Next log filter** on Log. Identical USSO,
UserManager, token and analytics messages are grouped under SDK debug. The SDK owns its own startup
and telemetry, and the app continues to use the platform's normal authorization and ECU conditions.
The 26 November log demonstrates the old fault on the G21. New behavior is covered by offline
tests. Hardware confirmation of the new flow, especially persisted parking evidence across MGU
shutdown, cold-start retries, remote start and each installed seat-module variant, remains pending.
