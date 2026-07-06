import base64
import hashlib
import json
import os
import time

import httpx
from fastapi import Header, HTTPException

GOOGLE_CLIENT_SUFFIX = ".apps.googleusercontent.com"
_GOOGLE_TOKEN_CACHE: dict[str, tuple[str, int]] = {}


def _env(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def _normalize_google_client_id(value: str) -> str:
    value = value.strip()
    duplicate_suffix = GOOGLE_CLIENT_SUFFIX + GOOGLE_CLIENT_SUFFIX
    while value.endswith(duplicate_suffix):
        value = value[: -len(GOOGLE_CLIENT_SUFFIX)]
    return value


GOOGLE_CLIENT_ID = _normalize_google_client_id(
    _env(
        "GOOGLE_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_ID",
        "VITE_GOOGLE_CLIENT_ID",
        "NEXT_PUBLIC_GOOGLE_CLIENT_ID",
    )
)
AUTH_CONFIGURED = bool(GOOGLE_CLIENT_ID)
AUTH_PROVIDER = "google" if AUTH_CONFIGURED else "demo"
AUTH_CONFIG_ERROR = ""
DEV_MODE = not AUTH_CONFIGURED


def _decode_jwt_payload_unverified(token: str) -> dict:
    try:
        payload = token.split(".")[1]
        payload += "=" * ((4 - len(payload) % 4) % 4)
        return json.loads(base64.urlsafe_b64decode(payload.encode()).decode())
    except Exception:
        return {}


def _get_user_id_from_google(token: str) -> str:
    cache_key = hashlib.sha256(token.encode()).hexdigest()
    cached = _GOOGLE_TOKEN_CACHE.get(cache_key)
    now = int(time.time())
    if cached and cached[1] > now + 30:
        return cached[0]

    try:
        response = httpx.get(
            "https://oauth2.googleapis.com/tokeninfo",
            params={"id_token": token},
            timeout=6,
        )
    except httpx.HTTPError as e:
        raise HTTPException(503, f"Could not verify Google session: {e}") from e
    if response.status_code != 200:
        raise HTTPException(401, "Invalid or expired Google session")

    idinfo = response.json()
    if idinfo.get("aud") != GOOGLE_CLIENT_ID:
        raise HTTPException(401, "Google session was issued for a different OAuth client")
    if idinfo.get("iss") not in {"accounts.google.com", "https://accounts.google.com"}:
        raise HTTPException(401, "Invalid Google token issuer")

    expires_at = int(idinfo.get("exp") or _decode_jwt_payload_unverified(token).get("exp") or 0)
    if expires_at <= now:
        raise HTTPException(401, "Google session expired")

    uid = idinfo.get("sub")
    if not uid:
        raise HTTPException(401, "Invalid Google session")
    user_id = f"google:{uid}"
    _GOOGLE_TOKEN_CACHE[cache_key] = (user_id, expires_at)
    return user_id


def get_user_id(authorization: str | None = Header(None), x_user_id: str | None = Header(None)) -> str:
    if DEV_MODE:
        if not x_user_id:
            raise HTTPException(401, "Not authenticated")
        return x_user_id
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing Authorization header")
    token = authorization.split(" ", 1)[1].removeprefix("google:")
    return _get_user_id_from_google(token)
