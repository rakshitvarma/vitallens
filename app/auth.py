import os
import base64
import hashlib
import json
import time
from fastapi import Header, HTTPException
import httpx
from jose import JWTError, jwt

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

SUPABASE_URL = _env("SUPABASE_URL", "VITE_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_ANON_KEY = _env(
    "SUPABASE_ANON_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "VITE_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
)
SUPABASE_JWT_SECRET = _env("SUPABASE_JWT_SECRET")
GOOGLE_CLIENT_ID = _normalize_google_client_id(
    _env(
        "GOOGLE_CLIENT_ID",
        "GOOGLE_OAUTH_CLIENT_ID",
        "VITE_GOOGLE_CLIENT_ID",
        "NEXT_PUBLIC_GOOGLE_CLIENT_ID",
    )
)
AUTH_PROVIDER_OVERRIDE = _env("AUTH_PROVIDER").lower()

_REQUIRED_AUTH_VARS = {
    "SUPABASE_URL": SUPABASE_URL,
    "SUPABASE_ANON_KEY": SUPABASE_ANON_KEY,
}
SUPABASE_CONFIGURED = all(_REQUIRED_AUTH_VARS.values())
GOOGLE_CONFIGURED = bool(GOOGLE_CLIENT_ID)
AUTH_CONFIGURED = GOOGLE_CONFIGURED or SUPABASE_CONFIGURED
if AUTH_PROVIDER_OVERRIDE == "supabase" and not SUPABASE_CONFIGURED:
    AUTH_PROVIDER = "demo"
elif AUTH_PROVIDER_OVERRIDE == "google" and not GOOGLE_CONFIGURED:
    AUTH_PROVIDER = "demo"
elif AUTH_PROVIDER_OVERRIDE == "google" and GOOGLE_CONFIGURED:
    AUTH_PROVIDER = "google"
elif AUTH_PROVIDER_OVERRIDE == "supabase" and SUPABASE_CONFIGURED:
    AUTH_PROVIDER = "supabase"
elif SUPABASE_CONFIGURED:
    AUTH_PROVIDER = "supabase"
elif GOOGLE_CONFIGURED:
    AUTH_PROVIDER = "google"
else:
    AUTH_PROVIDER = "demo"
AUTH_PARTIAL = (
    (AUTH_PROVIDER_OVERRIDE == "supabase" and not SUPABASE_CONFIGURED)
    or (AUTH_PROVIDER_OVERRIDE == "google" and not GOOGLE_CONFIGURED)
    or (any(_REQUIRED_AUTH_VARS.values()) and not SUPABASE_CONFIGURED and not GOOGLE_CONFIGURED)
)
AUTH_CONFIG_ERROR = (
    "AUTH_PROVIDER=supabase requires SUPABASE_URL and SUPABASE_ANON_KEY."
    if AUTH_PROVIDER_OVERRIDE == "supabase" and not SUPABASE_CONFIGURED
    else "AUTH_PROVIDER=google requires GOOGLE_CLIENT_ID."
    if AUTH_PROVIDER_OVERRIDE == "google" and not GOOGLE_CONFIGURED
    else (
    "Supabase auth is partially configured. Set SUPABASE_URL and "
    "SUPABASE_ANON_KEY together, or remove Supabase auth variables to run "
    "in demo mode."
    if AUTH_PARTIAL
    else ""
    )
)
DEV_MODE = not AUTH_CONFIGURED and not AUTH_PARTIAL

def _get_user_id_from_supabase(token: str) -> str:
    try:
        response = httpx.get(
            f"{SUPABASE_URL.rstrip('/')}/auth/v1/user",
            headers={"Authorization": f"Bearer {token}", "apikey": SUPABASE_ANON_KEY},
            timeout=6,
        )
    except httpx.HTTPError as e:
        raise HTTPException(503, f"Could not verify Supabase session: {e}") from e
    if response.status_code == 401:
        raise HTTPException(401, "Invalid or expired Supabase session")
    if response.status_code >= 400:
        raise HTTPException(502, f"Supabase session verification failed ({response.status_code})")
    uid = response.json().get("id")
    if not uid:
        raise HTTPException(401, "Invalid Supabase session")
    return uid

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
    if AUTH_PARTIAL:
        raise HTTPException(503, AUTH_CONFIG_ERROR)
    if DEV_MODE:
        if not x_user_id:
            raise HTTPException(401, "Not authenticated")
        return x_user_id
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing Authorization header")
    token = authorization.split(" ", 1)[1]
    google_error: HTTPException | None = None
    if GOOGLE_CONFIGURED:
        try:
            return _get_user_id_from_google(token.removeprefix("google:"))
        except HTTPException as e:
            google_error = e
            if token.startswith("google:") or not SUPABASE_CONFIGURED:
                raise
    if not SUPABASE_CONFIGURED:
        if google_error:
            raise google_error
        raise HTTPException(401, "No supported sign-in provider is configured")
    if SUPABASE_JWT_SECRET:
        try:
            payload = jwt.decode(token, SUPABASE_JWT_SECRET, algorithms=["HS256"], options={"verify_aud": False})
            uid = payload.get("sub")
            if uid:
                return uid
        except JWTError:
            pass
    return _get_user_id_from_supabase(token)
