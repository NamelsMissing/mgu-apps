# Cluster Lyrics changelog

## 0.1.5

- The Waze footer uses a non-exclusive map layer with `contend=0` and
  `guide_hold=1`. In 0.1.4 every visible Lyrics layer sent `guide_hold=0`.
  Waze uses a content video layer on the same map target. The renderer combines
  the flags of wanting layers with logical AND, then uses the result for the
  separate stock CarPlay guidance slot. The footer therefore vetoed Waze's
  hold regardless of pixel geometry or which client started first.
- Song and settings updates reuse the footer layer. The renderer receives
  changed pixels and restores the cached layer after a reconnect. Lyrics
  releases its own layer when disabled. Waze retains its existing controls.
- At 75%, short footer lines use 38 px and 21 px (previously 30 px and 17 px).
  The saved 50–120% scale still applies to both layouts. Long lines use measured
  fitting, with wrapping for the current line and ellipsis as needed.
- The footer has 6 px vertical padding and 4 px between rows, with a measured
  height and a smaller badge for the note-only state.

The arbitration was checked against cluster-render 0.8.11
([`stack.cpp`](https://github.com/robertnisipeanu/idrive-apps/blob/53e9b38/native/cluster-render/src/stack.cpp)
and [`slots.cpp`](https://github.com/robertnisipeanu/idrive-apps/blob/53e9b38/native/cluster-render/src/slots.cpp)).
The map scene uses ID `0x010004f0`. The guidance hold targets the stock turn box
(content `0x01000310`, typically slot `0x105` or `0x103`). There is no
per-overlay neutral state for guidance when the overlay is the only layer
holding the map. See the README for that case.

### Vehicle checks pending

On a parked ID7 vehicle, check Lyrics alone, Waze alone and both together,
with and without active navigation. Start and end navigation during lyrics,
change songs during navigation, switch layouts in both directions and
disable each app separately. Check a restart with autostart and both startup
orders. Observe the original turn box, Waze map, flicker and restoration of
the stock display. Check short and long lines, accents, descenders and the
note-only badge at 50%, 75% and 120%, including the actual visible footer area.
