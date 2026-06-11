# Iron Calibrator — Forward HIL Diagnostics

**Personal hobby project** — a browser-based mechatronics engineering game.

You are the engineering commander of an armored battalion at a forward operating base: damaged Main
Battle Tanks roll into your bay, you hook them to a Hardware-in-the-Loop terminal, re-derive the
turret stabilization PID loop, certify it, and prove the tune under live fire.

No frameworks, no build step — plain HTML/CSS/JS.

> **Play online:** after enabling GitHub Pages on this repo, the game is at  
> `https://mustafarkhan.github.io/iron-calibrator/`

## Run

Open `index.html` directly in a browser, or serve the folder:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Progress (gains, certifications, live-fire records) is saved in `localStorage`.

## The campaign

Three hulls, unlocked in sequence. Each has genuinely different plant physics, so a tune that
certifies one will not certify the next:

| Hull | Problem | What it teaches |
| --- | --- | --- |
| **VT4 — Hull 117** | Loop gains zeroed in a field repair | Basic P/D shaping: stiffness vs. damping |
| **T-80UD — Hull 203** | Worn race ring: double inertia, almost no friction | Damping ratio scales with Kd / 2√(Kp·J) — heavy Kd or it rings |
| **Al-Khalid I — Hull 044** | Derated drive + double terrain torque | Only integral action can null a sustained bias |

## Game loop

1. **HIL bench** — live turret simulation with manual slew commands, terrain disturbance, and a
   wargame auto-slew mode. Strip-chart telemetry shows gun vs. commanded azimuth. Unstable gains
   trip a safety clutch.
2. **Gain console** — Kp / Ki / Kd sliders plus underdamped and overdamped reference presets.
3. **Certification slew** — deterministic scripted pattern (0° → +60° → −30° over 10 s, terrain on)
   scored on overshoot, settling time (±4° band), rise time, and IAE. Ranks F through S. Passing
   unlocks the next hull.
4. **Live-fire exercise** — 60-second deployment: targets pop at random bearings, and a kill
   registers only if the gun holds within ±2° for 0.4 s before the target times out. Your tune does
   the shooting. Ratings: Unqualified / Qualified / Distinguished.

## The physics

Second-order rotational plant integrated at 240 Hz (live) / 500 Hz (certification):

```
u  = Kp·e + Ki·∫e dt − Kd·ω      (clamped to drive torque limit)
Jθ̈ = u + d(t) − b·ω
```

- Drive saturation is modeled, so large slews behave worse than linear theory predicts.
- The integrator uses conditional anti-windup (holds while the drive saturates in the same direction).
- Terrain disturbance is a deterministic multi-sine trunnion torque, so certification runs are fair
  and repeatable.
- Scoring constants were balanced numerically: stock and demo gains fail, careful tunes pass,
  near-optimal tunes reach rank S (≥ 80).

## Project structure

```
index.html      — screens: hangar, bay, field manual overlay
css/style.css   — flat military HUD theme
js/tanks.js     — hull roster: plant parameters, work orders, pass thresholds
js/sim.js       — physics core, certification runner, scoring/ranks
js/game.js      — game shell: rendering (canvas), wargame mode, persistence, UI wiring
```

## Roadmap (not yet in the game)

The original concept had three engineering bays; only **turret stabilization (PID)** is implemented
today. Likely next additions:

- **Hydraulic traverse** — pressure/flow puzzle for a stuck traverse drive
- **Fire-control bus** — CAN/LIN electrical diagnostics
- Sound (clutch trip, certification pass/fail, live-fire hits)
- Reset-progress control and save export/import
- Keyboard shortcuts for slew commands
- Automated sim tests in CI

## License

MIT — see [LICENSE](LICENSE).
