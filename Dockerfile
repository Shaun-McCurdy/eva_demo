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

# Cloud Run injects PORT; settings.py reads it.
ENV PORT=8080 \
    STATIC_DIR=/app/web/dist \
    STORE_BACKEND=firestore

# Run as a non-root user.
RUN useradd --create-home --uid 10001 eva && chown -R eva:eva /app
USER eva

EXPOSE 8080
WORKDIR /app/server
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT} --ws websockets --timeout-keep-alive 75
