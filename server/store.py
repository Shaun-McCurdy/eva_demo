"""Persistence for sales-engineer agent variants.

Two backends behind one interface:

  file       -- JSON on local disk. Fine for `npm run dev` on a laptop. On Cloud
                Run the filesystem is per-instance and disappears on scale-down,
                so variants created by one SE would vanish or be invisible to
                another. Dev only.
  firestore  -- Firestore in Native mode. The right answer on Cloud Run: shared
                across instances, survives restarts, free tier covers a demo
                site comfortably.

Built-in personas are code, not data. They cannot be edited or deleted through
the studio, which means a bad edit can never take the public demo down.
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any

from settings import settings


class AgentStore:
    def list_variants(self) -> list[dict[str, Any]]:
        raise NotImplementedError

    def get_variant(self, slug: str) -> dict[str, Any] | None:
        raise NotImplementedError

    def put_variant(self, variant: dict[str, Any]) -> None:
        raise NotImplementedError

    def delete_variant(self, slug: str) -> bool:
        raise NotImplementedError


class JsonFileStore(AgentStore):
    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)

    def _read(self) -> dict[str, dict]:
        if not os.path.exists(self.path):
            return {}
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else {}
        except (json.JSONDecodeError, OSError):
            return {}

    def _write(self, data: dict[str, dict]) -> None:
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, ensure_ascii=False)
        os.replace(tmp, self.path)

    def list_variants(self):
        with self._lock:
            return list(self._read().values())

    def get_variant(self, slug):
        with self._lock:
            return self._read().get(slug)

    def put_variant(self, variant):
        with self._lock:
            data = self._read()
            data[variant["slug"]] = variant
            self._write(data)

    def delete_variant(self, slug):
        with self._lock:
            data = self._read()
            if slug not in data:
                return False
            del data[slug]
            self._write(data)
            return True


class FirestoreStore(AgentStore):
    def __init__(self, collection: str, database: str = "(default)"):
        from google.cloud import firestore  # imported lazily

        kwargs = {}
        if database and database != "(default)":
            kwargs["database"] = database
        if settings.PROJECT_ID:
            kwargs["project"] = settings.PROJECT_ID
        self._client = firestore.Client(**kwargs)
        self._col = self._client.collection(collection)

    def list_variants(self):
        return [doc.to_dict() for doc in self._col.stream()]

    def get_variant(self, slug):
        doc = self._col.document(slug).get()
        return doc.to_dict() if doc.exists else None

    def put_variant(self, variant):
        self._col.document(variant["slug"]).set(variant)

    def delete_variant(self, slug):
        ref = self._col.document(slug)
        if not ref.get().exists:
            return False
        ref.delete()
        return True


def build_store() -> AgentStore:
    if settings.STORE_BACKEND == "firestore":
        return FirestoreStore(
            settings.FIRESTORE_COLLECTION, settings.FIRESTORE_DATABASE
        )
    return JsonFileStore(settings.STORE_FILE)
