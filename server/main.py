"""EVA demo site: static front end + hardened Vertex AI Live proxy.

One container, one port. Cloud Run friendly.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import ssl
from contextlib import asynccontextmanager

import certifi
from fastapi import (
    Body,
    Cookie,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

import security
from agents import AgentError, AgentRegistry, VOICES, full_view, public_view
from live_proxy import (
    CLOSE_INTERNAL,
    CLOSE_POLICY,
    CLOSE_TRY_AGAIN,
    build_setup_message,
    limiter,
    opening_turn,
    origin_allowed,
    sanitize_client_frame,
    token_provider,
)
from settings import settings
from store import build_store

logging.basicConfig(
    level=logging.DEBUG if settings.DEBUG else logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("eva")

registry = AgentRegistry(build_store())


@asynccontextmanager
async def lifespan(app: FastAPI):
    for problem in settings.validate():
        log.warning("CONFIG: %s", problem)
    log.info(
        "EVA demo up | project=%s (via %s) location=%s model=%s store=%s",
        settings.PROJECT_ID or "(unset)",
        settings.PROJECT_SOURCE,
        settings.LOCATION,
        settings.MODEL,
        settings.STORE_BACKEND,
    )
    yield


app = FastAPI(title="EVA Demo", lifespan=lifespan, docs_url=None, redoc_url=None)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault(
        "Permissions-Policy", "microphone=(self), camera=(), geolocation=()"
    )
    return response


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

@app.get("/healthz")
async def healthz():
    # projectSource names where the project id came from -- an env var, ADC, or
    # nowhere. It is the one thing you want to see when a deploy comes up with
    # no project, and it exposes nothing an anonymous caller could use.
    return {
        "ok": True,
        "project": bool(settings.PROJECT_ID),
        "projectSource": settings.PROJECT_SOURCE,
    }


@app.get("/api/agents")
async def list_public_agents():
    """Built-in personas for the landing page picker."""
    return {"agents": registry.public_agents()}


@app.get("/api/agents/{slug}")
async def get_public_agent(slug: str):
    agent = registry.get(slug)
    if agent is None or not agent.get("enabled", True):
        raise HTTPException(status_code=404, detail="No agent at that address.")
    return public_view(agent)


# ---------------------------------------------------------------------------
# Studio auth
# ---------------------------------------------------------------------------

def current_session(eva_studio: str | None = Cookie(default=None)) -> dict:
    session = security.read_session(eva_studio)
    if session is None:
        raise HTTPException(status_code=401, detail="Sign in to the studio first.")
    return session


@app.post("/api/studio/login")
async def studio_login(response: Response, payload: dict = Body(...)):
    password = str(payload.get("password") or "")
    label = str(payload.get("name") or "").strip()[:60]

    # Deliberate delay: makes online guessing tedious without a rate-limit store.
    await asyncio.sleep(0.4)

    if not security.check_studio_password(password):
        raise HTTPException(status_code=401, detail="That password is not right.")

    token = security.issue_session(label)
    response.set_cookie(
        key=settings.COOKIE_NAME,
        value=token,
        max_age=settings.SESSION_TTL_SECONDS,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    return {"ok": True, "who": label or "sales-engineer"}


@app.post("/api/studio/logout")
async def studio_logout(response: Response):
    response.delete_cookie(settings.COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/studio/session")
async def studio_session(session: dict = Depends(current_session)):
    return {"ok": True, "who": session.get("who", "")}


# ---------------------------------------------------------------------------
# Studio agent management
# ---------------------------------------------------------------------------

@app.get("/api/studio/agents")
async def studio_list(session: dict = Depends(current_session)):
    return {
        "agents": [full_view(a) for a in registry.all_agents()],
        "voices": VOICES,
    }


@app.post("/api/studio/agents")
async def studio_create(
    payload: dict = Body(...), session: dict = Depends(current_session)
):
    try:
        variant = registry.create_variant(payload, session.get("who", "sales-engineer"))
    except AgentError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return full_view(variant)


@app.put("/api/studio/agents/{slug}")
async def studio_update(
    slug: str, payload: dict = Body(...), session: dict = Depends(current_session)
):
    try:
        variant = registry.update_variant(slug, payload, session.get("who", "sales-engineer"))
    except AgentError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return full_view(variant)


@app.delete("/api/studio/agents/{slug}")
async def studio_delete(slug: str, session: dict = Depends(current_session)):
    try:
        removed = registry.delete_variant(slug)
    except AgentError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not removed:
        raise HTTPException(status_code=404, detail="No agent at that address.")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Live proxy
# ---------------------------------------------------------------------------

def _client_ip(ws: WebSocket) -> str:
    forwarded = ws.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return ws.client.host if ws.client else "unknown"


async def _pump_client_to_vertex(ws: WebSocket, upstream) -> None:
    while True:
        message = await ws.receive()
        if message.get("type") == "websocket.disconnect":
            return
        raw = message.get("text")
        if raw is None:
            # Binary frames are never expected; audio arrives base64 in JSON.
            continue
        safe = sanitize_client_frame(raw)
        if safe is None:
            log.debug("dropped client frame")
            continue
        await upstream.send(safe)


async def _pump_vertex_to_client(ws: WebSocket, upstream) -> None:
    greeted = False
    async for raw in upstream:
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", "replace")
        await ws.send_text(raw)
        if not greeted:
            try:
                if json.loads(raw).get("setupComplete") is not None:
                    greeted = True
                    await upstream.send(json.dumps(opening_turn()))
            except (json.JSONDecodeError, AttributeError):
                pass


@app.websocket("/ws/live")
async def live_session(ws: WebSocket):
    if not origin_allowed(ws.headers.get("origin")):
        await ws.close(code=CLOSE_POLICY)
        return

    await ws.accept()
    ip = _client_ip(ws)

    refusal = await limiter.acquire(ip)
    if refusal:
        await ws.send_text(json.dumps({"evaError": refusal}))
        await ws.close(code=CLOSE_TRY_AGAIN)
        return

    try:
        try:
            hello_raw = await asyncio.wait_for(ws.receive_text(), timeout=10.0)
            hello = json.loads(hello_raw)
        except (asyncio.TimeoutError, json.JSONDecodeError, WebSocketDisconnect):
            await ws.close(code=CLOSE_POLICY)
            return

        slug = str(hello.get("agent") or "concierge")
        agent = registry.get(slug)
        if agent is None or not agent.get("enabled", True):
            await ws.send_text(json.dumps({"evaError": "That agent is not available."}))
            await ws.close(code=CLOSE_POLICY)
            return

        if not settings.PROJECT_ID:
            await ws.send_text(
                json.dumps(
                    {"evaError": "Server is not configured with a Google Cloud project."}
                )
            )
            await ws.close(code=CLOSE_INTERNAL)
            return

        try:
            token = await token_provider.token()
        except Exception as exc:  # noqa: BLE001 - surfaced as a clean close
            log.exception("token mint failed")
            await ws.send_text(
                json.dumps({"evaError": "Server could not authenticate to Vertex AI."})
            )
            await ws.close(code=CLOSE_INTERNAL)
            return

        ssl_context = ssl.create_default_context(cafile=certifi.where())
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }

        log.info("session start agent=%s ip=%s", slug, ip)
        try:
            async with ws_connect(
                settings.service_url,
                additional_headers=headers,
                ssl=ssl_context,
                max_size=None,
                open_timeout=20,
            ) as upstream:
                await upstream.send(json.dumps(build_setup_message(agent)))
                await ws.send_text(
                    json.dumps({"evaReady": {"slug": slug, "name": agent.get("name", "")}})
                )

                tasks = [
                    asyncio.create_task(_pump_client_to_vertex(ws, upstream)),
                    asyncio.create_task(_pump_vertex_to_client(ws, upstream)),
                ]
                done, pending = await asyncio.wait(
                    tasks,
                    timeout=settings.MAX_SESSION_SECONDS,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if not done:
                    await ws.send_text(
                        json.dumps({"evaError": "Demo session time limit reached."})
                    )
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
        except (ConnectionClosed, WebSocketDisconnect):
            pass
        except Exception:  # noqa: BLE001
            log.exception("upstream failure")
            try:
                await ws.send_text(
                    json.dumps({"evaError": "Lost the connection to Vertex AI."})
                )
            except Exception:  # noqa: BLE001
                pass
    finally:
        await limiter.release(ip)
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
        log.info("session end ip=%s", ip)


# ---------------------------------------------------------------------------
# Static front end (mounted last so it never shadows the API)
# ---------------------------------------------------------------------------

STATIC_DIR = os.path.abspath(settings.STATIC_DIR)
INDEX_FILE = os.path.join(STATIC_DIR, "index.html")

if os.path.isdir(STATIC_DIR):
    assets = os.path.join(STATIC_DIR, "assets")
    if os.path.isdir(assets):
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        candidate = os.path.normpath(os.path.join(STATIC_DIR, full_path))
        if (
            full_path
            and candidate.startswith(STATIC_DIR + os.sep)
            and os.path.isfile(candidate)
        ):
            return FileResponse(candidate)
        if os.path.isfile(INDEX_FILE):
            return FileResponse(INDEX_FILE)
        return JSONResponse({"detail": "Front end not built."}, status_code=404)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=settings.PORT, reload=settings.DEBUG)
