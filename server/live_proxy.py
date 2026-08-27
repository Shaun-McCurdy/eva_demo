"""Hardened WebSocket proxy between the browser and Vertex AI Live.

Differences from the sample proxy this is derived from, all of them the
difference between "runs on my laptop" and "has a public URL":

1. The browser never sends the setup message. It sends one line naming an agent;
   the server looks that agent up and builds the setup itself. A visitor cannot
   change the system instruction, the model, the temperature, or the tools.
2. The browser never sends a service URL or a bearer token. Both are server
   constants. The sample accepted both from the client, which turns the proxy
   into an open relay for any host the client names.
3. Client frames are filtered to an allowlist of message types and a size cap,
   so nothing unexpected reaches Vertex on the project's credentials.
4. Sessions are capped by duration, per-IP concurrency, per-IP rate, and global
   concurrency, so one visitor cannot drain the Vertex quota.
5. The access token is minted from ADC on the server and refreshed in a worker
   thread, never exposed to the page.
"""

from __future__ import annotations

import asyncio
import collections
import json
import ssl
import time
from typing import Any

import certifi
import google.auth
import websockets
from google.auth.transport.requests import Request as GoogleAuthRequest

from agents import system_instruction_for
from personas import OPENING_TRIGGER
from settings import settings

# Only these top-level keys are forwarded from browser to Vertex.
ALLOWED_CLIENT_KEYS = {
    "realtime_input",
    "realtimeInput",
    "client_content",
    "clientContent",
    "tool_response",
    "toolResponse",
}

CLOSE_POLICY = 1008
CLOSE_TRY_AGAIN = 1013
CLOSE_INTERNAL = 1011


# --------------------------------------------------------------------------
# Credentials
# --------------------------------------------------------------------------

class TokenProvider:
    """Caches ADC credentials and refreshes them off the event loop."""

    def __init__(self):
        self._creds = None
        self._lock = asyncio.Lock()

    def _blocking_token(self) -> str:
        if self._creds is None:
            self._creds, _ = google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
        if not self._creds.valid:
            self._creds.refresh(GoogleAuthRequest())
        return self._creds.token

    async def token(self) -> str:
        async with self._lock:
            return await asyncio.to_thread(self._blocking_token)


token_provider = TokenProvider()


# --------------------------------------------------------------------------
# Abuse limits
# --------------------------------------------------------------------------

class SessionLimiter:
    """In-memory limits.

    Per-instance, so with several Cloud Run instances the effective ceiling is
    the limit times the instance count. For a demo site, pin max-instances low
    (see DEPLOY.md) and treat the Vertex quota as the real backstop.
    """

    def __init__(self):
        self.active_total = 0
        self.active_by_ip: dict[str, int] = collections.defaultdict(int)
        self.recent_by_ip: dict[str, collections.deque] = collections.defaultdict(
            collections.deque
        )
        self._lock = asyncio.Lock()

    async def acquire(self, ip: str) -> str | None:
        """Returns None on success, or a human-readable refusal reason."""
        now = time.monotonic()
        async with self._lock:
            history = self.recent_by_ip[ip]
            while history and now - history[0] > 3600:
                history.popleft()

            if self.active_total >= settings.MAX_CONCURRENT_SESSIONS:
                return "The demo is at capacity right now. Please try again shortly."
            if self.active_by_ip[ip] >= settings.MAX_SESSIONS_PER_IP:
                return "You already have a session open in another tab."
            if len(history) >= settings.MAX_SESSIONS_PER_IP_HOUR:
                return "Session limit reached for this hour. Please try again later."

            self.active_total += 1
            self.active_by_ip[ip] += 1
            history.append(now)
            return None

    async def release(self, ip: str) -> None:
        async with self._lock:
            self.active_total = max(0, self.active_total - 1)
            self.active_by_ip[ip] = max(0, self.active_by_ip[ip] - 1)
            if self.active_by_ip[ip] == 0:
                self.active_by_ip.pop(ip, None)


limiter = SessionLimiter()


# --------------------------------------------------------------------------
# Setup message
# --------------------------------------------------------------------------

def build_setup_message(agent: dict[str, Any]) -> dict[str, Any]:
    """Assemble the Vertex setup frame from server-held agent config."""
    setup: dict[str, Any] = {
        "model": settings.model_uri(),
        "generation_config": {
            "response_modalities": ["AUDIO"],
            "temperature": float(agent.get("temperature", 1.0)),
            "speech_config": {
                "voice_config": {
                    "prebuilt_voice_config": {
                        "voice_name": agent.get("voice", "Aoede")
                    }
                }
            },
            # Lets the model hear tone and respond to it, which is most of why
            # this sounds different from a classic IVR in a demo.
            "enable_affective_dialog": True,
        },
        "system_instruction": {
            "parts": [{"text": system_instruction_for(agent)}]
        },
        "proactivity": {"proactive_audio": True},
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        "realtime_input_config": {
            "automatic_activity_detection": {
                "disabled": False,
                "silence_duration_ms": 700,
                "prefix_padding_ms": 300,
                "end_of_speech_sensitivity": "END_SENSITIVITY_UNSPECIFIED",
                "start_of_speech_sensitivity": "START_SENSITIVITY_UNSPECIFIED",
            }
        },
    }
    return {"setup": setup}


def opening_turn() -> dict[str, Any]:
    """Nudge the agent to speak first, so the visitor is greeted on connect."""
    return {
        "client_content": {
            "turns": [{"role": "user", "parts": [{"text": OPENING_TRIGGER}]}],
            "turn_complete": True,
        }
    }


# --------------------------------------------------------------------------
# Frame filtering
# --------------------------------------------------------------------------

def sanitize_client_frame(raw: str | bytes) -> str | None:
    """Return a JSON string safe to forward upstream, or None to drop it."""
    if isinstance(raw, bytes):
        return None
    if len(raw) > settings.MAX_CLIENT_MESSAGE_BYTES:
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(data, dict):
        return None

    forwarded = {k: v for k, v in data.items() if k in ALLOWED_CLIENT_KEYS}
    if not forwarded:
        return None
    return json.dumps(forwarded)


def origin_allowed(origin: str | None) -> bool:
    if not settings.ALLOWED_ORIGINS:
        return True
    return bool(origin) and origin in settings.ALLOWED_ORIGINS
