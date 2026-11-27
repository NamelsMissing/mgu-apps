# MGU Store installation — main branch

1. In MGU Store add `namelsmissing/mgu-apps`. Use a lowercase L after `name`. The public repository is available without GitHub sign-in.
2. Select **Branch → main**. Do not choose the historical `wheelheat-autostart-0.4.2-qa` branch.
3. Refresh the source and compare the installed versions with [the current catalog](mgu-repo.json). Examples on `main`: `dpf_monitor` **0.2.8**, `g21_ambient` **0.4.7**, `g21_wheelheat` **0.5.5**, and `light_show` **0.4.8**. These are **repository** versions; they do not establish what is installed on the head unit.
4. Heating Comfort declares `mguAppStartType: autostart` in its app manifest and uses the standard Store build wrapper. Custom Cluster, Cluster Lyrics and Light Flasher also declare autostart; this is package metadata, **not proof** that the installed process or its background actions actually run after an MGU restart. No separate WheelHeat USB patch or second source branch is required.
5. Restart the MGU to test *process* autostart. Separately enable **Automatic heating on cold startup** in the app if it has never been enabled. Future normal updates preserve that choice and the other settings.

Autostart may depend on the MGU's app platform and installed deploy version. Check the MGU Store installation log and WheelHeat app log to verify process startup after a real head-unit restart.

**Important:** Physical heating duration while driving is not guaranteed by process autostart. The automatic 0x2E BDC command can now start and extend while driving if the speed signal and a fresh BDC read are valid, but the ECU may still reject those requests at speed. The command's timer field allows up to 255 seconds. Actual physical results require on-car validation. Manual writes still require standstill.

Offline checks (no BMW SDK), for changes affecting those apps:

```sh
node tests/g21_car_ui_smoke.test.js
node tests/wheelheat_live_gate.test.js
node --test tests/ambient_*.test.js tests/wheelheat_ui.test.js tests/controls.test.js
```

Settings are stored atomically in each installed app's stable `data/settings.json` with a local backup and should survive normal app restarts and Store updates. If the settings disappear again, inspect the application's log for `settings save failed` and the MGU Store update log for whether the app's data directory was retained.

**Moved app:** Blitzer Status and its `mgu-cluster-net` phone-port tool are now in [mgu-apps-beta](https://github.com/NamelsMissing/mgu-apps-beta). Refresh and install from that source; keep the existing app ID and replace the iPhone Shortcuts URLs if migrating from Custom Cluster.

**Documentation and release hygiene:** Check `mgu-repo.json`, the app's `app.json` and the corresponding `native/*/component.json` together before announcing a new version. Update the top-level [README](README.md) and the affected app README with the verified feature and test status. Do not claim a physical vehicle test or increment a version solely because documentation was refreshed.
