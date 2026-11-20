# Light Flasher 0.1.14

## 0.1.16 – Manual cleanup recovery (candidate)

If LOCKED appears after a run, park securely in P on private property, switch OEM high beam OFF and select **Restore normal lights (P)**. No new flash pattern is started. Recovery validates both FLM identities, attempts STOP and return to default diagnostic session, then checks CH8 OFF (0% / 0 mA) on both sides. Only confirmed replies and current parked/OEM-off signals permit removing the pending marker. If STOP is rejected (including an already expired routine), a timeout occurs, or readback fails, the lock remains: inspect the automatically exported recovery log and seek service if needed. Electrical readback is not optical restoration proof. The speed/P guard is restored; a successful final STOP retry supersedes an earlier failed STOP. Vehicle validation is pending.

## 0.1.14 – Test option: fast mode

New setting "Test: fast mode (no 150 ms gap, PWM 0 instead of STOP between pulses)", default OFF; applies to button and lever runs. Background: BimmerLight uses the same FLM_KANAL routine; its shorter intervals come mainly from a direct adapter connection and from sending STOP only at the end. Our 512 ms START gap at 100 ms requested consists of START and STOP round trips over TASU plus the fixed 150 ms dark gap.

In fast mode a side is switched off by restarting FLM_KANAL with PWM 0 (`31 01 A5 4B 08 00 01`) instead of `31 02 A5 4B`, and the fixed 150 ms gap is dropped. The first OFF per side is read back via D6DB; unless channel 8 shows 0 % / 0 mA the run stops immediately with STOP and default session ("fast test unusable"). Rejected PWM-0 or ON restarts (e.g. NRC 0x22/0x24 while the routine is running) also stop the run. Unchanged: ECU timeout 1 s per command, identity and high-beam-OFF preflight, P/stationary/OEM-off guard, final STOP + `10 01` on every touched side, cleanup lock. The diagnostics page shows whether PWM 0 was confirmed as OFF per side and the mean ON/OFF reply times; the JSON contains `fastTest` and `timing.pwm0OffResponses`. Expected: roughly 200–250 ms per change (estimate); 100 ms is not reachable over TASU. Not yet tested in the vehicle; compare the START gap with fast mode off and on.


## 0.1.13 – Lever trigger also with the app closed (autostart)

New setting "Lever trigger also with app closed (autostart, P only)", default OFF; it additionally requires manual parked flash and the lever trigger from 0.1.12. The autostart process of the app then evaluates the short lever pull even if the Light Flasher menu is closed or another screen is shown. The flash runs with the full guard: stationary, P, fresh OEM high beam OFF, FLM identity and channel-8 OFF preflight, STOP and default session, cleanup lock. Changing screens does not cancel such a run; loss of P/stationary, OEM beam ON, disabling a setting, opening the Light Flasher diagnostics page or shutdown cancels it. Not active while the diagnostics page is open. Each run writes the usual automatic JSON log with source "lever" and background=true. light-flasher-background.json now additionally contains the lever state, triggers, ignored pulses and recent events, so background behavior can be checked over SSH without opening the app.

Prerequisite: the autostart process must actually be running in the vehicle; this is still unconfirmed (see 0.1.8). If the lever does nothing with the app closed, check light-flasher-background.json first (startedAt, startReason, lever.state).

## 0.1.12 – Short lever pull starts the pattern (P only)

New setting "Start pattern by short lever flash (P only)", default OFF; it also requires "Enable manual parked flash". With the vehicle stationary in P and the Light Flasher main screen open, a short OEM flash pull on the lever starts ONE run of the saved pattern through exactly the same guarded path as the Start button (FLM identity and D6DB channel-8 OFF preflight, P/stationary/OEM-off guard during the run, STOP and default session on every side, cleanup lock).

Detection uses only the already subscribed combined signal statusMainBeam_headlightFlasher, which cannot distinguish a flash pull from switching high beam on. A pulse therefore counts only if OEM beam was OFF for at least 1 s, the ON phase lasted at most 1.5 s, and OFF then persists for 0.4 s; the run starts after release, never while the OEM beam is on. Longer ON (steady high beam), a second pull before settling, stale or unknown status, guard loss, leaving the main screen, another operation or a cleanup lock reset the detector. After any run (lever or button) a 5 s cooldown applies. A very short tap of the high-beam push may also count; the effect is the same parked one-shot run. Not active while driving, in the background or with the menu closed; the passive background monitor is unchanged and still sends nothing. The main screen shows the lever state; the diagnostic JSON and every automatic run log include the detector state, the triggering source (button/lever) and the measured pulse length. The thresholds are not yet verified in the vehicle: please record whether short pulls are recognised and whether steady high beam is reliably ignored.


## 0.1.11 – Compact UI and return status

Only two screens remain: flash control and combined read-only diagnostics. Requested intervals below 100 ms are removed, including the old transport experiment menu; persisted retired choices are migrated to 100 ms. The diagnostic page combines connection/background information, latest timing, acknowledged STOP/default-session status, stalk recording, FLM readback and full JSON export. Raw request history and automatic versioned flash logs remain. A successful vehicle test on 0.1.10 recorded ten positive START/STOP pairs and two positive default-session replies, 512 ms mean actual START gap at the 100 ms requested setting. The user also reported normal optical operation and lights returning to normal after that test. This verifies a normal-path run only, not physical restoration under loss of communication. The new release summary distinguishes diagnostic acknowledgements from physical restoration. The existing actuator sequence, cleanup and guard remain unchanged; all active tests remain parked-only. Passive observation remains independent of gear/speed.



## 0.1.10 – Automatic unique flash attempt logs

After an explicit Start flash pattern attempt completes, fails, is blocked or redirects to transport testing, a versioned timestamp/PID/attempt-number JSON file is automatically saved in the existing app data directory. The main menu displays the full saved path or a write error. No extra Save action is needed. The file records the requested settings, outcome/error and fresh actuator trace if a new run actually started. Old traces are not attributed to blocked attempts. Normal diagnostic export remains available. A process crash/power loss before the save completes may prevent an export; the existing cleanup marker is unchanged. No actuation or guard changes.



## 0.1.9 – Real timing instrumentation and passive driving observation

The supplied FLM02_L/R PRGs describe the existing FLM_KANAL activation time in seconds and the LED function test has a result definition, not a documented programmable millisecond sequence. No supported fast autonomous flash pattern or safe OEM override has been established. The 0.1.8 vehicle transport samples: 20–150 ms second request rejected; 200/300/500 ms one successful pair each, after the first ECU reply. Neither stable 200 ms nor optical timing has been established.

Manual parked testing now records per-request elapsed time and actual successive acknowledged START dispatch gaps. The UI and diagnostic JSON report minimum, maximum and mean host-side timings; none measure physical light timing. The existing acknowledged actuation, one-second ECU deadline, fixed inter-step gap, park/OEM-off guard and cleanup are unchanged. Choosing a sub-100 ms interval and pressing Start directs the user to the real read-only transport test in P; it never sends lamp commands automatically. Passive monitoring observes fresh BMW light status independently of vehicle speed and gear with the existing provider availability check. No background UDS requests or actuator commands; no flashing while driving. No suppression.



## 0.1.8 – Repeatable read-only transport tests and autostart evidence

The transport menu now selects the test interval directly, independent of flash settings. A run number, current selection and newest result first distinguish old results from new ones. A bounded 20–500 ms series runs at most nine pairs of identity reads with a 750 ms pause after each drained pair; it stops on cancellation or an unresolved accepted request. No lamp commands or retries are added. The observed 20 ms vehicle test was rejected at the transport layer for the second module, not by the right ECU itself. No assumption is made about higher intervals.

The existing autostart OAP process writes a small atomic light-flasher-background.json in its dataDir at startup and when passive monitor state changes, even if its menu is unopened. The file includes start time/reason, PID, first menu opening and observed status changes; inspect it over SSH before opening the app and compare its timestamps with the restart. There is no distinct daemon, and vehicle autostart is not yet confirmed. No background TASU requests or actuator commands. The file is local only. Manual flash path and OEM suppression readiness are unchanged.



## 0.1.7 – Real transport experiment, no preview menu

Select the requested interval and open TASU transport test. In P with diagnostics enabled, the test issues exactly two read-only identity requests to the two FLMs, dispatching the second without waiting for the first method verdict or ECU response. No retries, no actuator requests, no session change. A finite drain waits for replies and records actual dispatch gap, separate transport verdict times and ECU response times, busy/error events and matched identities. Tests may be affected by other diagnostic apps sharing TASU; stop their diagnostic operations first. Save diagnostic JSON. Two accepted requests do not establish safe repeated actuator sequencing or precise optical timing. Physical lamp control still uses the existing guarded acknowledged path; sub-100 ms settings are real transport tests, not lamp timing. The text preview is removed. Autostart remains passive.



## 0.1.6 – Autostart passive monitor and simulation timings

MGU Store builds now carry mguAppStartType=autostart in both archives using the existing scoped startup packaging helper. This starts the OAP app process, not a separate systemd service, without requiring the menu to be opened (actual vehicle boot behavior still needs verification). Background status monitor is enabled by default and can be switched off. It observes the already subscribed combined OEM light status only while the existing stationary/P guard is valid; no background UDS reads, no automatic flash trigger, no changes to vehicle lights. The combined signal still cannot distinguish a lever pull from sustained high beam. The JSON export includes app start reason, start time, first visible MAIN time and bounded status-transition samples. The status line shows observations before first opening; zero observations alone does not establish that autostart failed. No radio button action is implemented.

Existing 20/40/60/80 ms choices are newly available for text simulation only. Physical tests reject these settings rather than silently clamp them. Existing 100 ms and above remain requested intervals, not guaranteed physical timing; serialized TASU requests and mandatory STOP/cleanup prevent accurate sub-100 ms actuation. No change to physical actuation behavior, foreground guard or OEM suppression readiness.



## 0.1.5 – Manual pattern uses saved settings

Start flash pattern uses the same persisted pattern, interval and hold keys as the preview; the existing hold value is now the manual flash duration (2–5 seconds). Preview pattern -> Flash pattern; Preview step interval -> Requested step interval; Preview hold threshold -> Flash duration. Both use a common configuration validator. Alternate, double, triple and both are supported; each pulse is bounded by the existing one-second ECU timer. Starts are serialized, STOP precedes the next step and at least a requested 150 ms dark gap is inserted. The interval is a requested minimum step time, not guaranteed physical flash timing. Both sides are not exactly simultaneous. New starts cease at the duration deadline, cleanup may run longer. A preflight reads both channel-8 PWM/current values and requires both OFF. A persistent marker prevents further manual tests after unconfirmed cleanup or interrupted execution. No activation on launch/bookmark, no movement, no suppression of OEM lights, no zero PWM. Use only in P on private property away from other people. No change to Light Show.



## Manual flash (parked one-shot)

Enable manual parked flash in settings (default OFF). With the vehicle securely parked in P, on private property with a clear area in front, keep OEM high beam OFF. Select Flash once on the main screen. The app checks current vehicle speed, P, fresh OEM-off signal and both FLM identities. One short sequential channel-8 pulse per side at 60% uses the existing 1-second ECU routine; STOP and default session are attempted on each side, even on error/cancel. Stop, leaving screen, guard loss and shutdown cancel subsequent starts. Unconfirmed cleanup blocks another run in the same app instance. No zero PWM, OEM suppression, automatic launch/lever trigger, recurring pulses or road use. Physical timing and restoration have not been tested for this app.

The kit marks its app entry point bookmarkable but maps it to the main screen; a favorite button may open Light Flasher (vehicle support unverified). It does not automatically flash. Diagnostics still use read-only requests; manual mode is separate and shares the existing TASU connection.



## 0.1.3 – Verified electrical feedback; OEM priority remains unknown

D6DB decoding uses 15 x 5-byte records: PWM (%), big-endian unsigned current (mA), voltage (V), phase. The latest consistent OFF/ON/OFF vehicle series confirms channel 8 on each side goes 0%/0 mA -> 100%/1000 mA -> 0%/0 mA, while channel 7 remains at 100%. A voltage value of 1 V was observed on one side after switch-off; zero current is not identical to zero voltage. D6DB responses took 269–301 ms (eight reads, mean 290.75 ms). D9FC remained identical. The earlier BDC timeout is separate from the successful FLM reads.

Both original FLM02 PRGs define a timed channel routine and PWM parameter, but do not document arbitration against a normal high-beam request, the effect of zero PWM on that request, or physical restoration after stop/timeout. Existing Light Show deliberately excludes zero PWM. The diagnostic PRG is not ECU firmware. Positive UDS acknowledgment does not demonstrate physical output or restoration. No change to the actuator whitelist or any live suppression control is made. Further authority/restoration validation belongs on an isolated, non-road bench with manufacturer documentation and independent observation. Readback and readiness flags are now included in the log; those flags cannot be changed via settings.



## 0.1.2 – Read-only FLM feedback investigation

Offline inspection of both supplied FLM02 PRGs identifies FLM_KANAL_ERGEBNISSE (D6DB), FLM_FUNKTION_LICHTVERTEILUNG_ERGEBNISSE (D7A7) and FLM_ZUORDNUNG_SENSOREN_KANAELE (D9FC). D6DB includes channel PWM, current and voltage fields; it may reflect diagnostic routine results rather than live OEM output. D7A7 reports function-related feedback. No physical suppression authority or live measurement is assumed. FLM_KANAL has a PWM argument and seconds duration, but a PWM value of zero is not verified to override normal lighting. No suppression or write commands are implemented.

Diagnostics > FLM02 feedback: compare OFF / steady OEM high beam ON / OFF again using the normal vehicle controls in P on private property. Verify both FLM identities before reading the three DIDs on each side. Raw replies and errors, combined status before/after, and per-result timestamps are saved to the normal JSON export. Only service 22 is sent; no session changes, actuator routines or coding.



## 0.1.1 – Explicit connection preflight

The new Check BDC connection button checks F150 identity and reads E3B8 once. Start first runs the same check and begins the 60-second timer only after both succeed. The display distinguishes disabled mode, park guard, TASU unavailable, identity failure, and E3B8 failure. Errors remain visible, and a saved JSON report includes request/response bytes, timings and transport errors even if preflight fails. No new diagnostic services or actuator control are introduced.



Separate experimental ID7 app. **Read-only diagnostics and simulated pattern preview only.** Prior versions had no live flash actuator; current manual parked mode is described above. No lever-triggered effect or background control. The Enable setting controls diagnostic recording.

## Candidate stalk signal

Offline inspection of the supplied BDC_G05 PRG reveals LENKSTOCK_BLINKER / DID E3B8 / RES_0xE3B8_D and separate STAT_FERNLICHT and STAT_LICHTHUPE result descriptions. The response byte/bit mapping is NOT verified. The app reads ECU identity F150 and then E3B8 from BDC address 0x40 in the existing session, with no session changes or actuator commands. Combined Vehicle2 statusMainBeam_headlightFlasher is recorded separately; previous vehicle logs showed it cannot distinguish the two actions. No private diagnostic logs or BMW PRG files are bundled.

Park securely in P on private property, enable diagnostics, start capture, mark neutral, pull/release briefly, pull/release for over three seconds, push for continuous high beam and release lever, then turn high beam off. Mark the transitions, stop/save. Capture is bounded to 60 seconds / 300 events, stops on leaving the page or losing stationary state; read requests serialized and spaced at least 750 ms between starts. Export: app data directory/light-flasher-diagnostics.json. No promise of 100 ms ECU actuation; preview is text only.

Pattern, speed and hold threshold are saved settings for simulation. Original vehicle lights remain under OEM control. Light Show is unchanged.
