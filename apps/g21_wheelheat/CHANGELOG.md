# Heating Comfort changelog

## 0.5.6

- Fix: AutoHeat could never start after an `ENTRY_POINT` process start. The new-cycle and resume paths required `startReason === 'AUTOSTART'`, but the MGU also starts autostart apps with `ENTRY_POINT` (the runtime then opens the last entry itself, which is why the log showed `UI OPEN` one second after the process start). The start reason is now diagnostic only.
- Fix: a blocked ON no longer consumes a persisted vehicle OFF timestamp.
- New cycle evidence that does not need an observed OFF: a drive-ready heartbeat (persisted at most once a minute) compared with the MGU boot time (`os.uptime`). If the last drive-ready heartbeat lies before the MGU boot, the MGU was down for at least 2 minutes, and the MGU booted no more than 15 minutes before the first drive-ready signal, the parked time is measured from that heartbeat. Without uptime, an AUTOSTART process can use the same gap against its own start time.
- An OFF (Wohnen) that is first seen right after an MGU wake is measured from the last drive-ready heartbeat, not from the wake.
- An unknown cycle is re-evaluated every second. A new VehicleCondition event is no longer required.
- Same journey: an MGU or app restart during a drive, start-stop and readiness 12 → 10 do not start heating again. The original two-minute start window can still be resumed after a restart, without the AUTOSTART requirement.
- Diagnostics: a new *start conditions* view (Diagnostics → AutoHeat status → Start conditions) shows real values for service, enable switch, ignition, temperature, ECU, cycle state, evidence, missing evidence, MGU uptime, last OFF/ON, calculated OFF time, cycle ID, last confirmed heating, each heater and the final blocking reason. **Evaluate AutoHeat now** re-evaluates immediately and writes the full block to the log without bypassing any guard. Changes are logged as `START CONDITIONS` and `CYCLE CHECK` only when they change.
- Legacy and corrupt journals: invalid fields are discarded and reported, and timestamps in the future are ignored. A 0.5.5 journal with an observed OFF still works. The heartbeat-based evidence needs one drive with 0.5.6 first.

## 0.5.5

- Use the last observed vehicle OFF and a drive-ready report to assign an unattended startup to a new session. Resume an eligible existing session only within its original start window.
- Persist write reservations and readback confirmations separately for each heater. Retry transient failures with bounded delays and give manual changes precedence.
- Start the background service before RHMI settings and entry-point initialization finish. Add AutoHeat status and live-log filters.
