import { useEffect, useState } from "react";

/**
 * EVA's face.
 *
 * Renders /avatar/eva.png when that file exists, so swapping in a real portrait
 * is a drop-in with no code change. Until then it draws a line-art placeholder
 * so the page never shows a broken image.
 *
 * `agentLevel` and `micLevel` are 0..1 RMS values sampled from the audio graph;
 * the halo rings scale off whichever side currently has the floor.
 */

const PORTRAIT_SRC = "/avatar/eva.png";

function PlaceholderPortrait({ level }) {
  const bars = 9;
  return (
    <svg viewBox="0 0 200 200" role="img" aria-label="EVA">
      <defs>
        <linearGradient id="eva-skin" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#1b2a44" />
          <stop offset="100%" stopColor="#080e1a" />
        </linearGradient>
        <linearGradient id="eva-line" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8fe6ff" />
          <stop offset="100%" stopColor="currentColor" />
        </linearGradient>
      </defs>

      <rect width="200" height="200" fill="url(#eva-skin)" />

      {/* shoulders */}
      <path
        d="M34 200c0-32 30-52 66-52s66 20 66 52"
        fill="none"
        stroke="url(#eva-line)"
        strokeWidth="2"
        opacity="0.55"
      />
      {/* head */}
      <circle
        cx="100"
        cy="86"
        r="38"
        fill="none"
        stroke="url(#eva-line)"
        strokeWidth="2"
        opacity="0.8"
      />
      {/* eyes */}
      <circle cx="87" cy="80" r="2.6" fill="currentColor" />
      <circle cx="113" cy="80" r="2.6" fill="currentColor" />

      {/* mouth becomes a live equaliser while EVA speaks */}
      <g transform="translate(100 102)">
        {Array.from({ length: bars }).map((_, i) => {
          const centre = (bars - 1) / 2;
          const falloff = 1 - Math.abs(i - centre) / (centre + 1.2);
          const h = Math.max(2, 2 + level * 34 * falloff);
          return (
            <rect
              key={i}
              x={(i - centre) * 5 - 1.4}
              y={-h / 2}
              width="2.8"
              height={h}
              rx="1.4"
              fill="currentColor"
              opacity={0.45 + falloff * 0.5}
            />
          );
        })}
      </g>
    </svg>
  );
}

export default function Avatar({ agentLevel = 0, micLevel = 0, speaking = false, listening = false }) {
  const [hasPortrait, setHasPortrait] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => !cancelled && setHasPortrait(true);
    img.onerror = () => !cancelled && setHasPortrait(false);
    img.src = PORTRAIT_SRC;
    return () => {
      cancelled = true;
    };
  }, []);

  // The halo follows EVA while she talks and the visitor while she listens.
  const drive = speaking ? agentLevel : micLevel;
  const boosted = Math.min(1, drive * 3.2);

  return (
    <div className="avatar-wrap" data-speaking={speaking}>
      <div
        className="avatar-halo one"
        style={{ transform: `scale(${1 + boosted * 0.05})`, opacity: 0.35 + boosted * 0.6 }}
      />
      <div
        className="avatar-halo two"
        style={{ transform: `scale(${1 + boosted * 0.09})`, opacity: 0.18 + boosted * 0.45 }}
      />
      <div
        className="avatar-halo three"
        style={{ transform: `scale(${1 + boosted * 0.14})`, opacity: 0.08 + boosted * 0.3 }}
      />

      <div className="avatar-core" style={{ color: "var(--accent)" }}>
        {hasPortrait ? (
          <img src={PORTRAIT_SRC} alt="EVA" />
        ) : (
          <PlaceholderPortrait level={speaking ? boosted : 0} />
        )}
      </div>

      {listening && !speaking && (
        <div className="avatar-listening">
          <Equaliser level={micLevel} />
          Listening
        </div>
      )}
    </div>
  );
}

function Equaliser({ level }) {
  const bars = 5;
  return (
    <span className="eq" aria-hidden="true">
      {Array.from({ length: bars }).map((_, i) => {
        const falloff = 1 - Math.abs(i - (bars - 1) / 2) / bars;
        return (
          <span
            key={i}
            style={{ height: `${Math.max(3, Math.min(12, 3 + level * 90 * falloff))}px` }}
          />
        );
      })}
    </span>
  );
}
