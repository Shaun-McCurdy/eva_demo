"""Phase 0, spike B: what does a real Vertex AI Search query cost in latency?

Two questions, in order:

  1. Does an Enghouse data store exist in this project at all? `--list` answers
     that before anyone writes retrieval code against a store that isn't there.
  2. How slow is a query? This matters more than usual: gemini-3.1-flash-live
     supports synchronous function calling only, so the model is SILENT for the
     whole round trip. Anything past ~1s is audible dead air on a voice call.

It also measures the cost of `summarySpec` (which invokes an LLM server-side)
against snippets-only, because that is the single biggest latency lever in the
retrieval design and the plan assumes -- without evidence until this runs --
that summaries are too slow to use.

Auth is Application Default Credentials:
    gcloud auth application-default login

Run:
    .venv/Scripts/python.exe scripts/spike_datastore_latency.py --list
    .venv/Scripts/python.exe scripts/spike_datastore_latency.py --store <id>
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


def list_stores(session, project: str, location: str) -> list[dict]:
    """Enumerate data stores so we stop guessing what exists."""
    url = (
        f"https://{host_for(location)}/v1/projects/{project}/locations/{location}"
        f"/collections/default_collection/dataStores"
    )
    stores: list[dict] = []
    page_token = None
    while True:
        params = {"pageSize": 100}
        if page_token:
            params["pageToken"] = page_token
        response = session.get(url, params=params, timeout=30)
        if response.status_code != 200:
            print(f"FAIL: list returned {response.status_code}: {response.text[:400]}")
            return stores
        payload = response.json()
        stores.extend(payload.get("dataStores") or [])
        page_token = payload.get("nextPageToken")
        if not page_token:
            break
    return stores


def search_once(session, resource: str, location: str, query: str, summary: bool):
    """One :search call. Returns (seconds, http_status, result_count, body)."""
    url = f"https://{host_for(location)}/v1/{resource}/servingConfigs/default_search:search"
    content_spec: dict = {
        "snippetSpec": {"returnSnippet": True},
        "extractiveContentSpec": {"maxExtractiveAnswerCount": 1},
    }
    if summary:
        content_spec["summarySpec"] = {
            "summaryResultCount": 3,
            "ignoreAdversarialQuery": True,
            "includeCitations": True,
        }

    body = {
        "query": query,
        "pageSize": 4,
        "contentSearchSpec": content_spec,
        "queryExpansionSpec": {"condition": "AUTO"},
        "spellCorrectionSpec": {"mode": "AUTO"},
    }

    started = time.monotonic()
    response = session.post(url, json=body, timeout=30)
    elapsed = time.monotonic() - started
    if response.status_code != 200:
        return elapsed, response.status_code, 0, response.text[:400]
    payload = response.json()
    return elapsed, 200, len(payload.get("results") or []), payload


def report(label: str, timings: list[float]) -> None:
    if not timings:
        print(f"  {label:22} no successful calls")
        return
    ordered = sorted(timings)
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
    print(
        f"  {label:22} n={len(timings):<3} "
        f"median={statistics.median(ordered):.2f}s  "
        f"min={ordered[0]:.2f}s  max={ordered[-1]:.2f}s  p95={p95:.2f}s"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default=None)
    parser.add_argument("--location", default="global")
    parser.add_argument("--store", default=None, help="Data store id to probe.")
    parser.add_argument("--list", action="store_true", help="List data stores and exit.")
    parser.add_argument("--repeat", type=int, default=2)
    args = parser.parse_args()

    session, project = session_and_project(args.project)
    if session is None:
        return 2

    print(f"project  : {project}")
    print(f"location : {args.location}\n")

    if args.list or not args.store:
        stores = list_stores(session, project, args.location)
        if not stores:
            print("No data stores found in this project/location.")
            print("Nothing to ground against yet -- one has to be created first.")
            return 1
        print(f"{len(stores)} data store(s):\n")
        for store in stores:
            name = store.get("name", "")
            print(f"  id           {name.rsplit('/', 1)[-1]}")
            print(f"  displayName  {store.get('displayName', '')}")
            print(f"  contentConfig{store.get('contentConfig', '')!r}")
            print(f"  name         {name}\n")
        if args.list:
            return 0
        print("Pick one with --store <id> to measure latency.")
        return 0

    resource = (
        f"projects/{project}/locations/{args.location}"
        f"/collections/default_collection/dataStores/{args.store}"
    )
    print(f"store    : {resource}\n")

    snippets_only: list[float] = []
    with_summary: list[float] = []
    first_body = None

    for round_index in range(args.repeat):
        for query in DEFAULT_QUERIES:
            for summary, bucket in ((False, snippets_only), (True, with_summary)):
                elapsed, status, count, body = search_once(
                    session, resource, args.location, query, summary
                )
                tag = "summary " if summary else "snippets"
                if status != 200:
                    print(f"  [{tag}] HTTP {status} -- {body}")
                    continue
                bucket.append(elapsed)
                if first_body is None and not summary:
                    first_body = body
                if round_index == 0:
                    print(f"  [{tag}] {elapsed:5.2f}s  {count} results  {query[:48]!r}")

    print("\n" + "=" * 64)
    print("LATENCY -- this is dead air on a voice call, the model is blocked")
    print("=" * 64)
    report("snippets only", snippets_only)
    report("with summarySpec", with_summary)

    if snippets_only and with_summary:
        cost = statistics.median(with_summary) - statistics.median(snippets_only)
        print(f"\n  summarySpec costs an extra {cost:.2f}s at the median.")

    if snippets_only:
        median = statistics.median(snippets_only)
        if median <= 1.0:
            print("\n  PASS -- snippets-only fits the voice budget. Proceed to Phase 1.")
        else:
            print(
                f"\n  WARNING -- {median:.2f}s median is audible dead air. Phase 4's\n"
                "  bridge line becomes mandatory, and a 2.5-Flash NON_BLOCKING\n"
                "  fallback is worth costing out."
            )

    if first_body:
        results = first_body.get("results") or []
        if results:
            derived = (results[0].get("document") or {}).get("derivedStructData") or {}
            print("\n  First result's derivedStructData keys:")
            print(f"    {sorted(derived.keys())}")
            print("  (confirms the title/link/snippets shape retrieval.py will parse)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
