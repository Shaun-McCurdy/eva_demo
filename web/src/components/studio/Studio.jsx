import { useCallback, useEffect, useMemo, useState } from "react";
import AgentEditor from "./AgentEditor";
import StudioGate from "./StudioGate";
import { api } from "../../lib/api";

export default function Studio() {
  const [authed, setAuthed] = useState(null); // null = still checking
  const [who, setWho] = useState("");
  const [agents, setAgents] = useState([]);
  const [voices, setVoices] = useState([]);
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState("view");
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    document.title = "Studio — EVA demo";
    api
      .session()
      .then((s) => {
        setWho(s.who || "");
        setAuthed(true);
      })
      .catch(() => setAuthed(false));
  }, []);

  const load = useCallback(async (preferSlug) => {
    const data = await api.studioAgents();
    setAgents(data.agents || []);
    setVoices(data.voices || []);
    const slug = preferSlug || selected;
    const found = (data.agents || []).find((a) => a.slug === slug);
    setSelected(found ? found.slug : (data.agents || [])[0]?.slug || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (authed) load().catch((err) => setError(err.message));
  }, [authed, load]);

  const builtins = useMemo(() => agents.filter((a) => a.builtin), [agents]);
  const variants = useMemo(() => agents.filter((a) => !a.builtin), [agents]);

  const currentAgent = useMemo(
    () => (mode === "create" ? draft : agents.find((a) => a.slug === selected) || null),
    [mode, draft, agents, selected]
  );

  const effectiveMode =
    mode === "create" ? "create" : currentAgent?.builtin ? "view" : "edit";

  const pick = (slug) => {
    setSelected(slug);
    setMode("view");
    setDraft(null);
    setError("");
    setNotice("");
  };

  const startClone = () => {
    const base = agents.find((a) => a.slug === selected);
    if (!base) return;
    setDraft({
      ...base,
      slug: "",
      name: `${base.name} — copy`,
      baseSlug: base.slug,
      builtin: false,
      enabled: true,
    });
    setMode("create");
    setError("");
    setNotice("");
  };

  const save = async (form) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (mode === "create") {
        const created = await api.createAgent({ ...form, baseSlug: draft?.baseSlug });
        setMode("view");
        setDraft(null);
        await load(created.slug);
        setNotice(`Created. It is live now at /a/${created.slug}`);
      } else {
        const updated = await api.updateAgent(form.slug, form);
        await load(updated.slug);
        setNotice("Saved. The next conversation will use these instructions.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete ${selected}? Its URL will stop working immediately.`)) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.deleteAgent(selected);
      setSelected(null);
      await load(builtins[0]?.slug);
      setNotice("Deleted.");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    setAuthed(false);
    setAgents([]);
  };

  if (authed === null) {
    return (
      <div className="centered">
        <span className="spinner" />
      </div>
    );
  }

  if (!authed) {
    return (
      <main className="studio">
        <div className="shell">
          <StudioGate
            onSignedIn={(name) => {
              setWho(name);
              setAuthed(true);
            }}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="studio">
      <div className="shell">
        <div className="studio-head">
          <div>
            <h1>Studio</h1>
            <p>
              Signed in as {who || "sales engineer"}. Clone an agent, rewrite its
              instructions, and demo it from its own URL.
            </p>
          </div>
          <div className="editor-actions">
            <button className="btn btn-sm" onClick={startClone} disabled={!selected}>
              Clone selected
            </button>
            <button className="btn btn-ghost btn-sm" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>

        <div className="studio-grid">
          <div className="agent-list">
            <span className="list-label">Built-in</span>
            {builtins.map((agent) => (
              <button
                key={agent.slug}
                className="list-item"
                data-selected={mode !== "create" && agent.slug === selected}
                onClick={() => pick(agent.slug)}
              >
                <span className="swatch" style={{ background: agent.accent }} />
                <span className="meta">
                  <strong>{agent.name}</strong>
                  <span>/a/{agent.slug}</span>
                </span>
                <span className="badge">Locked</span>
              </button>
            ))}

            <span className="list-label">Your agents</span>
            {variants.length === 0 && (
              <p className="help" style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>
                None yet. Select a built-in agent and clone it.
              </p>
            )}
            {variants.map((agent) => (
              <button
                key={agent.slug}
                className="list-item"
                data-selected={mode !== "create" && agent.slug === selected}
                onClick={() => pick(agent.slug)}
              >
                <span className="swatch" style={{ background: agent.accent }} />
                <span className="meta">
                  <strong>{agent.name}</strong>
                  <span>/a/{agent.slug}</span>
                </span>
                {!agent.enabled && <span className="badge">Off</span>}
              </button>
            ))}
          </div>

          {currentAgent ? (
            <AgentEditor
              agent={currentAgent}
              mode={effectiveMode}
              voices={voices}
              onSave={save}
              onDelete={remove}
              onClone={startClone}
              busy={busy}
              error={error}
              notice={notice}
            />
          ) : (
            <div className="card">
              <p style={{ color: "var(--text-muted)" }}>Pick an agent on the left.</p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
