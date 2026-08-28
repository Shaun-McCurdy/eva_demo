# Deploying to Cloud Run

One container: the Python server serves both the API and the built React site,
on the single port Cloud Run gives it. The Live API is reached with an API key
held in Secret Manager; Firestore uses the attached service account. No key file
is ever created or stored.

Set these once:

```bash
export PROJECT_ID=your-gcp-project
export REGION=us-east1             # Cloud Run's region -- your choice, see below
export SERVICE=eva-demo
gcloud config set project $PROJECT_ID
```

---

## 1. Enable the APIs

```bash
gcloud services enable \
  generativelanguage.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  firestore.googleapis.com \
  secretmanager.googleapis.com
```

## 2. Create Firestore

Variants created in the studio need somewhere shared to live. Cloud Run's
filesystem is per-instance and disappears on scale-down, so `STORE_BACKEND=file`
would mean a variant one SE creates is invisible to another and gone by morning.

```bash
gcloud firestore databases create --location=$REGION
```

## 3. Create the service account

Least privilege. Since the model calls authenticate with an API key rather than
this identity, all it needs is one Firestore collection and the two secrets.

```bash
gcloud iam service-accounts create eva-demo-sa \
  --display-name="EVA demo runtime"

SA="eva-demo-sa@$PROJECT_ID.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:$SA" --role="roles/datastore.user"
```

## 4. Create the secrets

```bash
# The Microsoft app registration's client secret. Note these expire -- the
# failure mode is the studio locking everyone out on a Monday morning, so put
# the expiry in a calendar.
printf %s 'the-client-secret' | gcloud secrets create eva-ms-secret --data-file=-

# The Gemini API key, from https://aistudio.google.com/apikey. It is a
# long-lived bearer credential with no IAM scoping, so it never goes in an env
# var or into the image -- only here.
printf %s 'your-ai-studio-key' | gcloud secrets create eva-gemini-key --data-file=-

# Studio password, stored as a scrypt hash rather than plaintext.
python server/security.py hash 'the-password-you-give-your-SEs' \
  | tr -d '\n' | gcloud secrets create eva-studio-hash --data-file=-

# Cookie signing key. Without a stable value, every deploy and every new
# instance silently logs your SEs out.
python -c "import secrets; print(secrets.token_hex(32))" \
  | tr -d '\n' | gcloud secrets create eva-session-secret --data-file=-

for s in eva-gemini-key eva-ms-secret eva-studio-hash eva-session-secret; do
  gcloud secrets add-iam-policy-binding $s \
    --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
done
```

## 5. Deploy

```bash
gcloud run deploy $SERVICE \
  --source . \
  --region $REGION \
  --service-account $SA \
  --allow-unauthenticated \
  --cpu 1 --memory 1Gi \
  --min-instances 0 --max-instances 2 \
  --concurrency 20 \
  --timeout 3600 \
  --session-affinity \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT_ID,STORE_BACKEND=firestore,COOKIE_SECURE=true,MAX_SESSION_SECONDS=600,MAX_CONCURRENT_SESSIONS=12,MS_TENANT_ID=$MS_TENANT_ID,MS_CLIENT_ID=$MS_CLIENT_ID,MS_REDIRECT_URI=$URL/api/studio/sso/callback" \
  --set-secrets "GEMINI_API_KEY=eva-gemini-key:latest,MS_CLIENT_SECRET=eva-ms-secret:latest,STUDIO_PASSWORD_HASH=eva-studio-hash:latest,SESSION_SECRET=eva-session-secret:latest"
```

Then lock the WebSocket to your own origin:

```bash
URL=$(gcloud run services describe $SERVICE --region $REGION --format='value(status.url)')
gcloud run services update $SERVICE --region $REGION \
  --update-env-vars "ALLOWED_ORIGINS=$URL"
echo $URL
```

Add your custom domain's origin to that list too, comma-separated, once mapped.

### Why those flags

- **`--timeout 3600`** — Cloud Run's default request timeout also caps
  WebSocket lifetime. At the default 300s every conversation is cut off after
  five minutes. The app's own `MAX_SESSION_SECONDS` is the limit that should
  actually bite.
- **`--session-affinity`** — the rate limiter is per-instance in memory.
  Affinity keeps one visitor on one instance so the limit means something.
- **`--max-instances 2`** — the effective ceiling is the per-instance limit
  times the instance count. Keep it low for a demo; the API quota is the real
  backstop.
- **`--concurrency 20`** — each live session holds an open socket and a small
  amount of CPU. Packing hundreds onto one instance degrades audio for everyone.

## 5b. Register the Microsoft app

The studio signs in with Microsoft 365. Anyone in the tenant may sign in -- the
tenant id is the only membership check, which is deliberate for an internal
tool but does mean any Enghouse account can create, edit and delete demo agents.

In Entra ID -> App registrations -> New registration:

- **Redirect URI** (type Web): `$URL/api/studio/sso/callback`. It must match
  `MS_REDIRECT_URI` character for character, so deploy once to learn `$URL`,
  then register and redeploy.
- **API permissions**: delegated `openid`, `profile`, `email`. Nothing else --
  this app never calls Graph.
- **Certificates & secrets**: a client secret, into `eva-ms-secret` above.

```bash
export MS_TENANT_ID=<directory (tenant) id>
export MS_CLIENT_ID=<application (client) id>
```

`STUDIO_PASSWORD_FALLBACK` defaults to true so the shared password still works
while SSO beds in. Set it to `false` once you have signed in with Microsoft
successfully, and the studio then has exactly one way in.

## 6. Check it

```bash
curl -s $URL/healthz            # {"ok":true,"apiKey":true,"project":true,"projectSource":"GOOGLE_CLOUD_PROJECT"}
curl -s $URL/api/agents | head  # five built-in agents
```

`apiKey:false` means every live session will be refused — the `--set-secrets`
above did not land. It reports only whether a key is configured, never its value.

```bash
curl -s $URL/api/studio/auth-methods   # {"sso":true,"password":true}
```

`sso:false` means the three `MS_*` values did not all land. `password:true`
after you have switched the fallback off means `STUDIO_PASSWORD_FALLBACK` did
not land either.

`projectSource` says where the project id came from. It matters only to
Firestore now, since the model calls no longer touch Google Cloud:

| value | meaning |
| --- | --- |
| `GOOGLE_CLOUD_PROJECT` | the env var set by step 5. What you want. |
| `ADC` | the env var is missing; the id came from the metadata server. Works, but the `--set-env-vars` above did not land — fix the deploy so the config is explicit. |
| `unset` | no project. Harmless with `STORE_BACKEND=file`; with `firestore` the studio cannot read or write variants. |

Cloud Run does not set `GOOGLE_CLOUD_PROJECT` for you the way App Engine and
Cloud Functions do, so it has to come from `--set-env-vars`; the `ADC` fallback
exists only so a forgotten flag degrades to a warning instead of an outage.

Then open the URL, click through to an agent, and talk to it. Check the studio
at `$URL/studio`.

---

## Cost control

The Live API bills for audio in and out, so an unattended public URL is the
thing to watch. In rough order of usefulness:

1. **A rate limit on the API key** in AI Studio — the only hard ceiling that
   does not depend on this app behaving. Set it deliberately, and note it moved
   with the API: Vertex quotas on the GCP project no longer bound this demo.
2. **A billing budget alert** on whichever account backs the key.
3. `MAX_SESSION_SECONDS` — 600 is a generous demo; 300 is plenty for most.
4. `MAX_SESSIONS_PER_IP_HOUR` — the anti-scripting control.
5. `--max-instances` — bounds total concurrency.

If the demo is only ever shown by an SE on a call, consider not making it public
at all: drop `--allow-unauthenticated` and put it behind IAP, or put the whole
site behind the same shared password the studio uses.

---

## Operating notes

**Rotating the studio password.** Add a new secret version and redeploy; the
scrypt hash means the old password stops working immediately. Existing sessions
survive until the cookie expires — to kill those too, rotate `SESSION_SECRET`,
which signs every session out at once.

**Adding a vertical.** Built-ins live in `server/personas.py` and are code, not
data, so they cannot be broken from the studio. Add an entry, redeploy, and it
appears on the landing page. Variants created in the studio are deliberately
*unlisted* — reachable by their URL, never advertised on `/`.

**Changing model.** `GEMINI_MODEL` is an env var. Check the model's own page for
what it supports before switching: `gemini-3.1-flash-live-preview` accepts
neither affective dialog nor proactive audio, and the setup frame in
`live_proxy.py` was trimmed to match. A model that rejects a field in that frame
closes the socket rather than failing cleanly, so the close code and reason are
logged.

**Choosing a region.** The Developer API is global-routed, so the Cloud Run
`--region` no longer has to match anything -- pick whatever is near your
audience. Firestore is separate: its location is fixed when the database is
created and cannot be moved afterwards.

**Logs.** Session start and end lines carry the agent slug and client IP:

```bash
gcloud run services logs read $SERVICE --region $REGION --limit 50
```
