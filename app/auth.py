import os
from fastapi import Header, HTTPException
import httpx
from jose import JWTError, jwt

def _env(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""

SUPABASE_URL = _env("SUPABASE_URL", "VITE_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_ANON_KEY = _env(
    "SUPABASE_ANON_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "VITE_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
)
SUPABASE_JWT_SECRET = _env("SUPABASE_JWT_SECRET")
GOOGLE_CLIENT_ID = _env(
    "GOOGLE_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_ID",
    "VITE_GOOGLE_CLIENT_ID",
    "NEXT_PUBLIC_GOOGLE_CLIENT_ID",
)

_REQUIRED_AUTH_VARS = {
    "SUPABASE_URL": SUPABASE_URL,
    "SUPABASE_ANON_KEY": SUPABASE_ANON_KEY,
}
SUPABASE_CONFIGURED = all(_REQUIRED_AUTH_VARS.values())
GOOGLE_CONFIGURED = bool(GOOGLE_CLIENT_ID)
AUTH_CONFIGURED = GOOGLE_CONFIGURED or SUPABASE_CONFIGURED
AUTH_PROVIDER = "google" if GOOGLE_CONFIGURED else "supabase" if SUPABASE_CONFIGURED else "demo"
AUTH_PARTIAL = any(_REQUIRED_AUTH_VARS.values()) and not SUPABASE_CONFIGURED and not GOOGLE_CONFIGURED
AUTH_CONFIG_ERROR = (
    "Supabase auth is partially configured. Set SUPABASE_URL and "
    "SUPABASE_ANON_KEY together, or remove Supabase auth variables to run "
    "in demo mode."
    if AUTH_PARTIAL
    else ""
)
DEV_MODE = not AUTH_CONFIGURED

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

def _get_user_id_from_google(token: str) -> str:
    try:
        from google.auth.transport import requests
        from google.oauth2 import id_token

        idinfo = id_token.verify_oauth2_token(token, requests.Request(), GOOGLE_CLIENT_ID)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(401, f"Invalid Google session: {e}") from e
    uid = idinfo.get("sub")
    if not uid:
        raise HTTPException(401, "Invalid Google session")
    return f"google:{uid}"

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
    if token.startswith("google:"):
        if not GOOGLE_CONFIGURED:
            raise HTTPException(401, "Google sign-in is not configured")
        return _get_user_id_from_google(token.removeprefix("google:"))
    if not SUPABASE_CONFIGURED:
        raise HTTPException(401, "Supabase sign-in is not configured")
    if SUPABASE_JWT_SECRET:
        try:
            payload = jwt.decode(token, SUPABASE_JWT_SECRET, algorithms=["HS256"], options={"verify_aud": False})
            uid = payload.get("sub")
            if uid:
                return uid
        except JWTError:
            pass
    return _get_user_id_from_supabase(token)
