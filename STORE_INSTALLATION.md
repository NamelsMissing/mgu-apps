# MGU Store installation — main branch

1. In MGU Store add `namelsmissing/mgu-apps`. Use a lowercase L after `name`. The public repository is available without GitHub sign-in.
2. Select **Branch → main**. Do not choose the historical `wheelheat-autostart-0.4.2-qa` branch.
3. Refresh the source and update `dpf_monitor` 0.2.7, `g21_ambient` 0.4.4 and `g21_wheelheat` 0.4.8.
4. WheelHeat's installed package already includes `mguAppStartType: autostart`; there is no separate USB patch or second source branch required.
5. Restart the MGU to test *process* autostart. Separately enable **Automatic heating on cold startup** in the app if it has never been enabled. Future normal updates preserve that choice and the other settings.

Autostart may depend on the MGU's app platform and installed deploy version. Check the MGU Store installation log and WheelHeat app log to verify process startup after a real head-unit restart.

**Important:** Physical heating duration while driving is not guaranteed by process autostart. The automatic 0x2E BDC command can now start and extend while driving if the speed signal and a fresh BDC read are valid, but the ECU may still reject those requests at speed. The command's timer field allows up to 255 seconds. Actual physical results require on-car validation. Manual writes still require standstill.

Offline checks (no BMW SDK):

```sh
node tests/g21_car_ui_smoke.test.js
node tests/wheelheat_live_gate.test.js
node --test tests/ambient_*.test.js tests/wheelheat_ui.test.js tests/controls.test.js
```

Settings are stored atomically in each installed app's stable `data/settings.json` with a local backup and should survive normal app restarts and Store updates. If the settings disappear again, inspect the application's log for `settings save failed` and the MGU Store update log for whether the app's data directory was retained.
