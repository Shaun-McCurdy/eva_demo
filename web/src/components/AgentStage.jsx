import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Avatar from "./Avatar";
import Transcript from "./Transcript";
import { api } from "../lib/api";
import { EvaLiveClient, Msg } from "../lib/live-client";
import { CameraStreamer, MicStreamer, VoicePlayer } from "../lib/media";
import { accentVars } from "../lib/theme";
import { correctTranscript } from "../lib/transcript-text";

let turnSeq = 0;
const nextId = () => `t${++turnSeq}`;

export default function AgentStage() {
  const { slug = "concierge" } = useParams();

  const [agent, setAgent] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | connecting | live | ended | error
  const [error, setError] = useState("");
  const [turns, setTurns] = useState([]);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [micBlocked, setMicBlocked] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [searching, setSearching] = useState(false);

  const clientRef = useRef(null);
  const micRef = useRef(null);
  const playerRef = useRef(null);
  const cameraRef = useRef(null);
  const rafRef = useRef(null);

  // Stable identity on purpose. The Avatar keys its rAF loop on this, and an
  // inline object literal would tear the loop down and rebuild it on every
  // render -- which any state change triggers. The refs
  // themselves never change, so an empty dep list is correct.
  const audioSources = useMemo(() => ({ player: playerRef, mic: micRef }), []);
  const speakingUntilRef = useRef(0);

  // ---- load the agent's public profile ---------------------------------
  useEffect(() => {
    let cancelled = false;
    setAgent(null);
    setLoadError("");
    api
      .publicAgent(slug)
      .then((data) => !cancelled && setAgent(data))
      .catch((err) => !cancelled && setLoadError(err.message));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (agent?.name) document.title = `${agent.name} — EVA demo`;
  }, [agent]);

  // ---- transcript assembly ---------------------------------------------
  const appendChunk = useCallback((role, text, finished) => {
    setTurns((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === role && !last.finished) {
        const updated = [...prev];
        updated[updated.length - 1] = {
          ...last,
          // Corrected after concatenation, not on the incoming chunk: the
          // company name routinely straddles a chunk boundary, and half of it
          // is unrecognisable on its own.
          text: correctTranscript(last.text + text),
          finished: finished || last.finished,
        };
        return updated;
      }
      if (!text.trim() && !finished) return prev;
      return [
        ...prev,
        { id: nextId(), role, text: correctTranscript(text), finished: !!finished },
      ];
    });
  }, []);

  // `links` is how a page reaches the visitor without EVA ever seeing a URL:
  // she is given the passage text only, the browser is given the links, and
  // they meet here in the transcript rather than in anything she says.
  const addSystemLine = useCallback((text, links = null) => {
    setTurns((prev) => [
      ...prev,
      { id: nextId(), role: "system", text, links, finished: true },
    ]);
  }, []);

  const sealOpenTurns = useCallback(() => {
    setTurns((prev) => prev.map((t) => (t.finished ? t : { ...t, finished: true })));
  }, []);

  // ---- teardown ---------------------------------------------------------
  const teardown = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    cameraRef.current?.stop();
    cameraRef.current = null;
    micRef.current?.stop();
    micRef.current = null;
    playerRef.current?.destroy();
    playerRef.current = null;
    clientRef.current?.disconnect();
    clientRef.current = null;
    setSpeaking(false);
    setSearching(false);
    setCameraOn(false);
    setMuted(false);
    setMicBlocked(false);
  }, []);

  useEffect(() => teardown, [teardown]);

  const stop = useCallback(() => {
    teardown();
    sealOpenTurns();
    setPhase("ended");
    addSystemLine("Conversation ended.");
  }, [teardown, sealOpenTurns, addSystemLine]);

  // ---- incoming messages ------------------------------------------------
  const handleMessage = useCallback(
    (message) => {
      switch (message.type) {
        case Msg.AUDIO:
          // Mark EVA as speaking for a moment past the last chunk, so the
          // avatar does not flicker between packets.
          speakingUntilRef.current = performance.now() + 450;
          setSpeaking(true);
          playerRef.current?.play(message.data);
          break;

        case Msg.OUTPUT_TRANSCRIPTION:
          appendChunk("agent", message.data.text, message.data.finished);
          break;

        case Msg.INPUT_TRANSCRIPTION:
          appendChunk("visitor", message.data.text, message.data.finished);
          break;

        case Msg.TEXT:
          appendChunk("agent", message.data, false);
          break;

        case Msg.TOOL_STATUS: {
          // The model is blocked for the whole lookup and says nothing, so
          // without this the avatar just sits there and the visitor assumes the
          // line has dropped. This is the only thing on screen during it.
          const { state, sources } = message.data || {};
          if (state === "searching") {
            setSearching(true);
            break;
          }
          setSearching(false);
          const found = sources || [];
          if (!found.length) {
            // "couldn't reach" and "found nothing" need different fixes, and on
            // a demo they need different reactions from whoever is presenting.
            addSystemLine(
              state === "error"
                ? "Could not reach the knowledge base."
                : "Looked for that and found nothing."
            );
            break;
          }
          const names = [...new Set(found.map((s) => s.source).filter(Boolean))];
          // One entry per page, not per passage: several passages routinely
          // come from the same URL and listing it three times reads as a bug.
          const links = [];
          const seen = new Set();
          for (const source of found) {
            if (!source.link || seen.has(source.link)) continue;
            seen.add(source.link);
            links.push({
              title: source.title || source.link,
              summary: source.summary || "",
              link: source.link,
            });
            if (links.length === 3) break;
          }
          addSystemLine(`Looked in ${names.join(" and ")}.`, links);
          break;
        }

        case Msg.INTERRUPTED:
          playerRef.current?.interrupt();
          speakingUntilRef.current = 0;
          setSpeaking(false);
          // A visitor interrupting cancels the lookup upstream, so no "done"
          // frame is coming and the flag would otherwise stick on for good.
          setSearching(false);
          sealOpenTurns();
          break;

        case Msg.TURN_COMPLETE:
          setSearching(false);
          sealOpenTurns();
          break;

        case Msg.ERROR:
          setSearching(false);
          setError(String(message.data));
          setPhase("error");
          break;

        case Msg.CLOSED:
          setSearching(false);
          setPhase((current) => (current === "live" ? "ended" : current));
          break;

        default:
          break;
      }
    },
    [appendChunk, sealOpenTurns, addSystemLine]
  );

  // ---- start ------------------------------------------------------------
  /**
   * `opening` is text the visitor typed before the session existed. When it is
   * present EVA's scripted greeting is suppressed, so she answers the question
   * instead of talking past it.
   */
  const start = useCallback(async (openingArg = null) => {
    // Only a real string counts as an opening message. Wired directly to an
    // onClick this would otherwise receive a MouseEvent, suppress the greeting,
    // and then fail trying to serialise a DOM node onto the wire.
    const opening =
      typeof openingArg === "string" && openingArg.trim() ? openingArg : null;

    setError("");
    setPhase("connecting");
    setTurns([]);

    try {
      const player = new VoicePlayer();
      await player.init();
      playerRef.current = player;

      const client = new EvaLiveClient(slug);
      client.onMessage = handleMessage;
      clientRef.current = client;

      await client.connect({ greet: !opening });

      // The microphone is required to start by voice and optional when the
      // visitor started by typing -- someone who chose to type may well have
      // declined it, and the session works without it. EVA still answers out
      // loud; they just keep using the composer.
      let micOk = true;
      try {
        const mic = new MicStreamer(client);
        await mic.start();
        micRef.current = mic;
        setMicBlocked(false);
      } catch (err) {
        if (!opening) throw err;
        micOk = false;
        setMicBlocked(true);
      }

      setPhase("live");

      if (opening) {
        client.sendText(opening);
        setTurns([{ id: nextId(), role: "visitor", text: opening, finished: true }]);
      }
      // After the opening turn, which replaces the transcript wholesale.
      if (!micOk) {
        addSystemLine("No microphone — keep typing and EVA will answer out loud.");
      }

      // Only job left here is deciding when EVA has stopped talking. The
      // avatar reads the audio graph itself, so this no longer needs to push a
      // level into state -- which was re-rendering the whole stage 60x a second
      // to feed a prop nothing consumed any more.
      const tick = () => {
        const level = playerRef.current?.level() ?? 0;
        if (performance.now() > speakingUntilRef.current && level < 0.01) {
          setSpeaking(false);
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      teardown();
      const message =
        err?.name === "NotAllowedError"
          ? "Microphone access was blocked. Allow it in your browser and try again."
          : err?.message || "Could not start the conversation.";
      setError(message);
      setPhase("error");
    }
  }, [slug, handleMessage, teardown, addSystemLine]);

  // The composer is live before the session is. Typing is a way in, not just a
  // fallback once you are already talking.
  const sendText = useCallback(
    (text) => {
      if (clientRef.current && phase === "live") {
        clientRef.current.sendText(text);
        setTurns((prev) => [
          ...prev,
          { id: nextId(), role: "visitor", text, finished: true },
        ]);
        return;
      }
      start(text);
    },
    [phase, start]
  );

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    micRef.current?.setMuted(next);
  };

  const toggleCamera = async () => {
    if (cameraOn) {
      cameraRef.current?.stop();
      cameraRef.current = null;
      setCameraOn(false);
      addSystemLine("Camera off.");
      return;
    }
    try {
      const camera = new CameraStreamer(clientRef.current);
      await camera.start();
      cameraRef.current = camera;
      setCameraOn(true);
      addSystemLine("Camera on — EVA can see what you show her.");
    } catch {
      addSystemLine("Could not start the camera.");
    }
  };

  // ---- render -----------------------------------------------------------
  if (loadError) {
    return (
      <div className="centered">
        <h1>No agent at this address</h1>
        <p style={{ color: "var(--text-muted)" }}>{loadError}</p>
        <a className="btn" href="/">
          Back to all agents
        </a>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="centered">
        <span className="spinner" />
      </div>
    );
  }

  const live = phase === "live";
  const statusText = {
    idle: "Ready",
    connecting: "Connecting",
    live: "Live",
    ended: "Ended",
    error: "Problem",
  }[phase];

  return (
    <main className="stage" style={accentVars(agent.accent)}>
      <div className="shell">
        <div className="stage-top">
          <div className="stage-title">
            <h1>{agent.name}</h1>
            <p className="tagline">{agent.tagline}</p>
          </div>
          <span className="status-chip" data-state={phase === "live" ? "live" : phase}>
            <span className="led" />
            {statusText}
          </span>
        </div>

        {error && (
          <div className="notice" role="alert" style={{ marginBottom: "1.2rem" }}>
            {error}
          </div>
        )}

        <div className="stage-body">
          <section className="avatar-panel">
            <Avatar sources={audioSources} speaking={speaking} />

            <div className="caption">
              {phase === "idle" && (
                <>
                  <p className="line">{agent.blurb}</p>
                  <p className="hint" style={{ marginTop: "0.4rem" }}>
                    Your microphone stays on while you talk. Interrupt her any time.
                  </p>
                </>
              )}
              {phase === "connecting" && <p className="hint">Waking EVA up…</p>}
              {live && (
                <>
                  <p className="who">
                    {searching
                      ? "Looking that up"
                      : speaking
                        ? agent.name
                        : muted
                          ? "Muted"
                          : "Your turn"}
                  </p>
                  <p className="hint">
                    {searching ? (
                      <span className="searching-hint">
                        <span className="searching-dots" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                        </span>
                        Checking Enghouse sources — she'll answer in a moment.
                      </span>
                    ) : speaking ? (
                      "Speak over her to interrupt."
                    ) : muted ? (
                      "Unmute to keep talking."
                    ) : (
                      "Just start talking."
                    )}
                  </p>
                </>
              )}
              {phase === "ended" && <p className="hint">That's the end of the session.</p>}
            </div>

            <div className="controls">
              {!live ? (
                <button
                  className="btn btn-primary btn-lg"
                  onClick={() => start()}
                  disabled={phase === "connecting"}
                >
                  {phase === "connecting" ? (
                    <>
                      <span className="spinner" /> Connecting
                    </>
                  ) : phase === "ended" || phase === "error" ? (
                    "Start again"
                  ) : (
                    "Click to speak"
                  )}
                </button>
              ) : (
                <>
                  <button
                    className="icon-btn"
                    onClick={toggleMute}
                    disabled={micBlocked}
                    data-active={muted}
                    aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                    title={micBlocked ? "No microphone available" : muted ? "Unmute" : "Mute"}
                  >
                    {muted ? <MicOffIcon /> : <MicIcon />}
                  </button>
                  <button
                    className="icon-btn"
                    onClick={toggleCamera}
                    data-active={cameraOn}
                    aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
                    title={cameraOn ? "Camera off" : "Show EVA something"}
                  >
                    <CameraIcon />
                  </button>
                  <button
                    className="icon-btn"
                    onClick={stop}
                    data-danger="true"
                    aria-label="End conversation"
                    title="End conversation"
                  >
                    <HangUpIcon />
                  </button>
                </>
              )}
            </div>
          </section>

          <Transcript
            turns={turns}
            agentName={agent.name}
            onSend={sendText}
            canSend={phase !== "connecting"}
            live={live}
          />
        </div>
      </div>
    </main>
  );
}

/* ---- icons ------------------------------------------------------------- */

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

function MicIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" {...stroke} />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" {...stroke} />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 9V6a3 3 0 0 1 6 0v5M5 11a7 7 0 0 0 11 5M12 18v3M4 3l16 18" {...stroke} />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2.5" y="6.5" width="14" height="11" rx="2.5" {...stroke} />
      <path d="M16.5 11l5-3v8l-5-3z" {...stroke} />
    </svg>
  );
}

function HangUpIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3.5 13.5c5-4 11.5-4 17 0l.5-2.5c-6-5-12.5-5-18 0z"
        {...stroke}
        transform="rotate(135 12 12)"
      />
    </svg>
  );
}
