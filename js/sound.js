/* Procedural UI sounds via Web Audio — no asset files. */

window.SFX = (function () {
  let ctx = null;
  let enabled = true;

  function ac() {
    if (!enabled) return null;
    if (!ctx) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        enabled = false;
        return null;
      }
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function tone(freq, dur, type, gain, ramp) {
    const c = ac();
    if (!c) return;
    const t0 = c.currentTime;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type || "sine";
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain || 0.08, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  function noise(dur, gain) {
    const c = ac();
    if (!c) return;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    const t0 = c.currentTime;
    g.gain.setValueAtTime(gain || 0.06, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(g);
    g.connect(c.destination);
    src.start(t0);
  }

  return {
    setEnabled(v) {
      enabled = !!v;
    },
    isEnabled() {
      return enabled;
    },
    click() {
      tone(520, 0.04, "square", 0.04);
    },
    certPass() {
      tone(440, 0.12, "sine", 0.1);
      setTimeout(() => tone(660, 0.18, "sine", 0.09), 90);
    },
    certFail() {
      tone(180, 0.25, "sawtooth", 0.07);
    },
    clutch() {
      noise(0.35, 0.12);
      tone(90, 0.4, "square", 0.06);
    },
    hit() {
      tone(800, 0.06, "square", 0.05);
      noise(0.08, 0.04);
    },
    miss() {
      tone(220, 0.15, "triangle", 0.05);
    },
    tab() {
      tone(380, 0.03, "sine", 0.03);
    },
  };
})();
