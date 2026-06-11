# Iron Calibrator — Forward HIL Diagnostics

**Personal hobby project** — a browser-based mechatronics engineering game.

You are the engineering commander of an armored battalion at a forward operating base. Damaged MBTs roll into your bay; you hook each hull to a Hardware-in-the-Loop terminal and certify **three subsystems** before redeploying to the wargame.

No frameworks, no build step — plain HTML/CSS/JS.

**Play online:** [mustafarkhan.github.io/iron-calibrator](https://mustafarkhan.github.io/iron-calibrator/)

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Progress is saved in `localStorage`. Export/import and reset are available from the hangar.

## The three engineering bays

Each hull must pass all three before it is **combat ready** and the live-fire lane unlocks.

| Bay | Mechanic | What you learn |
| --- | --- | --- |
| **Stabilizer PID** | Tune Kp, Ki, Kd on a live turret plant with terrain torque | Control theory — damping, overshoot, integral bias rejection |
| **Hydraulic traverse** | Set pump pressure, relief crack, and flow gain | Fluid power — pressure/flow limits, relief venting, actuator response |
| **Fire-control CAN bus** | Fix node IDs and 120 Ω termination | Automotive Ethernet basics — addressing and physical-layer reflections |

## Campaign

Three hulls, unlocked in sequence when the previous hull is fully combat ready:

| Hull | PID challenge | Hydro challenge | Bus challenge |
| --- | --- | --- | --- |
| **VT4 — Hull 117** | Zeroed gains after field board swap | Relief valve cracked too low — pump vents dry | Stabilizer ECU on wrong address (0x11) |
| **T-80UD — Hull 203** | Double inertia, low friction — rings without heavy Kd | Return-line leak — pressure collapses under slew | Missing far-end termination |
| **Al-Khalid I — Hull 044** | Derated drive + heavy terrain torque — Ki required | Clogged filter caps max flow | LRF on 0x41, near terminator removed |

## Game loop

1. **HIL bench** — live simulation with manual slew, telemetry scopes, and subsystem-specific readouts.
2. **Certification** — scored test per bay (PID slew pattern, hydraulic pressure/position profile, CAN diagnostic sweep).
3. **Live-fire exercise** — 60-second deployment after all three bays pass; kills require holding ±2° for 0.4 s.

Keyboard: **1/2/3** switch bays · **Q/E** slew ±15° · **Space** certify · **Esc** hangar

## Project structure

```
index.html      — hangar, three bay panels, tutorial, field manual
css/style.css   — military HUD theme
js/tanks.js     — hull roster and per-subsystem fault data
js/sim.js       — PID plant, certification, ranking
js/hydro.js     — hydraulic circuit simulation
js/bus.js       — CAN node/termination diagnostics
js/sound.js     — procedural Web Audio UI sounds
js/game.js      — rendering, progression, persistence, wargame
```

## License

MIT — see [LICENSE](LICENSE).
