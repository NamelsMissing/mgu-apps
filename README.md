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
4. If the name is correct, the Store lists what the repository offers. Choose the branch **main** (marked *Default branch*). There are no releases or tags, and the other branches are old test versions, so don't pick them.
5. The source now appears under **Settings → Sources** with *Branch main*.
6. Go to the **Store** tab, choose an app and tap **Install**. If an app needs extra background components, the Store installs them with it.

### Even easier: add it from your phone

You don't have to type on the car at all:

1. In MGU Store open **Settings → Phone access → On**.
2. Connect your phone to the car's Wi-Fi hotspot and scan the QR code.
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

## The apps

**Stable** means the app works well on the developer's car. **Experimental** means it is still being built or tested: some parts may not work yet or may depend on your car. Tap an app's name for its full guide.

### Comfort and vehicle

| App | Status | What it's for |
| --- | --- | --- |
| [**Heating Comfort**](apps/g21_wheelheat/README.md) | Stable | Turns the seat and steering-wheel heating on by itself when it's cold. You choose from which temperature; manual buttons are there too. Since 0.5 it detects the control units (BDC or separate seat modules) and remembers them for the next start. |
| [**DPF Monitor**](apps/dpf_monitor/README.md) | Stable | For diesel cars: shows how full the particulate filter is and when it last cleaned itself. Only reads data; it doesn't start a cleaning cycle. |
| [**Vehicle Data**](https://github.com/NamelsMissing/mgu-chatgpt-bridge/tree/main/apps/vehicle_data) | Moved | Now part of [BMW AI](https://github.com/NamelsMissing/mgu-chatgpt-bridge): reads mileage, upcoming services and the service history and passes them to the BMW AI companion. Install it from that repository's store source. |
| [**Ambient Lighting**](apps/g21_ambient/README.md) | Experimental | Choose one interior ambient-light color and brightness, save favorite looks, and check vehicle diagnostic responses. |

### Screens and instrument cluster

| App | Status | What it's for |
| --- | --- | --- |
| [**GIF Home**](apps/gif_home/README.md) | Stable | Shows an animated GIF in the large tile on the iDrive home screen. Use the built-in animations or send your own GIF from your phone with a QR code. |
| [**Custom Cluster**](apps/custom_cluster/README.md) | Experimental | Alternative designs for the digital instrument cluster, inspired by other BMW models, plus Waze map control in the cluster. |
| [**Blitzer Status**](apps/blitzer_status/README.md) | Experimental | Starts with iDrive and shows the last Blitzer.de open or close event reported by iPhone Shortcuts. The optional status line sits in the cluster map window. |
| [**Cluster Lyrics**](apps/cluster_lyrics/README.md) | Experimental | Shows the lyrics of the song playing on your Spotify, on the iDrive screen and optionally in the instrument cluster. Needs internet in the car; not yet tested in a vehicle. |

### Entertainment (while parked)

| App | Status | What it's for |
| --- | --- | --- |
| [**GameStation**](apps/mgu_gamestation/README.md) | Experimental | Retro games such as Pong and classic console games, with in-game saves. Play with the iDrive controller, or use up to two phones as gamepads (needs the GameStation Phone Port tool, installed with it). |
| [**GameSnacks**](https://github.com/NamelsMissing/mgu-apps-beta/tree/main/apps/mgu_gamesnacks) | Moved | Now in [mgu-apps-beta](https://github.com/NamelsMissing/mgu-apps-beta): small games (2048, Snake, Blocks, Mines) and a gamesnacks.com web mirror. Install it from that repository's store source. |
| [**Video Hub**](apps/mgu_video_hub/README.md) | Experimental | Watch your own videos and YouTube links on the iDrive screen. Needs extra software on the head unit; YouTube also needs internet. |

### Sound

| App | Status | What it's for |
| --- | --- | --- |
| [**Equalizer DSP**](apps/equalizer/README.md) | Experimental | A 7-band equalizer with presets to fine-tune the sound. For now it only affects apps that are connected to it (such as Video Hub), not yet CarPlay, radio or Bluetooth. |
| [**Audio Diagnostics**](apps/mgu_audio_diagnostics/README.md) | Experimental | Shows how the head unit's audio system is set up. Only reads data; meant for troubleshooting and for developing the equalizer. |

### Lights (while parked)

| App | Status | What it's for |
| --- | --- | --- |
| [**Light Show**](apps/light_show/README.md) | Experimental | Exterior light shows while parked in P: automatic vehicle scan, headlamp LEDs, body-controller light functions and rear light modules, effect library, 3D car and phone remote via QR code (needs **Light Show Phone Port**). |
| [**Light Flasher**](apps/light_flasher/README.md) | Experimental | Makes the headlights flash rapidly like a strobe while parked. Starts with a button in the app or a short pull on the headlight-flasher stalk. |

**How Light Flasher works:** instead of one normal flash, the headlights flash on and off several times in quick succession, like a strobe light. You set the rhythm in the app (from very fast, 100 ms, to slower, 1 second, between flashes) and how long the strobe runs (2–5 seconds). You start it in one of two ways:

- **Button:** tap **Start flash pattern** on the app's main screen.
- **Stalk:** briefly pull the headlight-flasher stalk, as for a normal flash. The app recognises the pull and runs the strobe pattern once. This also works with the app closed, as long as it is running in the background.

Both only work when the car is stationary in **P** and are turned off by default; switch them on in the app's settings. Use it only on private ground with nobody in front of the car.

### Tools

| App | Status | What it's for |
| --- | --- | --- |
| [**Phone Terminal**](apps/mgu_phone_terminal/README.md) | Stable | Opens a command console for the head unit in your phone's browser: scan the QR code, run commands, copy the output and download files. For experienced users only. |

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
