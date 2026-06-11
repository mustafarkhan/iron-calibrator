/* Fire-control CAN bus — node addressing and termination diagnostics. */

window.BUS = (function () {
  const NODES = [
    { key: "stab", label: "Stabilizer ECU", correct: 0x10 },
    { key: "hydro", label: "Traverse hydraulic controller", correct: 0x20 },
    { key: "gunner", label: "Gunner display", correct: 0x30 },
    { key: "lrf", label: "Laser rangefinder", correct: 0x40 },
  ];

  const ID_OPTIONS = [0x08, 0x10, 0x11, 0x18, 0x20, 0x21, 0x30, 0x40, 0x41];

  const DEFAULT = {
    stab: 0x10,
    hydro: 0x20,
    gunner: 0x30,
    lrf: 0x40,
    termNear: true,
    termFar: true,
  };

  function cloneDefault() {
    return Object.assign({}, DEFAULT);
  }

  /* Bus health: correct IDs + both terminators present (unless plant says one end is internal). */
  function evaluate(tank, cfg) {
    const fault = tank.bus;
    let ack = 0;
    let errors = 0;
    const log = [];

    NODES.forEach((n) => {
      const set = cfg[n.key];
      const ok = set === n.correct;
      if (ok) ack++;
      else errors++;
      log.push({
        node: n.label,
        id: "0x" + set.toString(16).toUpperCase().padStart(2, "0"),
        ok: ok,
        expect: "0x" + n.correct.toString(16).toUpperCase().padStart(2, "0"),
      });
    });

    const termOk =
      (cfg.termNear || fault.nearInternal) && (cfg.termFar || fault.farInternal);
    if (!termOk) errors += 2;

    const reflections = !termOk ? Math.round(8 + Math.random() * 12) : 0;
    const score = Math.max(
      0,
      Math.round(100 - (4 - ack) * 18 - (termOk ? 0 : 28) - reflections * 1.5)
    );

    return {
      ack: ack,
      total: NODES.length,
      termOk: termOk,
      reflections: reflections,
      errors: errors,
      score: score,
      pass: ack === NODES.length && termOk && score >= fault.passScore,
      log: log,
    };
  }

  function runCertification(tank, cfg) {
    return evaluate(tank, cfg);
  }

  function rankFor(score) {
    if (score >= 90) return { rank: "S", label: "Clean bus — zero errors" };
    if (score >= 75) return { rank: "A", label: "All nodes responding" };
    if (score >= 60) return { rank: "B", label: "Serviceable" };
    if (score >= 40) return { rank: "C", label: "Degraded" };
    return { rank: "F", label: "Bus fault — no fire solution" };
  }

  return { NODES: NODES, ID_OPTIONS: ID_OPTIONS, DEFAULT: DEFAULT, cloneDefault: cloneDefault, evaluate: evaluate, runCertification: runCertification, rankFor: rankFor };
})();
