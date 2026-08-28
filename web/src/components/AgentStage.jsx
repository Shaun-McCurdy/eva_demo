import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Avatar from "./Avatar";
import Transcript from "./Transcript";
import { api } from "../lib/api";
import { EvaLiveClient, Msg } from "../lib/live-client";
import { CameraStreamer, MicStreamer, VoicePlayer } from "../lib/media";

let turnSeq = 0;
const nextId = () => `t${++turnSeq}`;

export default function AgentStage() {
  const { slug = "concierge" } = useParams();

  const [agent, setAgent] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | connecting | live | ended | error
  const [error, setError] = useState("");
  const [turns, setTurns] = useState([]);
  const [micLevel, setMicLevel] = useState(0);
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(false);

  const clientRef = useRef(null);
  const micRef = useRef(null);
  const playerRef = useRef(null);
  const cameraRef = useRef(null);
  const rafRef = useRef(null);

  // Stable identity on purpose. The Avatar keys its rAF loop on this, and an
  // inline object literal would tear the loop down and rebuild it on every
  // render -- which micLevel triggers several times a second. The refs
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
          text: last.text + text,
          finished: finished || last.finished,
        };
        return updated;
      }
      if (!text.trim() && !finished) return prev;
      return [...prev, { id: nextId(), role, text, finished: !!finished }];
    });
  }, []);

  const addSystemLine = useCallback((text) => {
    setTurns((prev) => [...prev, { id: nextId(), role: "system", text, finished: true }]);
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
    setMicLevel(0);
    setSpeaking(false);
    setCameraOn(false);
    setMuted(false);
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

        case Msg.INTERRUPTED:
          playerRef.current?.interrupt();
          speakingUntilRef.current = 0;
          setSpeaking(false);
          sealOpenTurns();
          break;

        case Msg.TURN_COMPLETE:
          sealOpenTurns();
          break;

        case Msg.ERROR:
          setError(String(message.data));
          setPhase("error");
          break;

        case Msg.CLOSED:
          setPhase((current) => (current === "live" ? "ended" : current));
          break;

        default:
          break;
      }
    },
    [appendChunk, sealOpenTurns]
  );

  // ---- start ------------------------------------------------------------
  const start = useCallback(async () => {
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

      await client.connect();

      const mic = new MicStreamer(client, { onLevel: setMicLevel });
      await mic.start();
      micRef.current = mic;

      setPhase("live");

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
  }, [slug, handleMessage, teardown]);

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

  const sendText = (text) => {
    clientRef.current?.sendText(text);
    setTurns((prev) => [...prev, { id: nextId(), role: "visitor", text, finished: true }]);
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
    <main className="stage" style={{ "--accent": agent.accent }}>
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
            <Avatar
              sources={audioSources}
              micLevel={micLevel}
              speaking={speaking}
              listening={live && !muted}
            />

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
                  <p className="who">{speaking ? agent.name : muted ? "Muted" : "Your turn"}</p>
                  <p className="hint">
                    {speaking
                      ? "Speak over her to interrupt."
                      : muted
                        ? "Unmute to keep talking."
                        : "Just start talking."}
                  </p>
                </>
              )}
              {phase === "ended" && <p className="hint">That's the end of the session.</p>}
            </div>

            <div className="controls">
              {!live ? (
                <button
                  className="btn btn-primary btn-lg"
                  onClick={start}
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
                    data-active={muted}
                    aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                    title={muted ? "Unmute" : "Mute"}
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
            canSend={live}
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
