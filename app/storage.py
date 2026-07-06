"""Storage layer: Firestore in production, local JSON fallback for dev/demo."""
import json
import os
import threading
import uuid
from datetime import datetime, timezone

_LOCAL_PATH = os.environ.get("LOCAL_DB_PATH", "/tmp/vitallens_db.json")
_lock = threading.Lock()

_firestore = None
_use_firestore = False

def _init():
    global _firestore, _use_firestore
    if os.environ.get("DISABLE_FIRESTORE") == "1":
        return
    try:
        from google.cloud import firestore  # type: ignore
        _firestore = firestore.Client()
        # cheap probe
        _firestore.collection("_probe").limit(1).get()
        _use_firestore = True
        print("[storage] Firestore connected")
    except Exception as e:  # noqa: BLE001
        print(f"[storage] Firestore unavailable, using local JSON fallback: {e}")

_init()


# ---------- local fallback helpers ----------

def _load_local() -> dict:
    if not os.path.exists(_LOCAL_PATH):
        return {"meals": [], "activities": [], "users": {}}
    try:
        with open(_LOCAL_PATH) as f:
            return json.load(f)
    except Exception:
        return {"meals": [], "activities": [], "users": {}}


def _save_local(db: dict) -> None:
    with open(_LOCAL_PATH, "w") as f:
        json.dump(db, f, default=str)


# ---------- public API ----------

def save_doc(collection: str, doc: dict) -> str:
    doc = dict(doc)
    doc_id = doc.get("id") or uuid.uuid4().hex
    doc["id"] = doc_id
    doc.setdefault("created_at", datetime.now(timezone.utc).isoformat())
    if _use_firestore:
        _firestore.collection(collection).document(doc_id).set(doc)
    else:
        with _lock:
            db = _load_local()
            db.setdefault(collection, [])
            db[collection] = [d for d in db[collection] if d.get("id") != doc_id]
            db[collection].append(doc)
            _save_local(db)
    return doc_id


def query_docs(collection: str, user_id: str | None = None, since_iso: str | None = None) -> list[dict]:
    if _use_firestore:
        q = _firestore.collection(collection)
        if user_id:
            q = q.where("user_id", "==", user_id)
        docs = [d.to_dict() for d in q.stream()]
    else:
        with _lock:
            db = _load_local()
        docs = db.get(collection, [])
        if user_id:
            docs = [d for d in docs if d.get("user_id") == user_id]
    if since_iso:
        docs = [d for d in docs if str(d.get("date", d.get("created_at", ""))) >= since_iso]
    return sorted(docs, key=lambda d: str(d.get("date", d.get("created_at", ""))))


def all_docs(collection: str) -> list[dict]:
    return query_docs(collection)


def get_user(user_id: str) -> dict:
    if _use_firestore:
        snap = _firestore.collection("users").document(user_id).get()
        return snap.to_dict() or {}
    with _lock:
        db = _load_local()
    return db.get("users", {}).get(user_id, {})


def set_user(user_id: str, data: dict) -> None:
    if _use_firestore:
        _firestore.collection("users").document(user_id).set(data, merge=True)
    else:
        with _lock:
            db = _load_local()
            db.setdefault("users", {})
            db["users"].setdefault(user_id, {})
            db["users"][user_id].update(data)
            _save_local(db)
