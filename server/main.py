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
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed, ConnectionClosedOK

import retrieval
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
    tool_response_frame,
)
from settings import settings
from store import build_store

_LOG_FORMAT = "%(asctime)s %(levelname)s %(message)s"


class _RedactingFormatter(logging.Formatter):
    """Keeps the API key out of the logs.

    The Live API takes its credential in the query string, so any exception
    carrying the connect URL would otherwise print the key straight into Cloud
    Run logs. Redacting at format time covers tracebacks as well, which a
    logging.Filter cannot reach.
    """

    def format(self, record: logging.LogRecord) -> str:
        return settings.redact(super().format(record))


logging.basicConfig(level=logging.DEBUG if settings.DEBUG else logging.INFO)
for _handler in logging.getLogger().handlers:
    _handler.setFormatter(_RedactingFormatter(_LOG_FORMAT))
log = logging.getLogger("eva")


def _close_info(exc: ConnectionClosed) -> tuple[int | None, str]:
    """Read the close code and reason across websockets versions.

    The library moved these from the exception onto a received Close frame, so
    try the frame first and fall back to the older attributes.
    """
    rcvd = getattr(exc, "rcvd", None)
    if rcvd is not None:
        return getattr(rcvd, "code", None), getattr(rcvd, "reason", "") or ""
    return getattr(exc, "code", None), getattr(exc, "reason", "") or ""

registry = AgentRegistry(build_store())


@asynccontextmanager
async def lifespan(app: FastAPI):
    for problem in settings.validate():
        log.warning("CONFIG: %s", problem)
    log.info(
        "EVA demo up | model=%s key=%s project=%s (via %s) store=%s",
        settings.MODEL,
        "set" if settings.GEMINI_API_KEY else "MISSING",
        settings.PROJECT_ID or "(unset)",
        settings.PROJECT_SOURCE,
        settings.STORE_BACKEND,
    )
    log.info("knowledge sources | %s", retrieval.describe())
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

# Two paths, one handler. `/healthz` is a *reserved path on Google Cloud*: the
# Google Front End answers it with its own branded 404 before the request ever
# reaches the container, on the run.app URL and through a domain mapping alike,
# and no request log is produced. The symptom is a health endpoint that works
# perfectly on localhost and 404s in production for no visible reason.
#
# /api/healthz is the one to use anywhere deployed. /healthz stays registered
# because it is reachable locally and behind any other proxy, and dropping it
# would break every runbook and bookmark that already uses it.
@app.get("/api/healthz")
@app.get("/healthz")
async def healthz():
    # Whether each dependency is configured, never what it is configured to.
    # apiKey gates every live session; project and projectSource only matter to
    # Firestore now, and projectSource is the one thing you want to see when a
    # deploy comes up with no project.
    # dataStores is a count, not a list: it is the one number that tells you
    # whether VERTEX_DATA_STORES actually reached the container. This project
    # deploys through a Cloud Build trigger that drops --set-env-vars, so a
    # config that "should" be set arriving as zero is a real failure mode, and
    # a silently source-less agent looks identical to a working one until a
    # customer asks it something.
    return {
        "ok": True,
        "apiKey": bool(settings.GEMINI_API_KEY),
        "project": bool(settings.PROJECT_ID),
        "projectSource": settings.PROJECT_SOURCE,
        "dataStores": len(retrieval.catalogue),
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


SSO_STATE_COOKIE = "eva_sso"


def _redirect_uri(request: Request) -> str:
    """Where Microsoft sends the visitor back.

    Configured explicitly in any real deployment, because it has to match a URI
    registered on the app registration character for character. The derived
    form is a local-development convenience only.
    """
    if settings.MS_REDIRECT_URI:
        return settings.MS_REDIRECT_URI
    return str(request.url_for("studio_sso_callback"))


# Constructing this performs OpenID discovery against Microsoft, so building
# one per request would put a network round trip in front of every sign-in and
# fail outright whenever login.microsoftonline.com hiccups. One instance, built
# on first use, reused thereafter -- msal caches the authority metadata on it.
_msal_singleton: dict = {}


def _msal_app():
    app_obj = _msal_singleton.get("app")
    if app_obj is None:
        import msal  # imported lazily so msal is optional when SSO is off

        app_obj = msal.ConfidentialClientApplication(
            client_id=settings.MS_CLIENT_ID,
            client_credential=settings.MS_CLIENT_SECRET,
            authority=settings.authority,
        )
        _msal_singleton["app"] = app_obj
    return app_obj


@app.get("/api/studio/auth-methods")
async def studio_auth_methods():
    """What the sign-in screen should offer. Never reveals any secret."""
    return {"sso": settings.sso_configured, "password": settings.password_enabled}


@app.get("/api/studio/sso/start")
async def studio_sso_start(request: Request):
    if not settings.sso_configured:
        raise HTTPException(status_code=404, detail="Microsoft sign-in is not configured.")

    try:
        # initiate_auth_code_flow generates the state, the nonce and the PKCE
        # pair, and puts the S256 challenge in the URL. Building that URL by
        # hand is how you end up shipping a flow that looks like PKCE and is
        # not: the older get_authorization_request_url() accepts and silently
        # discards code_challenge arguments.
        flow = _msal_app().initiate_auth_code_flow(
            scopes=[],  # identity only; we never call Graph
            redirect_uri=_redirect_uri(request),
        )
    except Exception:  # noqa: BLE001
        log.exception("sso start failed to build the authorization request")
        raise HTTPException(
            status_code=503, detail="Microsoft sign-in is unavailable right now."
        )

    response = RedirectResponse(flow["auth_uri"], status_code=307)
    # The flow travels in a cookie rather than server memory: the callback is a
    # fresh request that may land on any Cloud Run instance.
    response.set_cookie(
        key=SSO_STATE_COOKIE,
        value=security.issue_sso_state(flow),
        max_age=security.SSO_STATE_TTL_SECONDS,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite="lax",  # must survive Microsoft's cross-site redirect back
        path="/",
    )
    return response


@app.get("/api/studio/sso/callback", name="studio_sso_callback")
async def studio_sso_callback(
    request: Request, eva_sso: str | None = Cookie(default=None)
):
    def refuse(reason: str):
        log.warning("sso refused: %s", reason)
        r = RedirectResponse("/studio?sso=failed", status_code=303)
        r.delete_cookie(SSO_STATE_COOKIE, path="/")
        return r

    flow = security.read_sso_state(eva_sso)
    if flow is None:
        return refuse("no valid flow cookie: expired, tampered with, or forged callback")

    params = dict(request.query_params)
    if "error" in params:
        return refuse(
            "provider returned %s: %s"
            % (params.get("error"), params.get("error_description"))
        )

    try:
        # This validates state and nonce against the flow and completes the
        # PKCE exchange, then verifies the ID token's signature, issuer and
        # audience. A mismatch raises or comes back as an error result.
        result = _msal_app().acquire_token_by_auth_code_flow(flow, params)
    except Exception as exc:  # noqa: BLE001
        log.exception("sso token exchange failed")
        return refuse("token exchange raised %s" % type(exc).__name__)

    if "error" in result:
        return refuse("token exchange: %s" % result.get("error"))

    claims = result.get("id_token_claims") or {}
    # msal has verified the token itself. Which tenant it came from is ours to
    # check: without this, any Microsoft account in the world would be valid.
    if claims.get("tid") != settings.MS_TENANT_ID:
        return refuse("tenant %r is not this tenant" % claims.get("tid"))

    who = (
        claims.get("preferred_username")
        or claims.get("email")
        or claims.get("name")
        or "sales-engineer"
    )

    response = RedirectResponse("/studio", status_code=303)
    response.set_cookie(
        key=settings.COOKIE_NAME,
        value=security.issue_session(str(who)[:120]),
        max_age=settings.SESSION_TTL_SECONDS,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    response.delete_cookie(SSO_STATE_COOKIE, path="/")
    log.info("studio sign-in via sso who=%s", who)
    return response


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
        # Curated labels, not whatever Discovery Engine reports: display names
        # there are not unique -- nine stores in this project are called
        # "gcs_store" -- so an auto-populated picker would be unusable.
        "dataStores": retrieval.catalogue.public_entries(),
        "maxDataStores": settings.MAX_DATA_STORES_PER_AGENT,
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


async def _pump_client_to_model(ws: WebSocket, upstream, stats: dict) -> None:
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
            # Counted rather than logged per frame: at 4 audio chunks a second a
            # per-frame line would bury everything else, but a session that
            # forwards zero frames is the single most useful thing to know when
            # the agent cannot hear the visitor.
            stats["dropped"] += 1
            continue
        stats["sent"] += 1
        await upstream.send(safe)


async def _run_tool_call(
    ws: WebSocket, upstream, agent: dict, tool_call: dict, stats: dict
) -> None:
    """Execute a model tool call and answer it upstream.

    Runs as its own task so the receive loop keeps pumping audio while the
    search is in flight. The model is blocked either way -- Gemini 3.1 Flash
    Live has no asynchronous function calling -- but blocking the pump as well
    would also stall the visitor's own audio reaching Google.

    Every path must send a response. A tool call left unanswered hangs the turn
    permanently: the visitor gets silence and no error, which is the worst of
    the available failure modes.
    """
    calls = [c for c in (tool_call.get("functionCalls") or []) if isinstance(c, dict)]
    if not calls:
        return

    query = ""
    for call in calls:
        args = call.get("args") or {}
        if isinstance(args, dict) and args.get("query"):
            query = str(args["query"])
            break

    stats["tools"] += 1
    log.info("tool call agent=%s query=%r", agent.get("slug"), query[:120])

    # Tell the page a lookup started, so it can show something rather than
    # leaving the visitor watching an idle avatar.
    try:
        await ws.send_text(json.dumps({"evaTool": {"state": "searching", "query": query}}))
    except Exception:  # noqa: BLE001
        pass

    outcome = retrieval.SearchOutcome([], failed=True)
    try:
        outcome = await retrieval.search(agent.get("dataStores") or [], query)
    except Exception:  # noqa: BLE001
        log.exception("tool call failed agent=%s", agent.get("slug"))

    passages = outcome.passages
    payload = retrieval.tool_response_payload(passages, failed=outcome.failed)
    try:
        await upstream.send(json.dumps(tool_response_frame(calls, payload)))
    except Exception:  # noqa: BLE001
        log.exception("could not deliver tool response agent=%s", agent.get("slug"))
        return

    try:
        await ws.send_text(
            json.dumps(
                {
                    "evaTool": {
                        "state": "error" if outcome.failed else "done",
                        "query": query,
                        "sources": [p.for_client() for p in passages],
                    }
                }
            )
        )
    except Exception:  # noqa: BLE001
        pass


async def _pump_model_to_client(
    ws: WebSocket, upstream, agent: dict, stats: dict, greet: bool = True
) -> None:
    greeted = False
    pending: set[asyncio.Task] = set()
    try:
        async for raw in upstream:
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", "replace")
            stats["received"] += 1
            await ws.send_text(raw)

            # Substring guard before parsing: audio frames are large base64 and
            # decoding every one of them to find a few rare control messages is
            # not worth the CPU on a shared instance. toolCall MUST be in this
            # list -- without it every tool call is silently skipped and the
            # agent simply never looks anything up.
            if greeted and not any(
                marker in raw for marker in ("goAway", "toolCall")
            ):
                continue
            try:
                frame = json.loads(raw)
            except (json.JSONDecodeError, AttributeError):
                continue
            if not isinstance(frame, dict):
                continue
            if not greeted and frame.get("setupComplete") is not None:
                # Flip this either way: it also stops us parsing every audio frame
                # from here on, whether or not a greeting was sent.
                greeted = True
                if greet:
                    await upstream.send(json.dumps(opening_turn()))

            tool_call = frame.get("toolCall")
            if tool_call is not None:
                task = asyncio.create_task(
                    _run_tool_call(ws, upstream, agent, tool_call, stats)
                )
                pending.add(task)
                task.add_done_callback(pending.discard)

            cancellation = frame.get("toolCallCancellation")
            if cancellation is not None:
                # Sent when the visitor interrupts a turn the model was waiting
                # on. The search is now pointless -- and answering a cancelled
                # id is an error -- so drop the work.
                log.info("tool call cancelled ids=%s", cancellation.get("ids"))
                for task in list(pending):
                    task.cancel()

            going = frame.get("goAway")
            if going is not None:
                # Google warns before it ends a connection. Unlogged, the session
                # just stops and is indistinguishable from a crash.
                log.warning(
                    "upstream goAway timeLeft=%s -- connection is being ended",
                    going.get("timeLeft") if isinstance(going, dict) else going,
                )
    finally:
        for task in list(pending):
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)


@app.websocket("/ws/live")
async def live_session(ws: WebSocket):
    if not origin_allowed(ws.headers.get("origin")):
        await ws.close(code=CLOSE_POLICY)
        return

    await ws.accept()
    ip = _client_ip(ws)

    stats = {"sent": 0, "dropped": 0, "received": 0, "tools": 0}

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
        # The visitor may open with typed text instead of waiting to be greeted.
        # Anything other than an explicit false keeps the greeting.
        greet = hello.get("greet") is not False
        agent = registry.get(slug)
        if agent is None or not agent.get("enabled", True):
            await ws.send_text(json.dumps({"evaError": "That agent is not available."}))
            await ws.close(code=CLOSE_POLICY)
            return

        if not settings.GEMINI_API_KEY:
            await ws.send_text(
                json.dumps({"evaError": "Server is not configured with an API key."})
            )
            await ws.close(code=CLOSE_INTERNAL)
            return

        ssl_context = ssl.create_default_context(cafile=certifi.where())
        headers = {"Content-Type": "application/json"}

        log.info("session start agent=%s ip=%s", slug, ip)
        try:
            async with ws_connect(
                settings.authenticated_url(),
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
                    asyncio.create_task(_pump_client_to_model(ws, upstream, stats)),
                    asyncio.create_task(
                        _pump_model_to_client(ws, upstream, agent, stats, greet)
                    ),
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

                # asyncio.wait does not raise a finished task's exception, it
                # just hands the task back. Without re-raising here, an upstream
                # close dies unretrieved inside the pump task: the handlers below
                # never run, the browser is told nothing, and the only trace is
                # asyncio's own "Task exception was never retrieved" dump.
                for task in done:
                    if task.cancelled():
                        continue
                    exc = task.exception()
                    if exc is not None:
                        raise exc
        except (ConnectionClosedOK, WebSocketDisconnect):
            pass
        except ConnectionClosed as exc:
            # Google closes the socket with a code and a reason when it refuses
            # the setup frame -- an unsupported field, an unknown model, a dead
            # key. Swallowing that made every such failure look like an agent
            # that simply would not talk. Log the reason; tell the page only the
            # code, since this is a public site and the reason is internal.
            code, reason = _close_info(exc)
            log.warning(
                "upstream closed agent=%s code=%s reason=%s", slug, code, reason
            )
            try:
                await ws.send_text(
                    json.dumps(
                        {"evaError": f"The session ended unexpectedly (code {code})."}
                    )
                )
            except Exception:  # noqa: BLE001
                pass
        except Exception:  # noqa: BLE001
            log.exception("upstream failure agent=%s", slug)
            try:
                await ws.send_text(
                    json.dumps({"evaError": "Lost the connection to the Live API."})
                )
            except Exception:  # noqa: BLE001
                pass
    finally:
        await limiter.release(ip)
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
        # sent=0 means the browser never delivered audio -- look at the client,
        # not the model. dropped>0 means frames were filtered by
        # sanitize_client_frame, which is a client/server contract mismatch.
        log.info(
            "session end ip=%s frames sent=%s dropped=%s received=%s tools=%s",
            ip,
            stats.get("sent", 0),
            stats.get("dropped", 0),
            stats.get("received", 0),
            stats.get("tools", 0),
        )


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
