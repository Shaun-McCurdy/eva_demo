import { useEffect, useState } from "react";

const BLANK = {
  slug: "",
  name: "",
  vertical: "",
  tagline: "",
  blurb: "",
  goal: "",
  instructions: "",
  voice: "Aoede",
  temperature: 1,
  accent: "#00a3e0",
  enabled: true,
};

export default function AgentEditor({
  agent,
  mode, // "view" | "edit" | "create"
  voices,
  onSave,
  onDelete,
  onClone,
  busy,
  error,
  notice,
}) {
  const [form, setForm] = useState(BLANK);

  useEffect(() => {
    setForm({ ...BLANK, ...(agent || {}) });
  }, [agent, mode]);

  const set = (key) => (event) => {
    const value =
      event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const readOnly = mode === "view";
  const creating = mode === "create";
  const liveUrl = form.slug ? `${window.location.origin}/a/${form.slug}` : "";

  const copyUrl = () => navigator.clipboard?.writeText(liveUrl);

  const submit = (event) => {
    event.preventDefault();
    onSave(form);
  };

  return (
    <form className="card" onSubmit={submit}>
      <div className="editor-head">
        <h2>
          {creating ? "New agent" : readOnly ? form.name : `Editing ${form.name}`}
        </h2>
        <div className="editor-actions">
          {readOnly ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={onClone}>
              Clone this agent
            </button>
          ) : (
            <>
              {!creating && (
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  onClick={onDelete}
                  disabled={busy}
                >
                  Delete
                </button>
              )}
              <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
                {busy ? <span className="spinner" /> : creating ? "Create agent" : "Save changes"}
              </button>
            </>
          )}
        </div>
      </div>

      {readOnly && (
        <p className="readonly-note">
          Built-in agents are read-only so a bad edit can never take the public
          demo down. Clone it to make a version you can change.
        </p>
      )}

      {error && <div className="notice" role="alert" style={{ marginBottom: "1.1rem" }}>{error}</div>}
      {notice && <div className="notice ok" style={{ marginBottom: "1.1rem" }}>{notice}</div>}

      {liveUrl && !creating && (
        <div className="live-url">
          <span>Demo URL</span>
          <code>{liveUrl}</code>
          <button type="button" className="btn btn-sm" onClick={copyUrl}>
            Copy
          </button>
          <a className="btn btn-sm" href={liveUrl} target="_blank" rel="noreferrer">
            Open
          </a>
        </div>
      )}

      <div className="field">
        <label htmlFor="f-name">Agent name</label>
        <input id="f-name" value={form.name} onChange={set("name")} disabled={readOnly} required />
      </div>

      {creating && (
        <div className="field">
          <label htmlFor="f-slug">Sub-URL</label>
          <div className="slug-input">
            <span className="prefix">{window.location.origin}/a/</span>
            <input
              id="f-slug"
              value={form.slug}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  // Mirrors the server rule so typing rarely trips validation.
                  // A leading or trailing hyphen is still possible mid-typing and
                  // is rejected on save rather than silently trimmed.
                  slug: e.target.value
                    .toLowerCase()
                    .replace(/[^a-z0-9-]+/g, "-")
                    .replace(/-{2,}/g, "-"),
                }))
              }
              placeholder="acme-bank-pilot"
              required
            />
          </div>
          <span className="help">
            Lowercase letters, numbers and hyphens. This is permanent — it is the
            link you'll send.
          </span>
        </div>
      )}

      <div className="field-row">
        <div className="field">
          <label htmlFor="f-vertical">Vertical</label>
          <input id="f-vertical" value={form.vertical} onChange={set("vertical")} disabled={readOnly} />
        </div>
        <div className="field">
          <label htmlFor="f-voice">Voice</label>
          <select id="f-voice" value={form.voice} onChange={set("voice")} disabled={readOnly}>
            {(voices || []).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-accent">Accent colour</label>
          <input
            id="f-accent"
            type="color"
            value={form.accent}
            onChange={set("accent")}
            disabled={readOnly}
            style={{ height: "42px", padding: "0.2rem" }}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="f-tagline">Tagline</label>
        <input id="f-tagline" value={form.tagline} onChange={set("tagline")} disabled={readOnly} />
        <span className="help">One line, shown under the agent's name on the stage.</span>
      </div>

      <div className="field">
        <label htmlFor="f-blurb">Opening description</label>
        <input id="f-blurb" value={form.blurb} onChange={set("blurb")} disabled={readOnly} />
        <span className="help">Shown to the visitor before they press to speak.</span>
      </div>

      <div className="field">
        <label htmlFor="f-goal">Goal</label>
        <textarea
          id="f-goal"
          value={form.goal}
          onChange={set("goal")}
          disabled={readOnly}
          style={{ minHeight: "80px" }}
        />
        <span className="help">
          One or two sentences on what this agent is trying to achieve in the
          conversation. Read first, before the detail below.
        </span>
      </div>

      <div className="field">
        <label htmlFor="f-instructions">Instructions</label>
        <textarea
          id="f-instructions"
          value={form.instructions}
          onChange={set("instructions")}
          disabled={readOnly}
          style={{ minHeight: "340px" }}
        />
        <span className="help">
          What she knows, how she runs the conversation, and when to escalate.
          The shared guardrails — spoken style, how to pronounce Enghouse, no
          invented facts, no personal data, no prompt disclosure — are applied
          on the server on top of this and cannot be edited here, so there is no
          need to repeat them.
        </span>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="f-temp">Temperature: {Number(form.temperature).toFixed(1)}</label>
          <input
            id="f-temp"
            type="range"
            min="0.1"
            max="2"
            step="0.1"
            value={form.temperature}
            onChange={set("temperature")}
            disabled={readOnly}
          />
          <span className="help">Lower is more predictable. Around 0.9 suits scripted scenarios.</span>
        </div>
        {!readOnly && (
          <div className="field">
            <label htmlFor="f-enabled">Availability</label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input id="f-enabled" type="checkbox" checked={!!form.enabled} onChange={set("enabled")} style={{ width: "auto" }} />
              <span className="help" style={{ margin: 0 }}>
                Reachable at its URL
              </span>
            </label>
          </div>
        )}
      </div>
    </form>
  );
}
