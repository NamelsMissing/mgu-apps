# Blitzer Status for iDrive 7

Blitzer Status receives the open and close events that iPhone Shortcuts sends for Blitzer.de. The MGU Store package starts with the head unit. Once enabled in Settings, the link and optional KOMBI status line work with the app window closed.

## Setup

1. If Custom Cluster is installed, update it to **0.6.11** or newer and restart the MGU before enabling the new link. Both versions of the bridge use TCP port 18977.
2. Install **Blitzer Status** from the `NamelsMissing/mgu-apps` source in MGU Store. The Store installs the phone port tool and checks for the cluster renderer.
3. In Blitzer Status settings, enable **iPhone Shortcuts bridge**. Enable the **status line** there if you want the indicator in the cluster map window. Both settings start off.
4. Connect the iPhone to CarPlay. When the app shows the phone port is open, copy the **Opened** link from the app or scan its QR code. In iPhone Shortcuts, create an **App** automation for **Blitzer.de → Is Opened → Run Immediately**. Add **Get Contents of URL** with that link and method **GET**.
5. Use **Show closed link** in Blitzer Status and repeat for **Is Closed**. If you already have both automations, replace their URLs. Blitzer Status saves its own token, so URLs from Custom Cluster need to be updated once.
6. Open Blitzer.de and then leave it. The last report and event count in Blitzer Status should update for both actions.

iOS sends the close event when Blitzer.de leaves the foreground, including when it keeps running in the background. The app shows the last event received and carries no warning data. The thin green (opened) or red (closed) line appears along the bottom of an already visible cluster map window, for example with Waze. The line disappears six hours after the last event. The indicator uses the same map position during a parked Custom Cluster test. It does not request the map slot or change BMW turn guidance.

## Diagnostics and build

- The listener waits for the CarPlay Wi-Fi address and retries every five seconds. The existing `mgu-cluster-net` tool opens TCP 18977 on `wlan_bridge` only while the app's loopback health check reports that the listener is up.
- `blitzer-status-background.json` in the app data directory records startup, whether the window was opened, and the current link and event status. Keep the QR links private because they include the token used to submit events.
- Build with the extracted BMW OAP SDK using `python3 tools/build_store_app.py blitzer_status`. Check autostart, iPhone reachability and KOMBI output on the vehicle after installation.
