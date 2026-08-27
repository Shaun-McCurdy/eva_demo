"""The agent registry: built-in personas plus sales-engineer variants.

Two views of every agent:

  public_view -- what the browser is allowed to see. Name, tagline, accent,
                 voice. Never the goal or the instructions.
  full_view   -- what an authenticated studio user sees, including instructions.

The assembled system instruction is only ever built here, on the server, and
handed straight to the Vertex setup message. It is never returned by any public
endpoint and never accepted from a client.
"""

from __future__ import annotations

import datetime as _dt
import re
from typing import Any

from personas import BASE_GUARDRAILS, PERSONAS, persona_by_slug
from store import AgentStore

VOICES = ["Aoede", "Charon", "Fenrir", "Kore", "Puck"]

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$")

# Slugs the app itself uses, so a variant can never shadow a real route.
RESERVED_SLUGS = {
    "api", "ws", "studio", "admin", "login", "logout", "assets",
    "audio-processors", "avatar", "static", "health", "a",
}

MAX_INSTRUCTION_CHARS = 20_000
MAX_GOAL_CHARS = 2_000


class AgentError(ValueError):
    """Raised for invalid studio input; surfaced to the client as a 400."""


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def slugify(raw: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (raw or "").strip().lower()).strip("-")
    return s[:40].strip("-")


class AgentRegistry:
    def __init__(self, store: AgentStore):
        self.store = store
        self._builtins = {p["slug"]: dict(p, builtin=True, enabled=True) for p in PERSONAS}

    # ---- lookup -------------------------------------------------------

    def get(self, slug: str) -> dict[str, Any] | None:
        if slug in self._builtins:
            return self._builtins[slug]
        return self.store.get_variant(slug)

    def all_agents(self) -> list[dict[str, Any]]:
        return list(self._builtins.values()) + self.store.list_variants()

    def public_agents(self) -> list[dict[str, Any]]:
        """Built-in personas only. Variants are unlisted: reachable by their
        sub-URL, but never advertised on the public landing page."""
        return [public_view(a) for a in self._builtins.values()]

    # ---- mutation (studio only) ---------------------------------------

    def create_variant(self, payload: dict, author: str) -> dict[str, Any]:
        base_slug = payload.get("baseSlug") or "concierge"
        base = self.get(base_slug)
        if base is None:
            raise AgentError(f"Unknown base agent '{base_slug}'.")

        # An explicitly supplied sub-URL is validated, never silently rewritten:
        # this string is the link the sales engineer is about to send someone, so
        # quietly turning "acme-bank-" into "acme-bank" would hand them a URL
        # that is not the one they typed. Only an auto-derived slug is normalised.
        raw_slug = str(payload.get("slug") or "").strip()
        if raw_slug:
            slug = raw_slug.lower()
            if slug != raw_slug or slugify(raw_slug) != slug:
                raise AgentError(
                    "The sub-URL must be lowercase letters, numbers and single "
                    "hyphens only, with no spaces and no hyphen at either end."
                )
        else:
            slug = slugify(payload.get("name") or "")

        if not slug or not SLUG_RE.match(slug):
            raise AgentError(
                "The sub-URL must be 3-40 characters, lowercase letters, numbers "
                "and hyphens, starting and ending with a letter or number."
            )
        if slug in RESERVED_SLUGS or slug in self._builtins:
            raise AgentError(f"'{slug}' is reserved. Pick another sub-URL.")
        if self.store.get_variant(slug) is not None:
            raise AgentError(f"'{slug}' is already taken. Pick another sub-URL.")

        variant = _assemble_variant(payload, base, slug, author, created=_now())
        self.store.put_variant(variant)
        return variant

    def update_variant(self, slug: str, payload: dict, author: str) -> dict[str, Any]:
        existing = self.store.get_variant(slug)
        if existing is None:
            if slug in self._builtins:
                raise AgentError(
                    "Built-in agents cannot be edited. Clone it into a variant instead."
                )
            raise AgentError(f"No agent at '{slug}'.")
        base = self.get(existing.get("baseSlug") or "concierge") or self._builtins["concierge"]
        variant = _assemble_variant(
            payload, base, slug, existing.get("createdBy") or author,
            created=existing.get("createdAt") or _now(),
        )
        variant["updatedAt"] = _now()
        variant["updatedBy"] = author
        self.store.put_variant(variant)
        return variant

    def delete_variant(self, slug: str) -> bool:
        if slug in self._builtins:
            raise AgentError("Built-in agents cannot be deleted.")
        return self.store.delete_variant(slug)


def _clean_text(value: Any, limit: int, field: str) -> str:
    text = (value or "")
    if not isinstance(text, str):
        raise AgentError(f"{field} must be text.")
    text = text.replace("\r\n", "\n").strip()
    if len(text) > limit:
        raise AgentError(f"{field} is too long (limit {limit:,} characters).")
    return text


def _assemble_variant(payload: dict, base: dict, slug: str, author: str, created: str) -> dict:
    name = _clean_text(payload.get("name"), 80, "Name") or base["name"]
    goal = _clean_text(payload.get("goal"), MAX_GOAL_CHARS, "Goal") or base["goal"]
    instructions = _clean_text(
        payload.get("instructions"), MAX_INSTRUCTION_CHARS, "Instructions"
    ) or base["instructions"]

    voice = payload.get("voice") or base.get("voice") or "Aoede"
    if voice not in VOICES:
        raise AgentError(f"Voice must be one of: {', '.join(VOICES)}.")

    try:
        temperature = float(payload.get("temperature", base.get("temperature", 1.0)))
    except (TypeError, ValueError):
        raise AgentError("Temperature must be a number.")
    temperature = max(0.1, min(2.0, temperature))

    accent = str(payload.get("accent") or base.get("accent") or "#00A3E0")
    if not re.match(r"^#[0-9a-fA-F]{6}$", accent):
        accent = base.get("accent", "#00A3E0")

    return {
        "slug": slug,
        "name": name,
        "vertical": _clean_text(payload.get("vertical"), 60, "Vertical") or base.get("vertical", ""),
        "tagline": _clean_text(payload.get("tagline"), 120, "Tagline") or base.get("tagline", ""),
        "blurb": _clean_text(payload.get("blurb"), 400, "Description") or "",
        "goal": goal,
        "instructions": instructions,
        "voice": voice,
        "temperature": temperature,
        "accent": accent,
        "baseSlug": base["slug"],
        "builtin": False,
        "enabled": bool(payload.get("enabled", True)),
        "createdBy": author,
        "createdAt": created,
    }


def system_instruction_for(agent: dict) -> str:
    """Guardrails first, then the agent's goal, then its instructions.

    Guardrails lead so that a variant's instructions -- which a sales engineer
    can type freely -- are read as detail within the frame, not as a replacement
    for it.
    """
    goal = (agent.get("goal") or "").strip()
    instructions = (agent.get("instructions") or "").strip()
    parts = [BASE_GUARDRAILS.strip()]
    if goal:
        parts.append(f"# Your objective\n\n{goal}")
    if instructions:
        parts.append(instructions)
    return "\n\n---\n\n".join(parts)


def public_view(agent: dict) -> dict:
    """Safe to hand to any browser. No goal, no instructions."""
    return {
        "slug": agent["slug"],
        "name": agent.get("name", ""),
        "vertical": agent.get("vertical", ""),
        "tagline": agent.get("tagline", ""),
        "blurb": agent.get("blurb", ""),
        "accent": agent.get("accent", "#00A3E0"),
        "builtin": bool(agent.get("builtin")),
    }


def full_view(agent: dict) -> dict:
    """Studio view. Requires an authenticated session."""
    view = public_view(agent)
    view.update(
        {
            "goal": agent.get("goal", ""),
            "instructions": agent.get("instructions", ""),
            "voice": agent.get("voice", "Aoede"),
            "temperature": agent.get("temperature", 1.0),
            "baseSlug": agent.get("baseSlug", ""),
            "enabled": bool(agent.get("enabled", True)),
            "createdBy": agent.get("createdBy", ""),
            "createdAt": agent.get("createdAt", ""),
            "updatedAt": agent.get("updatedAt", ""),
        }
    )
    return view
