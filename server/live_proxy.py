"""Hardened WebSocket proxy between the browser and the Gemini Live API.

Differences from the sample proxy this is derived from, all of them the
difference between "runs on my laptop" and "has a public URL":

1. The browser never sends the setup message. It sends one line naming an agent;
   the server looks that agent up and builds the setup itself. A visitor cannot
   change the system instruction, the model, the temperature, or the tools.
2. The browser never sends a service URL or a credential. Both are server
   constants. The sample accepted both from the client, which turns the proxy
   into an open relay for any host the client names.
3. Client frames are filtered to an allowlist of message types and a size cap,
   so nothing unexpected reaches Google on the server's API key.
4. Sessions are capped by duration, per-IP concurrency, per-IP rate, and global
   concurrency, so one visitor cannot drain the API quota.
5. The API key stays server-side and is never exposed to the page. It travels in
   the upstream query string, so it must never reach a log line either --
   settings.redact() exists for that.
"""

from __future__ import annotations

import asyncio
import collections
import json
import time
from typing import Any

from agents import system_instruction_for
from personas import OPENING_TRIGGER
import retrieval
from settings import settings

SEARCH_TOOL_NAME = "search_enghouse_knowledge"

# One argument on purpose. Every extra parameter is another thing the model can
# get wrong while a visitor waits, and which store to search is the server's
# decision -- it comes from the agent's configuration, never from the model.
SEARCH_TOOL = {
    "name": SEARCH_TOOL_NAME,
    "description": (
        "Search Enghouse's own product and company material. Use this for any "
        "specific question about Enghouse products, capabilities, integrations "
        "or customers. Returns short passages from official Enghouse sources."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "query": {
                "type": "STRING",
                "description": (
                    "What to look up, in natural language. Use the person's own "
                    "wording where you can."
                ),
            }
        },
        "required": ["query"],
    },
}

# Only these top-level keys are forwarded from browser to Google.
# Deliberately no tool_response: the server executes every tool call itself and
# answers upstream directly. Leaving it here would let a visitor forge search
# results and feed arbitrary text to the model as if it came from an Enghouse
# source -- the exact injection the retrieval design exists to prevent.
ALLOWED_CLIENT_KEYS = {
    "realtime_input",
    "realtimeInput",
    "client_content",
    "clientContent",
}

CLOSE_POLICY = 1008
CLOSE_TRY_AGAIN = 1013
CLOSE_INTERNAL = 1011


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
    """Assemble the Live API setup frame from server-held agent config."""
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
        },
        "system_instruction": {
            "parts": [{"text": system_instruction_for(agent)}]
        },
        "input_audio_transcription": {},
        "output_audio_transcription": {},
        # Without this a session is capped at 15 minutes and, worse, is killed
        # outright once accumulated audio fills the context window -- which
        # reads as a crash mid-conversation rather than a limit. The sliding
        # window drops the oldest turns server-side instead. Note this does not
        # lift the ~10 minute cap on a single *connection*; surviving that needs
        # session resumption, which this demo does not implement.
        "context_window_compression": {"sliding_window": {}},
        # No realtime_input_config: automatic voice activity detection is on by
        # default, and sending the block is optional. The previous config named
        # START_SENSITIVITY_UNSPECIFIED / END_SENSITIVITY_UNSPECIFIED, which are
        # not among the values Google documents, and carried silence/padding
        # timings tuned for the 2.5 native-audio model. Defaults are the right
        # starting point; re-tune deliberately if the turn-taking feels wrong.
    }

    # Nested inside generation_config rather than at the top of setup: the Live
    # API reference enumerates BidiGenerateContentSetup's fields and thinking is
    # not among them, while generation_config is a standard GenerationConfig and
    # the unsupported-field list does not exclude thinking. No published example
    # shows a raw Live setup frame carrying it, so if this placement is wrong the
    # symptom is a 1007 close naming the field -- clear GEMINI_THINKING_LEVEL to
    # drop the block without a rebuild.
    if settings.thinking_level:
        setup["generation_config"]["thinking_config"] = {
            "thinking_level": settings.thinking_level
        }

    # Only declared when the agent actually has a source attached, so an agent
    # with none produces byte-for-byte the setup frame it did before this
    # existed. Note the Live API refuses to mix search tools (google_search)
    # with function declarations in one session -- if grounding with Google
    # Search is ever added, it cannot coexist with this.
    if retrieval.catalogue.resolve(agent.get("dataStores") or []):
        setup["tools"] = [{"function_declarations": [SEARCH_TOOL]}]

    return {"setup": setup}


def tool_response_frame(function_calls: list[dict], payload: dict) -> dict[str, Any]:
    """Answer every call in a toolCall frame.

    The id has to be echoed back verbatim: it is how the model matches the
    response to the call it is blocked on. Answering the wrong id, or dropping
    one of several, hangs the turn for good.
    """
    return {
        "tool_response": {
            "function_responses": [
                {
                    "id": call.get("id"),
                    "name": call.get("name") or SEARCH_TOOL_NAME,
                    "response": payload,
                }
                for call in function_calls
            ]
        }
    }


def opening_turn() -> dict[str, Any]:
    """Nudge the agent to speak first, so the visitor is greeted on connect.

    Sent as realtime_input rather than client_content. On
    gemini-3.1-flash-live-preview client_content is documented as seeding
    initial history only, and even that requires initial_history_in_client_content
    in the session config -- which this app does not set. It currently works
    anyway, but the greeting is the single most visible moment of the demo and
    resting it on undocumented leniency in a preview model is not a bet worth
    holding.
    """
    return {"realtime_input": {"text": OPENING_TRIGGER}}


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
