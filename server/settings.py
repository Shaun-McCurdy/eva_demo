"""Environment configuration for the EVA demo server.

Every knob the deployment needs lives here so Cloud Run can be configured
entirely with environment variables and no config files in the image.
"""

import os
import secrets


def _bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class Settings:
    # ---- Google Cloud / Vertex AI -------------------------------------
    # PROJECT_ID is required. On Cloud Run the attached service account
    # supplies credentials automatically via ADC -- no key file needed.
    PROJECT_ID = os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
    LOCATION = os.environ.get("VERTEX_LOCATION", "us-central1").strip()
    MODEL = os.environ.get(
        "GEMINI_MODEL", "gemini-live-2.5-flash-native-audio"
    ).strip()

    @property
    def api_host(self) -> str:
        return f"{self.LOCATION}-aiplatform.googleapis.com"

    @property
    def service_url(self) -> str:
        return (
            f"wss://{self.api_host}/ws/"
            "google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent"
        )

    def model_uri(self, model: str | None = None) -> str:
        return (
            f"projects/{self.PROJECT_ID}/locations/{self.LOCATION}"
            f"/publishers/google/models/{model or self.MODEL}"
        )

    # ---- Agent storage ------------------------------------------------
    # "file"      -> JSON on local disk (dev; ephemeral on Cloud Run)
    # "firestore" -> Firestore in Native mode (recommended for Cloud Run)
    STORE_BACKEND = os.environ.get("STORE_BACKEND", "file").strip().lower()
    STORE_FILE = os.environ.get("STORE_FILE", "./data/agents.json").strip()
    FIRESTORE_COLLECTION = os.environ.get(
        "FIRESTORE_COLLECTION", "eva_demo_agents"
    ).strip()
    FIRESTORE_DATABASE = os.environ.get("FIRESTORE_DATABASE", "(default)").strip()

    # ---- Sales-engineer studio auth -----------------------------------
    # Prefer STUDIO_PASSWORD_HASH (scrypt, produced by `python server/security.py hash`).
    # STUDIO_PASSWORD is accepted for quick local runs only.
    STUDIO_PASSWORD_HASH = os.environ.get("STUDIO_PASSWORD_HASH", "").strip()
    STUDIO_PASSWORD = os.environ.get("STUDIO_PASSWORD", "").strip()
    # Used to sign the studio session cookie. Set this in production, otherwise
    # every container restart (and every Cloud Run instance) invalidates logins.
    SESSION_SECRET = os.environ.get("SESSION_SECRET", "").strip() or secrets.token_hex(32)
    SESSION_TTL_SECONDS = _int("SESSION_TTL_SECONDS", 12 * 60 * 60)
    COOKIE_NAME = "eva_studio"
    COOKIE_SECURE = _bool("COOKIE_SECURE", True)

    # ---- Abuse limits for a publicly reachable demo --------------------
    MAX_SESSION_SECONDS = _int("MAX_SESSION_SECONDS", 600)
    MAX_CONCURRENT_SESSIONS = _int("MAX_CONCURRENT_SESSIONS", 12)
    MAX_SESSIONS_PER_IP = _int("MAX_SESSIONS_PER_IP", 3)
    MAX_SESSIONS_PER_IP_HOUR = _int("MAX_SESSIONS_PER_IP_HOUR", 20)
    MAX_CLIENT_MESSAGE_BYTES = _int("MAX_CLIENT_MESSAGE_BYTES", 2_000_000)
    # Comma-separated Origin allowlist for the live WebSocket. Empty = allow any
    # (fine for local dev, set it once you have a domain).
    ALLOWED_ORIGINS = [
        o.strip()
        for o in os.environ.get("ALLOWED_ORIGINS", "").split(",")
        if o.strip()
    ]

    # ---- Front end ----------------------------------------------------
    STATIC_DIR = os.environ.get("STATIC_DIR", "./web/dist").strip()
    PORT = _int("PORT", 8080)
    DEBUG = _bool("DEBUG", False)

    def validate(self) -> list[str]:
        problems = []
        if not self.PROJECT_ID:
            problems.append(
                "GOOGLE_CLOUD_PROJECT is not set -- the Vertex model URI cannot be built."
            )
        if not self.STUDIO_PASSWORD_HASH and not self.STUDIO_PASSWORD:
            problems.append(
                "Neither STUDIO_PASSWORD_HASH nor STUDIO_PASSWORD is set -- "
                "the sales-engineer studio will refuse every login."
            )
        if not os.environ.get("SESSION_SECRET"):
            problems.append(
                "SESSION_SECRET is not set -- a random one was generated, so studio "
                "logins will not survive a restart or span multiple instances."
            )
        return problems


settings = Settings()
