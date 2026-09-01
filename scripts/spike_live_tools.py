"""Phase 0, spike A: does gemini-3.1-flash-live-preview honour function_declarations?

The plan for data-store lookup rests on one assumption: that the Live model
emits a `toolCall` for a server-declared function. Preview models drop
features, and the docs say 3.1 Flash supports synchronous function calling
only -- no NON_BLOCKING. If the setup frame is refused, or a toolCall never
arrives, the function-calling design is dead and the fallback is moving the
proxy to Vertex.

This deliberately does NOT import from server/: it has to run before any of the
Phase 1-2 code exists. The setup frame below is the exact shape
build_setup_message() will produce once the tool is wired in, so a pass here
transfers directly.

Run:
    GEMINI_API_KEY=... .venv/Scripts/python.exe scripts/spike_live_tools.py
"""

from __future__ import annotations

import asyncio
import json
import os
import ssl
import sys
import time

import certifi
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

API_HOST = "generativelanguage.googleapis.com"
SERVICE_URL = (
    f"wss://{API_HOST}/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)

MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-live-preview").strip()
API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()

# Engineered to force a lookup: the system instruction forbids answering
# product questions from memory, so a model that supports the tool has no
# other move.
PROBE = "What does the Enghouse Virtual Agent integrate with?"

SYSTEM_INSTRUCTION = """You are EVA, a voice agent for Enghouse.

You have no product knowledge of your own. For ANY question about Enghouse,
its products, or its capabilities you MUST call the search_enghouse_knowledge
tool before answering. Never answer such a question from memory.

Before you call the tool, say one short sentence out loud so the caller knows
you are looking it up.
"""

TOOL = {
    "name": "search_enghouse_knowledge",
    "description": (
        "Search Enghouse's product and company knowledge base. Use this for any "
        "question about Enghouse products, capabilities, integrations, or "
        "customers. Returns short passages from official Enghouse sources."
    ),
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "query": {
                "type": "STRING",
                "description": "The search query, in natural language.",
            }
        },
        "required": ["query"],
    },
}


def setup_frame() -> dict:
    """Exactly what build_setup_message() will emit once tools are wired in."""
    return {
        "setup": {
            "model": f"models/{MODEL}",
            "generation_config": {
                "response_modalities": ["AUDIO"],
                "temperature": 1.0,
                "speech_config": {
                    "voice_config": {"prebuilt_voice_config": {"voice_name": "Aoede"}}
                },
            },
            "system_instruction": {"parts": [{"text": SYSTEM_INSTRUCTION}]},
            "input_audio_transcription": {},
            "output_audio_transcription": {},
            "context_window_compression": {"sliding_window": {}},
            "tools": [{"function_declarations": [TOOL]}],
        }
    }


FAKE_RESULTS = {
    "results": [
        {
            "title": "Enghouse Virtual Agent -- integrations",
            "snippet": (
                "The Enghouse Virtual Agent connects to CRM, ticketing and "
                "back-office systems through the contact centre's existing "
                "integration layer, under the customer's own security controls."
            ),
            "link": "https://example.invalid/eva/integrations",
        }
    ]
}


class Probe:
    def __init__(self) -> None:
        self.setup_accepted = False
        self.tool_call: dict | None = None
        self.spoke_before_tool = False
        self.answered_after_tool = False
        self.t_turn: float | None = None
        self.t_toolcall: float | None = None
        self.t_response: float | None = None

    def handle(self, frame: dict) -> bool:
        """Returns True when the current wait should stop."""
        if frame.get("setupComplete") is not None:
            self.setup_accepted = True
            print("[ok]   setup accepted -- tools declaration not refused")
            return True

        if frame.get("toolCall") is not None:
            self.t_toolcall = time.monotonic()
            self.tool_call = frame["toolCall"]
            elapsed = self.t_toolcall - (self.t_turn or self.t_toolcall)
            print(f"[ok]   toolCall after {elapsed:.2f}s")
            print(json.dumps(frame["toolCall"], indent=2))
            return True

        if frame.get("toolCallCancellation") is not None:
            print(f"[note] toolCallCancellation: {frame['toolCallCancellation']}")

        content = frame.get("serverContent") or {}
        transcript = content.get("outputTranscription")
        if transcript and transcript.get("text"):
            # Speech before the tool call is what covers the synchronous
            # blocking silence. Worth knowing if the model will actually do it.
            if self.tool_call is None:
                self.spoke_before_tool = True
                print(f"[speech pre-tool ] {transcript['text']!r}")
            else:
                self.answered_after_tool = True
                print(f"[speech post-tool] {transcript['text']!r}")

        if content.get("turnComplete") and self.tool_call is not None:
            if self.t_response is not None:
                delta = time.monotonic() - self.t_response
                print(f"[ok]   turn complete {delta:.2f}s after tool_response")
            return True
        return False


async def listen(ws, probe: Probe, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        except asyncio.TimeoutError:
            return
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", "replace")
        try:
            frame = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(frame, dict) and probe.handle(frame):
            return


async def main() -> int:
    if not API_KEY:
        print("FAIL: GEMINI_API_KEY is not set in the environment.")
        return 2

    ssl_ctx = ssl.create_default_context(cafile=certifi.where())
    probe = Probe()

    print(f"model : {MODEL}")
    print(f"probe : {PROBE!r}\n")

    try:
        async with ws_connect(
            f"{SERVICE_URL}?key={API_KEY}",
            additional_headers={"Content-Type": "application/json"},
            ssl=ssl_ctx,
            max_size=None,
            open_timeout=20,
        ) as ws:
            await ws.send(json.dumps(setup_frame()))
            await listen(ws, probe, 20)
            if not probe.setup_accepted:
                print("FAIL: never saw setupComplete.")
                return 1

            probe.t_turn = time.monotonic()
            await ws.send(
                json.dumps(
                    {
                        "client_content": {
                            "turns": [{"role": "user", "parts": [{"text": PROBE}]}],
                            "turn_complete": True,
                        }
                    }
                )
            )
            await listen(ws, probe, 30)

            if probe.tool_call is None:
                print("\nFAIL: no toolCall in 30s. Function calling is not usable here.")
                return 1

            calls = probe.tool_call.get("functionCalls") or []
            if not calls:
                print("\nFAIL: toolCall arrived with no functionCalls.")
                return 1

            probe.t_response = time.monotonic()
            await ws.send(
                json.dumps(
                    {
                        "tool_response": {
                            "function_responses": [
                                {
                                    "id": call.get("id"),
                                    "name": call.get("name"),
                                    "response": FAKE_RESULTS,
                                }
                                for call in calls
                            ]
                        }
                    }
                )
            )
            print("\n[sent] tool_response -- waiting for the model to resume\n")
            await listen(ws, probe, 30)

    except ConnectionClosed as exc:
        rcvd = getattr(exc, "rcvd", None)
        code = getattr(rcvd, "code", None) if rcvd else None
        reason = (getattr(rcvd, "reason", "") if rcvd else "") or ""
        print(f"\nFAIL: upstream closed code={code} reason={reason}")
        print("A refused setup frame is how an unsupported tools block shows up.")
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"\nFAIL: {type(exc).__name__}: {exc}")
        return 1

    print("\n" + "=" * 60)
    print("VERDICT")
    print("=" * 60)
    print(f"  setup accepted        {probe.setup_accepted}")
    print(f"  toolCall received     {probe.tool_call is not None}")
    print(f"  spoke before tool     {probe.spoke_before_tool}")
    print(f"  answered after tool   {probe.answered_after_tool}")

    ok = probe.setup_accepted and probe.tool_call and probe.answered_after_tool
    print(f"\n  {'PASS -- proceed to Phase 1' if ok else 'INCONCLUSIVE -- read the log above'}")
    if ok and not probe.spoke_before_tool:
        print(
            "  NOTE: the model did not speak before calling the tool. The bridge\n"
            "        line in Phase 4 needs stronger prompting, or the caller hears\n"
            "        dead air for the whole search."
        )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
