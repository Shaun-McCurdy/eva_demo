import { useEffect, useRef } from "react";

/**
 * Drifting particle field behind the whole site, with lines drawn between
 * neighbours. Respects prefers-reduced-motion by rendering one static frame,
 * and pauses entirely when the tab is hidden so it costs nothing in the
 * background during a long demo.
 */
/** Append an alpha to a #rrggbb, since the field is drawn straight to canvas. */
function withAlpha(hex, alpha) {
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  return `${hex}${a.toString(16).padStart(2, "0")}`;
}

export default function ParticleField({ accent = "#0bacf4", density = 0.00008 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // The field is a faint wash of the accent. On the dark ground a low alpha
    // reads fine; on Silver the same value is invisible, so the strength comes
    // from a token the theme sets rather than a constant baked in here.
    const strength = () => {
      const v = parseFloat(
        getComputedStyle(document.documentElement)
          .getPropertyValue("--particle-alpha")
      );
      return Number.isFinite(v) ? v : 0.33;
    };

    let particles = [];
    let frame = null;
    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const count = Math.min(140, Math.max(40, Math.floor(width * height * density)));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        r: Math.random() * 1.4 + 0.5,
      }));
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      const dotAlpha = strength();
      const lineAlpha = dotAlpha * 0.48;

      for (const p of particles) {
        if (!reduced) {
          p.x += p.vx;
          p.y += p.vy;
          if (p.x < 0 || p.x > width) p.vx *= -1;
          if (p.y < 0 || p.y > height) p.vy *= -1;
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(accent, dotAlpha);
        ctx.fill();
      }

      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist2 = dx * dx + dy * dy;
          if (dist2 < 16000) {
            ctx.strokeStyle = withAlpha(
              accent,
              (1 - dist2 / 16000) * lineAlpha
            );
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.stroke();
          }
        }
      }

      if (!reduced) frame = requestAnimationFrame(draw);
    };

    const onVisibility = () => {
      if (document.hidden) {
        if (frame) cancelAnimationFrame(frame);
        frame = null;
      } else if (!frame && !reduced) {
        frame = requestAnimationFrame(draw);
      }
    };

    resize();
    draw();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [accent, density]);

  return <canvas ref={canvasRef} className="particles" aria-hidden="true" />;
}
