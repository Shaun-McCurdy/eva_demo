/**
 * Audio and video capture/playback for the EVA live session.
 *
 * Derived from Google's media-utils sample. Added on top: RMS level metering on
 * both the microphone and the playback path, plus per-voice spectra for the
 * avatar's two rings, and a speaking flag so the UI knows who has the floor.
 */

// Bins the avatar draws per voice: enough to see consonants land, few enough
// to stay legible at 200px.
export const SPECTRUM_BINS = 56;

// Exported: the Live API needs this rate declared in the audio MIME type,
// and a mismatch there produces garbled audio rather than an error.
export const CAPTURE_RATE = 16000; // Gemini expects 16 kHz in
const PLAYBACK_RATE = 24000; // Gemini sends 24 kHz out

/**
 * Reduce an AnalyserNode's FFT to `out.length` bins in 0..1.
 *
 * Only the low 40% of the transform is read: above roughly 8 kHz there is
 * nothing in a speech signal worth drawing, and including it would spend most
 * of the visualiser's width on a flat line.
 */
export function readSpectrum(analyser, bytes, out) {
  if (!analyser) { out.fill(0); return 0; }
  analyser.getByteFrequencyData(bytes);
  const span = Math.floor(bytes.length * 0.4);
  let sum = 0;
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor((i / out.length) * span);
    const b = Math.max(a + 1, Math.floor(((i + 1) / out.length) * span));
    let peak = 0;
    for (let j = a; j < b; j++) if (bytes[j] > peak) peak = bytes[j];
    out[i] = peak / 255;
    sum += out[i];
  }
  return Math.min(1, (sum / out.length) * 2.2);
}


function rms(float32) {
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  return Math.sqrt(sum / float32.length);
}

function toPCM16(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s * 0x7fff;
  }
  return int16.buffer;
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return window.btoa(binary);
}

/** Captures the microphone and streams 16 kHz PCM to the client. */
export class MicStreamer {
  constructor(client) {
    this.client = client;
    this.audioContext = null;
    this.worklet = null;
    this.mediaStream = null;
    this.streaming = false;
    this.muted = false;
    this.analyser = null;
    this.freqBytes = null;
  }

  /** Fills `out` with the visitor's spectrum and returns their level, 0..1. */
  spectrum(out) {
    if (this.muted) { out.fill(0); return 0; }
    return readSpectrum(this.analyser, this.freqBytes, out);
  }

  async start(deviceId = null) {
    const audio = {
      sampleRate: CAPTURE_RATE,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (deviceId) audio.deviceId = { exact: deviceId };

    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio });

    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: CAPTURE_RATE,
    });
    await this.audioContext.audioWorklet.addModule(
      "/audio-processors/capture.worklet.js"
    );
    this.worklet = new AudioWorkletNode(
      this.audioContext,
      "audio-capture-processor"
    );

    // The visitor's side gets the same analyser treatment as playback, so both
    // halves of the avatar are measured identically. Taking level from here
    // rather than from the raw worklet buffer also puts both sides on one
    // smoothing constant, instead of one gliding while the other jitters.
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.6;
    this.freqBytes = new Uint8Array(this.analyser.frequencyBinCount);

    this.worklet.port.onmessage = (event) => {
      if (!this.streaming || event.data.type !== "audio") return;
      if (this.muted) return;
      // No level is computed here any more. The avatar pulls spectrum() from
      // its own animation frame, so measuring on every captured buffer was
      // work nothing consumed.
      if (this.client && this.client.connected) {
        this.client.sendAudioChunk(bufferToBase64(toPCM16(event.data.data)));
      }
    };

    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    source.connect(this.worklet);
    source.connect(this.analyser);

    this.streaming = true;
    return true;
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.mediaStream) {
      this.mediaStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
    }
  }

  stop() {
    this.streaming = false;
    this.analyser = null;
    if (this.worklet) {
      this.worklet.disconnect();
      this.worklet.port.close();
      this.worklet = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
  }
}

/** Plays 24 kHz PCM from Gemini and exposes a live output level. */
export class VoicePlayer {
  constructor() {
    this.audioContext = null;
    this.worklet = null;
    this.gain = null;
    this.analyser = null;
    this.sampleData = null;
    this.ready = false;
    this.volume = 1;
  }

  async init() {
    if (this.ready) return;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: PLAYBACK_RATE,
    });
    await this.audioContext.audioWorklet.addModule(
      "/audio-processors/playback.worklet.js"
    );
    this.worklet = new AudioWorkletNode(this.audioContext, "pcm-processor");

    this.gain = this.audioContext.createGain();
    this.gain.gain.value = this.volume;

    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.6;
    this.sampleData = new Uint8Array(this.analyser.fftSize);
    this.freqBytes = new Uint8Array(this.analyser.frequencyBinCount);

    this.worklet.connect(this.gain);
    this.gain.connect(this.analyser);
    this.gain.connect(this.audioContext.destination);

    this.ready = true;
  }

  /** Fills `out` with EVA's spectrum and returns her level, 0..1. */
  spectrum(out) {
    return readSpectrum(this.analyser, this.freqBytes, out);
  }

  /** 0..1 RMS of what is coming out of the speaker right now. */
  level() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.sampleData);
    let sum = 0;
    for (let i = 0; i < this.sampleData.length; i++) {
      const v = (this.sampleData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / this.sampleData.length);
  }

  async play(base64Audio) {
    if (!this.ready) await this.init();
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const pcm16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float32[i] = pcm16[i] / 32768;

    this.worklet.port.postMessage(float32);
  }

  interrupt() {
    if (this.worklet) this.worklet.port.postMessage("interrupt");
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  destroy() {
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.ready = false;
  }
}

/**
 * Optional camera feed. Sends one JPEG a second, which is enough for
 * "show me the damaged item" without flooding the socket.
 */
export class CameraStreamer {
  constructor(client) {
    this.client = client;
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.mediaStream = null;
    this.timer = null;
    this.streaming = false;
  }

  async start({ fps = 1, width = 640, height = 480, quality = 0.7 } = {}) {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: width }, height: { ideal: height }, facingMode: "user" },
    });

    this.video = document.createElement("video");
    this.video.srcObject = this.mediaStream;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true;

    this.canvas = document.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d");

    await new Promise((resolve) => {
      this.video.onloadedmetadata = resolve;
    });
    await this.video.play();

    this.streaming = true;
    this.timer = setInterval(() => {
      if (!this.streaming) return;
      this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
      this.canvas.toBlob(
        (blob) => {
          if (!blob) return;
          const reader = new FileReader();
          reader.onloadend = () => {
            const base64 = String(reader.result).split(",")[1];
            if (this.client && this.client.connected) {
              this.client.sendImageChunk(base64);
            }
          };
          reader.readAsDataURL(blob);
        },
        "image/jpeg",
        quality
      );
    }, 1000 / fps);

    return this.mediaStream;
  }

  stop() {
    this.streaming = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((t) => t.stop());
      this.mediaStream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.canvas = null;
    this.ctx = null;
  }
}
