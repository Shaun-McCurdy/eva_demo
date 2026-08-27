import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

const FEATURES = [
  {
    title: "It hears tone, not just words",
    body: "Native-audio speech in and out, so pace, hesitation and frustration all land — and shape how she answers.",
  },
  {
    title: "Interrupt her mid-sentence",
    body: "Talk over EVA and she stops, listens and picks up where you took her. No wake words, no beeps, no menus.",
  },
  {
    title: "She hands over cleanly",
    body: "When a contact needs a person, the context goes with it. The customer never starts the story again.",
  },
  {
    title: "Nothing to install",
    body: "Everything here runs in the browser tab you already have open, over the same channels your contact centre uses.",
  },
];

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
      <section className="hero">
        <div className="shell">
          <span className="eyebrow">
            <span className="dot" />
            Live voice demo
          </span>
          <h1>
            Talk to <span className="accent">EVA</span>.
            <br />
            She'll talk back.
          </h1>
          <p className="hero-sub">
            The Enghouse Virtual Agent handles real conversations across voice,
            chat and messaging — understanding intent, completing the task, and
            handing to a colleague with the context intact. Pick a scenario and
            have the conversation yourself.
          </p>
          <div className="hero-actions">
            <button
              className="btn btn-primary btn-lg"
              onClick={() => navigate(`/a/${primary?.slug || "concierge"}`)}
              disabled={!primary}
            >
              Start talking
            </button>
            <a className="btn btn-lg" href="#scenarios">
              See the scenarios
            </a>
          </div>
        </div>
      </section>

      <section className="section" id="scenarios">
        <div className="shell">
          <div className="section-head">
            <h2>Choose a conversation</h2>
            <p>
              Each one is a different agent with its own objective, tone and
              escalation rules. Same engine underneath.
            </p>
          </div>

          {error && <div className="notice" role="alert">{error}</div>}

          {loading ? (
            <div className="centered">
              <span className="spinner" />
            </div>
          ) : (
            <div className="agent-grid">
              {agents.map((agent) => (
                <button
                  key={agent.slug}
                  className="agent-card"
                  style={{ "--accent": agent.accent }}
                  onClick={() => navigate(`/a/${agent.slug}`)}
                >
                  <span className="vertical">{agent.vertical}</span>
                  <h3>{agent.name}</h3>
                  <p className="tagline">{agent.tagline}</p>
                  <p className="blurb">{agent.blurb}</p>
                  <span className="go">
                    Start talking <span className="arrow">→</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <div className="shell">
          <div className="section-head">
            <h2>Why it sounds different</h2>
            <p>
              Most voice bots take turns. This one holds a conversation.
            </p>
          </div>
          <div className="feature-grid">
            {FEATURES.map((f) => (
              <div className="feature" key={f.title}>
                <h4>{f.title}</h4>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
