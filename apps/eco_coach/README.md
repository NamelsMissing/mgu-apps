# Eco Coach 0.1.0 — fuel analysis and consumption test (diesel and petrol)

Eco Coach analyses your driving for fuel. While you drive, it learns your car's own consumption by speed, gear, slope, outside temperature, engine warmth, driving mode and A/C. An **interactive consumption test** then finds out at which speed, in which gear and with which way of accelerating and rolling out **your** car uses the least fuel.

Built with the `cauliflowermossgrape/idrive7-apps` kit, installable through MGU Store. **Read only:** nothing is written, coded or actuated.

> **Status: experimental, not yet tested in the car.** The analysis, the test logic and the screens are covered by offline tests with a simulated car (`node tests/eco_coach.test.js`). The car paths are open: the fuel figure (see below), the slope from the acceleration sensor and the A/C field all still need checking in the vehicle.

## Pages

| Page | What it shows |
| --- | --- |
| **Live** | Eco score for this trip, consumption now (l/100 km, or l/h when standing) against your usual at this speed, coaching hints from your own figures (better gear, 120 instead of 140, idling, cold engine), your sweet spot. |
| **Trips** | The last trips with km, l/100 km, cost, score and outside temperature. The last trip's score is split into acceleration, anticipation, gear / rpm, idling and speed, with up to three concrete tips. |
| **Speed map** | Your consumption model as l/100 km over speed (level road, 15 °C, warm engine), the everyday median per 10 km/h, the test windows as dots, the sweet spot, and the most economical gear per speed band. |
| **Test** | The interactive consumption test: what to drive next, what is being measured, and which parts are done. |
| **Findings** | What each factor costs at 100 km/h (+10 km/h, 10 °C colder, 1 % uphill, cold engine, ECO PRO, Sport, A/C) and what your test showed (lower gear, acceleration, roll-out, ECO PRO vs Comfort, sweet spot). |

## The interactive consumption test

Start it **while parked** (Test page, or the *Start / stop consumption test* button). Then just drive. The app recognises each part by itself, so you **don't touch anything while driving**. Use the cruise control, and where you can, drive each speed in both directions on a quiet, level road. Only drive the test where that is legal and safe.

| Part | How it is recognised | Counts when |
| --- | --- | --- |
| Steady 50 / 70 / 90 / 110 / 130 (150) km/h, **own gear** | speed within ±4 km/h of the target, in D | 20 s (setting: 20/30/45 s) after 3 s settling: speed SD < 1.5 km/h, same gear, fuel figure every second, coolant ≥ 70 °C, slope within ±3 % |
| The same speeds **one gear lower** | the gear is one below the gear measured in D at that speed (M/S mode, paddles) | as above |
| 100 km/h in **ECO PRO** and in **Comfort** | driving-mode signal | as above |
| Accelerating 35 → 75 km/h: **gentle / medium / brisk** | start at ≤ 35 km/h, sorted by mean acceleration (< 1, 1–2, > 2 m/s²) | reaches 75 km/h with a fuel figure in ≥ 90 % of the seconds |
| Rolling out 95 → 65 km/h: **neutral / coasting** and **in gear** (fuel cut-off) | no pedal, slowing down; neutral = selector N or engine at idle speed while rolling | reaches 65 km/h without pedal or hard braking |

Every part is needed twice. Accelerations and roll-outs are compared **over the same distance**. The shorter runs get the missing distance added at a steady 75 or 65 km/h, using your own model. Otherwise "brisk" or "in gear" would look cheaper just because they cover less road.

## How the analysis works

- **Ticks:** once a second the app takes speed, acceleration, fuel flow, gear, selector, pedal, rpm, coolant, outside temperature, driving mode, slope and A/C. Each second is classified as idle, cruise, accel, coast, brake or transient.
- **Trips** run from engine start to 5 min after the engine stops. The score (0–100) adds up acceleration 30, anticipation 25, gear / rpm 25, idling 10 and speed 10. A cruise above 2000 rpm (diesel) or 2500 rpm (petrol) counts as high rpm.
- **Steady stretches** (cruise, same gear and mode, ±3 km/h, 8–20 s) become samples of the speed map. Up to 3000 everyday samples are kept, plus all test windows.
- **Consumption model** (`model.js`): l/h = base + speed + speed³ (air) + slope × speed + cold × (0.5 + speed) + cold engine + ECO PRO × speed + Sport × speed + A/C. It is fitted by weighted ridge least squares, with test windows weighted 3×. A factor only enters the model once enough samples show it both ways. The sweet spot is searched only within the speeds you actually drove (±10 km/h).
- **Slope:** the acceleration sensor feels the change of speed plus gravity along the car, so `(measured − dv/dt) / g`. If the car's sensor already removes gravity, the slope stays at 0 and the model leaves it out.

## Where the fuel figure comes from

1. **Car signal** `CDS2.statusInjectionVolume`: a 16-bit counter of injected fuel that the car sends on its own. Its scale is unknown, so it is **learned** from the engine unit (median of 10–30 ratios whose quartiles agree within 30 %) and kept in `data/eco_coach.json`.
2. **Engine unit** at 0x12 (DDE or DME; if it stays silent, one functional `01 0C` request finds it), read only:
   - OBD `01 5E` / UDS `22 F45E` engine fuel rate in l/h
   - OBD `01 9D` / UDS `22 F49D` OBFCM fuel rate in g/s, converted with the fuel's density

   It is polled about once a second only while the scale isn't learned yet, while the test runs, or with *Fuel figure: Engine unit only*. Otherwise it is checked every 10 s.
3. **No figure** means no consumption is shown. Nothing is estimated from rpm or torque.

**Fuel type** comes from OBD `01 51` (or the *Fuel* setting) and sets the density (diesel 0.832, petrol 0.745 kg/l), CO₂ (2.65 / 2.37 kg/l) and the high-rpm limit.

**To check in the car (G21 B47 first):**
- Does the DDE answer `01 5E` or `01 9D`? The log says which one, or `no fuel rate from the engine unit` with the raw replies.
- Does the injection counter run on the diesel, and does its learned scale agree?
- Is the slope near 0 on a level road in both directions?
- What does the first logged `A/C status` look like?

## Settings

*Fuel* (automatic / diesel / petrol) · *Fuel price per litre* · *Fuel figure* (car signal learned from the engine unit / engine unit only) · *Test: highest steady speed* (130 / 150) · *Test: steady window* (20 / 30 / 45 s) · *Coaching hints* · *Demo data* (when the car does not answer / on / off) · colour theme, layout, renderer.

**Demo data** is a simulated 1.75 t estate with an 8-speed automatic and a physical fuel model (rolling, air, climbing, inertia, an efficiency map, fuel cut-off, idling in neutral). It is marked **DEMO**, is never saved and never mixed with your data.

## Files

| File | Purpose |
| --- | --- |
| `main.js` | Signals, the fuel reference, trips, saving, the view |
| `model.js` | Classes, trips and score, steady stretches, consumption model, gear table |
| `testplan.js` | The interactive test and its findings |
| `fuel.js` | Fuel types, reference candidates, the learned injection counter |
| `decode.js` | Signal scalings and enums |
| `demo.js` | Simulated car and driver |
| `ui.js` | The five pages |

Data lives in `data/eco_coach.json` (trips, samples, test results, learned scale) and survives updates.
