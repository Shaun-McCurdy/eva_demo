import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Avatar from "./Avatar";
import { api } from "../lib/api";
import { accentVars } from "../lib/theme";

const FEATURES = [
  {
    title: "It hears tone, not just words",
    body: "Native-audio speech in and out, so pace, hesitation and frustration all land — and shape how she answers.",
    icon: <path d="M12 3v18M7 7v10M17 7v10M3 10v4M21 10v4" />,
  },
  {
    title: "Interrupt her mid-sentence",
    body: "Talk over EVA and she stops, listens and picks up where you took her. No wake words, no beeps, no menus.",
    icon: <path d="M4 12h6l3-7 3 14 2-7h2" />,
  },
  {
    title: "She hands over cleanly",
    body: "When a contact needs a person, the context goes with it. The customer never starts the story again.",
    icon: <path d="M4 17v-1a4 4 0 0 1 4-4h4m0 0-3-3m3 3-3 3M16 7h4v10h-4" />,
  },
  {
    title: "Nothing to install",
    body: "Everything here runs in the browser tab you already have open, over the same channels your contact centre uses.",
    icon: <path d="M3 5h18v11H3zM8 20h8M12 16v4" />,
  },
];

// One glyph per vertical, keyed by slug so a variant with an unknown slug still
// renders something rather than a hole.
const CHIP_ICONS = {
  concierge: <path d="M4 5h16v10H9l-5 4z" />,
  banking: <path d="M3 8h18v10H3zM3 8l9-4 9 4M7 13h4" />,
  healthcare: <path d="M12 5v14M5 12h14" />,
  retail: <path d="M6 8h12l-1 11H7zM9 8V6a3 3 0 0 1 6 0v2" />,
  utilities: <path d="M13 3 5 14h6l-1 7 8-11h-6z" />,
};

function Glyph({ children, size = 18 }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export default function Landing() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = "EVA — Enghouse Virtual Agent";
    api
      .publicAgents()
      .then((data) => setAgents(data.agents || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const primary = agents.find((a) => a.slug === "concierge") || agents[0];

  return (
    <main>
      {/* Copy left, EVA right. She is on the landing page rather than behind a
          click, so the first thing a visitor sees is the thing being sold. */}
      <section className="shell hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="dot" />
            Live voice demo
          </span>
          <h1>
            Talk to <span className="accent">EVA</span>.
            <br />
            She'll talk back.
          </h1>
          <p className="lede">
            A voice agent that hears intent, completes the task, and hands to a
            colleague with the context intact. Speak to her yourself, right in
            this tab.
          </p>
          <div className="hero-actions">
            <button
              className="btn btn-primary btn-lg"
              onClick={() => navigate(`/a/${primary?.slug || "concierge"}`)}
              disabled={!primary}
            >
              Start talking
            </button>
            <a className="btn btn-lg" href="#features">
              See how it works
            </a>
          </div>
          <p className="hero-status">
            <span className="dot" />
            {loading ? "Waking the agents…" : "Tap start — she's ready"}
          </p>
        </div>

        <div className="hero-stage" aria-hidden="true">
          <Avatar />
        </div>
      </section>

      <section className="shell scenarios" id="scenarios">
        <div className="sc-head">
          <h2 className="lbl">Or start in a specific scenario</h2>
          <p className="note">
            Same engine underneath — different objective, tone and escalation
            rules.
          </p>
        </div>

        {error && (
          <div className="notice" role="alert">
            {error}
          </div>
        )}

        {loading ? (
          <div className="centered">
            <span className="spinner" />
          </div>
        ) : (
          <div className="chips">
            {agents.map((agent) => (
              <button
                key={agent.slug}
                className="chip"
                style={accentVars(agent.accent)}
                onClick={() => navigate(`/a/${agent.slug}`)}
              >
                <span className="ico">
                  <Glyph>{CHIP_ICONS[agent.slug] || CHIP_ICONS.concierge}</Glyph>
                </span>
                <span className="vertical">{agent.vertical}</span>
                <span className="chip-name">{agent.name}</span>
                <span className="chip-tag">{agent.tagline}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="band" />

      <section className="shell features" id="features">
        <div className="f-h">
          <h2>Why it sounds different</h2>
          <p>Most voice bots take turns. This one holds a conversation.</p>
        </div>
        {/* One hairline grid rather than four floating cards: the 1px gap over a
            line-coloured background is what draws the dividers. */}
        <div className="fgrid">
          {FEATURES.map((f) => (
            <div className="feat" key={f.title}>
              <span className="fi">
                <Glyph size={21}>{f.icon}</Glyph>
              </span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
