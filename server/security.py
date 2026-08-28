"""Auth for the sales-engineer studio.

Two ways in, one session out. Microsoft 365 is the front door; the shared
password remains as break-glass while SSO beds in. Both paths end at
`issue_session`, so everything downstream -- the studio API, the agent CRUD --
never learns which was used.

The password is compared against a scrypt hash in constant time, and a successful
login mints a signed, expiring, HttpOnly cookie. Nothing about the session lives
in JavaScript, so an XSS on the public page cannot lift a studio session.

Generate a hash for deployment:

    python server/security.py hash 'the-password-you-picked'
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import sys

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from settings import settings

_SCRYPT_N = 2**14
_SCRYPT_R = 8
_SCRYPT_P = 1
_PREFIX = "scrypt$"


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P
    )
    return (
        _PREFIX
        + base64.b64encode(salt).decode("ascii")
        + "$"
        + base64.b64encode(dk).decode("ascii")
    )


def verify_password(password: str, encoded: str) -> bool:
    if not encoded.startswith(_PREFIX):
        return False
    try:
        _, salt_b64, dk_b64 = encoded.split("$", 2)
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(dk_b64)
    except (ValueError, TypeError):
        return False
    candidate = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P
    )
    return hmac.compare_digest(candidate, expected)


def check_studio_password(password: str) -> bool:
    """True when the supplied password matches the configured secret."""
    if not settings.STUDIO_PASSWORD_FALLBACK:
        # Switched off deliberately: SSO is the only way in.
        return False
    if not password:
        return False
    if settings.STUDIO_PASSWORD_HASH:
        return verify_password(password, settings.STUDIO_PASSWORD_HASH)
    if settings.STUDIO_PASSWORD:
        # Plaintext fallback for local runs. Still constant time.
        return hmac.compare_digest(password, settings.STUDIO_PASSWORD)
    return False


_serializer = URLSafeTimedSerializer(settings.SESSION_SECRET, salt="eva-studio")


def issue_session(label: str = "") -> str:
    return _serializer.dumps({"who": label or "sales-engineer"})


def read_session(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        return _serializer.loads(token, max_age=settings.SESSION_TTL_SECONDS)
    except (BadSignature, SignatureExpired):
        return None


# ---------------------------------------------------------------------------
# Microsoft SSO: carrying the auth-code flow across the round trip
# ---------------------------------------------------------------------------

# msal's initiate_auth_code_flow() hands back a dict holding the state, nonce
# and PKCE verifier it generated. That dict has to survive a round trip through
# Microsoft and come back to *any* Cloud Run instance -- the callback is a fresh
# request and instances share no memory. Signing it into a short-lived cookie
# keeps the whole flow stateless.
#
# A separate salt from the session serialiser means the two token types can
# never be swapped for one another even though they share a key.
_sso_serializer = URLSafeTimedSerializer(settings.SESSION_SECRET, salt="eva-sso-state")

# Long enough for a slow sign-in with MFA, short enough that a captured flow is
# useless by the time anyone finds it.
SSO_STATE_TTL_SECONDS = 600


def issue_sso_state(flow: dict) -> str:
    return _sso_serializer.dumps(flow)


def read_sso_state(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        value = _sso_serializer.loads(token, max_age=SSO_STATE_TTL_SECONDS)
    except (BadSignature, SignatureExpired):
        return None
    return value if isinstance(value, dict) else None


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "hash":
        pwd = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("PW", "")
        if not pwd:
            print("usage: python server/security.py hash 'password'", file=sys.stderr)
            raise SystemExit(2)
        print(hash_password(pwd))
    else:
        print("usage: python server/security.py hash 'password'", file=sys.stderr)
        raise SystemExit(2)
