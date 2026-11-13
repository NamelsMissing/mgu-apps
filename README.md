# MGU Apps for BMW iDrive 7

A collection of community-made apps for **BMW MGU (iDrive 7)** head units. Install and update them through **MGU Store**.

The apps are developed for an ID7-equipped BMW G21. Compatibility and available features can differ between vehicles, control units and software versions.

## App overview

### Stable apps

These apps are marked **Stable** by the project maintainer. This describes their release status, not a guarantee that every feature works on every vehicle.

| App | Status | What it does |
| --- | --- | --- |
| [**DPF Monitor**](apps/dpf_monitor/README.md) (`dpf_monitor`) | **Stable** | View live diesel particulate filter data, sensor readings and recorded regeneration history. Shows real ECU data only; starting a regeneration is not enabled. |
| [**Heating Comfort / AutoHeating**](apps/g21_wheelheat/README.md) (`g21_wheelheat`) | **Stable** | Automatically manage seat and steering-wheel heating based on temperature. Includes adjustable settings, manual controls and diagnostic logs. |
| [**GIF Home**](apps/gif_home/README.md) (`gif_home`) | **Stable** | Display animated GIFs in a large iDrive home-screen tile. Choose built-in animations or upload your own GIF using a phone and QR code. |
| [**MGU Phone Terminal**](apps/mgu_phone_terminal/README.md) (`mgu_phone_terminal`) | **Stable** | Open a temporary command console for the head unit in your phone browser. Connect by QR code, run commands, copy output and download files. |

### Experimental apps

These apps are **Experimental**. They are still being developed or tested, and some functions may be incomplete or vehicle-dependent.

| App | Status | What it does |
| --- | --- | --- |
| [**Ambient Lighting**](apps/g21_ambient/README.md) (`g21_ambient`) | **Experimental** | Choose ambient-light colors, configure lighting zones, save presets and test color changes. Applying custom colors to the car is not fully verified. |
| [**Custom Cluster**](apps/custom_cluster/README.md) (`custom_cluster`) | **Experimental** | Preview custom instrument-cluster layouts inspired by the G80, G21 and 6WB. Integration with the real cluster and Waze is still being tested. |
| [**GameStation**](apps/mgu_gamestation/README.md) (`mgu_gamestation`) | **Experimental** | Play offline retro games such as Pong and supported console games. Use the iDrive controller or phones as controllers. |
| [**GameSnacks**](apps/mgu_gamesnacks/README.md) (`mgu_gamesnacks`) | **Experimental** | Prototype for playing offline HTML5 games on the iDrive display. Game availability and compatibility are still under review. |
| [**Video Hub**](apps/mgu_video_hub/README.md) (`mgu_video_hub`) | **Experimental** | Play local videos and work with YouTube links. Playback requires additional software; online videos also need an internet connection. |
| [**Equalizer DSP**](apps/equalizer/README.md) (`equalizer`) | **Experimental** | Adjust audio with seven parametric EQ bands, gain, frequency, Q and saved presets. Stock CarPlay, radio and Bluetooth audio are not yet routed through the DSP. |
| [**Light Show**](apps/light_show/README.md) (`light_show`) | **Experimental · 0.3.2** | FLM02-only effects using up to 30 selectable LEDs, inline channel naming/testing, 200–3000-ms requested pulses, and guided parked-vehicle OEM dark-stage preparation (no automatic safety-light override). |

## Installation

You need a compatible, already-rooted BMW MGU head unit and a working MGU Store installation.

1. Open **MGU Store** on your head unit.
2. Add this GitHub source: **`NamelsMissing/mgu-apps`**.
3. Select the **`main`** branch and refresh the source.
4. Select an app and install it. Follow any prompts for required components.
5. Open the app's documentation above for setup instructions and known limitations.

**Updates:** Refresh the same source in MGU Store to check for new versions. The Store catalog is [`mgu-repo.json`](mgu-repo.json); each app's source and version are under [`apps/`](apps/).

For additional installation details, see [Store Installation](STORE_INSTALLATION.md).

## Important notes

- **Unofficial project:** Not affiliated with or endorsed by BMW.
- **Use while parked:** Set up, test and operate distracting functions only when the vehicle is safely parked. Never use experimental cluster or lighting controls while driving.
- **Vehicle controls:** A successful software command does not always confirm a physical action. Follow each app's compatibility and safety notes.
- **Phone Terminal:** It can execute commands with root privileges. Use it only on a trusted local network, never expose its HTTP port to the internet, and revoke access after use.
- **DPF Monitor:** Readings depend on the vehicle's ECU. The app does not provide an enabled forced-regeneration function.
- **Backups:** Keep a backup before changing head-unit software, and provide stable power during installation and testing.

## Developers and documentation

This repository contains app source code and build tools, not a public copy of BMW's proprietary SDK. MGU Store uses an SDK donor available on the head unit to build supported apps.

| Resource | Description |
| --- | --- |
| [App source](apps/) | Source files and individual app documentation |
| [Store catalog](mgu-repo.json) | Available components, dependencies and Store versions |
| [Installation guide](STORE_INSTALLATION.md) | MGU Store setup and update information |
| [Equalizer DSP notes](native/equalizer-dsp/README.md) | DSP design, audio routing and limitations |
| [ECU/PRG review](docs/ecu-prg-review-2026-11-03.md) | Technical diagnostic research |

**Privacy:** Do not upload BMW SDK files, diagnostic PRG files, SSH keys, VINs, personal data or diagnostic logs containing sensitive vehicle information.

---
**License and third-party components:** Refer to the license files and notices included with each app and dependency.
