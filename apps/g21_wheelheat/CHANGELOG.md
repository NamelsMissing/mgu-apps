# Heating Comfort changelog

## 0.5.5

- Use the last observed vehicle OFF and a drive-ready report to assign an unattended startup to a new session. Resume an eligible existing session only within its original start window.
- Persist write reservations and readback confirmations separately for each heater. Retry transient failures with bounded delays and give manual changes precedence.
- Start the background service before RHMI settings and entry-point initialization finish. Add AutoHeat status and live-log filters.
