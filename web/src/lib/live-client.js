/**
 * Browser client for the EVA live session.
 *
 * Adapted from Google's GeminiLiveAPI sample, with one deliberate change: the
 * browser no longer builds or sends the `setup` frame. It sends a single
 * line naming an agent, and the server builds setup from its own copy of that
 * agent's instructions. Nothing about the agent's behaviour is client-controlled,
 * so a public demo URL cannot be repurposed.
 */

import { CAPTURE_RATE } from "./media.js";

export const Msg = {
  READY: "READY",
  ERROR: "ERROR",
  TEXT: "TEXT",
  AUDIO: "AUDIO",
  SETUP_COMPLETE: "SETUP_COMPLETE",
  INPUT_TRANSCRIPTION: "INPUT_TRANSCRIPTION",
  OUTPUT_TRANSCRIPTION: "OUTPUT_TRANSCRIPTION",
  TURN_COMPLETE: "TURN_COMPLETE",
  INTERRUPTED: "INTERRUPTED",
  TOOL_CALL: "TOOL_CALL",
  CLOSED: "CLOSED",
};

function parseServerFrame(data) {
  if (data?.evaReady) return { type: Msg.READY, data: data.evaReady };
  if (data?.evaError) return { type: Msg.ERROR, data: data.evaError };

  const parts = data?.serverContent?.modelTurn?.parts;

  if (data?.setupComplete !== undefined) {
    return { type: Msg.SETUP_COMPLETE, data: null };
  }
  if (data?.serverContent?.interrupted) {
    return { type: Msg.INTERRUPTED, data: null };
  }
  if (data?.serverContent?.inputTranscription) {
    const t = data.serverContent.inputTranscription;
    return {
      type: Msg.INPUT_TRANSCRIPTION,
      data: { text: t.text || "", finished: !!t.finished },
    };
  }
  if (data?.serverContent?.outputTranscription) {
    const t = data.serverContent.outputTranscription;
    return {
      type: Msg.OUTPUT_TRANSCRIPTION,
      data: { text: t.text || "", finished: !!t.finished },
    };
  }
  if (data?.toolCall) {
    return { type: Msg.TOOL_CALL, data: data.toolCall };
  }
  if (parts?.length && parts[0].text) {
    return { type: Msg.TEXT, data: parts[0].text };
  }
  if (parts?.length && parts[0].inlineData) {
    return { type: Msg.AUDIO, data: parts[0].inlineData.data };
  }
  if (data?.serverContent?.turnComplete) {
    return { type: Msg.TURN_COMPLETE, data: null };
  }
  return null;
}

function socketUrl() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/live`;
}

export class EvaLiveClient {
  constructor(agentSlug) {
    this.agentSlug = agentSlug;
    this.socket = null;
    this.connected = false;
    this.onMessage = () => {};
    this.onOpen = () => {};
    this.onClose = () => {};
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.socket = new WebSocket(socketUrl());

      this.socket.onopen = () => {
        this.connected = true;
        // The whole client-side setup: name the agent, nothing more.
        this.socket.send(JSON.stringify({ agent: this.agentSlug }));
        this.onOpen();
      };

      this.socket.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        const message = parseServerFrame(payload);
        if (!message) return;

        if (!settled && message.type === Msg.READY) {
          settled = true;
          resolve(message.data);
        }
        if (!settled && message.type === Msg.ERROR) {
          settled = true;
          reject(new Error(message.data));
        }
        this.onMessage(message);
      };

      this.socket.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error("Could not reach the EVA service."));
        }
      };

      this.socket.onclose = () => {
        this.connected = false;
        this.onMessage({ type: Msg.CLOSED, data: null });
        this.onClose();
        if (!settled) {
          settled = true;
          reject(new Error("The connection closed before the session started."));
        }
      };
    });
  }

  #send(payload) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  // `media_chunks` was the old shape and is now rejected outright with a 1007
  // close: "realtime_input.media_chunks is deprecated. Use audio, video, or
  // text instead." The rate has to be declared in the MIME type -- the API
  // assumes 16 kHz if it is absent, so a silent mismatch would mean garbled
  // audio rather than an error.
  sendAudioChunk(base64Pcm) {
    this.#send({
      realtime_input: {
        audio: { mime_type: `audio/pcm;rate=${CAPTURE_RATE}`, data: base64Pcm },
      },
    });
  }

  sendImageChunk(base64Jpeg) {
    this.#send({
      realtime_input: {
        video: { mime_type: "image/jpeg", data: base64Jpeg },
      },
    });
  }

  sendText(text) {
    this.#send({
      client_content: {
        turns: [{ role: "user", parts: [{ text }] }],
        turn_complete: true,
      },
    });
  }

  disconnect() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already gone */
      }
      this.socket = null;
    }
    this.connected = false;
  }
}
