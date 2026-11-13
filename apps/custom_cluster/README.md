# Custom Cluster 0.6.0 — BMW G21 / MGU iDrive 7


## 0.6.0: Persistent logs, static engine-off preview, explicit KOMBI safety boundary

- A `cluster-session-<timestamp>-<random>.txt` diagnostic file is created in the app's private `dataDir/exports/` **as soon as the app opens**, without pressing QR Logs. UI actions, panel requests, renderer responses and a vehicle/slot summary every 15 seconds are appended. The maximum size is 1 MiB per session.
- **QR Logs** still creates a separate `cluster-diagnostics-*.txt` snapshot and tries to copy it to writable USB mounts. Both formats can be deleted via Delete logs / Confirm delete; USB copies remain untouched. The QR screen displays the actual auto-log path when storage is available.
- New safe default **Test content → Static iDrive preview** shows a 30-second G80/6WB example with 0 km/h and 0 rpm. It needs no engine, RPM notifications or selector P because it **never touches the KOMBI slot**.
- Existing installs may retain the earlier saved `probe` setting. For engine-off testing select **Static iDrive preview** explicitly.
- The real **KOMBI marker** and **Full KOMBI design** modes still require recent real speed/RPM, selector P, and 0 km/h. Old samples (e.g. 180 s) cannot prove the vehicle is stopped; an engine-off indication by itself cannot replace an independent current stationary check.
- When target `panel` (slot 0x203) is mapped with `content` and `contend: true`, it may displace original right-hand media widgets. A working layered music-preserving full cluster has **not** been established. The real panel and Waze overlay are still experimental; no driving use of custom full gauges.

### Reading the automatic file
The physical path varies by MGU installer and app sandbox. The **QR Logs** screen shows the actual path as `Auto log: ...` when writable. Retrieve that file with your Phone Terminal SSH/SFTP workflow, or use QR Logs to obtain a numbered offline QR snapshot. No private log files are committed to GitHub.

## 0.5.9: Single native page and trace of the parked panel test

- The old Diagnostics and QR RHMI states are removed from the installed UI.
  Their content remains available through the **Diagnostics** and **QR logs**
  buttons on the one native **Custom Cluster** page. The previous duplicate
  navigation tabs could select MAIN while the old in-page Diagnostics view
  kept drawing. Selecting the app again after Home or Settings resets to its
  design preview. **Back to cluster** returns within the same HMI page.
- Each armed 12-second parked panel test now retains a capped, timestamped
  history of renderer layer events, slot transitions, refusal reasons and
  selected renderer status lines **while the test is running**. The QR export
  includes this history even after the panel is automatically restored.
  **Delete logs** also clears these in-memory event entries.
- A panel slot shown as **idle** after a 12-second test is insufficient to
  diagnose why the image failed to appear; its during-test events are needed.
  Neither the full rendering behaviour nor replacement warning display is
  verified on the real vehicle. The parked-only safety guard is unchanged.

## 0.5.8: Clear local diagnostic logs from QR view

- Open **QR logs**; the second bottom-bar button becomes **Delete logs**.
- A first press requests confirmation; press **Confirm delete** within eight
  seconds to remove only Custom Cluster's dated diagnostic `.txt` exports from
  the app's own `data/exports` folder. The current QR report and in-memory HMI
  event history are cleared too.
- Files from other apps, renderer/system journals, and copies already exported
  to a USB drive are **not** deleted. A new QR report can be generated with
  **Next QR page** after deletion, or by re-entering QR logs.

## 0.5.7: Diagnostics and QR use the main HMI page

- Diagnostics and the QR log now draw inside the existing MAIN page. This avoids
  unreliable second RHMI canvas state transitions seen on the installed MGU.
- Press **Diagnostics** to enter/leave Diagnostics; **QR logs** opens the
  export and advances through QR pages; **Back to cluster** returns to the
  design preview. The Settings button is unchanged.
- A white spot in the parked Kombi test is the small `probe` marker selected
  by default, not a failed full-cluster graphic. Full designs require choosing
  `Selected full cluster design (experimental)` in Settings and still use the
  parked-only, 12-second safety guard.
- Repeating the test remains blocked while the real vehicle speed/RPM signals
  are stale, even if the last received selector position was P.

## 0.5.6: Separate selector indication from telemetry freshness

- On the main screen, `Selector: P/N/...` is the last received selector value.
  `Live speed/RPM` and `Test safe` are displayed independently; `P` alone is
  never sufficient to arm a full-panel test.
- Diagnostics and the offline QR report now include speed, RPM, selector and
  sample age, to distinguish a missing gear event from stationary/stale data.
- The strict parked-only safety guard is unchanged.

**Experimental. Not validated on a real car. No authorization for driving with a replaced speedometer.**

## 0.5.5: Correct icon dimensions

The previous 0.5.4 icon was a 256×256 PNG. The ID7 installed-app tiles use 140×140 PNGs
in the other apps, and the 256px image was drawn too large on the MGU, overlapping the
"Custom Cluster" text and hiding the focus frame. Both the SVG source and PNG export
are now exactly **140×140**, with a small margin inside the image. The package and Store
versions were advanced so the corrected icon is included in a fresh installation.

## 0.5.4: HMI navigation and parking-test diagnostics

The former diagnostics and QR report were persistent drawing modes of the **MAIN** canvas.
Re-entering the app could therefore show the previous QR or diagnostic page rather than the
cluster preview. They are now three separate RHMI states: **MAIN** (design preview),
**DIAGNOSTICS** (renderer/guard status), and **QR_REPORT** (offline QR export).

* **Diagnostics** opens its own page with **Refresh**, **QR report**, and **Back to cluster**.
* **QR logs** opens a new snapshot on its own page with **Next QR page** (wraps after the
  final page), **New report** (fresh renderer snapshot), and **Back to cluster**.
* Returning to MAIN always shows the selected design preview, even if an old report exists.
  The App entry point still maps to MAIN as before. The diagnostic export includes recent
  iDrive navigation events, so another failure can be correlated with button presses.
* The app-list icon now has a transparent margin to make the selection frame distinguishable.
  The actual focus highlight is drawn by BMW HMI, not the app; verify on the head unit.
* A rejected panel test now says whether no complete speed/RPM sample was received, the
  sample is older than 30 seconds, the selector is not **P**, or the car is moving. The
  safety guard is unchanged: no real sample means no KOMBI panel takeover.

**Observed test:** the previous small white marker was expected when the diagnostic probe
was selected, and it proves only that a panel-layer graphic reached the cluster. The native
right-side music panel disappeared while the map persisted. The occupied `0x203` panel
slot may compete with OEM widgets; its exact render and compositor behavior are not yet
validated. Do **not** interpret this as a working replacement for the full OEM gauges.

**Parked retest:** select 6WB, G80 or G21 OEM-style → set **Parked test content** to
**Small diagnostic marker** → verify live speed/RPM and selector **P** → activate the 12 s
test. While it is armed, open QR logs, scan/photograph each page, then return via **Back
to cluster**. Retest full design only after reviewing marker/slot behavior. Do not drive
with an experimental instrument panel.

## 0.5.1: Small shader probe and offline diagnostics

Following the architecture documented by
[eroobeeroo/idrive7-cluster-info](https://github.com/eroobeeroo/idrive7-cluster-info/tree/main/apps/cluster_layouts),
the test now **defaults to a tiny GLSL ES 1.00 marker**, rather than the
previous 1920x720 single-shader dashboard. The white/accent test rectangle
is requested at x=86, y=300, w=260, h=110, left of the native map
(x=416..1504, y=120..600). It does not validate a full instrument display.

**Settings → Parked test content**:
* **Small diagnostic marker** (default): isolate renderer/slot failures from a complex shader failure.
* **Selected full cluster design**: the previous G80/G21/6WB single-shader implementation, explicitly opt-in and still unverified. Those large shaders have **not yet** been split into smaller layers.

**Settings → Panel target / slot** defaults to `panel` (DCSM slot `0x203`).
Experimental `panel201` and `panel202` are selectable only if the current
renderer advertises them. A firmware/renderer replacement is not required
for the default test and should not be performed without compatibility checks.

The app now distinguishes `Panel: REQUESTED` from the renderer's own
`Layer` and `Slot` events, including refusals. A created layer reference,
or even a `shown` status, **does not prove a visible image on the cluster**.
Press **Diagnostics** for the renderer backend, advertised targets, current
panel status, refusal reason and slot status excerpts.

Press **QR logs** to capture full renderer status and current app diagnostics.
Photograph each numbered QR code; use **Next QR page** to advance and **Back to cluster**
to return (since 0.5.4). No phone-MGU network or internet is needed.
Codes contain compressed text under a `CCLOG1` identifier. Put the scanned
QR text into `scanned-pages.txt` and run
`python3 tools/decode_custom_cluster_logs.py scanned-pages.txt`.
Full text also saves to the app's `exports/` folder and writable USB mounts.

Still to verify on this car: small-layer GPU rendering, target/scene ownership,
stock warning and gear displays, BMW/Waze map coexistence, and restoration
under each failure condition.

G80-inspired, G21 OEM-style and classic **BMW 6WB-inspired** reconstructed instrument **panels** (1920 × 720), three optional centre-map overlays, unchanged stock mode, a shared colour studio and switchable Waze map. Developed for a 2021 BMW G21 318d with iDrive 7 MGU and KOMBSP18; the appearances are original interpretations, not copies of BMW's instrument resources. The 318d engine scale remains 0–5000 rpm (not the M3's redline).

## Modes

| Layout | KOMBI output | Waze |
| --- | --- | --- |
| **BMW stock** (default) | No custom gauge layer | Normal Waze on Cluster, or the Waze preference selected here |
| **BMW 6WB digital** (new in 0.5.0) | Recreated F-series 6WB-style digital round instruments in three manual variants: Comfort (white), Sport (red), ECO PRO (blue). Color Studio can override the 6WB colours. **Only manually armed in P for 12 s**. | The 6WB graphic's central opening is transparent in every driving-display theme; live BMW map + Waze coexistence remains CAR-ONLY |
| **G21 OEM-style recolor** (new in 0.4.0) | Factory-inspired, entirely redrawn dial graphics taking their colour from Color Studio. **Only manually armed in P for 12 s**. Not BMW's original pixels and not yet pixel-accurate. | Permanently transparent centre map window; BMW/Waze coexistence unverified |
| **G80 full cluster** | Entire `panel` slot, **only when manually armed at standstill with the selector at P**, max. 12 seconds | Centre map window **always transparent**, both with Waze and with BMW's own map selected; panel+map combination needs a real-car test |
| M Sport / Classic / Minimal | Coloured overlay in `map` slot, beneath original BMW dials | Native 504×368 map guidance-safe region is transparent; does **not** take over the BMW stock map slot |

None of the full-panel modes immediately replaces the OEM cluster upon selection. They always open with the original BMW display. The iDrive main screen shows a design preview; it is not cluster output. To test the real `panel`, select 6WB, G80 or OEM-style, have genuine SOME/IP speed and engine rpm data, be in **P** with speed under 0.5 km/h, and press **Parked panel test**. In 0.5.1 this initially shows only a small marker unless you explicitly select the full-design test. Press the button again to stop. The layer is also dropped on departure from P, speed movement, missing data, layout change, app exit or after 12 seconds. Demo values cannot activate a panel. No persistent armed flag, no autostart of the full panel.

## 6WB variations (new in 0.5.0)

In **Settings → Cluster layout → BMW 6WB digital** choose **Settings → 6WB → 6WB driving display**:

* **Comfort:** fine white dial illumination and a subdued dark background.
* **Sport:** red high-contrast accents, heavier digital dial progress.
* **ECO PRO:** blue illumination with the same verified engine RPM scale (a real OEM 6WB replaces the right gauge with an efficiency meter, but we cannot calculate that safely from the current live signals).

**6WB instrument colors** allows either period-inspired preset colours, or the common Color Studio settings (including RGB and colour animation). These choices are **manual 6WB style presets**; automatic switching based on an unverified drive-mode signal is intentionally not implemented. The map window stays transparent for all three subthemes, including Waze off.

The panel is layered **above the BMW gauge graphics and below the BMW telltales** according to `cluster-render`'s upstream mapping. **This layering does not establish functional safety**: warning visibility, render order, startup/shutdown, faults, renderer loss, map coexistence and speedometer readability need car-specific validation. Do not use the experimental G80 full panel while driving. The system may additionally hold the panel scene for up to 3 seconds after a drop (`panel_linger_ms`).

## Color Studio (expanded in 0.4.0)

Open **Settings → Cluster colors** in the app:

* **Color palette:** M blue, turquoise, neon green, purple, pink, red, orange, amber, ice white and pure white.
* **Custom RGB:** red, green and blue separately adjustable in steps of 16 (plus 255); stored in the normal app settings.
* **Automatic color cycle:** optional full rainbow sweep, configurable 5–120 seconds per loop. Changes are applied to the real cluster's own decorative layers and the iDrive preview when rendering is available.
* **Color brightness:** 25–100%, affects the accent graphics, not the neutral white readouts and not the map itself.

All three custom map layouts, G80 and the OEM-style reconstruction use the same colour settings. The 6WB can either adopt the original-style colour of its selected mode or use Color Studio. **BMW Stock remains exactly the factory instrument display**; the `cluster-render` overlay protocol has no verified way to sample and recolour BMW's own gauge pixels. A genuinely 1:1 replica requires clean full-resolution photographs of the original display in each view, its exact gauge/symbol layout, and verified real-time signals for all essential states and telltales. The current prototype cannot replace the original while driving.

**Maps always take priority over decoration:** the G80 centre window stays transparent even when Waze is switched off, allowing the factory map to show if the BMW head unit offers it in that slot. M Sport, Classic and Minimal keep the native map's guidance-safe rectangle transparent, and request their overlays with `contend: false` so they never actively displace the BMW stock map. This also means their custom overlay may be parked/invisible when the stock map exclusively holds the slot. Actual coexistence and map behaviour remain unverified on this KOMBSP18; the app cannot force a map provider to publish a frame.

## Shared renderer and Waze

Custom Cluster talks to the *installed* `cluster-render` service from `robertnisipeanu/idrive-apps`. It **does not install another renderer**, modify `/usr/bin/carplay`, activate Waze patches, or flash/FDL-code KOMBSP18. Waze on Cluster remains a separate app; it can be turned off in its UI while retaining the shared service (if the Store dependency manager leaves it installed). Avoid uninstalling the service on which Custom Cluster depends.

The **Waze map in cluster** setting has three choices:

* **Auto (default):** leave Waze on Cluster's current map selection alone. The G80 design reserves its central opening for Waze or the BMW map.
* **Show:** send `{"cmd":"cluster","on":"1"}` to the existing Waze render socket and `{"cmd":"cluster","on":1}` to its patch daemon socket.
* **Hide:** send the corresponding `0` settings; HUD settings remain unchanged.

Both sockets must be accessible. The app reports the **request**, not confirmation, and a different Waze app instance may later change the same preference. No Waze feed is created unless the original tool's streaming and patch prerequisites already work. `Auto` after `Hide` does **not** roll back Hide; change the setting in Waze on Cluster or choose Show.

The Waze render socket is `/dev/shm/waze-on-cluster/ctl.sock`; the patch daemon socket is `/dev/shm/waze-on-cluster/patch.sock`. Those are upstream internal protocols and should be retested when updating the Waze app. The panel and HUD **reuse scene ID `0x01000400` and cannot both be requested at once**. If Waze is sending a HUD feed, disable it in the original Waze app before a parked G80 panel test; Custom Cluster does **not** change the HUD feed by itself. Rendering `panel` and `map` simultaneously is marked **CAR-ONLY / not verified** in upstream `cluster-render` documentation. The opening in the G80 shader is a transparency window, not proof that Waze will appear there.

## iPhone status badge

Optional Shortcuts bridge from v0.1.0 remains. It accepts authenticated, locally scoped `opened`/`closed` events from iPhone Shortcuts and shows a small neutral dot while a recent `opened` event exists. **It cannot verify that Blitzer.de remains active in the background**, and it sends no radar-warning data. Configure the Shortcuts app-open and app-close events using the generated bridge URLs on the iDrive screen. A CarPlay Wi-Fi link does not guarantee that the phone can reach the head unit's HTTP server. Background presence / speed-camera warnings are **not integrated**. Warning functions are restricted for drivers in Germany under § 23(1c) StVO.

## Build and deployment

1. Ensure your existing `cluster-render` native service is installed from the Waze on Cluster ecosystem, and check the target configuration and status before any parked test.
2. Add `apps/custom_cluster` to the `idrive7-apps` kit repository; the compatible SDK from your MGU is required to build.
3. Build: `python3 kit/tools/build.py custom_cluster`.
4. Install `dist/custom_cluster@0.5.1.mgu` by your trusted MGU installer, or update the source app through [NamelsMissing/mgu-apps](https://github.com/NamelsMissing/mgu-apps) in MGU Store **after that source has been updated**.
5. Start in **BMW stock**. Only use the full-panel **iDrive previews** until you can safely validate the renderer with the stationary car and reliable diagnostics.

No `cluster-render` dependency is automatically installed by the app. Your Store manifest should explicitly keep the dependency; otherwise installation of the standalone MGU package alone will only show the iDrive preview.

## Technical design

* `g80_panel_shader.js`: 1920 × 720 GLSL ES 1.00, separate G80 and subdued factory-inspired variants using a common selectable accent; live speed/rpm, permanently transparent centre map window; neutral dot.
* `sixwb_panel_shader.js`: original 6WB-inspired GLSL dial artwork, three preset styles with optional Color Studio tint; permanently transparent centre map window.
* `cluster_shader.js`: M Sport, Classic and Minimal decorative layers with the 504×368 map-safe area always transparent.
* `cluster_colors.js`: preset palette, RGB and colour animation shared by all custom layouts, controlled solely through MGU settings.
* `cluster_layers.js`: one renderer client; own refs for `map`, `panel`, phone badge; strictly guarded panel test; no demo data on KOMBI.
* `panel_probe_shader.js`: compact GLSL test, outside the map aperture.
* `cluster_diagnostics.js`, `qr_vendor.js`: read-only renderer, QR and USB logs.
* `waze_control.js`: optional one-shot requests to original Waze sockets; no root commands, patch install/revert, or HUD edits.
* `g80_preview.js`: iDrive-only canvas design, synthetic graphic centre map as a **mockup** (not a live Waze map).
* `sixwb_preview.js`: iDrive-only classic 6WB dial preview, with Comfort/Sport/ECO PRO colours and the same map mockup caveat.
* `phone_bridge.js`: Shortcuts event bridge, expiring status.
* `cluster_render_client.js`: upstream `cluster-render` client (MPL-2.0) by Robert Nisipeanu, see `NOTICE` / `LICENSE`.

Validation: built against extracted OAP SDK 24.10.2 (`x_call@4.25.3` donor), JS syntax and mocked unit tests passed, HMI preview rendered on PC. **Unvalidated**: GLSL compilation and output on the real cluster GPU, concurrent panel/Waze/HUD behaviour, warnings, phone-to-MGU Wi-Fi, socket authorization and actual MGU Store install. Test with a full diagnostic log. A cluster that looks normal during a short stationary test is not sufficient to approve driving.
