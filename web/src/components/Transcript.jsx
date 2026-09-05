import { useEffect, useRef } from "react";

const LABELS = { agent: "EVA", visitor: "You", system: "" };

export default function Transcript({ turns, agentName, onSend, canSend, live }) {
  const bodyRef = useRef(null);
  const inputRef = useRef(null);
  const pinnedToBottom = useRef(true);

  // Follow the conversation, but only while the reader is actually at the
  // bottom. Transcription streams in a few chunks a second, so scrolling
  // unconditionally would yank them back down the instant they scroll up to
  // re-read something.
  const trackScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottom.current = fromBottom < 40;
  };

  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
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

      <div
        className="transcript-body"
        ref={bodyRef}
        onScroll={trackScroll}
        aria-live="polite"
      >
        {turns.length === 0 ? (
          <p className="transcript-empty">
            Everything {agentName} hears and says appears here, live. You can
            speak, or type below to begin.
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
              {turn.links?.length > 0 && (
                <ul className="turn-links">
                  {turn.links.map((source) => (
                    <li key={source.link}>
                      <a
                        href={source.link}
                        // A same-tab navigation would tear down the live
                        // WebSocket mid-conversation. noreferrer alongside
                        // noopener because these URLs come from a crawled
                        // index, not from us.
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {source.title}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          ref={inputRef}
          type="text"
          placeholder={
            !canSend
              ? "Connecting…"
              : live
                ? "Or type instead…"
                : `Type to start talking to ${agentName || "EVA"}…`
          }
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
