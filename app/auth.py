from fastapi import Header

AUTH_CONFIGURED = False
AUTH_PROVIDER = "demo"
AUTH_CONFIG_ERROR = ""


def get_user_id(x_user_id: str | None = Header(None)) -> str:
    return x_user_id or "demo"
