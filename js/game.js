/* Iron Calibrator — full game: PID + hydraulics + CAN bus + live fire. */

(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const SAVE_KEY = "ironCalibratorSave.v2";
  const LIVE_WINDOW = 8;
  const DT = 1 / 240;

  const css = getComputedStyle(document.documentElement);
  const C = {
    bg: css.getPropertyValue("--panel").trim(),
    bg2: css.getPropertyValue("--bg").trim(),
    line: css.getPropertyValue("--line").trim(),
    line2: css.getPropertyValue("--line2").trim(),
    text: css.getPropertyValue("--text").trim(),
    muted: css.getPropertyValue("--muted").trim(),
    faint: css.getPropertyValue("--faint").trim(),
    accent: css.getPropertyValue("--accent").trim(),
    green: css.getPropertyValue("--green").trim(),
    red: css.getPropertyValue("--red").trim(),
    blue: css.getPropertyValue("--blue").trim(),
  };

  /* ---------- persistence ---------- */

  function emptyCert() {
    return { best: 0, pass: false, attempts: 0 };
  }

  function loadSave() {
    let raw = {};
    try {
      raw = JSON.parse(localStorage.getItem(SAVE_KEY)) || JSON.parse(localStorage.getItem("ironCalibratorSave.v1")) || {};
    } catch (e) {
      raw = {};
    }
    const s = {
      version: 2,
      settings: Object.assign({ sound: true, tutorialDone: false }, raw.settings),
      gains: raw.gains || {},
      hydro: raw.hydro || {},
      bus: raw.bus || {},
      cert: raw.cert || {},
      wargame: raw.wargame || {},
    };
    TANKS.forEach((t) => {
      if (!s.cert[t.id]) s.cert[t.id] = {};
      const c = s.cert[t.id];
      if (c.pass !== undefined && !c.pid) {
        c.pid = { best: c.best || 0, pass: !!c.pass, attempts: c.attempts || 0 };
        delete c.best;
        delete c.pass;
        delete c.attempts;
      }
      SUBSYSTEMS.forEach((sub) => {
        if (!c[sub.id]) c[sub.id] = emptyCert();
      });
    });
    return s;
  }

  const save = loadSave();
  const persist = () => localStorage.setItem(SAVE_KEY, JSON.stringify(save));

  function certOf(tid, sub) {
    return (save.cert[tid] && save.cert[tid][sub]) || emptyCert();
  }

  function isSubPass(tid, sub) {
    return !!certOf(tid, sub).pass;
  }

  function isHullReady(tid) {
    return SUBSYSTEMS.every((s) => isSubPass(tid, s.id));
  }

  function isUnlocked(i) {
    return i === 0 || isHullReady(TANKS[i - 1].id);
  }

  function recordCert(tid, sub, score, pass) {
    const c = certOf(tid, sub);
    c.best = Math.max(c.best, score);
    c.pass = c.pass || pass;
    c.attempts += 1;
    save.cert[tid][sub] = c;
    persist();
    return c;
  }

  /* ---------- runtime ---------- */

  let tank = null;
  let sub = "pid";
  let gains = Object.assign({}, DEFAULT_GAINS);
  let hydroCtrl = Object.assign({}, HYDRO.DEFAULT);
  let busCfg = BUS.cloneDefault();
  let bench = null;
  let hydroBench = null;
  let terrain = true;
  let autoSlew = false;
  let wg = null;
  let lastNow = performance.now();
  let clutchPlayed = false;

  function resetBench() {
    bench = { s: SIM.newState(), t: 0, target: 0, nextSlew: 3, clutchUntil: -10, trace: [] };
  }

  function resetHydroBench() {
    hydroBench = { s: HYDRO.newState(), t: 0, target: 0, trace: [] };
  }

  /* ---------- wargame ---------- */

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

  function endWargame(abort) {
    if (!wg) return;
    const total = wg.hits + wg.miss;
    const acc = total ? Math.round((wg.hits / total) * 100) : 0;
    const rating = abort ? "ABORTED" : acc >= 85 && total >= 8 ? "DISTINGUISHED" : acc >= 60 ? "QUALIFIED" : "UNQUALIFIED";
    if (!abort) {
      const prev = save.wargame[tank.id];
      const better = !prev || wg.hits > prev.hits || (wg.hits === prev.hits && acc > prev.acc);
      if (better) {
        save.wargame[tank.id] = { hits: wg.hits, total, acc, rating };
        persist();
      }
    }
    const el = $("wg-result");
    if (abort) {
      el.className = "banner";
      el.innerHTML = "<b>Exercise aborted.</b>";
    } else {
      el.className = "banner " + (rating === "UNQUALIFIED" ? "fail" : rating === "DISTINGUISHED" ? "gold" : "ok");
      el.innerHTML = "<b>" + rating + "</b> — " + wg.hits + " kills, " + wg.miss + " missed (" + acc + "%).";
      if (rating === "UNQUALIFIED") SFX.certFail();
      else SFX.certPass();
    }
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

    const runPid = sub === "pid" || wg;
    const runHydro = sub === "hydro" && !wg;

    while (elapsed > 0) {
      const h = Math.min(DT, elapsed);
      elapsed -= h;

      if (runPid) {
        bench.t += h;
        if (wg) {
          wg.timeLeft -= h;
          if (wg.timeLeft <= 0) {
            endWargame(false);
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
                SFX.hit();
              }
            } else wg.hold = Math.max(0, wg.hold - 2 * h);
            if (wg.state === "active" && bench.t >= wg.targetExpire) {
              wg.miss++;
              wg.state = "gap";
              wg.gapUntil = bench.t + 0.8;
              SFX.miss();
            }
          }
        } else if (autoSlew && bench.t >= bench.nextSlew) {
          bench.target = Math.round((Math.random() * 180 - 90) / 5) * 5;
          bench.nextSlew = bench.t + 2.5 + Math.random() * 2;
        }
        const distMul = wg ? tank.wargame.distMul : 1;
        SIM.step(bench.s, gains, tank.plant, bench.target, h, bench.t, wg ? true : terrain, distMul);
        if (!isFinite(bench.s.theta) || Math.abs(bench.s.theta) > 360) {
          bench.s = SIM.newState();
          bench.clutchUntil = bench.t + 4;
          if (!clutchPlayed) {
            SFX.clutch();
            clutchPlayed = true;
          }
        } else clutchPlayed = false;
        bench.trace.push({ t: bench.t, theta: bench.s.theta, target: bench.target });
        const cut = bench.t - LIVE_WINDOW - 0.5;
        while (bench.trace.length && bench.trace[0].t < cut) bench.trace.shift();
      }

      if (runHydro) {
        hydroBench.t += h;
        HYDRO.step(hydroBench.s, hydroCtrl, tank.hydro, hydroBench.target, h);
        hydroBench.trace.push({
          t: hydroBench.t,
          theta: hydroBench.s.theta,
          target: hydroBench.target,
          pressure: hydroBench.s.pressure,
        });
        const cut2 = hydroBench.t - LIVE_WINDOW - 0.5;
        while (hydroBench.trace.length && hydroBench.trace[0].t < cut2) hydroBench.trace.shift();
      }
    }
  }

  /* ---------- drawing helpers ---------- */

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawScope(cv, pts, x0, x1, yMin, yMax, opts) {
    if (!cv) return;
    opts = opts || {};
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    const mL = 70, mR = 14, mT = 16, mB = 42;
    const px = (t) => mL + ((t - x0) / (x1 - x0)) * (W - mL - mR);
    const py = (v) => SIM.clamp(mT + (1 - (v - yMin) / (yMax - yMin)) * (H - mT - mB), mT, H - mB);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg2;
    ctx.fillRect(mL, mT, W - mL - mR, H - mT - mB);
    if (opts.bands) {
      ctx.fillStyle = "rgba(139,152,165,0.14)";
      opts.bands.forEach((b) => {
        const yT = py(b.center + SIM.SETTLE_BAND);
        const yB = py(b.center - SIM.SETTLE_BAND);
        ctx.fillRect(px(b.from), yT, px(b.to) - px(b.from), Math.max(1, yB - yT));
      });
    }
    if (pts.length < 2) return;
    const step = Math.max(1, Math.floor(pts.length / 600));
    ctx.strokeStyle = C.muted;
    ctx.setLineDash([8, 7]);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      i === 0 ? ctx.moveTo(px(p.t), py(p.target)) : ctx.lineTo(px(p.t), py(p.target));
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      i === 0 ? ctx.moveTo(px(p.t), py(p.theta)) : ctx.lineTo(px(p.t), py(p.theta));
    }
    ctx.stroke();
  }

  function drawHydroScope() {
    const cv = $("hydro-scope");
    if (!cv || !hydroBench) return;
    const pts = hydroBench.trace;
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    const mL = 70, mR = 14, mT = 16, mB = 42;
    const x0 = Math.max(0, hydroBench.t - LIVE_WINDOW);
    const x1 = Math.max(LIVE_WINDOW, hydroBench.t);
    const px = (t) => mL + ((t - x0) / (x1 - x0)) * (W - mL - mR);
    const py = (v) => mT + (1 - (v + 90) / 180) * (H - mT - mB);
    const pp = (p) => mT + (1 - p / 200) * (H - mT - mB);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg2;
    ctx.fillRect(mL, mT, W - mL - mR, H - mT - mB);
    if (pts.length < 2) return;
    const step = Math.max(1, Math.floor(pts.length / 600));
    ctx.strokeStyle = C.red;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      const y = pp(p.pressure);
      i === 0 ? ctx.moveTo(px(p.t), y) : ctx.lineTo(px(p.t), y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      i === 0 ? ctx.moveTo(px(p.t), py(p.theta)) : ctx.lineTo(px(p.t), py(p.theta));
    }
    ctx.stroke();
  }

  function drawTurret() {
    const cv = $("turret-canvas");
    if (!cv || !bench) return;
    const ctx = cv.getContext("2d");
    const S = cv.width, c = S / 2;
    const rad = (d) => ((d - 90) * Math.PI) / 180;
    const pt = (d, r) => [c + r * Math.cos(rad(d)), c + r * Math.sin(rad(d))];
    ctx.clearRect(0, 0, S, S);
    ctx.strokeStyle = C.line2;
    [80, 140, 205].forEach((r) => {
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.stroke();
    });
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
    const tgt = bench.target;
    const [rx, ry] = pt(tgt, 205);
    ctx.strokeStyle = C.muted;
    ctx.setLineDash([9, 7]);
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(rx, ry);
    ctx.stroke();
    ctx.setLineDash([]);
    const wgOn = wg && wg.state === "active";
    ctx.strokeStyle = wgOn ? C.accent : C.muted;
    ctx.beginPath();
    ctx.arc(rx, ry, 15, 0, Math.PI * 2);
    ctx.stroke();
    if (wg && bench.t < wg.flashUntil) {
      ctx.strokeStyle = C.green;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(rx, ry, 30, 0, Math.PI * 2);
      ctx.stroke();
    }
    const th = bench.s.theta;
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate((th * Math.PI) / 180);
    ctx.fillStyle = C.accent;
    roundRect(ctx, -9, -184, 18, 130, 7);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, 0, 52, 0, Math.PI * 2);
    ctx.fillStyle = C.bg;
    ctx.fill();
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();
    const err = Math.abs(tgt - th);
    ctx.font = "600 20px monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = err <= 2 ? C.green : C.faint;
    ctx.fillText(err <= 2 ? "ON TARGET" : "ERR " + err.toFixed(1) + "\u00B0", c, S - 14);
  }

  function drawHydroBench() {
    const cv = $("hydro-canvas");
    if (!cv || !hydroBench) return;
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    const s = hydroBench.s;
    const plant = tank.hydro;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg2;
    ctx.fillRect(0, 0, W, H);
    // position bar
    const barX = 40, barW = W - 160, barY = H - 70, barH = 24;
    ctx.fillStyle = C.line2;
    roundRect(ctx, barX, barY, barW, barH, 6);
    ctx.fill();
    const frac = (s.theta + 90) / 180;
    ctx.fillStyle = C.accent;
    roundRect(ctx, barX, barY, barW * SIM.clamp(frac, 0, 1), barH, 6);
    ctx.fill();
    ctx.fillStyle = C.muted;
    ctx.font = "12px monospace";
    ctx.fillText("-90\u00B0", barX, barY - 8);
    ctx.fillText("+90\u00B0", barX + barW - 24, barY - 8);
    ctx.fillStyle = C.text;
    ctx.font = "bold 22px monospace";
    ctx.fillText(s.theta.toFixed(1) + "\u00B0", barX + barW / 2 - 30, barY - 8);
    // pressure gauge
    const gx = W - 100, gy = 80, gr = 70;
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(gx, gy, gr, Math.PI * 0.75, Math.PI * 2.25);
    ctx.stroke();
    const pFrac = s.pressure / plant.burst;
    ctx.strokeStyle = s.pressure > plant.safeP ? C.red : C.accent;
    ctx.beginPath();
    ctx.arc(gx, gy, gr, Math.PI * 0.75, Math.PI * 0.75 + pFrac * Math.PI * 1.5);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.font = "bold 18px monospace";
    ctx.textAlign = "center";
    ctx.fillText(s.pressure.toFixed(0), gx, gy + 6);
    ctx.font = "11px sans-serif";
    ctx.fillStyle = C.faint;
    ctx.fillText("bar", gx, gy + 22);
    ctx.textAlign = "left";
    // schematic label
    ctx.fillStyle = C.muted;
    ctx.font = "11px sans-serif";
    ctx.fillText("PUMP \u2192 RELIEF \u2192 ACTUATOR", 40, 36);
    ctx.fillText("Target: " + hydroBench.target + "\u00B0", 40, 56);
  }

  function drawBusTopology() {
    const cv = $("bus-canvas");
    if (!cv) return;
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = C.bg2;
    ctx.fillRect(0, 0, W, H);
    const y = H / 2;
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(W - 40, y);
    ctx.stroke();
    const nodes = BUS.NODES;
    const xs = [90, 210, 350, 470];
    nodes.forEach((n, i) => {
      const id = busCfg[n.key];
      const ok = id === n.correct;
      const x = xs[i];
      ctx.fillStyle = ok ? C.green : C.red;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = C.text;
      ctx.font = "11px monospace";
      ctx.textAlign = "center";
      ctx.fillText("0x" + id.toString(16).toUpperCase(), x, y - 24);
      ctx.font = "10px sans-serif";
      ctx.fillStyle = C.muted;
      const lbl = n.label.split(" ")[0];
      ctx.fillText(lbl, x, y + 32);
    });
    ctx.fillStyle = busCfg.termNear ? C.green : C.red;
    ctx.fillRect(28, y - 6, 12, 12);
    ctx.fillStyle = busCfg.termFar ? C.green : C.red;
    ctx.fillRect(W - 40, y - 6, 12, 12);
    ctx.fillStyle = C.faint;
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("NEAR 120\u03A9", 28, y + 28);
    ctx.textAlign = "right";
    ctx.fillText("FAR 120\u03A9", W - 28, y + 28);
  }

  /* ---------- cert UI ---------- */

  function renderCertPanel(panelId, bodyId, title, res, rank, extra) {
    $(panelId).classList.remove("hidden");
    const tone = res.burst || res.unstable ? "fail" : res.pass ? "ok" : "fail";
    $(bodyId).innerHTML =
      "<h3>" + title + "</h3>" +
      '<div class="banner ' + tone + '"><b>' +
      (res.pass ? "PASS — rank " + rank.rank + " (" + rank.label + ")" : "FAIL — rank " + rank.rank) +
      "</b></div>" +
      '<div class="stats-row">' + extra + "</div>";
    if (res.pass) SFX.certPass();
    else SFX.certFail();
  }

  function runCertPid() {
    const res = SIM.runCertification(tank, gains);
    const was = certOf(tank.id, "pid").pass;
    recordCert(tank.id, "pid", res.score, res.pass);
    const rank = SIM.rankFor(res.score);
    renderCertPanel(
      "cert-panel-pid",
      "cert-pid-body",
      "PID certification — " + tank.name,
      res,
      rank,
      tank.passScore,
      '<div class="stat"><span class="' + (res.pass ? "ok" : "bad") + '">' + res.score + '</span><label>score</label></div>' +
        '<div class="stat"><span>' + res.overshoot.toFixed(1) + "%</span><label>overshoot</label></div>" +
        '<div class="stat"><span>' + res.settle.toFixed(2) + "s</span><label>settling</label></div>" +
        '<div class="stat"><span>' + res.rise.toFixed(2) + "s</span><label>rise</label></div>" +
        '<div class="stat"><span>' + res.iae.toFixed(0) + "</span><label>IAE</label></div>"
    );
    drawScope($("cert-canvas-pid"), res.trace, 0, 10, -80, 110, {
      bands: [
        { from: 0.5, to: 5, center: 60 },
        { from: 5, to: 10, center: -30 },
      ],
    });
    if (res.pass && !was) maybeUnlockToast();
    renderTabs();
    renderStatusPills();
    refreshWargamePanel();
  }

  function runCertHydro() {
    const res = HYDRO.runCertification(tank, hydroCtrl);
    const was = certOf(tank.id, "hydro").pass;
    recordCert(tank.id, "hydro", res.score, res.pass);
    const rank = HYDRO.rankFor(res.score);
    renderCertPanel(
      "cert-panel-hydro",
      "cert-hydro-body",
      "Hydraulic certification — " + tank.name,
      res,
      rank,
      tank.hydro.passScore,
      '<div class="stat"><span class="' + (res.pass ? "ok" : "bad") + '">' + res.score + '</span><label>score</label></div>' +
        '<div class="stat"><span>' + res.maxP.toFixed(0) + " bar</span><label>peak P</label></div>" +
        '<div class="stat"><span>' + Math.round(res.settleFrac * 100) + "%</span><label>in-band</label></div>" +
        '<div class="stat"><span>' + res.iae.toFixed(0) + "</span><label>IAE</label></div>" +
        '<div class="stat"><span>' + (res.burst ? "YES" : "no") + "</span><label>burst</label></div>"
    );
    if (res.pass && !was) maybeUnlockToast();
    renderTabs();
    renderStatusPills();
    refreshWargamePanel();
  }

  function runCertBus() {
    const res = BUS.runCertification(tank, busCfg);
    const was = certOf(tank.id, "bus").pass;
    recordCert(tank.id, "bus", res.score, res.pass);
    const rank = BUS.rankFor(res.score);
    const log = res.log
      .map((l) => (l.ok ? "\u2713" : "\u2717") + " " + l.node + ": " + l.id + (l.ok ? "" : " (expect " + l.expect + ")"))
      .join("<br>");
    $("bus-log").innerHTML = log + (res.termOk ? "<br>\u2713 Termination OK" : "<br>\u2717 Termination fault — enable both ends");
    renderCertPanel(
      "cert-panel-bus",
      "cert-bus-body",
      "Bus diagnostic — " + tank.name,
      res,
      rank,
      tank.bus.passScore,
      '<div class="stat"><span class="' + (res.pass ? "ok" : "bad") + '">' + res.score + '</span><label>score</label></div>' +
        '<div class="stat"><span>' + res.ack + "/" + res.total + '</span><label>ACKs</label></div>' +
        '<div class="stat"><span>' + (res.termOk ? "OK" : "FAULT") + '</span><label>termination</label></div>' +
        '<div class="stat"><span>' + res.reflections + '</span><label>reflections</label></div>' +
        '<div class="stat"><span>' + res.errors + "</span><label>errors</label></div>"
    );
    drawBusTopology();
    if (res.pass && !was) maybeUnlockToast();
    renderTabs();
    renderStatusPills();
    refreshWargamePanel();
  }

  function maybeUnlockToast() {
    if (isHullReady(tank.id)) {
      $("workorder").innerHTML =
        "<span class='co-title'>Hull combat-ready</span>All three subsystems certified. Live-fire exercise unlocked.";
    }
  }

  /* ---------- bay UI ---------- */

  function setSub(s) {
    sub = s;
    SFX.tab();
    SUBSYSTEMS.forEach((x) => {
      $("panel-" + x.id).classList.toggle("hidden", x.id !== s);
    });
    document.querySelectorAll(".sub-tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.sub === s);
    });
    const faults = { pid: tank.fault, hydro: tank.hydroFault, bus: tank.busFault };
    $("workorder").innerHTML = "<span class='co-title'>Work order — " + SUBSYSTEMS.find((x) => x.id === s).label + "</span>" + faults[s];
    renderBayUI();
  }

  function renderTabs() {
    const nav = $("subsystem-tabs");
    nav.innerHTML = "";
    SUBSYSTEMS.forEach((s) => {
      const c = certOf(tank.id, s.id);
      const b = document.createElement("button");
      b.className = "sub-tab" + (sub === s.id ? " active" : "") + (c.pass ? " done" : "");
      b.dataset.sub = s.id;
      b.textContent = s.label + (c.pass ? " \u2713" : "");
      b.addEventListener("click", () => setSub(s.id));
      nav.appendChild(b);
    });
  }

  function renderStatusPills() {
    if (!tank) return;
    const box = $("bay-status-pills");
    box.innerHTML = "";
    SUBSYSTEMS.forEach((s) => {
      const c = certOf(tank.id, s.id);
      const p = document.createElement("span");
      p.className = "status-tag " + (c.pass ? "ok" : "warn");
      p.textContent = s.short + (c.pass ? " OK" : " OPEN");
      box.appendChild(p);
    });
    if (isHullReady(tank.id)) {
      const p = document.createElement("span");
      p.className = "status-tag ok";
      p.textContent = "COMBAT READY";
      box.appendChild(p);
    }
  }

  function renderReadouts() {
    if (!bench) return;
    const err = bench.target - bench.s.theta;
    $("ro-az").textContent = bench.s.theta.toFixed(1) + "\u00B0";
    $("ro-err").textContent = err.toFixed(1) + "\u00B0";
    $("ro-rate").textContent = bench.s.omega.toFixed(0) + "\u00B0/s";
    const eff = (Math.abs(bench.s.u) / tank.plant.maxT) * 100;
    $("ro-eff").textContent = eff.toFixed(0) + "%";
    $("ro-err").parentElement.className = "ro " + (Math.abs(err) <= 2 ? "good" : "");
    $("ro-eff").parentElement.className = "ro " + (eff >= 98 ? "bad" : "");
    $("clutch-warning").classList.toggle("hidden", bench.t >= bench.clutchUntil);
    $("bench-mode").textContent = wg ? "LIVE FIRE " + Math.ceil(wg.timeLeft) + "s" : terrain ? "ROUGH TERRAIN" : "STATIC";
    if (wg) {
      $("wg-time").textContent = Math.max(0, wg.timeLeft).toFixed(1);
      $("wg-hits").textContent = String(wg.hits);
      $("wg-miss").textContent = String(wg.miss);
      const t = wg.hits + wg.miss;
      $("wg-acc").textContent = t ? Math.round((wg.hits / t) * 100) + "%" : "\u2014";
    }
  }

  function renderHydroReadouts() {
    if (!hydroBench) return;
    const s = hydroBench.s;
    $("hy-az").textContent = s.theta.toFixed(1) + "\u00B0";
    $("hy-p").textContent = s.pressure.toFixed(0) + " bar";
    $("hy-flow").textContent = s.flow.toFixed(2);
    const bad = s.pressure > tank.hydro.safeP;
    $("hy-safe").textContent = bad ? "HIGH" : "OK";
    $("hy-safe").parentElement.className = "ro " + (bad ? "bad" : "good");
    $("hydro-tag").textContent = "P " + hydroCtrl.pump + " \u00B7 R " + hydroCtrl.relief + " \u00B7 F " + hydroCtrl.flow.toFixed(2);
  }

  function renderGainLabels() {
    $("val-kp").textContent = gains.kp.toFixed(1);
    $("val-ki").textContent = gains.ki.toFixed(1);
    $("val-kd").textContent = gains.kd.toFixed(1);
    $("gain-tag").textContent = "Kp " + gains.kp.toFixed(1) + " \u00B7 Ki " + gains.ki.toFixed(1) + " \u00B7 Kd " + gains.kd.toFixed(1);
  }

  function renderHydroLabels() {
    $("val-pump").textContent = String(hydroCtrl.pump);
    $("val-relief").textContent = String(hydroCtrl.relief);
    $("val-flow").textContent = hydroCtrl.flow.toFixed(2);
  }

  function buildBusControls() {
    const wrap = $("bus-controls");
    wrap.innerHTML = "";
    BUS.NODES.forEach((n) => {
      const row = document.createElement("div");
      row.className = "bus-row";
      const lab = document.createElement("label");
      lab.textContent = n.label;
      const sel = document.createElement("select");
      sel.className = "bus-select";
      BUS.ID_OPTIONS.forEach((id) => {
        const o = document.createElement("option");
        o.value = id;
        o.textContent = "0x" + id.toString(16).toUpperCase().padStart(2, "0");
        if (busCfg[n.key] === id) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", () => {
        busCfg[n.key] = parseInt(sel.value, 10);
        save.bus[tank.id] = Object.assign({}, busCfg);
        persist();
        drawBusTopology();
        SFX.click();
      });
      row.appendChild(lab);
      row.appendChild(sel);
      wrap.appendChild(row);
    });
    ["termNear", "termFar"].forEach((k, i) => {
      const lab = document.createElement("label");
      lab.className = "tgl bus-term";
      const inp = document.createElement("input");
      inp.type = "checkbox";
      inp.checked = busCfg[k];
      inp.addEventListener("change", () => {
        busCfg[k] = inp.checked;
        save.bus[tank.id] = Object.assign({}, busCfg);
        persist();
        drawBusTopology();
        SFX.click();
      });
      lab.appendChild(inp);
      lab.appendChild(document.createTextNode((i === 0 ? "Near" : "Far") + "-end 120 \u03A9 termination"));
      wrap.appendChild(lab);
    });
  }

  function refreshWargamePanel() {
    if (!tank) return;
    const ready = isHullReady(tank.id);
    $("wargame-panel").classList.toggle("hidden", !ready);
    $("wg-hud").classList.toggle("hidden", !wg);
    $("wg-idle").classList.toggle("hidden", !!wg);
    $("btn-abort-wg").classList.toggle("hidden", !wg);
    const rec = save.wargame[tank.id];
    $("wg-best").textContent = rec
      ? "Best: " + rec.hits + " kills \u00B7 " + rec.acc + "% \u00B7 " + rec.rating
      : "No live-fire record yet.";
  }

  function setWgControls(running) {
    document.querySelectorAll("#slew-buttons button, [data-preset], #btn-cert-pid, #btn-cert-hydro, #btn-cert-bus").forEach((b) => {
      b.disabled = running && b.id !== "btn-abort-wg";
    });
    $("tgl-terrain").disabled = running;
    $("tgl-autoslew").disabled = running;
  }

  function renderBayUI() {
    $("crew-note-pid").innerHTML = "<span class='co-title'>Crew chief</span>" + tank.hint;
    $("crew-note-hydro").innerHTML = "<span class='co-title'>Crew chief</span>" + tank.hydroHint;
    $("crew-note-bus").innerHTML = "<span class='co-title'>Crew chief</span>" + tank.busHint;
    $("cert-req-pid").textContent = "Pass score \u2265 " + tank.passScore + ". Space to run.";
    $("cert-req-hydro").textContent = "Pass score \u2265 " + tank.hydro.passScore + ". Avoid burst > " + tank.hydro.burst + " bar.";
    $("cert-req-bus").textContent = "Pass score \u2265 " + tank.bus.passScore + ". All nodes ACK + clean termination.";
    renderGainLabels();
    renderHydroLabels();
    buildBusControls();
    drawBusTopology();
  }

  function enterBay(t) {
    tank = t;
    sub = "pid";
    gains = Object.assign({}, DEFAULT_GAINS, save.gains[t.id]);
    hydroCtrl = Object.assign({}, t.hydroDefault, save.hydro[t.id]);
    busCfg = Object.assign({}, t.busDefault, save.bus[t.id]);
    resetBench();
    resetHydroBench();
    wg = null;
    autoSlew = false;
    $("tgl-autoslew").checked = false;
    terrain = $("tgl-terrain").checked;
    $("bay-title").textContent = t.name;
    $("bay-class").textContent = t.klass;
    $("sl-kp").value = gains.kp;
    $("sl-ki").value = gains.ki;
    $("sl-kd").value = gains.kd;
    $("sl-pump").value = hydroCtrl.pump;
    $("sl-relief").value = hydroCtrl.relief;
    $("sl-flow").value = hydroCtrl.flow;
    ["cert-panel-pid", "cert-panel-hydro", "cert-panel-bus"].forEach((id) => $(id).classList.add("hidden"));
    $("wg-result").classList.add("hidden");
    renderTabs();
    setSub("pid");
    renderStatusPills();
    refreshWargamePanel();
    setWgControls(false);
    $("screen-hangar").classList.add("hidden");
    $("screen-bay").classList.remove("hidden");
    window.scrollTo(0, 0);
  }

  function slew(delta) {
    if (!tank || wg) return;
    if (sub === "pid") bench.target = SIM.clamp(bench.target + delta, -90, 90);
    if (sub === "hydro") hydroBench.target = HYDRO.clamp(hydroBench.target + delta, -90, 90);
    SFX.click();
  }

  /* ---------- hangar ---------- */

  function drawMiniTank(cv, theta, locked) {
    const ctx = cv.getContext("2d");
    const W = cv.width, H = cv.height, c = { x: W / 2, y: H / 2 };
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = locked ? 0.4 : 1;
    ctx.fillStyle = C.line2;
    roundRect(ctx, c.x - 95, c.y - 44, 190, 14, 7);
    ctx.fill();
    ctx.fillStyle = C.bg2;
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 2;
    roundRect(ctx, c.x - 95, c.y - 32, 190, 64, 12);
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(((theta - 90) * Math.PI) / 180);
    ctx.fillStyle = locked ? C.faint : C.accent;
    roundRect(ctx, -4, -110, 8, 82, 4);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function renderHangar() {
    const wrap = $("hangar-cards");
    wrap.innerHTML = "";
    let ready = 0;
    TANKS.forEach((t, i) => {
      const unlocked = isUnlocked(i);
      const hullReady = isHullReady(t.id);
      if (hullReady) ready++;
      const card = document.createElement("div");
      card.className = "bay-card" + (unlocked ? "" : " locked");
      const cv = document.createElement("canvas");
      cv.width = 300;
      cv.height = 130;
      card.appendChild(cv);
      const dots = document.createElement("div");
      dots.className = "sub-dots";
      SUBSYSTEMS.forEach((s) => {
        const d = document.createElement("span");
        d.className = "dot" + (certOf(t.id, s.id).pass ? " on" : "");
        d.title = s.label;
        d.textContent = s.short;
        dots.appendChild(d);
      });
      card.appendChild(dots);
      const tag = document.createElement("span");
      tag.className = "status-tag " + (hullReady ? "ok" : unlocked ? "warn" : "locked");
      tag.textContent = hullReady ? "COMBAT READY" : unlocked ? "IN DIAGNOSTICS" : "LOCKED";
      card.appendChild(tag);
      const name = document.createElement("p");
      name.className = "name";
      name.textContent = t.name;
      card.appendChild(name);
      const klass = document.createElement("p");
      klass.className = "klass";
      klass.textContent = t.klass;
      card.appendChild(klass);
      const btn = document.createElement("button");
      btn.className = "btn" + (unlocked && !hullReady ? " primary" : "");
      btn.textContent = unlocked ? "Enter bay" : "Complete " + TANKS[i - 1].name.split(" \u2014 ")[0];
      btn.disabled = !unlocked;
      btn.addEventListener("click", () => {
        SFX.click();
        enterBay(t);
      });
      card.appendChild(btn);
      wrap.appendChild(card);
      drawMiniTank(cv, [-25, 20, 40][i], !unlocked);
    });
    $("fleet-status").textContent = ready + " / " + TANKS.length;
    const banner = $("campaign-banner");
    if (ready === TANKS.length) {
      banner.className = "banner gold";
      banner.innerHTML = "<b>BATTALION COMBAT READY.</b> All hulls certified across PID, hydraulics, and bus.";
    } else banner.className = "banner hidden";
  }

  /* ---------- settings ---------- */

  function exportSave() {
    const blob = new Blob([JSON.stringify(save, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "iron-calibrator-save.json";
    a.click();
    SFX.click();
  }

  function importSave(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        localStorage.setItem(SAVE_KEY, JSON.stringify(data));
        location.reload();
      } catch (e) {
        alert("Invalid save file.");
      }
    };
    r.readAsText(file);
  }

  function resetProgress() {
    if (confirm("Reset all progress? This cannot be undone.")) {
      localStorage.removeItem(SAVE_KEY);
      localStorage.removeItem("ironCalibratorSave.v1");
      location.reload();
    }
  }

  /* ---------- bind ---------- */

  function bind() {
    SFX.setEnabled(save.settings.sound);
    $("tgl-sound").checked = save.settings.sound;
    $("tgl-sound").addEventListener("change", (e) => {
      save.settings.sound = e.target.checked;
      SFX.setEnabled(save.settings.sound);
      persist();
    });

    [["sl-kp", "kp"], ["sl-ki", "ki"], ["sl-kd", "kd"]].forEach(([id, k]) => {
      $(id).addEventListener("input", (e) => {
        if (!tank) return;
        gains[k] = parseFloat(e.target.value);
        save.gains[tank.id] = Object.assign({}, gains);
        persist();
        renderGainLabels();
      });
    });
    [["sl-pump", "pump"], ["sl-relief", "relief"], ["sl-flow", "flow"]].forEach(([id, k]) => {
      $(id).addEventListener("input", (e) => {
        if (!tank) return;
        hydroCtrl[k] = k === "flow" ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
        save.hydro[tank.id] = Object.assign({}, hydroCtrl);
        persist();
        renderHydroLabels();
      });
    });

    document.querySelectorAll("[data-preset]").forEach((b) => {
      b.addEventListener("click", () => {
        if (!tank) return;
        gains = Object.assign({}, GAIN_PRESETS[b.dataset.preset]);
        save.gains[tank.id] = Object.assign({}, gains);
        persist();
        $("sl-kp").value = gains.kp;
        $("sl-ki").value = gains.ki;
        $("sl-kd").value = gains.kd;
        renderGainLabels();
        SFX.click();
      });
    });
    document.querySelectorAll("[data-hpreset]").forEach((b) => {
      b.addEventListener("click", () => {
        if (!tank) return;
        hydroCtrl = Object.assign({}, HYDRO_PRESETS[b.dataset.hpreset]);
        save.hydro[tank.id] = Object.assign({}, hydroCtrl);
        persist();
        $("sl-pump").value = hydroCtrl.pump;
        $("sl-relief").value = hydroCtrl.relief;
        $("sl-flow").value = hydroCtrl.flow;
        renderHydroLabels();
        SFX.click();
      });
    });

    const mkSlew = (wrap, targets) => {
      wrap.innerHTML = "";
      targets.forEach((a) => {
        const b = document.createElement("button");
        b.className = "btn";
        b.textContent = (a > 0 ? "+" : "") + a + "\u00B0";
        b.addEventListener("click", () => {
          if (wrap.id === "slew-buttons") bench.target = a;
          else hydroBench.target = a;
          SFX.click();
        });
        wrap.appendChild(b);
      });
    };
    mkSlew($("slew-buttons"), [-90, -45, 0, 45, 90]);
    mkSlew($("hydro-slew-buttons"), [-60, -30, 0, 30, 60]);

    $("tgl-terrain").addEventListener("change", (e) => {
      terrain = e.target.checked;
    });
    $("tgl-autoslew").addEventListener("change", (e) => {
      autoSlew = e.target.checked;
      if (autoSlew) bench.nextSlew = bench.t;
    });

    $("btn-cert-pid").addEventListener("click", () => {
      SFX.click();
      runCertPid();
    });
    $("btn-cert-hydro").addEventListener("click", () => {
      SFX.click();
      runCertHydro();
    });
    $("btn-cert-bus").addEventListener("click", () => {
      SFX.click();
      runCertBus();
    });

    $("btn-wargame").addEventListener("click", () => {
      wg = { timeLeft: 60, hits: 0, miss: 0, state: "gap", gapUntil: bench.t + 1.2, hold: 0, flashUntil: 0 };
      $("wg-result").classList.add("hidden");
      setWgControls(true);
      refreshWargamePanel();
      setSub("pid");
      SFX.click();
    });
    $("btn-abort-wg").addEventListener("click", () => endWargame(true));

    $("btn-back").addEventListener("click", () => {
      if (wg) endWargame(true);
      tank = null;
      $("screen-bay").classList.add("hidden");
      $("screen-hangar").classList.remove("hidden");
      renderHangar();
      SFX.click();
    });

    $("btn-manual").addEventListener("click", () => $("manual-overlay").classList.remove("hidden"));
    $("btn-manual-close").addEventListener("click", () => $("manual-overlay").classList.add("hidden"));
    $("manual-overlay").addEventListener("click", (e) => {
      if (e.target.id === "manual-overlay") $("manual-overlay").classList.add("hidden");
    });

    $("btn-tutorial").addEventListener("click", () => $("tutorial-overlay").classList.remove("hidden"));
    $("btn-tutorial-close").addEventListener("click", () => closeTutorial());
    $("btn-tutorial-start").addEventListener("click", () => closeTutorial());
    $("btn-export").addEventListener("click", exportSave);
    $("btn-import").addEventListener("click", () => $("import-file").click());
    $("import-file").addEventListener("change", (e) => {
      if (e.target.files[0]) importSave(e.target.files[0]);
    });
    $("btn-reset").addEventListener("click", resetProgress);

    document.addEventListener("keydown", (e) => {
      if (e.target.matches("input, select, textarea")) return;
      if (!tank && e.key >= "1" && e.key <= "3") return;
      if (e.key === "Escape") {
        if (!$("manual-overlay").classList.contains("hidden")) $("manual-overlay").classList.add("hidden");
        else if (!$("tutorial-overlay").classList.contains("hidden")) closeTutorial();
        else if (tank) $("btn-back").click();
        return;
      }
      if (!tank) return;
      if (e.key === "1") setSub("pid");
      if (e.key === "2") setSub("hydro");
      if (e.key === "3") setSub("bus");
      if (e.key === "q" || e.key === "Q") slew(-15);
      if (e.key === "e" || e.key === "E") slew(15);
      if (e.key === " ") {
        e.preventDefault();
        if (sub === "pid") runCertPid();
        if (sub === "hydro") runCertHydro();
        if (sub === "bus") runCertBus();
      }
    });
  }

  function closeTutorial() {
    $("tutorial-overlay").classList.add("hidden");
    save.settings.tutorialDone = true;
    persist();
  }

  function frame(now) {
    if (tank) {
      advance(now);
      if (sub === "pid" || wg) {
        drawTurret();
        drawScope($("scope-canvas"), bench.trace, Math.max(0, bench.t - LIVE_WINDOW), Math.max(LIVE_WINDOW, bench.t), -120, 120);
        renderReadouts();
      }
      if (sub === "hydro" && !wg) {
        drawHydroBench();
        drawHydroScope();
        renderHydroReadouts();
      }
      if (sub === "bus") drawBusTopology();
    } else lastNow = now;
    requestAnimationFrame(frame);
  }

  bind();
  renderHangar();
  if (!save.settings.tutorialDone) $("tutorial-overlay").classList.remove("hidden");
  requestAnimationFrame(frame);
})();
