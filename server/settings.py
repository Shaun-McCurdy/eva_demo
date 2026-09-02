"""Environment configuration for the EVA demo server.

Every knob the deployment needs lives here so Cloud Run can be configured
entirely with environment variables and no config files in the image.
"""

import os
import secrets

# Environment variables that can name the GCP project, in precedence order.
# GOOGLE_CLOUD_PROJECT is the current one; the other two are what older Google
# runtimes set and cost nothing to honour.
_PROJECT_ENV_VARS = ("GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GCP_PROJECT")


def _resolve_project() -> tuple[str, str]:
    """Find the GCP project id, and report where it came from.

    Cloud Run does *not* inject GOOGLE_CLOUD_PROJECT into the container the way
    App Engine and Cloud Functions do, so a deploy that omits
    `--set-env-vars GOOGLE_CLOUD_PROJECT=...` leaves it empty. Since the move to
    the Gemini Developer API only Firestore needs this -- the model calls no
    longer touch Google Cloud at all -- but an unset project still silently
    breaks the studio.

    Application Default Credentials already know the answer -- from the
    metadata server on Cloud Run, and from the gcloud ADC file or a
    service-account key locally -- so fall back to those instead of failing on
    a missing env var. Only reached when no env var is set, so the configured
    path costs nothing and importing this module stays offline.
    """
    for name in _PROJECT_ENV_VARS:
        value = os.environ.get(name, "").strip()
        if value:
            return value, name

    try:
        import google.auth

        _, project = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
    except Exception:  # noqa: BLE001 - no ADC, no metadata server, no library
        return "", "unset"

    project = (project or "").strip()
    return (project, "ADC") if project else ("", "unset")


# The Developer API is global-routed: one host, no region prefix, unlike
# Vertex's {region}-aiplatform.googleapis.com.
API_HOST = "generativelanguage.googleapis.com"

# Not every model accepts every level -- gemini-3.1-flash-live-preview takes all
# four, others take a subset -- so this is the vocabulary, not a guarantee.
THINKING_LEVELS = ("minimal", "low", "medium", "high")


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


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class Settings:
    # ---- Gemini Developer API -----------------------------------------
    # The Live API authenticates with an API key in the query string. There is
    # no header form, which makes the connect URL itself a secret -- hence the
    # split between service_url (safe to log) and authenticated_url (not).
    GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
    MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.1-flash-live-preview").strip()

    # How hard the model thinks before answering. Pinned rather than inherited:
    # the default is the model's to change, and on a voice demo the difference
    # between levels is audible as latency before every reply.
    #
    # Set empty to send nothing at all and fall back to whatever the model does
    # on its own -- which is also the escape hatch if a future model rejects the
    # field, since it can be cleared with an env var and no rebuild.
    THINKING_LEVEL = os.environ.get("GEMINI_THINKING_LEVEL", "minimal").strip().lower()

    # ---- Google Cloud --------------------------------------------------
    # Firestore is the only thing left that needs a project; the model calls do
    # not touch GCP. PROJECT_SOURCE records which mechanism supplied the id, so
    # a misconfigured deploy is one /healthz away from being obvious.
    PROJECT_ID, PROJECT_SOURCE = _resolve_project()

    @property
    def thinking_level(self) -> str:
        """The configured level, or "" when thinking config should be omitted."""
        return self.THINKING_LEVEL if self.THINKING_LEVEL in THINKING_LEVELS else ""

    @property
    def service_url(self) -> str:
        """Upstream endpoint with no credential in it. Safe to log."""
        return (
            f"wss://{API_HOST}/ws/"
            "google.ai.generativelanguage.v1beta.GenerativeService"
            ".BidiGenerateContent"
        )

    def authenticated_url(self) -> str:
        """service_url carrying the API key. Never log this -- redact() it."""
        return f"{self.service_url}?key={self.GEMINI_API_KEY}"

    def redact(self, text: str) -> str:
        """Blank the API key out of anything bound for a log line."""
        if self.GEMINI_API_KEY:
            return text.replace(self.GEMINI_API_KEY, "***")
        return text

    def model_uri(self, model: str | None = None) -> str:
        # The Developer API names models `models/<id>`. The long
        # projects/.../locations/.../publishers/... form is Vertex-only.
        return f"models/{model or self.MODEL}"

    # ---- Vertex AI Search (Discovery Engine) --------------------------
    # The allowlist of knowledge sources an agent may be pointed at. One
    # record per line or per `;`:
    #
    #   key | Label for the studio | engine:<engine-id> [| location]
    #
    # Target an *engine*, not a data store: search edition is set at the engine
    # level, and a data store queried directly runs at STANDARD tier, which
    # refuses extractive answers and website search outright.
    #
    # This is an allowlist rather than free-text because the project is a
    # shared demo sandbox holding other customers' data stores. See
    # retrieval.py for the full reasoning.
    VERTEX_DATA_STORES = os.environ.get("VERTEX_DATA_STORES", "").strip()
    SEARCH_LOCATION = os.environ.get("SEARCH_LOCATION", "global").strip() or "global"
    # The Live model blocks synchronously on a tool call, so this timeout is
    # how long a visitor can be left listening to silence before the agent is
    # told the lookup failed and can say so.
    SEARCH_TIMEOUT_SECONDS = _float("SEARCH_TIMEOUT_SECONDS", 6.0)
    SEARCH_MAX_RESULTS = _int("SEARCH_MAX_RESULTS", 4)
    # Per-passage cap. Four passages of 600 characters is roughly 2.5 kB into
    # an audio context window that is already under sliding-window compression.
    SEARCH_SNIPPET_CHARS = _int("SEARCH_SNIPPET_CHARS", 600)
    # How many sources one agent may carry. Each is a parallel request inside a
    # turn the model is blocked on, so this is a latency ceiling, not a quota.
    MAX_DATA_STORES_PER_AGENT = _int("MAX_DATA_STORES_PER_AGENT", 3)

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
    # Microsoft 365 is the front door. Everyone in the tenant may sign in; the
    # tenant id is the only membership check, which is a deliberate choice for
    # an internal demo tool.
    MS_TENANT_ID = os.environ.get("MS_TENANT_ID", "").strip()
    MS_CLIENT_ID = os.environ.get("MS_CLIENT_ID", "").strip()
    MS_CLIENT_SECRET = os.environ.get("MS_CLIENT_SECRET", "").strip()
    # Must match a redirect URI registered on the app exactly. Left empty it is
    # derived from the incoming request, which is right for local runs and
    # wrong the moment anything sits in front of Cloud Run.
    MS_REDIRECT_URI = os.environ.get("MS_REDIRECT_URI", "").strip()

    # The shared password, kept as break-glass while SSO beds in. Turn it off
    # once SSO is proven and the studio has exactly one way in.
    STUDIO_PASSWORD_FALLBACK = _bool("STUDIO_PASSWORD_FALLBACK", True)
    # Prefer STUDIO_PASSWORD_HASH (scrypt, produced by `python server/security.py hash`).
    # STUDIO_PASSWORD is accepted for quick local runs only.
    STUDIO_PASSWORD_HASH = os.environ.get("STUDIO_PASSWORD_HASH", "").strip()
    STUDIO_PASSWORD = os.environ.get("STUDIO_PASSWORD", "").strip()

    @property
    def sso_configured(self) -> bool:
        return bool(self.MS_TENANT_ID and self.MS_CLIENT_ID and self.MS_CLIENT_SECRET)

    @property
    def authority(self) -> str:
        return f"https://login.microsoftonline.com/{self.MS_TENANT_ID}"

    @property
    def password_enabled(self) -> bool:
        """The password path is only live if it is both configured and allowed."""
        return self.STUDIO_PASSWORD_FALLBACK and bool(
            self.STUDIO_PASSWORD_HASH or self.STUDIO_PASSWORD
        )
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
        if self.VERTEX_DATA_STORES and not self.PROJECT_ID:
            problems.append(
                "VERTEX_DATA_STORES is set but no Google Cloud project could be "
                "determined, so every knowledge lookup will fail. Set "
                "GOOGLE_CLOUD_PROJECT (Cloud Run does not set it for you)."
            )
        if self.THINKING_LEVEL and not self.thinking_level:
            problems.append(
                "GEMINI_THINKING_LEVEL=%r is not one of %s -- no thinking config "
                "will be sent and the model's own default applies."
                % (self.THINKING_LEVEL, ", ".join(THINKING_LEVELS))
            )
        if not self.GEMINI_API_KEY:
            problems.append(
                "GEMINI_API_KEY is not set -- the Live API cannot authenticate, so "
                "every session will be refused."
            )
        if self.STORE_BACKEND == "firestore" and not self.PROJECT_ID:
            problems.append(
                "STORE_BACKEND=firestore but no Google Cloud project could be "
                "determined, so Firestore cannot be reached. Set "
                "GOOGLE_CLOUD_PROJECT (Cloud Run does not set it for you) or "
                "attach credentials that name a project."
            )
        if not self.sso_configured and not self.password_enabled:
            problems.append(
                "No way into the studio: Microsoft SSO is not configured "
                "(MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET) and the "
                "password fallback is off or unset."
            )
        if self.sso_configured and not self.MS_REDIRECT_URI:
            problems.append(
                "MS_REDIRECT_URI is not set -- the redirect will be derived from "
                "the request, which breaks behind a proxy and must match the URI "
                "registered on the app exactly."
            )
        if not os.environ.get("SESSION_SECRET"):
            problems.append(
                "SESSION_SECRET is not set -- a random one was generated, so studio "
                "logins will not survive a restart or span multiple instances."
            )
        return problems


settings = Settings()
