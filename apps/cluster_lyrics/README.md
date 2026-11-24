# Cluster Lyrics 0.1.5 — BMW G21 / MGU iDrive 7

Shows the synchronised lyrics of the song that is playing on **your own Spotify account**:

- on the iDrive screen (title, artist, current line, next line), and
- optionally in the **instrument cluster's map window**, replacing the map or overlaying lyrics while Waze remains visible.

**Status:** The exclusive map lyric display was confirmed on a BMW G21; new functions still require
vehicle testing. See
[What is verified](#what-is-verified) before you rely on any part of it.

## Starts with the car, works without the app window (0.1.4)

The app declares `mguAppStartType: autostart`. The **MGU Store build wrapper** writes this metadata into
the installed packages. The app process can therefore start with iDrive without opening its menu.
In addition, **Autostart KOMBI lyrics when iDrive starts** controls whether the saved KOMBI switch
is automatically resumed at the next process start. It defaults to **On**, but the separate
**Show lyrics in the instrument cluster** switch remains **Off** on a fresh installation.
Activate that master switch once after signing in to Spotify.

The Autostart preference controls the **next** process start, not the currently visible lyrics.
With Autostart Off, use the **KOMBI lyrics** button to turn the cluster on manually for this session;
the next process launch again begins with the cluster off. An explicitly disabled KOMBI master switch
always keeps it off.

Important: building with `kit/tools/build.py` alone does **not** add the native autostart metadata.
Use `python3 tools/build_store_app.py cluster_lyrics`, as the MGU Store does.

| You want | Settings |
| --- | --- |
| Lyrics in the cluster, menu never opened | **Show lyrics in the instrument cluster** On, **Autostart KOMBI lyrics** On (Spotify sign-in required once) |
| Lyrics only after manual activation this session | **Autostart KOMBI lyrics** Off, then press **KOMBI lyrics** when needed |
| only when standing still | **When lyrics may be shown**: at a standstill (default) |
| also while driving | **When lyrics may be shown**: always |
| nothing in the cluster | **Show lyrics in the instrument cluster** off |

Spotify polling, lyrics download and the cluster layers run in the background process (a timer, not the screen's draw loop). With the cluster switch off, the app does not poll Spotify unless its window is open.

**Check it over SSH:** `cluster-lyrics-background.json` in the app data directory contains
`startReason`, `startedAt`, `windowOpenedYet`, `kombiOn` (effective activation),
`autoStartOnBoot`, `rendererReady`, `rendererMapState`, and `heartbeat15s`.
If `windowOpenedYet` stays `false` while the heartbeat advances, the process is demonstrably
alive without opening the menu. This alone does not prove that lyrics are visible in the cluster:
inspect the renderer and lyric states as well. The **Log** page shows the session and boot state.

**Not verified on a vehicle:** that the autostart process runs at all on this head unit (the same open question exists for Light Flasher), and everything listed under "What is verified".

## How it works

| Part | Source | Notes |
|---|---|---|
| What is playing, and the position in the song | Spotify Web API, `GET /v1/me/player/currently-playing` | Read-only. Asked every 4 s while a song plays, every 8 s otherwise, and only while the app's screen is open or cluster lyrics are switched on. |
| Lyrics with time stamps | [LRCLIB](https://lrclib.net) | Spotify's API does not hand out lyrics. LRCLIB is a free community database: many songs have synchronised lyrics, some have none. Only title, artist, album and length are sent. |
| Internet | MGU Store uplink (`"mguInternet": true`) | Same mechanism as MGU Video Hub. Only `accounts.spotify.com`, `api.spotify.com` and `lrclib.net` can be reached, on port 443, with certificate checks. |
| Cluster display | `cluster-render`, target `map` (1088x480) | Lyrics only uses an opaque exclusive background and separate text layers. Lyrics + Waze uses one non-exclusive image layer with a compact translucent footer. Its background follows the actual rendered glyphs, including accents and descenders. |

When the lyrics are hidden (song paused, nothing playing, vehicle moving in standstill mode, switch off), the
layers become invisible and the map window is released: the Waze map or BMW's map comes back by itself.
This app never changes Waze's own setting and draws nothing on the speedometer/warning area (`panel`).
In Lyrics only, `guide_hold=0` preserves the stock turn box. In Lyrics + Waze,
`guide_hold=1` prevents the footer from vetoing Waze's request to hide the box.
Waze can still opt out of suppression with its own `guide_hold=0`. On renderer
versions that combine the flags with AND, if the footer remains active and
retains the map slot by itself, the renderer can keep the box hidden until
the footer also releases the slot. The map protocol has no passive
guide-hold mode for an overlay.

## Setup

1. **Internet in the car.** Install the Store's `mgu-uplink`, then connect the car to your phone's hotspot in
   **MGU Store → Settings → Wi-Fi**. Install (or reinstall) Cluster Lyrics *after* the uplink exists, so the
   Store registers the app for internet access. The Setup page must show `Internet: ROUTED`.
2. **Your own Spotify app** (needs Spotify Premium). At <https://developer.spotify.com/dashboard> create an app,
   select *Web API* and add exactly this Redirect URI: `http://127.0.0.1:8898/callback`. Note the *Client ID*.
3. **Sign in once on a PC:**

   ```sh
   python3 tools/spotify_login.py <client-id>
   ```

   Your browser opens Spotify's own sign-in page; the script never sees your password and uses no client
   secret (Authorization Code with PKCE). It asks for two read-only permissions
   (`user-read-currently-playing`, `user-read-playback-state`) and writes `cluster-lyrics-spotify.json`.
4. **Bring it to the car.** Copy that file to a USB stick (top level or one folder down), plug it in, open
   **Cluster Lyrics → Setup** and press **Import from USB**. Then delete the file from the stick: whoever has it
   can see what you listen to until you remove the app's access in your Spotify account settings.
5. Start a song in Spotify on your phone. The **Now playing** page shows the lines.
6. For the cluster: press **KOMBI lyrics: Off** so it reads **On**.

**Sign out** (Log page, press twice) removes the stored sign-in and the lyrics cache from the car.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| Show lyrics in the instrument cluster | Off | Master switch for KOMBI lyrics. Enable once to allow the start-on-boot preference to resume the display. |
| Autostart KOMBI lyrics when iDrive starts | On | Resume the saved KOMBI master setting at the **next** app-process startup, without opening the app screen. When Off, manually press **KOMBI lyrics** each session. |
| When lyrics may be shown | Only at a standstill | *Only at a standstill*: shown after the car has stood for 1.5 s with a fresh speed signal, hidden at once from 3 km/h or when the signal is missing. *Also while driving*: no speed condition. |
| Also replace BMW's own map (not only Waze) | Off | Applies to **Lyrics only**; ignored in **Lyrics + Waze** to avoid taking over BMW's map. |
| KOMBI display: lyrics only or together with Waze | Lyrics only | **Lyrics only** replaces the map. **Lyrics + Waze** displays a compact translucent lyrics strip along the bottom while Waze continues underneath (Waze must already be running). |
| KOMBI lyrics font size | 75% | Saved 50–120% scaling for the current and next lyric lines; the text is constrained to the cluster's central region. |
| Show the next line | On | Second line with a lighter colour than before, still visually distinct from the current line. |
| Colour of the current line | White | White, green, amber or blue. |
| Lyrics delay | 0 ms | Positive values show each line **later**, negative values **earlier** (−2000 … +3000 ms). On Now Playing the song clock and shifted lyric clock are shown separately. The progress bar continues to indicate the actual song position. |

Reading text while driving takes your eyes off the road. The default therefore shows lyrics only at a
standstill; choosing *Also while driving* is your own decision and responsibility as the driver.

## Verifying the delay (0.1.3)

- Open **Now playing** with a song that has synchronised lyrics. The two right-hand clocks show **Song** (Spotify playback, unchanged by delay) and **Lyrics** (playback minus delay).
- Set **Lyrics delay = +2000 ms**. The lyric clock will run 2 seconds behind the song clock and lyrics will appear 2 seconds later.
- Set **Lyrics delay = −2000 ms**. The lyric clock will run 2 seconds ahead and lyrics will appear earlier.
- **Log** records each change to the delay setting. If both clocks move together or the log does not register a change, verify that the settings are being applied by the installed build.
- Spotify provides periodic playback position snapshots; network latency and the cluster renderer's refresh interval may introduce residual jitter. The setting only shifts the lyric timestamp, not the audio itself.

## What you see when something is missing

| Message | Meaning |
|---|---|
| `Internet: Store uplink offline` / `Store online - app not routed` | No hotspot connection, or the app was installed before the uplink (reinstall it). |
| `Spotify sign-in expired` | Repeat setup steps 3 and 4. |
| `Spotify refused the request (Premium / app user list?)` | The Spotify account is not Premium, or it is not the account that owns the Spotify app. |
| `Lyrics: not found on LRCLIB` / `only unsynchronised text available` | Only a music note is displayed in the cluster for that track, including instrumental and unreadable lyrics. Cache behaviour is unchanged. |
| `Lyrics: in a script this display cannot draw` | The built-in font covers Latin (with umlauts and accents) and Cyrillic, not e.g. Chinese, Japanese, Korean or Arabic. |
| `KOMBI: hidden - vehicle moving` / `no fresh speed signal` | Standstill mode is doing its job. |
| `KOMBI: requested - map window waiting (held by stock)` | BMW's own map holds the window and *Also replace BMW's own map* is off. |
| `KOMBI: cluster-render not connected` | The `cluster-render` tool is not installed or not running. |

The **Log** page lists the last events (song changes, renderer states, refusals). The same lines are in the
app's log file.

## What is verified

Verified on a PC:

- Unit tests (`node tests/cluster_lyrics.test.js`): LRC parsing and timing, line wrapping, the host allow-list
  and DNS checks, token refresh and rotation, rate-limit and error handling, LRCLIB lookup and cache, the
  standstill rule, and the cluster layers both against a fake renderer and through the real
  `cluster_render_client.js` over a socket.
- `python3 -m pytest tests/test_spotify_login.py`: PKCE values, the loopback callback, the code exchange.
- The Store build (`python3 tools/build_store_app.py cluster_lyrics`) and the three app pages in the kit's PC
  preview with canned answers.
- TLS: a self-signed certificate is refused; the host name is used for SNI and the certificate check.

**Not verified** — needs the car:

- That the head unit's Node 8 accepts the certificates of Spotify and LRCLIB with its built-in root store, and
  that an app with an uplink lease can reach them.
- A real Spotify sign-in with `tools/spotify_login.py` and real answers from Spotify and LRCLIB (the sandbox
  this was written in has no access to them).
- Everything on the instrument cluster: that the `map` window shows these layers, that `exclusive` hides the
  Waze map as documented, how it behaves next to Waze's video upload budget, during warnings and with BMW
  route guidance. Custom Cluster's own cluster output is also still unconfirmed on this car.
- How far the lyrics are off against the sound with CarPlay (the *Lyrics delay* setting is for this).
- That a USB stick is readable by the app under `/media`, `/run/media`, `/mnt/usb` or `/mnt/media_rw`.

**Vehicle follow-up for 0.1.2:** The original exclusive lyric display was confirmed on a G21. The narrower text, note fallback and simultaneous Waze overlay have not yet been verified on the vehicle. Waze mode never starts or controls Waze itself.

First test with the car parked: open the app, check **Setup** (steps 1, 2 and 4 green), play a song, then
switch **KOMBI lyrics** on and take a photo of the cluster and of the **Log** page.

## Privacy and terms

- The refresh token is stored only in the app's private data folder on the head unit (file mode 0600).
- Lyrics are fetched at runtime and cached privately (at most 300 songs); none are part of this repository.
  Song lyrics are protected works; LRCLIB's entries are contributed by its community.
- You use your own Spotify developer app; its use is subject to Spotify's developer terms. This project is
  not affiliated with or endorsed by Spotify, LRCLIB or BMW.

## Files

- `main.js`: pages, buttons, settings.
- `engine.js`: polling, line timing, the rule for when the cluster may show text.
- `spotify.js`, `lrclib.js`, `uplink_http.js`: the three network parts.
- `lrc.js`: LRC parsing, timing, wrapping.
- `kombi.js`, `cluster_render_client.js`: cluster layers (client from `robertnisipeanu/idrive-apps`, MPL-2.0).
- `lyric_font.js`, `lyric_font_data.js`: text with umlauts/accents/Cyrillic (DejaVu Sans, baked by
  `tools/bake_lyric_font.py`).
