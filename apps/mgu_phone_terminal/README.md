# Phone Terminal — MGU/iDrive 7

Run temporary shell commands on an already-rooted head unit through a phone browser instead of connecting a Windows laptop over ENET/OBD.

## Installation

Select the **main branch** of `NamelsMissing/mgu-apps` in MGU Store, then install **Phone Terminal** (version 0.1.7) and update its required tool `mgu-phone-bridge` (version 0.1.6). This tool is a systemd service running as root, not a normal OAP app. It uses no SSH private key; it runs commands on the local MGU.

Open **Phone Terminal** on the head unit, press **New session**, and scan the QR code with the phone camera. A local website opens where a command can be submitted and stdout/stderr displayed. Use **Revoke access** on iDrive or **Disconnect** on the website when finished.

- **Clear command** clears only the shell input field, leaving the console output intact.
- **Copy output** copies the complete console history (including content outside the scroll area) to the phone's clipboard. On private HTTP connections where the modern Clipboard API is unavailable, the page uses a synchronous copy fallback; if the browser blocks both methods, it selects the output for manual copying.

### Downloading a file to the phone

1. Use the terminal to create or locate the file on the head unit. For example, an existing diagnostic archive may be `/tmp/carplay-audio-analysis.tgz`.
2. Under **Download a file from the MGU** on the phone page, enter its absolute path and press **Prepare download**.
3. Tap the resulting **Save filename** link. On iPhone, find the transferred file in the browser's Downloads or the Files app.

Downloads stream binary content without loading the whole file in memory. The authenticated, one-use URL contains no local filesystem path, expires after 60 seconds, and is invalidated by disconnect/revoke. Only regular files up to 256 MiB may be transferred. To transfer a folder, create a `.tgz` archive with a terminal command first. The downloaded file is not automatically deleted from the MGU.

## Security

- The in-car control interface is bound to `127.0.0.1:18891` and authenticated with an app-owned, mode-0600 key. The app creates the key in its own data directory on first start; the daemon can also provision it if the directory already exists. The daemon assigns the private file to the registered OAP user ID rather than blindly copying the data directory owner; root-owned legacy keys can be migrated safely. The daemon never accepts an unauthenticated request to provision a root-control key.
- Phone HTTP runs on port `18890` and is locked until the app creates a new QR token. QR pairing is one-time and expires after 3 minutes. The paired root terminal has no 15-minute timeout: access remains active until **Disconnect** on the phone, **Revoke Access** on iDrive, or a restart of the MGU/bridge service. The persistent HttpOnly browser cookie lasts up to one year (browser policies can clear cookies earlier), but the root session itself has no timed expiry and is held only in the bridge process's memory. It is invalid immediately after service restart or revocation.
- File downloads require the authenticated browser session plus a freshly prepared one-time link, and close immediately if the session is revoked. The server refuses directories, final-path symlinks and non-regular files and limits transfers to 256 MiB.
- The bridge's root service opens one tagged `nftables` accept rule only for TCP port `18890` on `wlan_bridge`, while pairing or a session is active. It checks the rule periodically and restores it after a BMW firewall reload. Revocation and service shutdown remove the rule; systemd also runs a best-effort final cleanup. The app does not show its QR until the rule is reported ready, and displays firewall errors instead of implying network readiness.
- The QR code's token is a URL fragment, not sent in HTTP requests. Login changes it into an HttpOnly, SameSite=Strict session cookie; requests require a matching browser origin.
- Only one noninteractive command may run at once. Each command is killed after 15 seconds or 60 KB of output. Revoking access also kills a running command.
- **Do not expose port 18890 to the internet.** Connections use local HTTP, not HTTPS; use a trusted private network. A scanned QR code is not proof that the iPhone can route to the MGU. Test CarPlay Wi-Fi Direct connectivity on your vehicle.
- **Only use when parked.** Incorrect root commands can brick or destabilize the head unit. No speed gating is implemented in the daemon.

## Known limitations

- The console is not an interactive SSH/PTY session: shell prompts, `vi`, interactive `top`, etc. are not supported.
- The current daemon locates app data from `/var/opt/public/oap/oap_12201/data/apps/mgu_phone_terminal.json`. Other firmware layouts may need adaptation.
- Older versions showed `App key setup: EACCES` on the vehicle, and subsequent versions displayed a QR but Safari/Firefox could not reach `172.16.222.97:18890`. The MGU Store's `172.16.222.97:8470` HTTP endpoint was reachable, confirming iPhone-to-head-unit routing; its JSON `not found` response was an application response, not a connection timeout. The missing input firewall rule is the likely reason for port `18890` timing out. Version 0.1.4/bridge 0.1.3 adds that rule and requires another on-car test.

## Sources and licenses

The app uses the shared `kit/` already in this repository (MIT). QR generation uses `qrcode-generator` (MIT); see `QR-LICENSE`. No BMW SDK, SSH key or car-specific data is committed.
