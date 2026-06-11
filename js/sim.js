/* Simulation core — second-order turret plant with drive saturation and anti-windup PID. */

window.SIM = (function () {
  const SETTLE_BAND = 4; // deg

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* Multi-sine terrain torque on the trunnion. Deterministic so certification is fair. */
  function disturbance(p, t, mul) {
    return (
      p.dist *
      (mul || 1) *
      (Math.sin(2.7 * t) + 0.6 * Math.sin(7.3 * t + 1.7) + 0.35 * Math.sin(13.1 * t + 0.4))
    );
  }

  /*
   * One integration step.
   *   u = Kp·e + Ki·∫e − Kd·ω   (clamped to drive torque limit)
   *   J·θ̈ = u + d(t) − b·ω
   * Anti-windup: the integrator holds while the drive is saturated in the same direction.
   */
  function step(s, g, p, target, dt, t, distOn, distMul) {
    const e = target - s.theta;
    let u = g.kp * e + g.ki * s.integ - g.kd * s.omega;
    const sat = Math.abs(u) > p.maxT;
    u = clamp(u, -p.maxT, p.maxT);
    if (!sat || e * u < 0) s.integ += e * dt;
    const lim = p.maxT / Math.max(g.ki, 1);
    s.integ = clamp(s.integ, -lim, lim);
    const d = distOn ? disturbance(p, t, distMul) : 0;
    const alpha = (u + d - p.b * s.omega) / p.J;
    s.omega += alpha * dt;
    s.theta += s.omega * dt;
    s.u = u;
  }

  function newState() {
    return { theta: 0, omega: 0, integ: 0, u: 0 };
  }

  /* Scripted certification slew: 0° → +60° at 0.5 s → −30° at 5 s. */
  function certTarget(t) {
    return t < 0.5 ? 0 : t < 5 ? 60 : -30;
  }

  function runCertification(tank, g) {
    const p = tank.plant;
    const dt = 1 / 500;
    const T = 10;
    const s = newState();
    const trace = [];
    let iae = 0;
    let maxTheta = -Infinity;
    let rise = -1;
    let lastOut = 0.5;
    let unstable = false;

    for (let i = 0; i <= T / dt; i++) {
      const t = i * dt;
      const target = certTarget(t);
      step(s, g, p, target, dt, t, true, 1);
      iae += Math.abs(target - s.theta) * dt;
      if (t >= 0.5 && t < 5) {
        maxTheta = Math.max(maxTheta, s.theta);
        if (rise < 0 && s.theta >= 54) rise = t - 0.5;
        if (Math.abs(s.theta - 60) > SETTLE_BAND) lastOut = t;
      }
      if (i % 10 === 0) trace.push({ t: t, theta: clamp(s.theta, -400, 400), target: target });
      if (!isFinite(s.theta) || Math.abs(s.theta) > 2000) {
        unstable = true;
        break;
      }
    }

    const overshoot = Math.max(0, ((maxTheta - 60) / 60) * 100);
    const settle = clamp(lastOut - 0.5, 0, 4.5);
    const score = unstable
      ? 0
      : clamp(
          Math.round(100 - overshoot * 1.0 - settle * 8 - Math.max(0, iae - tank.iae0) * 0.5),
          0,
          100
        );
    return {
      score: score,
      overshoot: overshoot,
      settle: settle,
      rise: rise < 0 ? 4.5 : rise,
      iae: iae,
      unstable: unstable,
      pass: !unstable && score >= tank.passScore,
      trace: trace,
    };
  }

  function rankFor(score) {
    if (score >= 80) return { rank: "S", label: "Critical damping — textbook" };
    if (score >= 70) return { rank: "A", label: "Combat ready" };
    if (score >= 60) return { rank: "B", label: "Serviceable" };
    if (score >= 45) return { rank: "C", label: "Marginal" };
    if (score >= 30) return { rank: "D", label: "Degraded" };
    return { rank: "F", label: "Unsafe to deploy" };
  }

  return {
    SETTLE_BAND: SETTLE_BAND,
    clamp: clamp,
    disturbance: disturbance,
    step: step,
    newState: newState,
    certTarget: certTarget,
    runCertification: runCertification,
    rankFor: rankFor,
  };
})();
