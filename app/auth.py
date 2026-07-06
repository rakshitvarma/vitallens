import os
from fastapi import Header, HTTPException
from jose import JWTError, jwt

SUPABASE_JWT_SECRET = os.environ.get("SUPABASE_JWT_SECRET", "")
DEV_MODE = not SUPABASE_JWT_SECRET

def get_user_id(authorization: str | None = Header(None), x_user_id: str | None = Header(None)) -> str:
    if DEV_MODE:
        if not x_user_id:
            raise HTTPException(401, "Not authenticated")
        return x_user_id
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing Authorization header")
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(token, SUPABASE_JWT_SECRET, algorithms=["HS256"], options={"verify_aud": False})
        uid = payload.get("sub")
        if not uid:
            raise HTTPException(401, "Invalid token")
        return uid
    except JWTError as e:
        raise HTTPException(401, f"Invalid token: {e}") from e