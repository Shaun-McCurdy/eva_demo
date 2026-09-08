import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Avatar from "./Avatar";
import JourneyExplainer from "./JourneyExplainer";
import { api } from "../lib/api";
import { DEMO_URL } from "../lib/site";
import { accentVars } from "../lib/theme";

/* Copy on this page follows the naming rules written down in lib/site.js:
   EnghouseAI is the portfolio, Enghouse Virtual Agent (EVA) is the product,
   and an "AI agent" is one deployed EVA working a queue. EVA takes "it".

   Nothing here quotes a containment rate, a saving, a customer name or a
   named integration -- the same restriction personas.py puts on EVA's own
   speech applies to the page selling it. */

/* The portfolio -> product -> deployed-agent chain, stated once so a visitor
   reading the measurement section already knows what "AI agent" refers to. */
const NAMING = [
  {
    term: "EnghouseAI",
    kind: "the portfolio",
    def:
      "The AI portfolio around the Enghouse contact centre platforms: virtual " +
      "agents, insights, quality management, knowledge and workforce management.",
  },
  {
    term: "Enghouse Virtual Agent",
    kind: "the product",
    def:
      "EVA. The product inside that portfolio which holds the conversation and " +
      "completes the task, across voice, chat and digital channels.",
  },
  {
    term: "AI agent",
    kind: "one deployment",
    def:
      "A single deployed EVA, working a queue alongside your human agents — and " +
      "managed and measured the same way they are.",
  },
];

/* The user's own KPI list. Deliberately no figures against them: the page can
   say what is measured without inventing what it measured. */
const KPIS = [
  {
    name: "Resolution rate",
    desc: "The share of contacts it finished, rather than passed on.",
  },
  {
    name: "Transfer rate",
    desc: "How often it handed to a person, and at which step that happened.",
  },
  {
    name: "Quality",
    desc: "Scored against the same evaluation criteria as your human agents.",
  },
  {
    name: "CSAT",
    desc: "Asked of the customer the same way, so the two are comparable.",
  },
  {
    name: "Cost per resolution",
    desc: "The figure that shows whether the automation paid for itself.",
  },
];

const TRUST = [
  {
    title: "Permissions",
    body:
      "Scoped, explicit access to systems and actions. What an agent may do is a " +
      "setting you own, not a behaviour that emerges.",
    icon: <path d="M12 3 4 6v5.5c0 4.6 3.3 8.2 8 9.5 4.7-1.3 8-4.9 8-9.5V6zM9.5 12l2 2 3.5-4" />,
  },
  {
    title: "Guardrails",
    body:
      "Topic boundaries, refusal rules and value limits are enforced outside the " +
      "conversation, where a customer's words cannot move them.",
    // Inward brackets around a contained line: bounded, rather than the hash
    // this used to be, which read as a grid.
    icon: <path d="M9 4H4v16h5M15 4h5v16h-5M12 8.5v7" />,
  },
  {
    title: "Auditability",
    body:
      "Every turn, retrieval and action is logged and attributable, so a " +
      "resolution can be reconstructed afterwards.",
    icon: <path d="M6 3h9l3 3v15H6zM9 9h6M9 13h6M9 17h4" />,
  },
  {
    title: "Data handling",
    body:
      "Runs under your existing rules for residency, retention and redaction. " +
      "Sensitive details need not enter the conversation to finish the task.",
    icon: <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />,
  },
  {
    title: "Human escalation",
    body:
      "A person stays reachable throughout. The route to one is a designed path, " +
      "not a failure state.",
    icon: <path d="M4 20v-1a4 4 0 0 1 4-4h3m9-4h-6m0 0 2.5-2.5M15 11l2.5 2.5M10 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" />,
  },
];

/* Why the live conversation itself holds up. Kept last, because it describes
   the demo rather than the product's commercial case. */
const FEATURES = [
  {
    title: "It hears tone, not just words",
    body: "Native-audio speech in and out, so pace, hesitation and frustration all land — and shape the reply.",
    icon: <path d="M12 3v18M7 7v10M17 7v10M3 10v4M21 10v4" />,
  },
  {
    title: "Interrupt it mid-sentence",
    body: "Talk over EVA and it stops, listens and picks up from where you took it. No wake words, no beeps, no menus.",
    icon: <path d="M4 12h6l3-7 3 14 2-7h2" />,
  },
  {
    title: "One agent, every channel",
    body: "The same intent handling, knowledge and actions on voice, chat and digital — not a separate bot per channel.",
    icon: <path d="M4 6h16v9H4zM8 19h8M12 15v4M17 3l3 3-3 3" />,
  },
  {
    title: "Nothing to install",
    body: "This runs in the browser tab you already have open, over the same channels your contact centre uses.",
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
    document.title = "EVA — the Enghouse Virtual Agent that resolves";
    api
      .publicAgents()
      .then((data) => setAgents(data.agents || []))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const primary = agents.find((a) => a.slug === "concierge") || agents[0];

  return (
    <main>
      {/* Copy left, EVA right. The avatar is on the landing page rather than
          behind a click, so the first thing a visitor sees is the thing being
          sold. */}
      <section className="shell hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="dot" />
            Outcome First AI · live voice demo
          </span>
          <h1>
            Don't just respond.
            <br />
            <span className="accent">Resolve.</span>
          </h1>
          <p className="lede">
            EVA, the Enghouse Virtual Agent, works out what a customer needs,
            completes the task in your systems, and confirms it actually
            happened. Talk to it yourself, right in this tab.
          </p>
          <div className="hero-actions">
            <button
              className="btn btn-primary btn-lg"
              onClick={() => navigate(`/a/${primary?.slug || "concierge"}`)}
              disabled={!primary}
            >
              Start talking
            </button>
            <a className="btn btn-lg" href="#journey">
              See how it resolves
            </a>
          </div>
          <p className="hero-status">
            <span className="dot" />
            {loading ? "Waking the agents…" : "Tap start — it's ready"}
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
            Same engine underneath — different objective, systems and escalation
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

      <JourneyExplainer />

      <div className="band" />

      {/* The vocabulary, before the section that leans on it. */}
      <section className="shell naming" id="naming">
        <div className="s-head">
          <h2>Where the names fit</h2>
          <p>
            Three names, one line of descent — so it is always clear which one a
            sentence is about.
          </p>
        </div>
        <ol className="nm-list">
          {NAMING.map((n, i) => (
            <li className="nm-row" key={n.term} data-depth={i}>
              <span className="nm-rail" aria-hidden="true" />
              <div className="nm-body">
                <h3>
                  {n.term}
                  <span className="nm-kind">{n.kind}</span>
                </h3>
                <p>{n.def}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="band" />

      <section className="shell metrics" id="measure">
        <div className="s-head">
          <h2>Manage AI agents the way you manage your team</h2>
          <p>
            An AI agent is not a side project with its own dashboard. It is
            capacity in a queue — so it belongs in the same workforce view,
            answering the same questions you already ask of your people.
          </p>
        </div>
        <div className="kgrid">
          {KPIS.map((k) => (
            <div className="kpi" key={k.name}>
              <h3>{k.name}</h3>
              <p>{k.desc}</p>
            </div>
          ))}
        </div>
        <p className="m-note">
          Because the AI and the people are measured on one basis, you can tell
          whether automation is resolving contacts or just moving them — and
          route accordingly.
        </p>
      </section>

      <div className="band" />

      <section className="shell trust" id="trust">
        <div className="s-head">
          <h2>Enterprise controls, not good intentions</h2>
          <p>
            Everything an AI agent may do is something you configured, and
            everything it did is something you can inspect.
          </p>
        </div>
        <div className="tgrid">
          {TRUST.map((t) => (
            <div className="tcard" key={t.title}>
              <span className="ti">
                <Glyph size={20}>{t.icon}</Glyph>
              </span>
              <h3>{t.title}</h3>
              <p>{t.body}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="band" />

      <section className="shell features" id="features">
        <div className="s-head">
          <h2>Why the conversation itself holds up</h2>
          <p>
            Most voice bots take turns. This one holds a conversation — and you
            can test that in the next thirty seconds.
          </p>
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

      <section className="shell closer">
        <div className="closer-inner">
          <h2>See it against your own contact centre</h2>
          <p>
            Bring the contact type that costs you the most. We will walk through
            where an AI agent would resolve it end to end, and where it should
            hand to a person.
          </p>
          <div className="closer-actions">
            <a
              className="btn btn-primary btn-lg"
              href={DEMO_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Book a demo
            </a>
            <button
              className="btn btn-lg"
              onClick={() => navigate(`/a/${primary?.slug || "concierge"}`)}
              disabled={!primary}
            >
              Talk to EVA first
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
