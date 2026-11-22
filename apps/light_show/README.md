# Light Show 0.4.7

Exterior light shows for BMW G-series cars with the iDrive 7 head unit (MGU), in the spirit of
Bimmerlight: pick lights, pick an effect, start, from the BMW screen or from your phone.
Unofficial, not from BMW. Use only parked in P, standing still, on private ground, with nobody
in front of the car. Don't look into the headlights.

## Getting started

Add `namelsmissing/mgu-apps` to MGU Store, select `main`, then install Light Show. There is a
lowercase L after `name`. The public repository is available without GitHub sign-in. See the
[installation guide](../../README.md#add-this-repository-to-mgu-store).

In P, open **Vehicle** and wait for the scan. Then open **Lights**, test one light at a time and
confirm what you saw when the test finishes. A module listed in **Vehicle** has returned its
identity. Whether an individual light turns on depends on the hardware. Add a confirmed light to
the show and start with **Chase**, which works with a single light. **Wig-Wag** needs a confirmed
light on each side. There are no preselected channels.

## What's new compared to 0.3.4 (mgu-apps)

| | 0.3.4 | 0.4.0 beta |
|---|---|---|
| Lights | Headlamp LED channels (FLM02) | Headlamp LED channels (FLM02, FLM02X, FLM2_1), all exterior BDC light functions, every BDC exterior output, rear light modules (RLM2 functions, RLM_1 channels) |
| Which car | Fixed addresses and FLM02 only | **Vehicle scan** reads the identity of every control unit and offers only what this car has |
| Effects | 6 patterns | 9 effects: Wig-Wag, Dual Flash, Chase, Knight Rider, Front-to-Rear Wave, All Flash, Alternating, Heartbeat, Sparkle |
| Screen | Text menus | Canvas UI with tabs, rotating 3D car whose lamps light up during the show |
| Phone | - | **Phone remote**: QR code on the BMW screen opens a web page with the same functions and a 3D car you can turn |

Names and test results from 0.3.x are taken over (same app id, same data folder).

## Pages on the BMW screen

- **Show** - 3D car, effect library, step time, pause, repeats, headlamp LED brightness, Start / Stop.
- **Lights** - every light the scan found. Select one, press **Test**, then say what you saw:
  *Lit, quiet* / *Nothing* / *Noise*. Only lights confirmed "lit, quiet" (and whose release was
  acknowledged) can be added to a show. *Rename* cycles through preset names; any name can be
  typed on the phone.
- **Vehicle** - the scan (read-only), the support level of the
  body controller and both headlamp modules, the list of all units, the switch for experimental
  headlamp modules, and the manual "lights checked" confirmation if a recovery file is unreadable.
- **Phone** - QR code, status of the firewall helper, the server and the phone connection.

## Finding and browsing lights

**Lights** has three independent filters. Open each filter to choose one value. The button
shows the active value, and the count shows matching lights out of all entries in the catalog.

| Filter | Options |
|---|---|
| Position | All, Front, Side, Rear |
| Availability | All, Controllable, Unavailable |
| Test status | All, Visible, Not tested, No visible effect, Noise |

The initial view shows controllable lights in every position and with every test status.
**Controllable** describes the control route available on the scanned vehicle. **Visible**
requires a stored, confirmed test with visible light and no unusual noise. The list shows both
values separately. The catalog includes only the channels it can describe for each module.

Changing a filter moves to the top and keeps the selected light when it still matches. Otherwise
the first match becomes selected. **Reset filters** in the empty view sets all three filters to
**All**. Filtering and browsing do not send diagnostic commands.

- **Touchscreen** - Swipe vertically inside the Lights list or the **All control units** list
  on Vehicle. Tap a light to select it. The detail panel and action buttons stay in place.
- **iDrive in the full layout** - Turn through the filters and lights. The list follows the
  focused light, and pressing selects it. Tilt to move between the list, adjacent controls and
  tabs. On Vehicle, focus the scroll bar and turn the knob to browse control units. Continue
  turning past either end to leave the list.
- **Standard or software layout** - Use **Previous focus**, **Next focus** and **Activate focus**
  in the native HMI bar. **Next page** switches tabs. Swiping and tapping the drawn lists require
  a renderer with touch routing.

## Vehicle scan (modelled on BimmerLight)

The scan runs **by itself on the first start** as soon as the car is parked in P and standing
still (and no show or release is pending): up to 3 tries per app run, a minute apart. The
result is saved; after that the app scans again only when you press *Scan again* on *Vehicle*
(e.g. after a control unit was replaced).

1. One functional `22 F1 50` to all control units.
2. Every light address that did not answer is checked on its own: gateway 0x10,
   rear light modules 0x17 / 0x1A / 0x1C / 0x1E, body 0x40, headlamps 0x43 / 0x44, 0x72.
   If the BDC or a previously identified module still has no reply, it is checked a second time.
3. The vehicle order (`22 3F 06`) is read from the gateway; option codes such as 5AZ (Laserlight)
   or 552 (Adaptive LED) are shown as a hint.

**Last seen** means the module did not answer in this scan. Light Show keeps the last identity
and checks it again before any test or show. A scan without any light module identity fails and
keeps the previous result. If there is no previously saved result, the automatic scan retries.

At the gateway only identity and the vehicle order are read. Rear light modules get control
telegrams only after they identified as one of the RLM variants below.

## Supported control units

Support levels: **tested** = driven in a car (G21); **from BMW data** = telegram taken from the BMW
PRG of that control unit, not yet driven in a car. Test every light once while you watch.

| Unit | Identity | Lights | Status |
|---|---|---|---|
| Body controller 0x40 | `BDC_G05` (`0F2680`) | 19 light functions `2E D5 42` (side lights, low/high beam, DRL, indicators L/R, hazard, front/rear fog, cornering L/R, brake, reversing, parking L/R, locator, manoeuvring, welcome, goodbye) + single outputs `2F E3 B5` | High beam tested; other functions from BMW data; single outputs experimental (no visible effect on the G21) |
| Body controller 0x40 | `BDC_G11` (`0F2050`), `BDC` (`0F19C0`) | Same light functions (ids from `TAB_LAMPEN_FUNKTION`), BDC_G11 also the illuminated kidney grille | From BMW data |
| Headlamp 0x43 / 0x44 | `FLM02_L/R` (`0F26C0/D0`) | `FLM_KANAL 31 01 A5 4B`, channels 1-15 and 0 = all LEDs | Channels tested (G21, basic LED) |
| Headlamp 0x43 / 0x44 | `FLM02X_L/R` (`0F26C8/D8`), `FLM2_1_L/R` (`0F26CC/DC`) | Same routine, channels 1-17 and 0 = all LEDs | From BMW data (adaptive LED / laser) |
| Rear light modules 0x17 / 0x1A / 0x1C / 0x1E | `RLM2_1L/1R/2L/2R` (`0F2C10..40`) | `RLM_LICHTFUNKTIONEN 2E A8 3B <fn> <s>`: tail, rear fog, brake, indicator, reversing, side marker, side light, parking, plate; and `RLM_KANAL 31 01 A5 56 <group 0x60-0x6F / 0x70 all> <PWM> 00 64 <s>`: 16 segment groups at 100 mA, stop `31 02 A5 56` | From BMW data |
| Rear light modules | `RLM_1L/1R/2L/2R` (`0F23C0..F0`) | `RLM_KANAL 2E D6 DA <1-8> <s> <PWM>` | From BMW data |
| Headlamp | `FLM01`, `FLM03`, `LHM2`, `FLE` | - | Recognised, not supported |
| Gateway 0x10 | `ZGW_01`, `ZGW_SP18`, `BCP_SP21` | Identity and vehicle order only | - |

Every light has a finite time in the control unit (D542: 10 ms steps, RLM: seconds, FLM: seconds,
never "permanent") and is switched off explicitly after each step. One FLM and one RLM2 module
run one channel routine at a time; effects split steps accordingly.

Cross-checked with BimmerLight's module mapping (supplied by the user, not included here):
it drives headlamps with the same `FLM_KANAL` routine (incl. channel 0 = all), RLM2 tail lights
with `RLM_KANAL` segment groups at 100 mA, and BDC lights with `LICHT_AUSGANG_DIGITAL_STEUERN`
(E3B5, the single outputs here). On LED cars the low and high beam LEDs sit in the headlamp
modules, so the BDC low-beam output stays dark there - that is what the G21 test showed.

## Test option: silence the headlamp modules

Settings (app settings, or the switch on *Vehicle* / the phone's *Car* tab): **"Test: headlamp
modules ignore bus messages during shows"**, off by default. As BimmerLight does it, each
headlamp module used by a show gets, after its extended session:

- `28 02 01` CommunicationControl disableRxAndEnableTx, normal messages - the module stops
  following the car's own light requests (DRL, low beam), so only the show's channels light up;
- at the end, before the default session: `28 00 03` enableRxAndTx, normal + network management.

The recovery file records the silenced modules; STOP and the next app start send `28 00 03`
again. Returning to the default session (or its timeout) restores normal communication as
well (ISO 14229), so a refused `28 00 03` only blocks when the default session was not
confirmed either. Only the headlamp modules 0x43 / 0x44 accept these two telegrams; the
option cannot be changed while a show runs. Test results remember whether it was on.

Not used on purpose: single RLM2 LED channels (only the groups), laser function test, special
flashing modes and check-control messages in the instrument cluster.

Whether the laser element of laser headlights sits on any FLM channel is unknown (the PRGs list a
separate laser function test). If a channel turns on something unexpected, like a very bright
spot or the headlight adjusting itself, press STOP and leave that channel out.

## Phone remote

1. Install **Light Show Phone Port** (`mgu-light-net`) from this source as well: it opens TCP
   18880 on the car Wi-Fi only while Light Show answers its health probe.
2. Connect the phone to the car's Wi-Fi hotspot, open *Phone* on the BMW screen and scan the code.
3. The link holds a random token that changes with every start of the app.

The page polls the app; every action goes through the same checks as the BMW screen (P,
standstill, identities, tested lights). No Internet is needed.

## Safety

- Before every request: P and a current speed signal of 0 km/h. Losing either stops the show.
- Before anything is switched: BDC_G05 and every used headlamp module are identified.
- A recovery file is written before the first session or lamp request. It is removed only after
  every touched unit acknowledged its STOP / OFF and the default session; otherwise STOP (or the
  next app start) releases them again.
- Every lamp has a finite time in the control unit (FLM seconds, D542 duration) and an explicit OFF.
- One FLM module plays one LED channel at a time; effects split steps accordingly.
- Requests go one by one through BMW's diagnostic transport (about 100-500 ms each in the car),
  so shows are slower and less exact than with an OBD adapter.

An acknowledgement confirms the control unit received the command. Report **Nothing** if you
didn't see light. A more recent **Nothing** overrides a previous visible result for that light.
If the test fails, the error points to the ECU address and diagnostic response when available.
Use those details and the result of the test when reporting a problem.

## Tests

```sh
node --test tests/light_show.test.js tests/light_show_ui.test.js
```
