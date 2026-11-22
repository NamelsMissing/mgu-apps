# MGU Apps for BMW iDrive 7

Community-made apps for **BMW iDrive 7** head units (**MGU**). You install and update them through **[MGU Store](https://github.com/robertnisipeanu/mgu-store)** directly in the car.

The apps are developed and tested on a BMW 3 Series Touring (G21). On other cars, some functions may behave differently or not work.

## Add this repository to MGU Store

> [!IMPORTANT]
> The GitHub account is called **NamelsMissing**. The letter after "Name" is a **lowercase L**, not a capital **i**.
> On the iDrive screen `l` and `I` look the same, so most people type **NameIsMissing**. That account is not this one, and the Store answers *"Not found or private"*.

**The easy fix: type everything in lowercase.** GitHub ignores upper and lower case in account and repository names, and in lowercase you can tell the letters apart (`l` has no dot, `i` has one):

```text
namelsmissing/mgu-apps
```

Spelled out: **n a m e L s m i s s i n g** / **m g u - a p p s**

### Step by step in the car

1. Park the car and make sure MGU Store has internet, for example your phone's hotspot under **Settings → Wi-Fi**.
2. In MGU Store, open **Settings** and tap **+ Add source**.
3. Enter `namelsmissing/mgu-apps`. The repository is public and works without GitHub sign-in.
4. If the name is correct, the Store lists what the repository offers. Choose the branch **main** (marked *Default branch*). For normal installations use the default branch; test branches may contain incomplete changes.
5. The source now appears under **Settings → Sources** with *Branch main*.
6. Go to the **Store** tab, choose an app and tap **Install**. If an app needs extra background components, the Store installs them with it.

### Even easier: add it from your phone

You don't have to type on the car at all:

1. In MGU Store open **Settings → Phone access → On**.
2. Connect your phone to a network that can reach the MGU phone-access page, then scan the QR code.
3. On the phone page, add a source and **paste** this link (copy it from here):
   `https://github.com/NamelsMissing/mgu-apps`
4. Choose the branch **main** as above, then turn **Phone access** off again.

### Something went wrong?

| Message | What to do |
| --- | --- |
| *Not found or private* | You almost certainly typed a capital **I**. Type it again, all in lowercase: `namelsmissing/mgu-apps`. |
| *Offline* | MGU Store has no internet. Connect it under **Settings → Wi-Fi** and try again. |
| *GitHub limit reached* | GitHub is limiting requests for now. Wait a while and try again. |

**Updates:** tap **Check now** in MGU Store's **Settings**. New versions of the apps from this repository then appear in the Store.

**Requirements:** an iDrive 7 head unit (MGU) with root access and MGU Store installed. How to get there is explained in the [MGU Store guide](https://github.com/robertnisipeanu/mgu-store#requirements).

## Apps available from this main source

Version numbers below are those in the **main** store catalog. **Stable** means the described basic use has been reported working on a compatible vehicle; **Beta / Experimental** means important functions, vehicle variants or hardware control paths remain unverified. Versions below are repository versions on `main`, **not a readout of what is installed in your car**. Consult each app's guide and its vehicle-verification notes before operating it.

### Comfort and vehicle

| App | Version | Status | What it does |
| --- | --- | --- | --- |
| [**Heating Comfort**](apps/g21_wheelheat/README.md) | **0.5.4** | Beta / vehicle-specific | Automatic seat and steering-wheel heating, BDC / seat-module detection, saved settings, background startup, manual controls and logs. Separate seat-module writes are opt-in and experimental; ECU acceptance varies by vehicle. |
| [**DPF Monitor**](apps/dpf_monitor/README.md) | **0.2.8** | Experimental / read-only | Requests diesel particulate-filter measurements and regeneration-history values from the DDE. DID scaling was reviewed offline; live routing and actual responses still need vehicle verification. Does **not** start forced regeneration. |
| [**Ambient Lighting**](apps/g21_ambient/README.md) | **0.4.7** | Experimental | Reads the OEM BMW ambient-color status and offers manual selection of menu slots 1–12 with separate setter/readback feedback. Includes RGB previews, saved looks and carefully gated BDC LIN testing; aftermarket LED control is not yet verified. |

### Screens and cluster

| App | Version | Status | What it does |
| --- | --- | --- | --- |
| [**GIF Home**](apps/gif_home/README.md) | **0.4.0** | Vehicle verification pending | Animated iDrive home widget with a local GIF library, phone management, groups and playlists. |
| [**Custom Cluster**](apps/custom_cluster/README.md) | **0.6.11** | Experimental | Alternative instrument-cluster layouts, navigation-related controls and diagnostics. KOMBI overlay tests are guarded by parked / selected-layout conditions; background startup does not activate an overlay by itself. |
| [**Cluster Lyrics**](apps/cluster_lyrics/README.md) | **0.1.4** | Experimental | Spotify lyrics on the iDrive screen, optionally in the cluster map region, including an overlay mode with Waze visible. The app supports background startup; display and lyric availability depend on Spotify data and network access. |

### Entertainment (parked only)

| App | Version | Status | What it does |
| --- | --- | --- | --- |
| [**GameStation**](apps/mgu_gamestation/README.md) | **0.3.0** | Experimental | Offline retro games with saves, iDrive controls and optional phone gamepads for one or two players. |
| [**Video Hub**](apps/mgu_video_hub/README.md) | **0.2.0** | Experimental | Local videos and YouTube links using the head-unit playback tool; web video needs internet. |

### Sound

| App | Version | Status | What it does |
| --- | --- | --- | --- |
| [**Equalizer DSP**](apps/equalizer/README.md) | **0.2.4** | Experimental | Seven-band audio equalizer with filters and presets. Currently applies only to supported app playback paths, **not** system-wide CarPlay, radio or Bluetooth. |
| [**Audio Diagnostics**](apps/mgu_audio_diagnostics/README.md) | **0.1.2** | Experimental / read-only | Displays SmartX, ALSA and DSP information for audio troubleshooting. It does not change sound settings. |

### Exterior lighting (use on private ground while parked)

| App | Version | Status | What it does |
| --- | --- | --- | --- |
| [**Light Show**](apps/light_show/README.md) | **0.4.8** | Experimental | Scans supported BDC, headlamp and rear-light controllers; filters and tests individual outputs before allowing them in lighting effects. Includes 3D car view, phone remote, STOP and recovery reporting. Requires parked/P checks. |
| [**Light Flasher**](apps/light_flasher/README.md) | **0.1.26** | Experimental | Configurable headlamp strobe sequences with a button or short high-beam stalk pulse, recovery and background observation. |

Use lighting effects only while safely parked in P on private ground, with nobody in front of the car. **Light Flasher 0.1.26 does not enforce P or zero speed**, so this is a user safety requirement, not a claim that the software blocks operation while moving. These features send diagnostic commands; acknowledgements do not guarantee physical lamp restoration. See each safety and recovery guide.

### Tools

| App | Version | Status | What it does |
| --- | --- | --- | --- |
| [**Phone Terminal**](apps/mgu_phone_terminal/README.md) | **0.1.7** | Advanced / privileged | Temporary phone-browser terminal with QR pairing, commands, output and file downloads. Uses root privileges; verify local reachability and access controls on your MGU before relying on it. |

### Background components installed with apps

The same [store catalog](mgu-repo.json) lists **13 apps** and **6 native helper components**. These tools are dependencies, not additional user-facing MGU apps.

| Helper | Version | Used by |
| --- | --- | --- |
| `mgu-equalizer-dsp` | **0.2.1** | Equalizer DSP, Video Hub and Audio Diagnostics |
| `mgu-game-net` | **0.1.0** | GameStation phone controllers |
| `mgu-gif-net` | **0.1.0** | GIF Home phone management |
| `mgu-light-net` | **0.1.0** | Light Show phone remote |
| `mgu-phone-bridge` | **0.1.6** | Phone Terminal |
| `mgu-video-net` | **0.1.0** | Video Hub phone import |

App and tool version numbers are maintained in `apps/*/app.json` and `native/*/component.json`, respectively; `mgu-repo.json` must match those files. Do not raise version numbers just to refresh documentation. A Store install or update also depends on the actual SDK, network access and vehicle setup.

### Apps moved to other repositories

These apps are **not** in the main MGU Store catalog. Add the linked repository separately:

| App | Location | Note |
| --- | --- | --- |
| [**Blitzer Status**](https://github.com/NamelsMissing/mgu-apps-beta/tree/main/apps/blitzer_status) | [MGU Apps Beta](https://github.com/NamelsMissing/mgu-apps-beta) | Version **0.1.0**. Receives iPhone Shortcuts foreground open/close events and optionally shows the last report in the cluster map window. Its companion phone-port tool moved with it. This does **not** prove Blitzer.de's background mode is running. |
| [**GameSnacks**](https://github.com/NamelsMissing/mgu-apps-beta/tree/main/apps/mgu_gamesnacks) | [MGU Apps Beta](https://github.com/NamelsMissing/mgu-apps-beta) | Version **0.2.0**. Parked-only mini-games and optional web mirror. |
| [**Vehicle Data**](https://github.com/NamelsMissing/mgu-chatgpt-bridge/tree/main/apps/vehicle_data) | [BMW AI / MGU ChatGPT Bridge](https://github.com/NamelsMissing/mgu-chatgpt-bridge) | Vehicle mileage, service information and related BMW AI integration. |

For Blitzer Status, first update Custom Cluster to **0.6.11** or newer if you use it, then reinstall Blitzer Status from **beta** and replace the two iPhone Shortcut URLs with those shown by the app. Keep both repository sources in MGU Store for other apps and shared components.

## Good to know

- **Unofficial:** this project is not made or endorsed by BMW.
- **Only while parked:** set up and use games, videos, light and cluster functions only when the car is safely parked.
- **Not every command reaches the car:** when an app says a command was sent, that doesn't always mean the car carried it out. Each app's guide lists what is confirmed.
- **Phone Terminal runs commands with full rights (root).** Use it only on your own network, never make it reachable from the internet, and end the session when you're done.
- **Before you install:** keep a backup of your head-unit software and make sure the car has stable power.

## For developers

This repository contains the apps' source code and build tools, but no BMW SDK. MGU Store builds the apps on the head unit using the SDK that is already there.

| Resource | Description |
| --- | --- |
| [App source](apps/) | Source code and a detailed guide for each app |
| [Store catalog](mgu-repo.json) | All components, versions and dependencies the Store reads |
| [Store installation notes](STORE_INSTALLATION.md) | Autostart and settings behaviour after Store updates |
| [Equalizer DSP notes](native/equalizer-dsp/README.md) | DSP design, audio routing and limits |
| [ECU/PRG review](docs/ecu-prg-review-2026-11-03.md) | Technical diagnostic research |

**Privacy:** never upload BMW SDK files, diagnostic PRG files, SSH keys, VINs, personal data or logs that contain sensitive vehicle information.

## Credits

These apps would not exist without the work of:

- **[cauliflowermossgrape](https://github.com/cauliflowermossgrape)** for the [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) kit, the iDrive 7 app framework these apps are built on.
- **[robertnisipeanu](https://github.com/robertnisipeanu)** for [MGU Store](https://github.com/robertnisipeanu/mgu-store), which installs, builds and updates these apps directly in the car.

Thank you both!

---

## License

Copyright (C) 2026 NamelsMissing

Original code and contributions by NamelsMissing are licensed under the
**GNU General Public License v3.0 only** (`GPL-3.0-only`), except where
explicitly stated otherwise. See [LICENSE](LICENSE) for the full terms.
Redistributions must preserve the applicable copyright and license notices.

Third-party code and components retain their respective licenses and copyright
notices, including the MIT-licensed app kit and QR generators, MPL-2.0-covered
cluster components, and the separately licensed GPL-2.0 GameStation app.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the license files,
source headers and notices included with each app and dependency.

Project: https://github.com/NamelsMissing/mgu-apps
