import os
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException

AUTH_PROVIDER = os.environ.get("AUTH_PROVIDER", "firebase").strip().lower()
ADMIN_EMAILS = {
    email.strip().lower()
    for email in os.environ.get("ADMIN_EMAILS", "").split(",")
    if email.strip()
}
AUTH_CONFIGURED = AUTH_PROVIDER == "demo"
AUTH_CONFIG_ERROR = ""

_firebase_auth = None

if AUTH_PROVIDER == "firebase":
    try:
        import firebase_admin
        from firebase_admin import auth as firebase_auth

        project_id = os.environ.get("FIREBASE_PROJECT_ID") or os.environ.get("GOOGLE_CLOUD_PROJECT")
        options = {"projectId": project_id} if project_id else None
        if not firebase_admin._apps:
            firebase_admin.initialize_app(options=options)
        _firebase_auth = firebase_auth
        AUTH_CONFIGURED = True
    except Exception as exc:  # noqa: BLE001
        AUTH_CONFIG_ERROR = str(exc)
        AUTH_CONFIGURED = False
elif AUTH_PROVIDER != "demo":
    AUTH_CONFIG_ERROR = f"Unsupported AUTH_PROVIDER: {AUTH_PROVIDER}"


def _demo_user(x_user_id: str | None = None) -> dict:
    uid = x_user_id or "demo"
    return {
        "uid": uid,
        "email": "dev@local",
        "name": "Demo User",
        "picture": "",
        "provider_ids": ["demo"],
        "claims": {},
    }


def get_current_user(
    authorization: str | None = Header(None),
    x_user_id: str | None = Header(None),
) -> dict:
    if AUTH_PROVIDER == "demo":
        return _demo_user(x_user_id)
    if not AUTH_CONFIGURED or _firebase_auth is None:
        raise HTTPException(503, f"Authentication is not configured: {AUTH_CONFIG_ERROR or AUTH_PROVIDER}")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Missing Authorization header")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(401, "Missing Authorization token")
    try:
        decoded = _firebase_auth.verify_id_token(token)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(401, "Invalid or expired Authorization token") from exc
    return {
        "uid": decoded.get("uid") or decoded.get("sub"),
        "email": decoded.get("email", ""),
        "name": decoded.get("name", ""),
        "picture": decoded.get("picture", ""),
        "provider_ids": decoded.get("firebase", {}).get("sign_in_provider", ""),
        "claims": decoded,
    }


def get_user_id(current_user: dict = Depends(get_current_user)) -> str:
    user = current_user
    uid = user.get("uid")
    if not uid:
        raise HTTPException(401, "Invalid authenticated user")
    return uid


def require_admin(current_user: dict = Depends(get_current_user)) -> dict:
    user = current_user
    email = str(user.get("email") or "").lower()
    if AUTH_PROVIDER == "demo":
        return user
    if not email or email not in ADMIN_EMAILS:
        raise HTTPException(403, "Admin access required")
    return user


def list_auth_users() -> list[dict]:
    if AUTH_PROVIDER == "demo" or _firebase_auth is None:
        return [_demo_user()]
    users = []
    for record in _firebase_auth.list_users().iterate_all():
        metadata = record.user_metadata
        users.append({
            "uid": record.uid,
            "email": record.email or "",
            "display_name": record.display_name or "",
            "photo_url": record.photo_url or "",
            "provider_ids": [provider.provider_id for provider in record.provider_data],
            "created_at": (
                datetime.fromtimestamp(metadata.creation_timestamp / 1000, timezone.utc).isoformat()
                if metadata and metadata.creation_timestamp else ""
            ),
            "last_sign_in_at": (
                datetime.fromtimestamp(metadata.last_sign_in_timestamp / 1000, timezone.utc).isoformat()
                if metadata and metadata.last_sign_in_timestamp else ""
            ),
            "disabled": bool(record.disabled),
        })
    return users
