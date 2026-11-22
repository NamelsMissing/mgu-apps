# GIF Home 0.4.0

GIF Home plays animated GIFs in the large BMW iDrive 7 home widget. Five
animations are bundled. The local phone page manages uploads, groups and
playback. App runtime target is BMW MGU with Node.js 8.

## Setup on the MGU

1. Install or update **GIF Home** from the MGU Store. The repository catalog
   declares **GIF Home Network Bridge** (`mgu-gif-net`) as a dependency. For a
   manual deployment, install that native component as well.
2. In iDrive HOME, tilt the controller up and select **Customize main menu**.
   Add **GIF Home**, select the large tile, and save. The narrow tile shows
   the current animation's name.
3. Open GIF Home. **Page** cycles through Preview, Library, Playback, Phone
   Connection and Diagnostics. **Next item / IP** moves the selection or cycles
   IP addresses. **Select** applies the highlighted action. Preview uses these
   two buttons for Next GIF and Pause/Resume. **Phone**, **Diagnostics** and
   **Settings** are shortcuts.

## Pair and upload from iPhone

With the iPhone connected to the MGU's local Wi-Fi, open **Phone** and scan the
QR code with Camera. The advertised URL uses local HTTP on TCP **18883**.
The phone needs a route to the displayed IPv4 address. Wireless CarPlay can
run over a link that Safari cannot route through on some MGU/iOS combinations.

- **HTTP server Running** means the app owns the listening socket. A port
  conflict is reported by its error code.
- **Network bridge Ready** means the helper could verify its own temporary
  firewall rule on `wlan_bridge`. **Not required** means the selected local
  interface uses the existing LAN firewall configuration.
- **QR session Active** means the pairing token is valid. The QR code appears
  once the selected address and the applicable firewall prerequisites are ready.
- **Phone connection Connected** requires a successful authenticated page or
  state request from a mobile browser on the selected subnet. **Last request**
  shows when the app last processed a successful request.

Use **Next item / IP** to search again and try the next address. **Select**
restarts pairing on the preferred address if a connection is awaiting
verification. Pairing prefers `wlan_bridge` and includes private Wi-Fi Direct
and IPv4 link-local candidates. A QR URL expires after 30 minutes. A connected
phone can extend the session using **Extend session**. Starting a new pairing
or stopping Phone invalidates the old URL. Use the URL on the trusted car link
and keep it private.

The helper uses the same deployment model as the Video Hub helper. Its
loopback-only status endpoint is on TCP **18983**. It checks a GIF Home
loopback health endpoint and restores its tagged IPv4 input rule every 2.5
seconds while a Wi-Fi session is eligible. Session end, process exit and
helper shutdown trigger removal of its rule. The helper only opens TCP 18883
on `wlan_bridge` for private or link-local source ranges. The application requires the selected destination IP, a
peer on its private subnet and a valid pairing token for management. No
outbound service, router forwarding, or public endpoint is required.

## Library, groups and playback

Choose one or more GIFs using **Upload**. Each upload receives its own internal
ID, including files with the same name. Use **Preview** to play one gallery
preview at a time. The card shows the file size, resolution, frame count and
duration. **Play on Home** activates the GIF in Single mode. The header shows
what the MGU currently plays. Mark GIFs for batch deletion or group assignment.
Deletion requires confirmation. Built-in animations are available for playback
and grouping.

Create groups in **Groups**. Mark GIFs in the library and use **Add marked** or
**Remove marked** on the group. A group's deletion leaves its GIFs available.
**Play group** switches to Random – Group.

| Mode | Playback |
| --- | --- |
| Single GIF | Repeats the chosen GIF. **Next GIF** selects the next item in the library. |
| Random – Selected GIFs | Shuffles the checked GIFs. |
| Random – Group | Shuffles the active group's GIFs. |
| Sequential | Plays the checked GIFs in the displayed order. Use **Move up** to reorder. |
| Random – All | Shuffles uploads and built-ins. |

Switch after a full animation pass, after 5, 10, 15 or 30 seconds, or after a
custom interval of up to an hour. An animation repeats until a fixed interval
ends. One-pass timing uses GIF frame delays and playback speed. A zero delay
uses 100 ms. Shuffle avoids repeating an animation until the current cycle has
covered the available selection, and avoids a repeat at cycle boundaries.
A missing or failed asset is skipped. An empty or unusable selection falls back
to the built-in logo. Changes are applied by the MGU before the page confirms
them. The page refreshes its state every three seconds while visible.

### Storage and limits

Uploads are GIF87a/89a up to 6 MiB, 640 × 360 pixels, 90 frames and 32 MiB of
decoded RGBA data per GIF. The library is limited to 64 uploads or 96 MiB and
64 groups. The app validates an upload before publishing it. GIF files live
under `ctx.dataDir/gifs/`. `library.json` contains a single atomic snapshot of
the catalog, groups and playback configuration so references change together.
Malformed or missing catalog metadata with existing blobs blocks edits and
preserves the files for recovery. Restore a known-good catalog and its
corresponding GIF files before restarting. The current playback item is
checkpointed separately at most once every five seconds during automatic
playback. A restart begins a newly loaded animation at its first frame.

An existing 0.3.1 `custom.gif` is imported on first startup. The original file
is retained as a migration backup. The previous source and pause preferences
seed the new playback settings. Fit, speed, refresh rate, renderer and widget
appearance settings carry over.

## Brightness and widget diagnosis

The app feeds an opaque 384 × 256 PNG into `BackgroundImage1` of
`LT_Table_OnlineApps_DriveRecorderWidget`. It fills the image canvas with a
uniform background before applying cover or contain scaling. No additional
alpha mask or edge darkening is applied by the original-colour path. A GIF
can contain dark edges itself, and **Contain** can expose the uniform bars.
On the generated PNG, the legacy compensation brightens mainly top and
bottom and can clip bright colours. The extended mode adds restrained
horizontal and vertical compensation with shared RGB gain and highlight
roll-off.

Compare these settings with **Fill / crop edges** and a flat-colour GIF.

1. **Original GIF colours** uses the selected native background setting and
   performs no colour correction.
2. **Legacy brightness compensation** reproduces the 0.3.1 correction.
3. **Extended edge compensation** addresses all four sides.
4. **Original colours, native background off** also forces the template's
   `background` cell off. This is the default for new installations. Compare
   this to Original with the cell on.

The builder and the widget API expose the image asset and named cells. The
checkout includes no documented mask override or second ID7 layout with a
verified large-widget image cell. The existing Drive Recorder layout is
therefore retained. The local preview renders the PNG before the BMW
compositor. Measuring any remaining HMI shade and determining its direction
or whether `background` affects it require a head unit. Refresh remains at
1–6 fps because each displayed frame incurs PNG generation and an RHMI
resource update. Fast animations can skip sampled frames.

## Diagnostics

**Diagnostics** shows a rolling log of the last 140 entries. **Next item / IP**
pages through the log. Press **Select** twice to clear it. On a verified
connection, **Select** in the Phone view switches between the pairing code and
the JSON download code. The phone page also has a diagnostic download link
for copying error text. Log entries omit pairing tokens. Compare **Last error**
and **Last request** when the QR code appears but Safari fails to connect.

## Build

With the BMW OAP SDK extracted in `oap-sdk/` at the checkout root, run
`python3 tools/build_gif_home.py gif_home`. The build produces
`dist/gif_home@0.4.0.mgu` and `dist/gif_home@0.4.0.tgz`. The Store archive
includes `rhmiDataStartWidget`; the network helper is installed separately
through the catalog dependency.

The bundled QR generator is Kazuhiko Arase's QR Code Generator (MIT, 2009).
See [LICENSE](LICENSE).
