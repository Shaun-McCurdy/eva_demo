"""Phase 0, spike B: what can this project's Vertex AI Search actually do, and how fast?

Three questions, in order:

  1. What data stores and engines exist? (`--list`, `--list-engines`)
  2. Which contentSearchSpec features does the tier actually allow? Querying a
     data store's own servingConfig has no engine in front of it, so it runs as
     STANDARD edition and refuses extractive answers, website search and
     summaries with a 400. Enterprise edition is set at the ENGINE level, so
     the same query routed through an engine can behave completely differently.
     The capability ladder below finds the richest spec that works.
  3. How slow is a query? gemini-3.1-flash-live supports synchronous function
     calling only, so the model is SILENT for the whole round trip. Anything
     past ~1s is audible dead air on a voice call.

Auth is Application Default Credentials.

Run:
    python scripts/spike_datastore_latency.py --list
    python scripts/spike_datastore_latency.py --list-engines
    python scripts/spike_datastore_latency.py --engine <engine-id>
    python scripts/spike_datastore_latency.py --store  <store-id>
"""

from __future__ import annotations

import argparse
import os
import statistics
import sys
import time

DEFAULT_QUERIES = [
    "What does the Enghouse Virtual Agent integrate with?",
    "Which contact centre platforms does Enghouse offer?",
    "How does Enghouse handle handover to a human agent?",
    "What is EnghouseAI?",
    "Does Enghouse support Microsoft Teams?",
]

SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]

SNIPPET = {"snippetSpec": {"returnSnippet": True}}
EXTRACTIVE = {"extractiveContentSpec": {"maxExtractiveAnswerCount": 1}}
SUMMARY = {
    "summarySpec": {
        "summaryResultCount": 3,
        "ignoreAdversarialQuery": True,
        "includeCitations": True,
    }
}

# Richest first. The first level that returns 200 is what retrieval.py can
# safely build on -- everything below it is a downgrade in grounding quality.
LADDER: list[tuple[str, dict | None]] = [
    ("snippets+extractive+summary", {**SNIPPET, **EXTRACTIVE, **SUMMARY}),
    ("snippets+extractive", {**SNIPPET, **EXTRACTIVE}),
    ("extractive only", dict(EXTRACTIVE)),
    ("snippets only", dict(SNIPPET)),
    ("plain (no contentSearchSpec)", None),
]


def host_for(location: str) -> str:
    """Non-global locations are served from a regional host."""
    return (
        "discoveryengine.googleapis.com"
        if location == "global"
        else f"{location}-discoveryengine.googleapis.com"
    )


def session_and_project(explicit_project: str | None):
    import google.auth
    from google.auth.transport.requests import AuthorizedSession

    try:
        credentials, adc_project = google.auth.default(scopes=SCOPES)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: no Application Default Credentials ({type(exc).__name__}: {exc})")
        print("Fix:  gcloud auth application-default login")
        return None, None

    project = (
        explicit_project
        or os.environ.get("GOOGLE_CLOUD_PROJECT", "").strip()
        or (adc_project or "")
    )
    if not project:
        print("FAIL: no project id. Pass --project or set GOOGLE_CLOUD_PROJECT.")
        return None, None
    return AuthorizedSession(credentials), project


def _collection(project: str, location: str) -> str:
    return (
        f"projects/{project}/locations/{location}/collections/default_collection"
    )


def _paged(session, url: str, key: str) -> list[dict]:
    items: list[dict] = []
    page_token = None
    while True:
        params = {"pageSize": 100}
        if page_token:
            params["pageToken"] = page_token
        response = session.get(url, params=params, timeout=30)
        if response.status_code != 200:
            print(f"FAIL: {response.status_code} on {url}\n{response.text[:500]}")
            return items
        payload = response.json()
        items.extend(payload.get(key) or [])
        page_token = payload.get("nextPageToken")
        if not page_token:
            break
    return items


def list_stores(session, project: str, location: str) -> list[dict]:
    url = f"https://{host_for(location)}/v1/{_collection(project, location)}/dataStores"
    return _paged(session, url, "dataStores")


def list_engines(session, project: str, location: str) -> list[dict]:
    """Engines are where the edition (STANDARD vs ENTERPRISE) is actually set."""
    url = f"https://{host_for(location)}/v1/{_collection(project, location)}/engines"
    return _paged(session, url, "engines")


def search_once(session, resource: str, location: str, query: str, spec: dict | None):
    """One :search call. Returns (seconds, status, result_count, payload_or_error)."""
    url = f"https://{host_for(location)}/v1/{resource}/servingConfigs/default_search:search"
    body: dict = {
        "query": query,
        "pageSize": 4,
        "queryExpansionSpec": {"condition": "AUTO"},
        "spellCorrectionSpec": {"mode": "AUTO"},
    }
    if spec is not None:
        body["contentSearchSpec"] = spec

    started = time.monotonic()
    try:
        response = session.post(url, json=body, timeout=30)
    except Exception as exc:  # noqa: BLE001
        return time.monotonic() - started, 0, 0, f"{type(exc).__name__}: {exc}"
    elapsed = time.monotonic() - started
    if response.status_code != 200:
        return elapsed, response.status_code, 0, response.text[:600]
    payload = response.json()
    return elapsed, 200, len(payload.get("results") or []), payload


def probe_capabilities(session, resource: str, location: str):
    """Find the richest contentSearchSpec this resource accepts."""
    print("CAPABILITY LADDER (richest first)")
    print("-" * 64)
    supported: list[tuple[str, dict | None]] = []
    for label, spec in LADDER:
        elapsed, status, count, body = search_once(
            session, resource, location, DEFAULT_QUERIES[0], spec
        )
        if status == 200:
            print(f"  [OK  ] {label:30} {elapsed:5.2f}s  {count} results")
            supported.append((label, spec))
        else:
            reason = body if isinstance(body, str) else ""
            first_line = ""
            for marker in ('"message": "', "'message': '"):
                if marker in reason:
                    first_line = reason.split(marker, 1)[1].split('"')[0][:140]
                    break
            print(f"  [FAIL] {label:30} HTTP {status}  {first_line or reason[:140]}")
    print()
    return supported


def report(label: str, timings: list[float]) -> None:
    if not timings:
        print(f"  {label:30} no successful calls")
        return
    ordered = sorted(timings)
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
    print(
        f"  {label:30} n={len(timings):<3} "
        f"median={statistics.median(ordered):.2f}s  "
        f"min={ordered[0]:.2f}s  max={ordered[-1]:.2f}s  p95={p95:.2f}s"
    )


def describe_shape(payload: dict) -> None:
    results = payload.get("results") or []
    if not results:
        print("\n  No results -- the store may be empty or still indexing.")
        return
    document = results[0].get("document") or {}
    derived = document.get("derivedStructData") or {}
    print("\n  First result's derivedStructData keys:")
    print(f"    {sorted(derived.keys())}")
    for field in ("title", "link"):
        if field in derived:
            print(f"    {field}: {str(derived[field])[:90]!r}")
    if "snippets" in derived and derived["snippets"]:
        snippet = derived["snippets"][0]
        print(f"    snippet: {str(snippet.get('snippet', ''))[:140]!r}")
    if "extractive_answers" in derived and derived["extractive_answers"]:
        answer = derived["extractive_answers"][0]
        print(f"    extractive: {str(answer.get('content', ''))[:140]!r}")
    if payload.get("summary"):
        text = (payload["summary"] or {}).get("summaryText", "")
        print(f"    summary: {text[:160]!r}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default=None)
    parser.add_argument("--location", default="global")
    parser.add_argument("--store", default=None, help="Data store id to probe.")
    parser.add_argument("--engine", default=None, help="Engine/app id to probe.")
    parser.add_argument("--list", action="store_true", help="List data stores and exit.")
    parser.add_argument(
        "--list-engines", action="store_true", help="List engines and exit."
    )
    parser.add_argument("--repeat", type=int, default=2)
    args = parser.parse_args()

    session, project = session_and_project(args.project)
    if session is None:
        return 2

    print(f"project  : {project}")
    print(f"location : {args.location}\n")

    if args.list_engines:
        engines = list_engines(session, project, args.location)
        if not engines:
            print("No engines. Every data store is queryable only at STANDARD tier,")
            print("so extractive answers and summaries stay unavailable.")
            return 1
        print(f"{len(engines)} engine(s):\n")
        for engine in engines:
            name = engine.get("name", "")
            config = engine.get("searchEngineConfig") or {}
            print(f"  id            {name.rsplit('/', 1)[-1]}")
            print(f"  displayName   {engine.get('displayName', '')}")
            print(f"  dataStoreIds  {engine.get('dataStoreIds', [])}")
            print(f"  tier          {config.get('searchTier', '(unset)')}")
            print(f"  addOns        {config.get('searchAddOns', [])}")
            print(f"  vertical      {engine.get('industryVertical', '')}\n")
        return 0

    if args.list or (not args.store and not args.engine):
        stores = list_stores(session, project, args.location)
        if not stores:
            print("No data stores found in this project/location.")
            return 1
        print(f"{len(stores)} data store(s):\n")
        for store in stores:
            name = store.get("name", "")
            print(f"  id             {name.rsplit('/', 1)[-1]}")
            print(f"  displayName    {store.get('displayName', '')}")
            print(f"  contentConfig  {store.get('contentConfig', '') or '(none)'}")
        if args.list:
            return 0
        print("\nPick one with --store <id>, or --engine <id> for Enterprise features.")
        return 0

    collection = _collection(project, args.location)
    if args.engine:
        resource = f"{collection}/engines/{args.engine}"
    else:
        resource = f"{collection}/dataStores/{args.store}"
    print(f"resource : {resource}\n")

    supported = probe_capabilities(session, resource, args.location)
    if not supported:
        print("FAIL: not one contentSearchSpec level worked. Read the errors above.")
        return 1

    best_label, best_spec = supported[0]
    print(f"Timing the richest working level: {best_label}")
    print("-" * 64)

    timings: list[float] = []
    first_payload = None
    for round_index in range(args.repeat):
        for query in DEFAULT_QUERIES:
            elapsed, status, count, payload = search_once(
                session, resource, args.location, query, best_spec
            )
            if status != 200:
                print(f"  HTTP {status} -- {payload}")
                continue
            timings.append(elapsed)
            if first_payload is None:
                first_payload = payload
            if round_index == 0:
                print(f"  {elapsed:5.2f}s  {count} results  {query[:50]!r}")

    print("\n" + "=" * 64)
    print("LATENCY -- this is dead air on a voice call, the model is blocked")
    print("=" * 64)
    report(best_label, timings)

    if timings:
        median = statistics.median(timings)
        if median <= 1.0:
            print("\n  PASS -- fits the voice budget. Proceed to Phase 1.")
        else:
            print(
                f"\n  WARNING -- {median:.2f}s median is audible dead air. Phase 4's\n"
                "  bridge line becomes mandatory, and a 2.5-Flash NON_BLOCKING\n"
                "  fallback is worth costing out."
            )

    if first_payload:
        describe_shape(first_payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
