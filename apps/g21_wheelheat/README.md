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
