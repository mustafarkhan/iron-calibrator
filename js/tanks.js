/* Tank roster — plant physics validated numerically so each hull demands a different tune. */

window.DEFAULT_GAINS = { kp: 8, ki: 0, kd: 0 };

window.GAIN_PRESETS = {
  stock: { kp: 8, ki: 0, kd: 0 },
  under: { kp: 20, ki: 2, kd: 1 },
  over: { kp: 6, ki: 1, kd: 10 },
};

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
      "The loop that certified on Hull 117 rings violently here. Expect to need much heavier " +
      "derivative damping.",
    hint:
      "Damping ratio scales with Kd / (2·\u221AKp\u00B7J). With J this high and b this low, push Kd toward the " +
      "top of its range before chasing speed.",
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
      "far, and the traverse drive is derated to 80% torque. Pure PD will sit off-target — integral " +
      "action is mandatory.",
    hint:
      "Watch the steady-state error with terrain on. Only Ki can null a sustained torque bias, but too " +
      "much of it reintroduces overshoot.",
    wargame: { targetLife: 5.0, distMul: 1.25 },
  },
];
