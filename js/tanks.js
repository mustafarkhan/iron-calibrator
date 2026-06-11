/* Tank roster — three engineering bays per hull with distinct plant physics. */

window.DEFAULT_GAINS = { kp: 8, ki: 0, kd: 0 };

window.GAIN_PRESETS = {
  stock: { kp: 8, ki: 0, kd: 0 },
  under: { kp: 20, ki: 2, kd: 1 },
  over: { kp: 6, ki: 1, kd: 10 },
};

window.HYDRO_PRESETS = {
  stock: { pump: 70, relief: 120, flow: 0.35 },
  sluggish: { pump: 85, relief: 130, flow: 0.25 },
  aggressive: { pump: 110, relief: 170, flow: 0.85 },
};

window.SUBSYSTEMS = [
  { id: "pid", label: "Stabilizer PID", short: "PID" },
  { id: "hydro", label: "Hydraulic traverse", short: "HYD" },
  { id: "bus", label: "Fire-control bus", short: "CAN" },
];

window.TANKS = [
  {
    id: "vt4",
    name: "VT4 — Hull 117",
    klass: "MBT-3000 series",
    plant: { J: 1.0, b: 0.8, maxT: 500, dist: 22 },
    passScore: 60,
    iae0: 60,
    fault:
      "EFCS stabilizer board was swapped in the field and all loop gains were zeroed. The gun drifts " +
      "off the aim point whenever the hull moves. Re-derive P, I and D from scratch and certify the loop.",
    hint:
      "Raise Kp until the slew is brisk, then add Kd until the overshoot dies. Finish with enough Ki " +
      "to hold zero error under terrain torque.",
    hydroFault:
      "Traverse actuator is sluggish: the relief valve was left cracked at field pressure. Pump builds " +
      "pressure then dumps it — the turret barely moves. Raise relief crack pressure above working line " +
      "pressure, then tune pump and flow gain.",
    hydroHint:
      "Relief below ~150 bar vents your pump dry. Set relief just under burst margin (~155–165), then " +
      "raise pump until pressure holds under slew without pegging the gauge.",
    hydro: {
      inertia: 0.85,
      friction: 2.2,
      damp: 0.55,
      actGain: 20,
      maxFlow: 3.6,
      nominalP: 110,
      burst: 180,
      safeP: 168,
      compK: 18,
      flowR: 0.28,
      reliefK: 2.8,
      leak: 0.28,
      maxPumpRate: 90,
      passScore: 55,
      iae0: 130,
    },
    hydroDefault: { pump: 70, relief: 120, flow: 0.35 },
    busFault:
      "Post-repair CAN scan shows the stabilizer ECU answering on the wrong address after the board " +
      "swap. Gunner display and LRF are clean, but the FCS will not arm until every node ACKs on spec.",
    busHint: "Stabilizer ECU must be 0x10. Enable 120 Ω termination at both physical bus ends.",
    bus: { passScore: 60, nearInternal: false, farInternal: false },
    busDefault: { stab: 0x11, hydro: 0x20, gunner: 0x30, lrf: 0x40, termNear: true, termFar: true },
    wargame: { targetLife: 5.0, distMul: 1.1 },
  },
  {
    id: "t80",
    name: "T-80UD — Hull 203",
    klass: "Object 478B",
    plant: { J: 1.9, b: 0.35, maxT: 460, dist: 32 },
    passScore: 55,
    iae0: 80,
    fault:
      "Worn traverse race ring: turret inertia is nearly double spec and natural friction is gone. " +
      "The loop that certified on Hull 117 rings violently here. Expect to need much heavier derivative damping.",
    hint:
      "Damping ratio scales with Kd / (2·\u221AKp\u00B7J). With J this high and b this low, push Kd toward the " +
      "top of its range before chasing speed.",
    hydroFault:
      "Battle damage opened a return-line leak on the hydro pack. Pressure bleeds off under load — you " +
      "need higher pump command and moderate flow gain or the traverse hunts.",
    hydroHint:
      "High leak means pressure collapses during fast slews. Pump up, keep flow gain moderate (~0.45–0.55) " +
      "so you do not oscillate the spool valve.",
    hydro: {
      inertia: 1.2,
      friction: 1.6,
      damp: 0.6,
      actGain: 16,
      maxFlow: 2.8,
      nominalP: 115,
      burst: 175,
      safeP: 162,
      compK: 16,
      flowR: 0.32,
      reliefK: 2.5,
      leak: 0.75,
      maxPumpRate: 85,
      passScore: 52,
      iae0: 145,
    },
    hydroDefault: { pump: 80, relief: 150, flow: 0.7 },
    busFault:
      "Intermittent frame errors on the gunner display — classic missing far-end termination. Near-end " +
      "terminator is present; the far end of the harness was never re-installed after track swap.",
    busHint: "Enable termination on the far bus end. IDs are correct — fix the physical layer first.",
    bus: { passScore: 55, nearInternal: false, farInternal: false },
    busDefault: { stab: 0x10, hydro: 0x20, gunner: 0x30, lrf: 0x40, termNear: true, termFar: false },
    wargame: { targetLife: 5.5, distMul: 1.15 },
  },
  {
    id: "alkhalid",
    name: "Al-Khalid I — Hull 044",
    klass: "MBT-2000 derivative",
    plant: { J: 1.3, b: 0.55, maxT: 400, dist: 45 },
    passScore: 60,
    iae0: 70,
    fault:
      "Tasked to the wadi sector: terrain torque on the trunnion is double anything in the wargame so " +
      "far, and the traverse drive is derated to 80% torque. Pure PD will sit off-target — integral action is mandatory.",
    hint:
      "Watch the steady-state error with terrain on. Only Ki can null a sustained torque bias, but too much of it reintroduces overshoot.",
    hydroFault:
      "Wadi grit clogged the traverse filter — max flow is capped and the pump hits relief early. You must " +
      "balance lower flow demand with enough pressure headroom; slamming flow gain pegs the gauge.",
    hydroHint:
      "Clogged filter = lower max flow. Use gentler flow gain (~0.4) and higher pump setpoint. Watch max " +
      "pressure during certification — bursting the line fails instantly.",
    hydro: {
      inertia: 1.0,
      friction: 2.0,
      damp: 0.5,
      actGain: 18,
      maxFlow: 2.0,
      nominalP: 108,
      burst: 170,
      safeP: 158,
      compK: 17,
      flowR: 0.3,
      reliefK: 2.6,
      leak: 0.38,
      maxPumpRate: 80,
      passScore: 55,
      iae0: 135,
    },
    hydroDefault: { pump: 100, relief: 152, flow: 0.72 },
    busFault:
      "LRF module was RFI-retagged to 0x41 during ECM trials and the near-end terminator was removed " +
      "for a field laptop tap. Restore 0x40 and both terminators before the FCS will accept a fire solution.",
    busHint: "LRF = 0x40. Both near and far termination must be ON for a clean bus on this hull.",
    bus: { passScore: 60, nearInternal: false, farInternal: false },
    busDefault: { stab: 0x10, hydro: 0x20, gunner: 0x30, lrf: 0x41, termNear: false, termFar: true },
    wargame: { targetLife: 5.0, distMul: 1.25 },
  },
];
