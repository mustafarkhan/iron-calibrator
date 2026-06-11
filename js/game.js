/* Iron Calibrator — game shell: hangar, HIL bay, certification, live-fire wargame. */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const css = getComputedStyle(document.documentElement);
  const C = {
    bg: css.getPropertyValue("--panel").trim() || "#131a21",
    bg2: css.getPropertyValue("--bg").trim() || "#0c1014",
    line: css.getPropertyValue("--line").trim() || "#28333f",
    line2: css.getPropertyValue("--line2").trim() || "#1d2630",
    text: css.getPropertyValue("--text").trim() || "#d9e1e8",
    muted: css.getPropertyValue("--muted").trim() || "#8b98a5",
    faint: css.getPropertyValue("--faint").trim() || "#5c6873",
    accent: css.getPropertyValue("--accent").trim() || "#e3a23c",
    green: css.getPropertyValue("--green").trim() || "#46b558",
    red: css.getPropertyValue("--red").trim() || "#e5534b",
  };

  /* ---------------- persistence ---------------- */

  const SAVE_KEY = "ironCalibratorSave.v1";

  function loadSave() {
    let s = {};
    try {
      s = JSON.parse(localStorage.getItem(SAVE_KEY)) || {};
    } catch (e) {
      s = {};
    }
    s.gains = s.gains || {};
    s.cert = s.cert || {};
    s.wargame = s.wargame || {};
    return s;
  }

  const save = loadSave();
  const persist = () => localStorage.setItem(SAVE_KEY, JSON.stringify(save));

  const isUnlocked = (i) => i === 0 || !!(save.cert[TANKS[i - 1].id] && save.cert[TANKS[i - 1].id].pass);

  /* ---------------- runtime state ---------------- */

  const LIVE_WINDOW = 8; // seconds of telemetry
  const DT = 1 / 240;

  let tank = null; // current tank object
  let gains = Object.assign({}, DEFAULT_GAINS);
  let bench = null; // live sim state
  let terrain = true;
  let autoSlew = false;
  let wg = null; // wargame state
  let lastNow = performance.now();

  function resetBench() {
    bench = {
      s: SIM.newState(),
      t: 0,
      target: 0,
      nextSlew: 3,
      clutchUntil: -10,
      trace: [],
    };
  }

  /* ---------------- simulation advance ---------------- */

  function spawnWgTarget() {
    let a;
    do {
      a = Math.round((Math.random() * 200 - 100) / 5) * 5;
    } while (Math.abs(a - bench.s.theta) < 30);
    wg.state = "active";
    wg.targetExpire = bench.t + tank.wargame.targetLife;
    wg.hold = 0;
    bench.target = a;
  }

  function endWargame() {
    const total = wg.hits + wg.miss;
    const acc = total ? Math.round((wg.hits / total) * 100) : 0;
    const rating = acc >= 85 && total >= 8 ? "DISTINGUISHED" : acc >= 60 ? "QUALIFIED" : "UNQUALIFIED";
    const prev = save.wargame[tank.id];
    const better = !prev || wg.hits > prev.hits || (wg.hits === prev.hits && acc > prev.acc);
    if (better) {
      save.wargame[tank.id] = { hits: wg.hits, total: total, acc: acc, rating: rating };
      persist();
    }
    const el = $("wg-result");
    el.className = "banner " + (rating === "UNQUALIFIED" ? "fail" : rating === "DISTINGUISHED" ? "gold" : "ok");
    el.innerHTML =
      "<b>" + rating + "</b> — " + wg.hits + " kills, " + wg.miss + " missed (" + acc + "% accuracy)." +
      (better && prev ? " New battalion record for this hull." : "") +
      (rating === "UNQUALIFIED"
        ? " The fire-control computer can only shoot as well as your loop settles — go back to the gain console."
        : "");
    el.classList.remove("hidden");
    wg = null;
    setWgControls(false);
    refreshWargamePanel();
    renderStatusPills();
  }

  function advance(now) {
    let elapsed = Math.min((now - lastNow) / 1000, 0.05);
    lastNow = now;
    if (!tank) return;

    const distMul = wg ? tank.wargame.distMul : 1;
    const distOn = wg ? true : terrain;

    while (elapsed > 0) {
      const h = Math.min(DT, elapsed);
      elapsed -= h;
      bench.t += h;

      if (wg) {
        wg.timeLeft -= h;
        if (wg.timeLeft <= 0) {
          endWargame();
          break;
        }
        if (wg.state === "gap" && bench.t >= wg.gapUntil) spawnWgTarget();
        if (wg.state === "active") {
          if (Math.abs(bench.target - bench.s.theta) <= 2) {
            wg.hold += h;
            if (wg.hold >= 0.4) {
              wg.hits++;
              wg.flashUntil = bench.t + 0.45;
              wg.state = "gap";
              wg.gapUntil = bench.t + 0.8;
            }
          } else {
            wg.hold = Math.max(0, wg.hold - 2 * h);
          }
          if (wg.state === "active" && bench.t >= wg.targetExpire) {
            wg.miss++;
            wg.state = "gap";
            wg.gapUntil = bench.t + 0.8;
          }
        }
      } else if (autoSlew && bench.t >= bench.nextSlew) {
        bench.target = Math.round((Math.random() * 180 - 90) / 5) * 5;
        bench.nextSlew = bench.t + 2.5 + Math.random() * 2;
      }

      SIM.step(bench.s, gains, tank.plant, bench.target, h, bench.t, distOn, distMul);

      if (!isFinite(bench.s.theta) || Math.abs(bench.s.theta) > 360) {
        bench.s = SIM.newState();
        bench.clutchUntil = bench.t + 4;
      }
    }

    bench.trace.push({ t: bench.t, theta: bench.s.theta, target: bench.target });
    const cutoff = bench.t - LIVE_WINDOW - 0.5;
    while (bench.trace.length && bench.trace[0].t < cutoff) bench.trace.shift();
  }

  /* ---------------- drawing: turret ---------------- */

  function drawTurret() {
    const cv = $("turret-canvas");
    const ctx = cv.getContext("2d");
    const S = cv.width;
    const c = S / 2;
    const rad = (deg) => ((deg - 90) * Math.PI) / 180;
    const pt = (deg, r) => [c + r * Math.cos(rad(deg)), c + r * Math.sin(rad(deg))];

    ctx.clearRect(0, 0, S, S);

    // bearing rings + ticks
    ctx.strokeStyle = C.line2;
    ctx.lineWidth = 1.5;
    [80, 140, 205].forEach((r) => {
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.strokeStyle = C.line;
    for (let a = 0; a < 360; a += 30) {
      const [x1, y1] = pt(a, 196);
      const [x2, y2] = pt(a, 220);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    // hull + tracks
    ctx.fillStyle = C.line2;
    roundRect(ctx, c - 100, c - 118, 24, 236, 10);
    ctx.fill();
    roundRect(ctx, c + 76, c - 118, 24, 236, 10);
    ctx.fill();
    ctx.fillStyle = C.bg;
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    roundRect(ctx, c - 76, c - 118, 152, 236, 18);
    ctx.fill();
    ctx.stroke();

    // commanded reticle
    const tgt = bench.target;
    const [rx, ry] = pt(tgt, 205);
    ctx.strokeStyle = C.muted;
    ctx.lineWidth = 2;
    ctx.setLineDash([9, 7]);
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(rx, ry);
    ctx.stroke();
    ctx.setLineDash([]);

    const wgActive = wg && wg.state === "active";
    ctx.strokeStyle = wgActive ? C.accent : C.muted;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(rx, ry, 15, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rx - 22, ry);
    ctx.lineTo(rx + 22, ry);
    ctx.moveTo(rx, ry - 22);
    ctx.lineTo(rx, ry + 22);
    ctx.stroke();

    if (wgActive) {
      // time-remaining arc (counts down) + lock-progress arc
      const frac = Math.max(0, (wg.targetExpire - bench.t) / tank.wargame.targetLife);
      ctx.strokeStyle = C.faint;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(rx, ry, 26, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
      ctx.stroke();
      if (wg.hold > 0) {
        ctx.strokeStyle = C.green;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(rx, ry, 20, -Math.PI / 2, -Math.PI / 2 + Math.min(1, wg.hold / 0.4) * Math.PI * 2);
        ctx.stroke();
      }
    }
    if (wg && wg.flashUntil && bench.t < wg.flashUntil) {
      const k = 1 - (wg.flashUntil - bench.t) / 0.45;
      ctx.strokeStyle = C.green;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(rx, ry, 15 + k * 38, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // turret + gun
    const th = bench.s.theta;
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate((th * Math.PI) / 180);
    ctx.fillStyle = C.accent;
    roundRect(ctx, -9, -184, 18, 130, 7);
    ctx.fill();
    roundRect(ctx, -14, -142, 28, 24, 6);
    ctx.fill();
    ctx.fillStyle = C.bg;
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, 0, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = C.accent;
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // status text
    const err = Math.abs(tgt - th);
    ctx.font = "600 20px ui-monospace, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = err <= 2 ? C.green : C.faint;
    ctx.fillText(err <= 2 ? "ON TARGET" : "ERROR " + err.toFixed(1) + "\u00B0", c, S - 14);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------- drawing: scope ---------------- */

  function drawScope(cv, pts, x0, x1, yMin, yMax, opts) {
    opts = opts || {};
    const ctx = cv.getContext("2d");
    const W = cv.width;
    const H = cv.height;
    const mL = 70, mR = 14, mT = 16, mB = 42;
    const px = (t) => mL + ((t - x0) / (x1 - x0)) * (W - mL - mR);
    const py = (v) => SIM.clamp(mT + (1 - (v - yMin) / (yMax - yMin)) * (H - mT - mB), mT, H - mB);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg2;
    ctx.fillRect(mL, mT, W - mL - mR, H - mT - mB);

    // settle bands
    if (opts.bands) {
      ctx.fillStyle = "rgba(139, 152, 165, 0.14)";
      opts.bands.forEach((b) => {
        const yTop = py(b.center + SIM.SETTLE_BAND);
        const yBot = py(b.center - SIM.SETTLE_BAND);
        ctx.fillRect(px(b.from), yTop, px(b.to) - px(b.from), Math.max(1, yBot - yTop));
      });
    }

    // grid
    ctx.font = "18px ui-monospace, Menlo, monospace";
    ctx.fillStyle = C.faint;
    const ySpan = yMax - yMin;
    const yStep = ySpan > 200 ? 60 : 30;
    ctx.textAlign = "right";
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) {
      ctx.strokeStyle = v === 0 ? C.line : C.line2;
      ctx.lineWidth = v === 0 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(mL, py(v));
      ctx.lineTo(W - mR, py(v));
      ctx.stroke();
      ctx.fillText(v + "\u00B0", mL - 8, py(v) + 6);
    }
    ctx.textAlign = "center";
    const xStep = opts.xStep || 2;
    for (let t = Math.ceil(x0 / xStep) * xStep; t <= x1 + 1e-9; t += xStep) {
      ctx.strokeStyle = C.line2;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px(t), mT);
      ctx.lineTo(px(t), H - mB);
      ctx.stroke();
      ctx.fillText(opts.xLabel ? opts.xLabel(t) : String(t), px(t), H - mB + 26);
    }

    if (pts.length < 2) return;
    const step = Math.max(1, Math.floor(pts.length / 600));

    // commanded (dashed)
    ctx.strokeStyle = C.muted;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 7]);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      i === 0 ? ctx.moveTo(px(p.t), py(p.target)) : ctx.lineTo(px(p.t), py(p.target));
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // actual
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      i === 0 ? ctx.moveTo(px(p.t), py(p.theta)) : ctx.lineTo(px(p.t), py(p.theta));
    }
    ctx.stroke();
  }

  /* ---------------- bay UI ---------------- */

  function setText(id, txt) {
    $(id).textContent = txt;
  }

  function renderReadouts() {
    const err = bench.target - bench.s.theta;
    setText("ro-az", bench.s.theta.toFixed(1) + "\u00B0");
    setText("ro-err", err.toFixed(1) + "\u00B0");
    setText("ro-rate", bench.s.omega.toFixed(0) + "\u00B0/s");
    const eff = (Math.abs(bench.s.u) / tank.plant.maxT) * 100;
    setText("ro-eff", eff.toFixed(0) + "%");
    $("ro-err").parentElement.className = "ro " + (Math.abs(err) <= 2 ? "good" : "");
    $("ro-eff").parentElement.className = "ro " + (eff >= 98 ? "bad" : "");
    $("clutch-warning").classList.toggle("hidden", bench.t >= bench.clutchUntil);
    setText(
      "bench-mode",
      wg ? "LIVE FIRE \u00B7 " + Math.ceil(wg.timeLeft) + "s" : terrain ? "ROUGH TERRAIN" : "STATIC HULL"
    );
    if (wg) {
      setText("wg-time", Math.max(0, wg.timeLeft).toFixed(1));
      setText("wg-hits", String(wg.hits));
      setText("wg-miss", String(wg.miss));
      const tot = wg.hits + wg.miss;
      setText("wg-acc", tot ? Math.round((wg.hits / tot) * 100) + "%" : "\u2014");
    }
  }

  function renderGainLabels() {
    setText("val-kp", gains.kp.toFixed(1));
    setText("val-ki", gains.ki.toFixed(1));
    setText("val-kd", gains.kd.toFixed(1));
    setText("gain-tag", "Kp " + gains.kp.toFixed(1) + " \u00B7 Ki " + gains.ki.toFixed(1) + " \u00B7 Kd " + gains.kd.toFixed(1));
  }

  function renderStatusPills() {
    const box = $("bay-status-pills");
    box.innerHTML = "";
    const cert = save.cert[tank.id];
    const pill = document.createElement("span");
    pill.className = "status-tag " + (cert && cert.pass ? "ok" : "warn");
    pill.textContent = cert && cert.pass ? "CERTIFIED \u00B7 BEST " + cert.best : "AWAITING CERTIFICATION";
    box.appendChild(pill);
    const rec = save.wargame[tank.id];
    if (rec) {
      const p2 = document.createElement("span");
      p2.className = "status-tag " + (rec.rating === "UNQUALIFIED" ? "warn" : "ok");
      p2.textContent = "LIVE FIRE \u00B7 " + rec.rating;
      box.appendChild(p2);
    }
  }

  function refreshWargamePanel() {
    const cert = save.cert[tank.id];
    $("wargame-panel").classList.toggle("hidden", !(cert && cert.pass));
    $("wg-hud").classList.toggle("hidden", !wg);
    $("wg-idle").classList.toggle("hidden", !!wg);
    const rec = save.wargame[tank.id];
    setText(
      "wg-best",
      rec
        ? "Best on this hull: " + rec.hits + " kills \u00B7 " + rec.acc + "% \u00B7 " + rec.rating
        : "No live-fire record on this hull yet."
    );
  }

  function setWgControls(running) {
    document.querySelectorAll("#slew-buttons button, [data-preset], #btn-cert").forEach((b) => (b.disabled = running));
    $("tgl-terrain").disabled = running;
    $("tgl-autoslew").disabled = running;
    $("sl-kp").disabled = false; // gains stay live — tuning mid-fight is allowed but cert score won't change
  }

  function enterBay(t) {
    tank = t;
    gains = Object.assign({}, DEFAULT_GAINS, save.gains[t.id]);
    resetBench();
    wg = null;
    autoSlew = false;
    $("tgl-autoslew").checked = false;
    terrain = $("tgl-terrain").checked;

    setText("bay-title", t.name);
    setText("bay-class", t.klass + " \u00B7 mission " + (TANKS.indexOf(t) + 1) + " of " + TANKS.length);
    $("workorder").innerHTML = "<span class='co-title'>Work order \u2014 " + t.name + "</span>" + t.fault;
    $("crew-note").innerHTML = "<span class='co-title'>Crew chief's note</span>" + t.hint;
    setText("cert-req", "Scripted 10 s pattern: 0\u00B0 \u2192 +60\u00B0 \u2192 \u221230\u00B0, terrain on. Pass at score \u2265 " + t.passScore + ".");
    setText("scope-caption", "Source: HIL bench simulation \u00B7 " + t.name + " \u00B7 last " + LIVE_WINDOW + " s \u00B7 x-axis: time relative to now (s)");

    $("sl-kp").value = gains.kp;
    $("sl-ki").value = gains.ki;
    $("sl-kd").value = gains.kd;
    renderGainLabels();
    renderStatusPills();
    refreshWargamePanel();
    $("cert-panel").classList.add("hidden");
    $("wg-result").classList.add("hidden");
    setWgControls(false);

    $("screen-hangar").classList.add("hidden");
    $("screen-bay").classList.remove("hidden");
    window.scrollTo(0, 0);
  }

  /* ---------------- certification ---------------- */

  function runCert() {
    const res = SIM.runCertification(tank, gains);
    const rec = save.cert[tank.id] || { best: 0, pass: false, attempts: 0 };
    const newlyPassed = res.pass && !rec.pass;
    rec.best = Math.max(rec.best, res.score);
    rec.pass = rec.pass || res.pass;
    rec.attempts += 1;
    save.cert[tank.id] = rec;
    persist();

    const rank = SIM.rankFor(res.score);
    const banner = $("cert-banner");
    const idx = TANKS.indexOf(tank);
    if (res.unstable) {
      banner.className = "banner fail";
      banner.innerHTML =
        "<b>UNSTABLE \u2014 run aborted.</b> The azimuth loop diverged during the slew pattern and the " +
        "range safety officer cut drive power. Score 0. Reduce Kp or raise Kd.";
    } else if (res.pass) {
      banner.className = "banner ok";
      banner.innerHTML =
        "<b>PASS \u2014 rank " + rank.rank + " (" + rank.label + ").</b> Hull cleared for the wargame." +
        (newlyPassed && idx < TANKS.length - 1
          ? " <b>" + TANKS[idx + 1].name + " is now unlocked in the hangar.</b>"
          : "") +
        " The live-fire exercise below will put the tune to work.";
    } else {
      banner.className = "banner fail";
      banner.innerHTML =
        "<b>FAIL \u2014 rank " + rank.rank + " (" + rank.label + ").</b> Score " + res.score +
        " &lt; required " + tank.passScore + ". Overshoot says more Kd, slow rise says more Kp, a " +
        "hanging offset under terrain torque says more Ki.";
    }

    setText("cert-heading", "Certification result \u2014 " + tank.name);
    setText("cs-score", String(res.score));
    setText("cs-score-lbl", "score (pass \u2265 " + tank.passScore + ")");
    $("cs-score").className = res.pass ? "ok" : "bad";
    setText("cs-os", res.overshoot.toFixed(1) + "%");
    $("cs-os").className = res.overshoot > 15 ? "bad" : res.overshoot > 8 ? "warn" : "ok";
    setText("cs-settle", res.settle.toFixed(2) + " s");
    $("cs-settle").className = res.settle > 2 ? "warn" : "ok";
    setText("cs-rise", res.rise.toFixed(2) + " s");
    $("cs-rise").className = "";
    setText("cs-iae", res.iae.toFixed(0));
    $("cs-iae").className = "";

    drawScope($("cert-canvas"), res.trace, 0, 10, -80, 110, {
      xStep: 1,
      bands: [
        { from: 0.5, to: 5, center: 60 },
        { from: 5, to: 10, center: -30 },
      ],
    });

    $("cert-panel").classList.remove("hidden");
    renderStatusPills();
    refreshWargamePanel();
    $("cert-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /* ---------------- hangar ---------------- */

  function drawMiniTank(cv, theta, locked) {
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    const c = { x: W / 2, y: H / 2 };
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = locked ? 0.4 : 1;
    ctx.fillStyle = C.line2;
    roundRect(ctx, c.x - 95, c.y - 44, 190, 14, 7); ctx.fill();
    roundRect(ctx, c.x - 95, c.y + 30, 190, 14, 7); ctx.fill();
    ctx.fillStyle = C.bg2;
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    roundRect(ctx, c.x - 95, c.y - 32, 190, 64, 12); ctx.fill(); ctx.stroke();
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(((theta - 90) * Math.PI) / 180);
    ctx.fillStyle = locked ? C.faint : C.accent;
    roundRect(ctx, -4, -110, 8, 82, 4); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, 24, 0, Math.PI * 2);
    ctx.fillStyle = C.bg2; ctx.fill();
    ctx.strokeStyle = locked ? C.faint : C.accent; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function renderHangar() {
    const wrap = $("hangar-cards");
    wrap.innerHTML = "";
    let passed = 0;

    TANKS.forEach((t, i) => {
      const unlocked = isUnlocked(i);
      const cert = save.cert[t.id];
      const rec = save.wargame[t.id];
      if (cert && cert.pass) passed++;

      const card = document.createElement("div");
      card.className = "bay-card" + (unlocked ? "" : " locked");

      const cv = document.createElement("canvas");
      cv.width = 300;
      cv.height = 130;
      card.appendChild(cv);

      const tag = document.createElement("span");
      tag.className = "status-tag " + (cert && cert.pass ? "ok" : unlocked ? "warn" : "locked");
      tag.textContent = cert && cert.pass
        ? "CERTIFIED \u00B7 RANK " + SIM.rankFor(cert.best).rank
        : unlocked
          ? cert ? "IN DIAGNOSTICS" : "AWAITING CALIBRATION"
          : "LOCKED";
      card.appendChild(tag);

      const name = document.createElement("p");
      name.className = "name";
      name.textContent = t.name;
      card.appendChild(name);

      const klass = document.createElement("p");
      klass.className = "klass";
      klass.textContent = t.klass + " \u00B7 J " + t.plant.J.toFixed(1) + " \u00B7 b " + t.plant.b.toFixed(2) +
        " \u00B7 drive " + t.plant.maxT + " \u00B7 terrain " + t.plant.dist;
      card.appendChild(klass);

      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent =
        (cert ? "cert best " + cert.best + " / " + t.passScore + " \u00B7 " + cert.attempts + " attempts" : "no certification runs") +
        (rec ? " \u00B7 live fire " + rec.hits + " kills (" + rec.acc + "%)" : "");
      card.appendChild(meta);

      const btn = document.createElement("button");
      btn.className = "btn" + (unlocked && !(cert && cert.pass) ? " primary" : "");
      btn.textContent = unlocked ? "Enter bay" : "Certify " + TANKS[i - 1].name.split(" \u2014 ")[0] + " to unlock";
      btn.disabled = !unlocked;
      btn.addEventListener("click", () => enterBay(t));
      card.appendChild(btn);

      wrap.appendChild(card);
      drawMiniTank(cv, [-25, 20, 40][i], !unlocked);
    });

    setText("fleet-status", passed + " / " + TANKS.length);

    const banner = $("campaign-banner");
    if (passed === TANKS.length) {
      const totalKills = TANKS.reduce((n, t) => n + ((save.wargame[t.id] || {}).hits || 0), 0);
      banner.className = "banner gold";
      banner.innerHTML =
        "<b>BATTALION COMBAT READY.</b> All three stabilizers certified" +
        (totalKills ? " \u00B7 " + totalKills + " live-fire kills logged across the fleet" : "") +
        ". Chase rank S on every hull, or push your live-fire records.";
    } else {
      banner.className = "banner hidden";
    }
  }

  /* ---------------- wiring ---------------- */

  function bind() {
    [["sl-kp", "kp"], ["sl-ki", "ki"], ["sl-kd", "kd"]].forEach(([id, key]) => {
      $(id).addEventListener("input", (e) => {
        gains[key] = parseFloat(e.target.value);
        save.gains[tank.id] = Object.assign({}, gains);
        persist();
        renderGainLabels();
      });
    });

    document.querySelectorAll("[data-preset]").forEach((b) => {
      b.addEventListener("click", () => {
        gains = Object.assign({}, GAIN_PRESETS[b.dataset.preset]);
        save.gains[tank.id] = Object.assign({}, gains);
        persist();
        $("sl-kp").value = gains.kp;
        $("sl-ki").value = gains.ki;
        $("sl-kd").value = gains.kd;
        renderGainLabels();
      });
    });

    const slews = $("slew-buttons");
    [-90, -45, 0, 45, 90].forEach((a) => {
      const b = document.createElement("button");
      b.className = "btn";
      b.textContent = (a > 0 ? "+" : "") + a + "\u00B0";
      b.addEventListener("click", () => {
        if (!wg) bench.target = a;
      });
      slews.appendChild(b);
    });

    $("tgl-terrain").addEventListener("change", (e) => {
      terrain = e.target.checked;
      setText("scope-caption", "Source: HIL bench simulation \u00B7 " + tank.name + " \u00B7 last " + LIVE_WINDOW + " s \u00B7 x-axis: time relative to now (s)");
    });
    $("tgl-autoslew").addEventListener("change", (e) => {
      autoSlew = e.target.checked;
      if (autoSlew) bench.nextSlew = bench.t;
    });

    $("btn-cert").addEventListener("click", runCert);

    $("btn-wargame").addEventListener("click", () => {
      wg = { timeLeft: 60, hits: 0, miss: 0, state: "gap", gapUntil: bench.t + 1.2, hold: 0, flashUntil: 0 };
      $("wg-result").classList.add("hidden");
      setWgControls(true);
      refreshWargamePanel();
    });

    $("btn-back").addEventListener("click", () => {
      if (wg) {
        wg = null;
        setWgControls(false);
      }
      tank = null;
      $("screen-bay").classList.add("hidden");
      $("screen-hangar").classList.remove("hidden");
      renderHangar();
      window.scrollTo(0, 0);
    });

    $("btn-manual").addEventListener("click", () => $("manual-overlay").classList.remove("hidden"));
    $("btn-manual-close").addEventListener("click", () => $("manual-overlay").classList.add("hidden"));
    $("manual-overlay").addEventListener("click", (e) => {
      if (e.target === $("manual-overlay")) $("manual-overlay").classList.add("hidden");
    });
  }

  /* ---------------- main loop ---------------- */

  function frame(now) {
    if (tank) {
      advance(now);
      drawTurret();
      drawScope(
        $("scope-canvas"),
        bench.trace,
        Math.max(0, bench.t - LIVE_WINDOW),
        Math.max(LIVE_WINDOW, bench.t),
        -120,
        120,
        { xStep: 2, xLabel: (t) => (t - bench.t).toFixed(0) + "s" }
      );
      renderReadouts();
    } else {
      lastNow = now;
    }
    requestAnimationFrame(frame);
  }

  bind();
  renderHangar();
  requestAnimationFrame(frame);
})();
