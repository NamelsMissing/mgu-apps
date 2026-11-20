# G21 Ambient Lighting 0.4.2

An iDrive 7 MGU app with a single RGB color and brightness control, six favorites, driving-mode previews, and vehicle diagnostics.

## Color and saved looks

- **Color** offers direct presets, a touch palette and four sliders. Select the number beside a slider to adjust its exact value with the iDrive controller. Turn to adjust, press to save or tilt left to cancel.
- **RAM test** sends one temporary request for all RAM01 ambient modules after two deliberate presses while the car is stationary. The first press checks the RAM identity and starts an eight-second confirmation window. The duration is set in Settings. Check the interior lights for the result.
- **Favorites** retain RGB and brightness from earlier versions. **Drive modes** can save a look for Sport, Comfort, Eco or Adaptive. Following the vehicle mode updates the editor only.

With renderer touch routing, use the on-screen tabs and controls. In the native HMI fallback, **Next page** cycles tabs. **Previous** and **Next** move the outline, **Select** activates the outlined control, and **Settings** opens the app settings. While editing a number, Previous and Next adjust it and Select saves it.

## Diagnostics

**READ RAM IDENTITY** checks RAM01 at address `0x37` with `22 F150`. The last result of the temporary test (`2E E311`) stays visible when the identity is refreshed. `6E E3 11` means the ECU acknowledged the request. `7F 2E 31` means the ECU rejected it as out of range.

**READ BDC STATUS** sends read-only queries for `DA5F` and `E3D1` to `0x40`. The app retries each busy response (`7F 22 21`) once and displays the final reply status. A positive reply establishes diagnostic access to that data identifier. The BDC queries have no effect on the lights.

**Menu 11 plan** in Diagnostics previews the requested color or factory values for existing iDrive color position 11. Both previews are offline.

The 2019 G21 in issue 8 identified RAM01 but reported a failed write and busy responses from both BDC queries. Compatibility with the retrofitted door and console LEDs and the illuminated grille remains unverified. Their wiring determines which controller can change them. [Issue 8](https://github.com/NamelsMissing/mgu-apps/issues/8)
