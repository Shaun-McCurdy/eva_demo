# ---- stage 1: build the React front end ----------------------------------
FROM node:22-slim AS web

WORKDIR /build
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY web/ ./
RUN npm run build

# ---- stage 2: runtime ------------------------------------------------------
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY server/requirements.txt ./server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt

COPY server/ ./server/
COPY --from=web /build/dist ./web/dist

# ---- deployment configuration ---------------------------------------------
# Baked into the image so a build-and-deploy that carries no --set-env-vars
# still comes up configured. Cloud Build overrides any of these with
# --build-arg; a Cloud Run env var overrides them again at runtime.
#
# GOOGLE_CLOUD_PROJECT is only Firestore's concern now -- the model calls go to
# the Gemini Developer API, which is global-routed and needs no project or
# region. Cloud Run still does not inject it the way App Engine does, and
# settings.py's metadata-server fallback is a safety net, not configuration.
ARG GOOGLE_CLOUD_PROJECT=virtual-agent-demos
ARG GEMINI_MODEL=gemini-3.1-flash-live-preview

ENV GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT} \
    GEMINI_MODEL=${GEMINI_MODEL}

# Cloud Run injects PORT; settings.py reads it.
ENV PORT=8080 \
    STATIC_DIR=/app/web/dist \
    STORE_BACKEND=firestore

# ---- what deliberately is NOT baked in -------------------------------------
# Every ENV above is readable by anyone who can pull the image (`docker
# history`), so nothing secret goes here. These are supplied at deploy time --
# --set-secrets for the first three, --set-env-vars for the last:
#
#   GEMINI_API_KEY        Authenticates every Live API session. A long-lived
#                         bearer credential with no IAM scoping -- it belongs
#                         in Secret Manager and nowhere else.
#   SESSION_SECRET        Signs the studio cookie. Unset, settings.py generates
#                         a random one per instance, so studio logins break on
#                         every restart and never span two instances.
#   STUDIO_PASSWORD_HASH  scrypt hash from `python server/security.py hash`.
#                         Unset, the studio refuses every login.
#   ALLOWED_ORIGINS       The service URL, not knowable until after the first
#                         deploy. Empty lets any origin open the live socket.
#
# The abuse limits (MAX_SESSION_SECONDS and friends) are absent on purpose:
# settings.py already defaults them to the values DEPLOY.md recommends, and
# repeating them here would just create two places to drift.

# Run as a non-root user.
RUN useradd --create-home --uid 10001 eva && chown -R eva:eva /app
USER eva

EXPOSE 8080
WORKDIR /app/server
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT} --ws websockets --timeout-keep-alive 75
