import { useEffect, useRef } from "react";
import { SPECTRUM_BINS } from "../lib/media";

/**
 * EVA's presence: two spectrum rings, one per voice.
 *
 * The inner ring is EVA and grows outward; the outer ring is the visitor and
 * grows inward. Both are live at once during a barge-in, which is the one
 * moment a voice demo has to sell and the one the old avatar could not show —
 * it drew whichever side had the floor and discarded the other.
 *
 * Deliberately not a face. A crude face lands in the uncanny valley and gets
 * worse the more detail you give it; the voice is the thing worth drawing.
 *
 * Animation reads straight from the audio graph inside one rAF loop rather than
 * through props, so a 60fps visualiser costs zero React renders. `speaking` and
 * `listening` still arrive as props because they change rarely and drive state,
 * not motion.
 */

const VISITOR = "#cbd5e1";

function readAccent(el) {
  const v = getComputedStyle(el).getPropertyValue("--accent").trim();
  return v || "#00a3e0";
}

/** #rrggbb -> rgba(), so the accent can come from CSS and still take an alpha. */
function rgba(hex, a) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Mirror the bin index so each ring is symmetric left-to-right and reads as one
// object rather than a strip wrapped around a circle.
function binAt(i, total) {
  const half = total / 2;
  const k = i < half ? i : total - 1 - i;
  return Math.min(SPECTRUM_BINS - 1, Math.floor((k / half) * SPECTRUM_BINS));
}

export default function Avatar({ sources, speaking = false }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const specA = new Float32Array(SPECTRUM_BINS);
    const specB = new Float32Array(SPECTRUM_BINS);

    let frame = null;
    let accent = readAccent(canvas);
    let accentAt = 0;

    const ring = (g, radius, spec, level, colour, dir, outward, t) => {
      const { cx, cy, unit } = g;

      ctx.strokeStyle = rgba(colour, 0.22);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      const total = SPECTRUM_BINS * 2;
      ctx.lineCap = "round";
      ctx.lineWidth = Math.max(1.3, unit * 0.008);
      for (let i = 0; i < total; i++) {
        const v = spec[binAt(i, total)];
        const a = (i / total) * Math.PI * 2 - Math.PI / 2 + t * 0.06 * dir;
        const len = 1.5 + v * unit * 0.08;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const r2 = radius + len * (outward ? 1 : -1);
        ctx.strokeStyle = rgba(colour, 0.28 + v * 0.65);
        ctx.beginPath();
        ctx.moveTo(cx + ca * radius, cy + sa * radius);
        ctx.lineTo(cx + ca * r2, cy + sa * r2);
        ctx.stroke();
      }

      // Whoever holds the floor gets a brighter ring, readable from across a
      // room when the demo is on a screen share.
      ctx.strokeStyle = rgba(colour, 0.1 + level * 0.5);
      ctx.lineWidth = Math.max(1.5, unit * 0.011);
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();
    };

    const draw = (now) => {
      const t = now / 1000;

      // The accent is per-agent and set inline on the stage; re-reading it
      // every few frames costs nothing and avoids threading it through props.
      if (now - accentAt > 500) {
        accent = readAccent(canvas);
        accentAt = now;
      }

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const g = { cx: w / 2, cy: h / 2, unit: Math.min(w, h) };
      const player = sources?.player?.current;
      const mic = sources?.mic?.current;

      // Zero the buffer when a source is gone rather than leaving it be, or the
      // ring freezes mid-spectrum after the session ends instead of settling
      // flat.
      let levelA = 0;
      let levelB = 0;
      if (player) levelA = player.spectrum(specA); else specA.fill(0);
      if (mic) levelB = mic.spectrum(specB); else specB.fill(0);

      // The rings used to occupy barely half the canvas. Pushed outward, with
      // the bar length trimmed so the two never collide at full amplitude:
      // inner reaches 0.27, outer reaches down to 0.28.
      const rIn = g.unit * 0.19;
      const rOut = g.unit * 0.36;

      const glow = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, rIn * 2.6);
      glow.addColorStop(0, rgba(accent, 0.22 + levelA * 0.3));
      glow.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, rIn * 2.6, 0, Math.PI * 2);
      ctx.fill();

      ring(g, rIn, specA, levelA, accent, 1, true, t);
      ring(g, rOut, specB, levelB, VISITOR, -1, false, t);

      const core = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, rIn * 0.8);
      core.addColorStop(0, rgba("#ffffff", 0.35 + levelA * 0.4));
      core.addColorStop(0.5, rgba(accent, 0.5 + levelA * 0.3));
      core.addColorStop(1, rgba(accent, 0));
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, rIn * 0.8, 0, Math.PI * 2);
      ctx.fill();

      frame = requestAnimationFrame(draw);
    };

    if (reduced) {
      // One static frame. The rings still show their resting geometry, so the
      // avatar reads as present rather than missing.
      draw(0);
      cancelAnimationFrame(frame);
      frame = null;
    } else {
      frame = requestAnimationFrame(draw);
    }

    // A demo can sit open for a long time; don't burn a core on a hidden tab.
    const onVisibility = () => {
      if (document.hidden) {
        if (frame) cancelAnimationFrame(frame);
        frame = null;
      } else if (!frame && !reduced) {
        frame = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sources]);

  return (
    <div className="avatar-wrap" data-speaking={speaking}>
      <canvas ref={canvasRef} className="avatar-canvas" role="img" aria-label="EVA" />
    </div>
  );
}
