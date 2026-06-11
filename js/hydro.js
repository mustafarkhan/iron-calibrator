/* Hydraulic traverse circuit — pressure, flow, and position response. */

window.HYDRO = (function () {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const DEFAULT = { pump: 90, relief: 155, flow: 0.55 };

  function newState() {
    return { theta: 0, omega: 0, pressure: 0, flow: 0 };
  }

  function step(s, ctrl, plant, target, dt) {
    const e = target - s.theta;
    const demand = ctrl.flow * e - (plant.damp || 0) * s.omega;
    const avail = plant.maxFlow * Math.sqrt(clamp(s.pressure, 0, plant.burst) / plant.nominalP);
    let flow = Math.sign(demand) * Math.min(Math.abs(demand), avail);
    const reliefDump = s.pressure > ctrl.relief ? (s.pressure - ctrl.relief) * plant.reliefK : 0;
    const leak = plant.leak * s.pressure;
    const pumpDrive = clamp(ctrl.pump - s.pressure, -plant.maxPumpRate, plant.maxPumpRate);
    const dP = pumpDrive * plant.compK - Math.abs(flow) * plant.flowR - reliefDump - leak;
    s.pressure = clamp(s.pressure + dP * dt, 0, plant.burst);
    s.flow = flow;
    const torque = flow * plant.actGain;
    const alpha = (torque - plant.friction * s.omega) / plant.inertia;
    s.omega += alpha * dt;
    s.theta += s.omega * dt;
  }

  /* 0° → +30° → −25° → 0° */
  function certTarget(t) {
    return t < 0.5 ? 0 : t < 4.5 ? 30 : t < 7.5 ? -25 : 0;
  }

  function runCertification(tank, ctrl) {
    const p = tank.hydro;
    const dt = 1 / 400;
    const T = 10;
    const s = newState();
    const trace = [];
    let iae = 0;
    let maxP = 0;
    let settleSum = 0;
    let settleN = 0;
    let burst = false;

    for (let i = 0; i <= T / dt; i++) {
      const t = i * dt;
      const target = certTarget(t);
      step(s, ctrl, p, target, dt);
      iae += Math.abs(target - s.theta) * dt;
      maxP = Math.max(maxP, s.pressure);
      if (s.pressure >= p.burst * 0.98) burst = true;
      if ((t > 2 && t < 4.2) || (t > 5.2 && t < 7.2) || t > 8.2) {
        if (Math.abs(s.theta - target) <= 5) settleSum += dt;
        settleN += dt;
      }
      if (i % 8 === 0) trace.push({ t: t, theta: s.theta, target: target, pressure: s.pressure });
    }

    const settleFrac = settleN > 0 ? settleSum / settleN : 0;
    const pressurePenalty = maxP > p.safeP ? (maxP - p.safeP) * 1.5 : 0;
    const score = burst
      ? 0
      : clamp(
          Math.round(100 - Math.max(0, iae - p.iae0) * 0.25 - pressurePenalty - (1 - settleFrac) * 22),
          0,
          100
        );

    return {
      score: score,
      iae: iae,
      maxP: maxP,
      settleFrac: settleFrac,
      burst: burst,
      pass: !burst && score >= p.passScore && settleFrac >= 0.4,
      trace: trace,
    };
  }

  function rankFor(score) {
    if (score >= 80) return { rank: "S", label: "Nominal hydraulic response" };
    if (score >= 70) return { rank: "A", label: "Traverse ready" };
    if (score >= 60) return { rank: "B", label: "Acceptable" };
    if (score >= 45) return { rank: "C", label: "Marginal" };
    return { rank: "F", label: "Unsafe pressure / sluggish" };
  }

  return { DEFAULT: DEFAULT, newState: newState, step: step, certTarget: certTarget, runCertification: runCertification, rankFor: rankFor, clamp: clamp };
})();
