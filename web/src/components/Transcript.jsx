import { useEffect, useRef } from "react";

const LABELS = { agent: "EVA", visitor: "You", system: "" };

export default function Transcript({ turns, agentName, onSend, canSend }) {
  const bodyRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const submit = (event) => {
    event.preventDefault();
    const value = inputRef.current?.value.trim();
    if (!value) return;
    onSend(value);
    inputRef.current.value = "";
  };

  return (
    <section className="transcript-panel" aria-label="Conversation transcript">
      <div className="transcript-head">
        <span>Transcript</span>
        <span>{turns.filter((t) => t.role !== "system").length} turns</span>
      </div>

      <div className="transcript-body" ref={bodyRef} aria-live="polite">
        {turns.length === 0 ? (
          <p className="transcript-empty">
            Everything {agentName} hears and says appears here, live.
          </p>
        ) : (
          turns.map((turn) => (
            <div key={turn.id} className={`turn ${turn.role}`}>
              {turn.role !== "system" && (
                <span className="label">
                  {turn.role === "agent" ? agentName || LABELS.agent : LABELS.visitor}
                </span>
              )}
              <div className="bubble">
                {turn.text}
                {!turn.finished && turn.role !== "system" && (
                  <span className="cursor" aria-hidden="true" />
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          ref={inputRef}
          type="text"
          placeholder={canSend ? "Or type instead…" : "Start the conversation first"}
          disabled={!canSend}
          aria-label="Type a message"
        />
        <button className="btn btn-sm" type="submit" disabled={!canSend}>
          Send
        </button>
      </form>
    </section>
  );
}
