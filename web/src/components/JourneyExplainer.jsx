import { useEffect, useMemo, useRef, useState } from "react";

/* The end-to-end journey, explained rather than demonstrated.

   This is deliberately not a screen recording. A recording shows one run of one
   scenario and goes stale the moment the UI moves; this shows the shape of the
   work, which is the thing a buyer is actually trying to understand.

   Everything animates from CSS driven by React state, so the whole diagram is
   legible frozen on any single step. That matters twice over: the global
   prefers-reduced-motion rule in styles.css disables every animation on the
   site, and a visitor who clicks straight to step 4 should not have to sit
   through steps 1-3 to understand it.

   Geometry lives in one 760x330 viewBox. The wire ids are shared between the
   drawn wire and the animated overlay that travels along it, so a coordinate
   only ever exists in one place. */

const STEP_MS = 6200;

const WIRES = {
  c1: "M130 166 H252",
  c2: "M334 132 C392 96, 436 75, 498 75",
  c3: "M348 166 H498",
  c5: "M334 200 C392 236, 436 259, 498 259",
};

const STEPS = [
  {
    id: "intent",
    tag: "Understand",
    title: "It works out what is actually being asked",
    body:
      "EVA picks out the intent behind a sentence — a duplicate charge on a " +
      "specific order — and holds on to it for the rest of the conversation. " +
      "No menu to navigate, and no starting again when the customer rephrases.",
    nodes: ["customer", "eva"],
    wire: "c1",
    show: ["bubble", "intentTag"],
  },
  {
    id: "knowledge",
    tag: "Know",
    title: "It answers from knowledge you trust",
    body:
      "Before it says anything, EVA reads from sources you have approved: your " +
      "policies, your product data, your procedures. The answer comes from what " +
      "your business has published, not from what a model recalled.",
    nodes: ["eva", "knowledge"],
    wire: "c2",
    show: ["intentTag"],
  },
  {
    id: "act",
    tag: "Act",
    title: "It takes the action, inside your permissions",
    body:
      "Resolving this means doing something — raising the refund in the system " +
      "that owns it. EVA acts only where it has been granted permission, only " +
      "within the limits you set, and every action lands in the audit trail.",
    nodes: ["eva", "gate", "systems"],
    wire: "c3",
    show: ["gateOk"],
  },
  {
    id: "verify",
    tag: "Verify",
    title: "It confirms the outcome before it closes",
    body:
      "EVA checks that the refund actually posted, then tells the customer what " +
      "happens next and when. A contact counts as resolved when the system says " +
      "so, not when the conversation stops.",
    nodes: ["eva", "systems"],
    wire: "c3",
    reverse: true,
    show: ["gateOk", "verifyBadge"],
  },
  {
    id: "escalate",
    tag: "Escalate",
    title: "When a person is needed, the context goes too",
    body:
      "Some cases should not be finished by software: a judgement call, a limit " +
      "exceeded, or a customer who simply asks for a person. EVA hands over with " +
      "the intent, the transcript and the actions already taken attached.",
    nodes: ["eva", "human"],
    wire: "c5",
    show: ["contextCard"],
  },
];

function prefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export default function JourneyExplainer() {
  const [step, setStep] = useState(0);
  // Autoplay is opt-out for everyone who has not asked for stillness. Starting
  // paused under reduced-motion is the point of the setting -- the CSS rule
  // alone would freeze the drawing while the step timer kept firing.
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const [inView, setInView] = useState(false);
  const sectionRef = useRef(null);
  const tabsRef = useRef(null);

  // Hold at step 1 until the section is actually on screen, so a visitor who
  // scrolls down after a minute does not arrive halfway through the story.
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => setInView(entry.isIntersecting),
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!playing || !inView) return;
    const t = setTimeout(() => setStep((s) => (s + 1) % STEPS.length), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, inView, step]);

  const active = STEPS[step];
  const on = useMemo(() => new Set(active.nodes), [active]);
  const shown = useMemo(() => new Set(active.show), [active]);
  const running = playing && inView;

  // Clicking or arrowing to a step is a request to look at that step, so it
  // stops the carousel rather than fighting the next tick.
  const goTo = (i) => {
    setStep(i);
    setPlaying(false);
  };

  const onTabKey = (e) => {
    const last = STEPS.length - 1;
    let next = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = step === last ? 0 : step + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = step === 0 ? last : step - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    goTo(next);
    tabsRef.current?.querySelectorAll("[role=tab]")[next]?.focus();
  };

  const box = (name) => `jx-box${on.has(name) ? " on" : ""}`;
  const lbl = (name) => `jx-lbl${on.has(name) ? " on" : ""}`;
  const sub = (name) => `jx-sub${on.has(name) ? " on" : ""}`;
  const fx = (name) => (shown.has(name) ? "jx-fx in" : "jx-fx out");

  return (
    <section className="shell journey" id="journey" ref={sectionRef}>
      <div className="j-head">
        <h2>From conversation to completed resolution</h2>
        <p>
          The same five steps sit behind every scenario on this page. This is the
          shape of the work &mdash; not a recording of the demo.
        </p>
      </div>

      <div className="j-frame">
        <div className="j-diagram">
          {/* The scroll container is separate from the cell so the pan hint
              below stays put while the diagram moves inside it. */}
          <div className="j-scroll">
          <svg
            viewBox="0 0 760 330"
            className="jx"
            role="img"
            aria-label={`Step ${step + 1} of ${STEPS.length}: ${active.title}`}
          >
            {/* ---- wires, drawn under everything ------------------------- */}
            {Object.entries(WIRES).map(([id, d]) => (
              <path key={id} d={d} className={`jx-wire${active.wire === id ? " on" : ""}`} />
            ))}
            {/* The travelling dash is what turns a static schematic into a
                direction. Step 4 reuses step 3's wire backwards: the action
                goes out, the confirmation comes back. */}
            <path
              key={`${active.id}-flow`}
              d={WIRES[active.wire]}
              pathLength="100"
              className={
                `jx-flow${active.reverse ? " rev" : ""}` + (running ? "" : " still")
              }
            />

            {/* ---- customer ---------------------------------------------- */}
            <g className={fx("bubble")}>
              {/* Tail first so the bubble's own fill hides where the two meet,
                  rather than a stroke running through the join. */}
              <path className="jx-bubble-tail" d="M64 100 L78 126 L92 100 Z" />
              <rect className="jx-bubble" x="14" y="44" width="180" height="64" rx="14" />
              <text className="jx-say" x="32" y="72">&ldquo;I&rsquo;ve been charged</text>
              <text className="jx-say" x="32" y="92">twice for my order.&rdquo;</text>
            </g>
            <rect className={box("customer")} x="26" y="138" width="104" height="56" rx="12" />
            <text className={lbl("customer")} x="78" y="172" textAnchor="middle">Customer</text>

            {/* ---- EVA ---------------------------------------------------- */}
            <circle className={`jx-eva${on.has("eva") ? " on" : ""}`} cx="300" cy="166" r="48" />
            <text className={`jx-eva-t${on.has("eva") ? " on" : ""}`} x="300" y="173" textAnchor="middle">
              EVA
            </text>

            {/* Sits low enough to clear the escalation curve leaving EVA, which
                passes about y=229 at this pill's right edge. */}
            <g className={fx("intentTag")}>
              <rect className="jx-pill" x="186" y="236" width="186" height="27" rx="13" />
              <text className="jx-pill-t" x="279" y="254" textAnchor="middle">
                intent &middot; duplicate charge
              </text>
            </g>
            <g className={fx("verifyBadge")}>
              <circle className="jx-tick-bg" cx="260" cy="126" r="15" />
              <path className="jx-tick" d="M253 126 l5 6 l10 -11" />
            </g>

            {/* ---- permission gate --------------------------------------- */}
            <rect className={`jx-gate${on.has("gate") ? " on" : ""}`} x="418" y="150" width="32" height="32" rx="9" />
            <path
              className={`jx-lock${on.has("gate") ? " on" : ""}`}
              d="M429 164v-3.5a5 5 0 0 1 10 0v3.5M426.5 164h15v11h-15z"
            />
            <text className={`jx-micro${shown.has("gateOk") ? " on" : ""}`} x="434" y="200" textAnchor="middle">
              permitted
            </text>

            {/* ---- the three destinations -------------------------------- */}
            <rect className={box("knowledge")} x="498" y="44" width="236" height="62" rx="12" />
            <text className={lbl("knowledge")} x="520" y="70">Trusted knowledge</text>
            <text className={sub("knowledge")} x="520" y="90">your approved sources</text>

            <rect className={box("systems")} x="498" y="136" width="236" height="62" rx="12" />
            <text className={lbl("systems")} x="520" y="162">Enterprise systems</text>
            <text className={sub("systems")} x="520" y="182">CRM &middot; orders &middot; billing</text>

            <rect className={box("human")} x="498" y="228" width="236" height="62" rx="12" />
            <text className={lbl("human")} x="520" y="254">Human agent</text>
            <text className={sub("human")} x="520" y="274">full context, no repeat</text>

            <g className={fx("contextCard")}>
              <rect className="jx-card" x="362" y="232" width="124" height="27" rx="8" />
              <text className="jx-card-t" x="424" y="250" textAnchor="middle">context attached</text>
            </g>
          </svg>
          </div>
          {/* Below 720px the diagram is held at a minimum width and pans rather
              than shrinking its labels into illegibility. The caption carries
              the whole story in text, so panning is optional. */}
          <p className="j-pan" aria-hidden="true">Swipe the diagram to pan</p>
        </div>

        {/* ---- caption + transport ------------------------------------- */}
        <div className="j-panel">
          <div
            className="j-cap"
            id={`j-panel-${active.id}`}
            role="tabpanel"
            aria-labelledby={`j-tab-${active.id}`}
          >
            <span className="j-num">
              Step {step + 1} of {STEPS.length}
            </span>
            <h3>{active.title}</h3>
            <p>{active.body}</p>
          </div>

          <div className="j-transport">
            <button
              type="button"
              className="j-play"
              onClick={() => setPlaying((p) => !p)}
              aria-label={playing ? "Pause the walkthrough" : "Play the walkthrough"}
            >
              {playing ? (
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                  <rect x="7" y="5" width="3.5" height="14" rx="1" />
                  <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                  <path d="M8 5.5v13l11-6.5z" />
                </svg>
              )}
              {playing ? "Pause" : "Play"}
            </button>

            <div className="j-tabs" role="tablist" ref={tabsRef} aria-label="Journey steps" onKeyDown={onTabKey}>
              {STEPS.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  id={`j-tab-${s.id}`}
                  aria-selected={i === step}
                  aria-controls={i === step ? `j-panel-${s.id}` : undefined}
                  tabIndex={i === step ? 0 : -1}
                  className={`j-tab${i === step ? " on" : ""}${i < step ? " done" : ""}`}
                  onClick={() => goTo(i)}
                >
                  <span className="j-tab-n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="j-tab-l">{s.tag}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Keyed on the step so the bar restarts rather than continuing from
              wherever the previous step left it. Paused, it reads as a dim
              full rail instead of an empty sliver that looks broken. */}
          <div className={`j-bar${running ? " run" : ""}`} aria-hidden="true">
            <span key={`${active.id}-bar`} style={{ animationDuration: `${STEP_MS}ms` }} />
          </div>
        </div>
      </div>

      <p className="j-foot">
        The same agent and the same actions run on voice, chat and digital channels.
      </p>
    </section>
  );
}
