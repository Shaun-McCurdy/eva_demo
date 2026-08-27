# EVA Demo Site

A public-facing demo of the **Enghouse Virtual Agent**, built on Google's
[Gemini Live API native-audio React demo][upstream] and reshaped into a site in
the spirit of [alice.enghouseinteractive.com][alice]: a landing page, a set of
switchable vertical agents, an audio-reactive avatar, and a password-gated
studio where sales engineers clone an agent with their own instructions and get
their own sub-URL.

[upstream]: https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/multimodal-live-api/native-audio-websocket-demo-apps/react-demo-app
[alice]: https://alice.enghouseinteractive.com/

---

## What this is

| Route | What it is |
|---|---|
| `/` | Landing page and scenario picker |
| `/a/:slug` | The conversation stage for one agent |
| `/studio` | Password-gated console for sales engineers |
| `/ws/live` | The hardened WebSocket proxy to the Gemini Live API |
| `/api/*` | Public agent metadata + authenticated studio API |

Five built-in agents ship with it: **concierge** (Enghouse product Q&A),
**banking**, **healthcare**, **retail**, and **utilities**. Each has its own
goal, instructions, voice and accent colour.

---

## Authentication is an API key, and it never leaves the server

This app talks to the **Gemini Developer API**, not Vertex AI. It used to be the
other way round; the move happened because `gemini-3.1-flash-live-preview` is
served here and has no documented Vertex equivalent.

```
wss://generativelanguage.googleapis.com/ws/...GenerativeService.BidiGenerateContent?key={GEMINI_API_KEY}
model: models/{MODEL}
```

Two consequences worth knowing.

**The credential is in the query string.** There is no header form. That makes
the connect URL itself a secret, which is why `settings.service_url` deliberately
excludes the key and `settings.authenticated_url()` — used only at the moment of
connecting — includes it. A logging formatter in `main.py` redacts the key from
every line it emits, tracebacks included. There is a test for this, because a
leak here would be silent.

**It is long-lived and unscoped.** Unlike the Vertex service-account token this
replaced, an API key carries no IAM roles, no VPC-SC, and no expiry. It belongs
in Secret Manager and nowhere else. Restrict it in AI Studio.

The browser never sees it either way — the proxy holds it server-side, which is
the same property the Vertex version had.

Google Cloud has not disappeared entirely: `STORE_BACKEND=firestore` still needs
a project and Application Default Credentials. The model calls no longer do.

---

## What was changed from the upstream sample, and why

The sample proxy is written for `localhost`. Four things had to change before it
could have a public URL.

**1. The browser no longer builds the session.**
Upstream, the React app constructs the entire `setup` frame — model,
system instruction, temperature, tools — and the proxy forwards it. On a public
site that means anyone who opens devtools can point your API key at any
prompt they like. Here, the browser sends one line:

```json
{ "agent": "banking" }
```

The server looks that agent up in its own store and builds `setup` itself from
`BASE_GUARDRAILS + goal + instructions`. Nothing about the agent's behaviour is
client-controlled.

**2. The proxy no longer trusts the client for the upstream address or credential.**
Upstream accepts `service_url` and `bearer_token` in the client's first message.
Both are server constants here.

**3. Client frames are filtered.**
Only `realtime_input`, `client_content` and `tool_response` are forwarded, under
a size cap. A frame carrying `setup` — even smuggled alongside a legitimate
audio chunk — is stripped or dropped. This is covered by tests.

**4. Sessions are bounded.**
Per-IP concurrency, per-IP hourly rate, global concurrency, and a hard session
duration. A public demo URL is otherwise an uncapped bill.

The audio pipeline itself — the capture and playback AudioWorklets, the 16 kHz
in / 24 kHz out PCM handling, the response parser — is upstream's, and works
well. The additions there are RMS level metering on both directions, which is
what drives the avatar.

---

## Running it locally

You need Node 20+, Python 3.11+, an API key from
[AI Studio](https://aistudio.google.com/apikey), and — only if you want the
Firestore store — a GCP project.

```bash
# 1. Configure
cp .env.example .env
$EDITOR .env          # set GEMINI_API_KEY, STUDIO_PASSWORD, COOKIE_SECURE=false

# 2. Only if you want the Firestore store (STORE_BACKEND=file needs none of this)
gcloud auth application-default login

# 3. Back end
python -m venv .venv && source .venv/bin/activate
pip install -r server/requirements.txt
set -a && source .env && set +a
cd server && python main.py           # http://localhost:8080

# 4. Front end, in a second terminal
cd web && npm install && npm run dev  # http://localhost:5173
```

Open <http://localhost:5173>. Vite proxies `/api` and `/ws` to port 8080, so the
browser only ever sees one origin and cookies behave as they will in production.

Set `COOKIE_SECURE=false` for local http, or the studio cookie will not be
stored and you will appear to log in successfully and then immediately be
logged out.

### Tests

```bash
python tests/test_server.py
```

71 checks, no dependencies beyond the standard library and `itsdangerous`. They
cover the things that would actually hurt: frame filtering, that instructions
never appear in a public API response, slug and variant validation, password
hashing, session tampering, and origin checks.

---

## Deploying

See **[DEPLOY.md](DEPLOY.md)** for the Cloud Run walkthrough.

---

## Giving EVA a face

The avatar renders `web/public/avatar/eva.png` if that file exists, and a
line-art placeholder if it does not. Drop a portrait in at that path — square,
at least 512×512, ideally with the subject centred — and it appears with no code
change. The halo, the equaliser mouth and the listening indicator all keep
working around it.

If you later want a lip-synced video avatar (HeyGen, D-ID, Simli), the seam is
`web/src/components/Avatar.jsx`. It already receives `agentLevel`, `micLevel`
and `speaking`, which is everything such a vendor needs, and nothing else in the
app reaches into it.

---

## Layout

```
server/
  main.py         FastAPI app: static site, public API, studio API, /ws/live
  live_proxy.py   Frame filtering, setup construction, rate limits
  agents.py       Registry: built-ins + variants, validation, public/full views
  personas.py     BASE_GUARDRAILS and the five shipped agents
  store.py        JSON-file and Firestore backends
  security.py     scrypt password hashing, signed session cookies
  settings.py     The full environment-variable contract

web/
  src/lib/        live-client.js, media.js, api.js
  src/components/ Landing, AgentStage, Avatar, Transcript, ParticleField
  src/components/studio/  Gate, Studio console, AgentEditor
  public/audio-processors/  capture + playback worklets (from upstream)
  public/avatar/  drop eva.png here

tests/test_server.py
Dockerfile        Two-stage: npm build, then Python runtime
```
