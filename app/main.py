import base64, calendar, hashlib, hmac, json, os, random, statistics
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app import gemini_client, scoring, storage
from app.auth import (
    ADMIN_EMAILS,
    AUTH_CONFIG_ERROR,
    AUTH_CONFIGURED,
    AUTH_PROVIDER,
    get_current_user,
    get_user_id,
    list_auth_users,
    require_admin,
)

app = FastAPI(title="VitalLens")
STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
STRAVA_ID = os.environ.get("STRAVA_CLIENT_ID", "")
STRAVA_SECRET = os.environ.get("STRAVA_CLIENT_SECRET", "")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8080")
STRAVA_SCOPE = "activity:read_all"
MAX_IMAGE_BYTES = 8_000_000
FIREBASE_CONFIG = {
    "apiKey": os.environ.get("FIREBASE_API_KEY", ""),
    "authDomain": os.environ.get("FIREBASE_AUTH_DOMAIN", ""),
    "projectId": os.environ.get("FIREBASE_PROJECT_ID", os.environ.get("GOOGLE_CLOUD_PROJECT", "")),
    "appId": os.environ.get("FIREBASE_APP_ID", ""),
    "storageBucket": os.environ.get("FIREBASE_STORAGE_BUCKET", ""),
    "messagingSenderId": os.environ.get("FIREBASE_MESSAGING_SENDER_ID", ""),
    "measurementId": os.environ.get("FIREBASE_MEASUREMENT_ID", ""),
}

NUTRIENTS = ("calories", "protein_g", "carbs_g", "fat_g", "sugar_g", "fiber_g", "sodium_mg", "salt_g")
DEFAULT_USER_TARGETS = {
    **scoring.TARGETS,
    "fiber_g_per_day": 25,
    "steps_per_day": 8000,
    "calories_burned_per_week": 1200,
    "distance_m_per_week": 15000,
}


def _float(value, default: float = 0) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return default


def _round(value, digits: int = 1):
    rounded = round(_float(value), digits)
    return int(rounded) if digits == 0 else rounded


def _as_date(value) -> date | None:
    if isinstance(value, date):
        return value
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)[:10]).date()
    except ValueError:
        return None


def _iso(d: date) -> str:
    return d.isoformat()


def _period_bounds(period: str, anchor: str | None) -> tuple[str, date, date]:
    mode = "month" if period == "month" else "week"
    base = _as_date(anchor) or datetime.now(timezone.utc).date()
    if mode == "month":
        start = base.replace(day=1)
        end = base.replace(day=calendar.monthrange(base.year, base.month)[1])
    else:
        start = base - timedelta(days=base.weekday())
        end = start + timedelta(days=6)
    return mode, start, end


def _previous_bounds(period: str, start: date, end: date) -> tuple[date, date]:
    if period == "month":
        previous_end = start - timedelta(days=1)
        previous_start = previous_end.replace(day=1)
        return previous_start, previous_end
    previous_end = start - timedelta(days=1)
    return previous_end - timedelta(days=6), previous_end


def _previous_month_bounds(anchor_start: date) -> tuple[date, date]:
    previous_end = anchor_start.replace(day=1) - timedelta(days=1)
    return previous_end.replace(day=1), previous_end


def _filter_range(docs: list[dict], start: date, end: date) -> list[dict]:
    return [d for d in docs if (doc_date := _as_date(d.get("date", d.get("created_at")))) and start <= doc_date <= end]


def _date_list(start: date, end: date) -> list[date]:
    return [start + timedelta(days=i) for i in range(max((end - start).days + 1, 0))]


def _normalize_meal_doc(doc: dict) -> dict:
    doc = dict(doc)
    doc["date"] = doc.get("date") or datetime.now(timezone.utc).date().isoformat()
    for key in NUTRIENTS:
        doc[key] = _float(doc.get(key))
    if not doc.get("salt_g") and doc.get("sodium_mg"):
        doc["salt_g"] = round(_float(doc.get("sodium_mg")) * 2.5 / 1000, 2)
    items = []
    for item in doc.get("items") or []:
        if not isinstance(item, dict):
            continue
        clean = dict(item)
        clean["name"] = str(clean.get("name") or "Food item").strip() or "Food item"
        clean["portion"] = str(clean.get("portion") or "Estimated serving").strip() or "Estimated serving"
        for key in NUTRIENTS:
            clean[key] = _float(clean.get(key))
        if not clean.get("salt_g") and clean.get("sodium_mg"):
            clean["salt_g"] = round(_float(clean.get("sodium_mg")) * 2.5 / 1000, 2)
        items.append(clean)
    doc["items"] = items
    doc["items_summary"] = ", ".join(i.get("name", "?") for i in items)[:200]
    return doc


def _normalize_activity_doc(doc: dict) -> dict:
    doc = dict(doc)
    doc["date"] = doc.get("date") or datetime.now(timezone.utc).date().isoformat()
    doc["type"] = str(doc.get("type") or "workout").replace("_", " ").lower()
    doc["minutes"] = _round(doc.get("minutes", 0), 1)
    doc["elapsed_minutes"] = _round(doc.get("elapsed_minutes") or doc.get("minutes") or 0, 1)
    doc["intensity"] = doc.get("intensity") or "moderate"
    doc["source"] = doc.get("source") or "manual"
    for key in ("distance_m", "calories_burned", "average_heartrate", "max_heartrate", "elevation_gain_m", "average_speed_mps", "max_speed_mps", "steps"):
        if doc.get(key) in ("", None):
            doc[key] = None
        elif doc.get(key) is not None:
            doc[key] = _float(doc.get(key))
    return doc


def _sum(docs: list[dict], key: str) -> float:
    return sum(_float(d.get(key)) for d in docs)


def _avg(values: list[float]) -> float | None:
    values = [v for v in values if v]
    return round(sum(values) / len(values), 1) if values else None


def _food_summary(meals: list[dict], days: int) -> dict:
    totals = {key: _round(_sum(meals, key), 0 if key in ("calories", "sodium_mg") else 1) for key in NUTRIENTS}
    daily = {key: _round(totals[key] / max(days, 1), 0 if key in ("calories", "sodium_mg") else 1) for key in NUTRIENTS}
    foods: dict[str, dict] = {}
    for meal in meals:
        for item in meal.get("items") or []:
            name = str(item.get("name") or "Food item")
            entry = foods.setdefault(name, {"name": name, "count": 0, "calories": 0})
            entry["count"] += 1
            entry["calories"] += _float(item.get("calories"))
    top_foods = sorted(foods.values(), key=lambda x: (x["count"], x["calories"]), reverse=True)[:5]
    recent = [{
        "date": meal.get("date", ""),
        "meal_guess": meal.get("meal_guess", "meal"),
        "items_summary": meal.get("items_summary") or ", ".join(i.get("name", "?") for i in meal.get("items", [])),
        "calories": round(_float(meal.get("calories"))),
    } for meal in sorted(meals, key=lambda m: str(m.get("date", "")), reverse=True)[:5]]
    return {
        "totals": totals,
        "daily_avg": daily,
        "meal_count": len(meals),
        "days_logged": len({str(m.get("date", ""))[:10] for m in meals}),
        "top_foods": top_foods,
        "recent": recent,
    }


def _movement_summary(activities: list[dict]) -> dict:
    type_breakdown: dict[str, float] = {}
    for act in activities:
        type_breakdown[act.get("type", "workout")] = type_breakdown.get(act.get("type", "workout"), 0) + _float(act.get("minutes"))
    return {
        "active_minutes": round(sum(_float(a.get("minutes")) * (1.5 if a.get("intensity") == "high" else 1.0) for a in activities)),
        "raw_minutes": _round(_sum(activities, "minutes"), 1),
        "workouts": len(activities),
        "calories_burned": round(_sum(activities, "calories_burned")),
        "distance_m": round(_sum(activities, "distance_m")),
        "steps": round(_sum(activities, "steps")),
        "average_heartrate": _avg([_float(a.get("average_heartrate")) for a in activities]),
        "type_breakdown": [{"type": k, "minutes": round(v)} for k, v in sorted(type_breakdown.items(), key=lambda item: item[1], reverse=True)],
    }


def _day_log(meals: list[dict], activities: list[dict], start: date, end: date, targets: dict | None = None) -> list[dict]:
    t = {**DEFAULT_USER_TARGETS, **(targets or {})}
    rows = []
    for day in _date_list(start, end):
        key = day.isoformat()
        day_meals = [m for m in meals if str(m.get("date", ""))[:10] == key]
        day_acts = [a for a in activities if str(a.get("date", ""))[:10] == key]
        calories = _sum(day_meals, "calories")
        sugar = _sum(day_meals, "sugar_g")
        sodium = _sum(day_meals, "sodium_mg")
        active = sum(_float(a.get("minutes")) * (1.5 if a.get("intensity") == "high" else 1.0) for a in day_acts)
        if not day_meals and not day_acts:
            status = "empty"
        elif sugar > t["sugar_g_per_day"] or sodium > t["sodium_mg_per_day"]:
            status = "elevated" if active < 20 else "watch"
        elif active >= 20 and day_meals:
            status = "healthy"
        else:
            status = "watch"
        rows.append({
            "date": key,
            "calories": round(calories),
            "sugar_g": round(sugar, 1),
            "sodium_mg": round(sodium),
            "active_min": round(active),
            "steps": round(_sum(day_acts, "steps")),
            "meals": len(day_meals),
            "activities": len(day_acts),
            "meal_names": [m.get("items_summary") or m.get("meal_guess", "meal") for m in day_meals[:3]],
            "activity_names": [a.get("name") or a.get("type", "activity") for a in day_acts[:3]],
            "status": status,
        })
    return rows


def _trend(day_rows: list[dict], activities: list[dict]) -> list[dict]:
    burned_by_day = {}
    for act in activities:
        d = str(act.get("date", ""))[:10]
        burned_by_day[d] = burned_by_day.get(d, 0) + _float(act.get("calories_burned"))
    return [{**row, "calories_burned": round(burned_by_day.get(row["date"], 0))} for row in day_rows]


def _analytics(meals: list[dict], activities: list[dict], start: date, end: date) -> dict:
    period_days = max((end - start).days + 1, 1)
    period_meals = _filter_range(meals, start, end)
    period_acts = _filter_range(activities, start, end)
    food = _food_summary(period_meals, period_days)
    movement = _movement_summary(period_acts)
    return {
        "meals": period_meals,
        "activities": period_acts,
        "food": food,
        "movement": movement,
        "summary": {
            **food["daily_avg"],
            "meal_count": food["meal_count"],
            "days_logged": food["days_logged"],
            **movement,
        },
    }


def _delta(current: float, previous: float, lower_is_better: bool = False) -> dict:
    if previous <= 0:
        return {"current": current, "previous": previous, "change_pct": None, "direction": "none"}
    pct = round((current - previous) / previous * 100, 1)
    improved = pct < 0 if lower_is_better else pct > 0
    return {"current": current, "previous": previous, "change_pct": pct, "direction": "good" if improved else "bad" if pct else "none"}


def _comparisons(current: dict, previous: dict, previous_month: dict) -> dict:
    metrics = [
        ("calories", "Calories/day", "kcal", True),
        ("sugar_g", "Sugar/day", "g", True),
        ("sodium_mg", "Sodium/day", "mg", True),
        ("active_minutes", "Active minutes", "min", False),
        ("steps", "Steps", "steps", False),
    ]
    def build(base: dict, enough: bool) -> list[dict]:
        rows = []
        for key, label, unit, lower in metrics:
            cur = _float(current["summary"].get(key))
            prev = _float(base["summary"].get(key))
            rows.append({"key": key, "label": label, "unit": unit, "enough_data": enough and prev > 0, **_delta(cur, prev, lower)})
        return rows
    return {
        "previous_period": build(previous, bool(previous["meals"] or previous["activities"])),
        "previous_month_average": build(previous_month, bool(previous_month["meals"] or previous_month["activities"])),
    }


def _user_targets(user_id: str) -> dict:
    raw = storage.get_user(user_id).get("targets") or {}
    targets = {**DEFAULT_USER_TARGETS}
    for key in targets:
        if key in raw:
            targets[key] = max(0, _float(raw.get(key), targets[key]))
    return targets


def _fallback_weekly_insight(score_data: dict) -> str:
    weekly = score_data.get("weekly", {})
    signals = score_data.get("signals", [])
    signal = next((s for s in signals if s.get("level") != "healthy"), signals[0] if signals else {})
    action = "Log meals on at least 5 days this period so the score has a stronger baseline."
    if weekly.get("active_minutes", 0) < 150:
        action = "Add three 20-minute brisk walks this week to move closer to the activity target."
    elif weekly.get("avg_sodium_mg", 0) > 2000:
        action = "Choose one lower-salt swap each day, such as less packaged food or asking for less salt in cooked meals."
    elif weekly.get("avg_sugar_g", 0) > 50:
        action = "Replace one sweet drink or dessert with fruit, curd, or unsweetened tea on most days."
    elif weekly.get("avg_protein_g", 0) < 55:
        action = "Add one protein serving such as dal, paneer, eggs, curd, chana, or lean meat to one meal daily."
    return (
        f"Your VitalScore is {score_data.get('score')} ({score_data.get('band')}). "
        f"This period you logged {weekly.get('active_minutes', 0)} active minutes, "
        f"{weekly.get('avg_sugar_g', 0)}g sugar/day, and {weekly.get('avg_sodium_mg', 0)}mg sodium/day. "
        f"Main signal: {str(signal.get('type', 'overall balance')).replace('_', ' ')} - "
        f"{signal.get('why', 'your recent logs need a little more consistency')}. {action}"
    )


@app.get("/api/health")
def health(): return {"ok": True}


@app.get("/api/config")
def config():
    firebase_required = ("apiKey", "authDomain", "projectId", "appId")
    firebase_web_configured = all(FIREBASE_CONFIG.get(key) for key in firebase_required)
    return {
        "auth_provider": AUTH_PROVIDER,
        "gemini_enabled": gemini_client.is_configured(),
        "gemini_model": gemini_client.MODEL,
        "strava_enabled": bool(STRAVA_ID),
        "auth_enabled": AUTH_CONFIGURED and (AUTH_PROVIDER == "demo" or firebase_web_configured),
        "auth_error": AUTH_CONFIG_ERROR,
        "firebase_config": FIREBASE_CONFIG if firebase_web_configured else {},
    }


@app.post("/api/session")
def session(current_user: dict=Depends(get_current_user)):
    uid = current_user["uid"]
    email = current_user.get("email", "")
    user_doc = {
        "email": email,
        "display_name": current_user.get("name", ""),
        "photo_url": current_user.get("picture", ""),
        "last_seen_at": datetime.now(timezone.utc).isoformat(),
        "auth_provider": AUTH_PROVIDER,
    }
    storage.set_user(uid, user_doc)
    return {
        "uid": uid,
        "email": email,
        "display_name": user_doc["display_name"],
        "photo_url": user_doc["photo_url"],
        "is_admin": AUTH_PROVIDER == "demo" or email.lower() in ADMIN_EMAILS,
    }


class TargetIn(BaseModel):
    calories_per_day: float = DEFAULT_USER_TARGETS["calories_per_day"]
    sugar_g_per_day: float = DEFAULT_USER_TARGETS["sugar_g_per_day"]
    sodium_mg_per_day: float = DEFAULT_USER_TARGETS["sodium_mg_per_day"]
    protein_g_per_day: float = DEFAULT_USER_TARGETS["protein_g_per_day"]
    fiber_g_per_day: float = DEFAULT_USER_TARGETS["fiber_g_per_day"]
    activity_min_per_week: float = DEFAULT_USER_TARGETS["activity_min_per_week"]
    steps_per_day: float = DEFAULT_USER_TARGETS["steps_per_day"]
    calories_burned_per_week: float = DEFAULT_USER_TARGETS["calories_burned_per_week"]
    distance_m_per_week: float = DEFAULT_USER_TARGETS["distance_m_per_week"]


@app.get("/api/targets")
def get_targets(user_id: str=Depends(get_user_id)):
    return _user_targets(user_id)


@app.put("/api/targets")
def update_targets(targets: TargetIn, user_id: str=Depends(get_user_id)):
    clean = {}
    for key, default in DEFAULT_USER_TARGETS.items():
        clean[key] = max(0, _float(getattr(targets, key), default))
    storage.set_user(user_id, {"targets": clean})
    return clean


@app.post("/api/meals/analyze")
async def analyze_meal(image: UploadFile=File(...), portion_note: str=Form(""), user_id: str=Depends(get_user_id)):
    data = await image.read()
    mime_type = image.content_type or "image/jpeg"
    if not data:
        raise HTTPException(400, "No image uploaded")
    if not mime_type.startswith("image/"):
        raise HTTPException(415, "Upload a meal photo image")
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "Image too large. Use a smaller photo under 8 MB.")
    try:
        return gemini_client.analyze_meal_image(data, mime_type, portion_note)
    except RuntimeError as e:
        raise HTTPException(503, str(e)) from e
    except Exception as e:
        raise HTTPException(503, gemini_client.user_facing_error(e)) from e


class MealTextIn(BaseModel):
    portion_note: str = ""


@app.post("/api/meals/analyze-text")
def analyze_meal_text(body: MealTextIn, user_id: str=Depends(get_user_id)):
    portion_note = body.portion_note.strip()
    if not portion_note:
        raise HTTPException(400, "Describe what you ate before analyzing")
    try:
        return gemini_client.analyze_meal_text(portion_note)
    except RuntimeError as e:
        raise HTTPException(503, str(e)) from e
    except Exception as e:
        raise HTTPException(503, gemini_client.user_facing_error(e)) from e


class MealIn(BaseModel):
    date: str | None = None
    meal_guess: str = "meal"
    portion_note: str = ""
    source: str = "manual"
    confidence: float = 0
    health_notes: list[str] = Field(default_factory=list)
    items: list[dict] = Field(default_factory=list)
    calories: float = 0
    protein_g: float = 0
    carbs_g: float = 0
    fat_g: float = 0
    sugar_g: float = 0
    fiber_g: float = 0
    sodium_mg: float = 0
    salt_g: float = 0


@app.post("/api/meals")
def save_meal(meal: MealIn, user_id: str=Depends(get_user_id)):
    doc = _normalize_meal_doc(meal.model_dump())
    doc["user_id"] = user_id
    return {"id": storage.save_doc("meals", doc)}


@app.put("/api/meals/{meal_id}")
def update_meal(meal_id: str, meal: MealIn, user_id: str=Depends(get_user_id)):
    existing = next((m for m in storage.query_docs("meals", user_id=user_id) if m.get("id") == meal_id), None)
    if not existing:
        raise HTTPException(404, "Meal not found")
    doc = _normalize_meal_doc({**meal.model_dump(), "id": meal_id})
    doc["user_id"] = user_id
    doc["created_at"] = existing.get("created_at")
    return {"id": storage.save_doc("meals", doc)}


@app.get("/api/meals")
def list_meals(days: int=7, user_id: str=Depends(get_user_id)):
    since=(datetime.now(timezone.utc)-timedelta(days=days)).date().isoformat()
    return storage.query_docs("meals", user_id=user_id, since_iso=since)


class ActivityIn(BaseModel):
    date: str | None = None
    type: str = "walk"
    minutes: float = 30
    intensity: str = "moderate"
    source: str = "manual"
    name: str = ""
    distance_m: float | None = None
    calories_burned: float | None = None
    average_heartrate: float | None = None
    max_heartrate: float | None = None
    elapsed_minutes: float | None = None
    steps: float | None = None
    notes: str = ""


@app.post("/api/activities")
def save_activity(act: ActivityIn, user_id: str=Depends(get_user_id)):
    doc = _normalize_activity_doc(act.model_dump())
    doc["source"] = "manual"
    doc["user_id"] = user_id
    return {"id": storage.save_doc("activities", doc)}


@app.put("/api/activities/{activity_id}")
def update_activity(activity_id: str, act: ActivityIn, user_id: str=Depends(get_user_id)):
    existing = next((a for a in storage.query_docs("activities", user_id=user_id) if a.get("id") == activity_id), None)
    if not existing:
        raise HTTPException(404, "Activity not found")
    if existing.get("source") == "strava":
        raise HTTPException(409, "Strava activities are read-only. Re-sync Strava to refresh them.")
    doc = _normalize_activity_doc({**act.model_dump(), "id": activity_id})
    doc["source"] = existing.get("source") or "manual"
    doc["user_id"] = user_id
    doc["created_at"] = existing.get("created_at")
    return {"id": storage.save_doc("activities", doc)}


@app.get("/api/activities")
def list_activities(days: int=7, user_id: str=Depends(get_user_id)):
    since=(datetime.now(timezone.utc)-timedelta(days=days)).date().isoformat()
    return storage.query_docs("activities", user_id=user_id, since_iso=since)


@app.get("/auth/strava/login")
def strava_login(user_id: str=Depends(get_user_id)):
    if not STRAVA_ID or not STRAVA_SECRET: raise HTTPException(501, "Strava not configured")
    redirect=f"{PUBLIC_BASE_URL.rstrip('/')}/auth/strava/callback"
    params={
        "client_id": STRAVA_ID,
        "response_type": "code",
        "redirect_uri": redirect,
        "approval_prompt": "auto",
        "scope": STRAVA_SCOPE,
        "state": _encode_strava_state(user_id),
    }
    return {"url": f"https://www.strava.com/oauth/authorize?{urlencode(params)}"}


def _encode_strava_state(user_id: str) -> str:
    payload=base64.urlsafe_b64encode(json.dumps({"u":user_id,"iat":int(datetime.now(timezone.utc).timestamp())},separators=(",",":")).encode()).decode().rstrip("=")
    sig=hmac.new(STRAVA_SECRET.encode(),payload.encode(),hashlib.sha256).hexdigest()
    return f"{payload}.{sig}"


def _decode_strava_state(state: str) -> str:
    try:
        payload,sig=state.split(".",1)
        expected=hmac.new(STRAVA_SECRET.encode(),payload.encode(),hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig,expected): return ""
        data=json.loads(base64.urlsafe_b64decode(payload+"="*((4-len(payload)%4)%4)).decode())
        if int(datetime.now(timezone.utc).timestamp())-int(data.get("iat",0))>1800: return ""
        return str(data.get("u") or "")
    except Exception:
        return ""


def _store_strava_tokens(user_id: str, token_data: dict, scope: str="") -> None:
    current=storage.get_user(user_id)
    storage.set_user(user_id,{
        "strava_connected": True,
        "strava_access_token": token_data.get("access_token") or current.get("strava_access_token",""),
        "strava_refresh_token": token_data.get("refresh_token") or current.get("strava_refresh_token",""),
        "strava_expires_at": int(token_data.get("expires_at") or current.get("strava_expires_at") or 0),
        "strava_scope": scope or token_data.get("scope") or current.get("strava_scope",""),
        "strava_athlete_id": str((token_data.get("athlete") or {}).get("id") or current.get("strava_athlete_id","")),
    })


async def _strava_access_token(user_id: str) -> str:
    user=storage.get_user(user_id)
    refresh=user.get("strava_refresh_token")
    access=user.get("strava_access_token")
    expires_at=int(user.get("strava_expires_at") or 0)
    if not refresh:
        raise HTTPException(409, "Connect Strava first")
    if access and expires_at > int(datetime.now(timezone.utc).timestamp())+300:
        return access
    async with httpx.AsyncClient(timeout=15) as hx:
        resp=await hx.post("https://www.strava.com/oauth/token",data={"client_id":STRAVA_ID,"client_secret":STRAVA_SECRET,"grant_type":"refresh_token","refresh_token":refresh})
    if resp.status_code==401:
        storage.set_user(user_id,{"strava_connected":False})
        raise HTTPException(401, "Strava authorization expired. Connect Strava again.")
    if resp.status_code!=200:
        raise HTTPException(502, f"Strava token refresh failed ({resp.status_code})")
    token_data=resp.json()
    _store_strava_tokens(user_id,token_data,user.get("strava_scope",""))
    return token_data["access_token"]


def _activity_from_strava(user_id: str, activity: dict) -> dict:
    start=str(activity.get("start_date_local") or activity.get("start_date") or "")[:10]
    avg_hr=_float(activity.get("average_heartrate"))
    moving_seconds = _float(activity.get("moving_time") or activity.get("elapsed_time"))
    elapsed_seconds = _float(activity.get("elapsed_time") or moving_seconds)
    calories = _float(activity.get("calories")) or (_float(activity.get("kilojoules")) * 239.006 if activity.get("kilojoules") else 0)
    return _normalize_activity_doc({
        "id": f"strava-{activity['id']}",
        "user_id": user_id,
        "date": start or datetime.now(timezone.utc).date().isoformat(),
        "type": str(activity.get("sport_type") or activity.get("type") or "workout").replace("_"," ").lower(),
        "minutes": round(moving_seconds/60,1),
        "elapsed_minutes": round(elapsed_seconds/60,1),
        "intensity": "high" if avg_hr>140 else "moderate",
        "source": "strava",
        "strava_id": str(activity.get("id")),
        "name": activity.get("name","Strava activity"),
        "distance_m": round(_float(activity.get("distance")),1),
        "calories_burned": round(calories),
        "average_heartrate": avg_hr or None,
        "max_heartrate": _float(activity.get("max_heartrate")) or None,
        "steps": _float(activity.get("steps")) or None,
        "elevation_gain_m": _float(activity.get("total_elevation_gain")) or None,
        "average_speed_mps": _float(activity.get("average_speed")) or None,
        "max_speed_mps": _float(activity.get("max_speed")) or None,
    })


async def _sync_strava_activities(user_id: str, access_token: str, days: int=30) -> int:
    days=max(1,min(days,90))
    after=int((datetime.now(timezone.utc)-timedelta(days=days)).timestamp())
    imported=0
    async with httpx.AsyncClient(timeout=20) as hx:
        for page in range(1,4):
            resp=await hx.get("https://www.strava.com/api/v3/athlete/activities",params={"after":after,"page":page,"per_page":100},headers={"Authorization":f"Bearer {access_token}"})
            if resp.status_code==401:
                raise HTTPException(401, "Strava authorization expired. Connect Strava again.")
            if resp.status_code!=200:
                raise HTTPException(502, f"Strava activities sync failed ({resp.status_code})")
            activities=resp.json()
            for activity in activities:
                storage.save_doc("activities",_activity_from_strava(user_id,activity))
            imported+=len(activities)
            if len(activities)<100: break
    storage.set_user(user_id,{"strava_connected":True,"strava_last_sync_at":datetime.now(timezone.utc).isoformat()})
    return imported


@app.get("/auth/strava/callback")
async def strava_callback(code: str="", state: str="", scope: str=""):
    user_id=_decode_strava_state(state)
    if not code or not user_id: return RedirectResponse("/?strava=error")
    accepted={s for s in scope.replace(","," ").split() if s}
    if not ({"activity:read","activity:read_all"} & accepted): return RedirectResponse("/?strava=scope")
    async with httpx.AsyncClient(timeout=20) as hx:
        tok=await hx.post("https://www.strava.com/oauth/token",data={"client_id":STRAVA_ID,"client_secret":STRAVA_SECRET,"code":code,"grant_type":"authorization_code"})
        if tok.status_code!=200: return RedirectResponse("/?strava=error")
    token_data=tok.json()
    _store_strava_tokens(user_id,token_data,scope)
    try:
        imported=await _sync_strava_activities(user_id,token_data["access_token"],days=30)
    except HTTPException:
        return RedirectResponse("/?strava=error")
    return RedirectResponse(f"/?strava=ok&synced={imported}")


@app.post("/api/strava/sync")
async def sync_strava(days: int=30, user_id: str=Depends(get_user_id)):
    if not STRAVA_ID or not STRAVA_SECRET: raise HTTPException(501, "Strava not configured")
    access=await _strava_access_token(user_id)
    imported=await _sync_strava_activities(user_id,access,days=days)
    return {"ok": True, "synced": imported, "last_sync_at": storage.get_user(user_id).get("strava_last_sync_at","")}


@app.get("/api/admin/users")
def admin_users(_: dict=Depends(require_admin)):
    auth_users = {user["uid"]: user for user in list_auth_users()}
    user_docs = {user["id"]: user for user in storage.list_users()}
    meals = storage.all_docs("meals")
    activities = storage.all_docs("activities")
    user_ids = set(auth_users) | set(user_docs) | {m.get("user_id") for m in meals} | {a.get("user_id") for a in activities}
    user_ids.discard(None)
    rows = []
    for uid in sorted(user_ids):
        auth_user = auth_users.get(uid, {})
        user_doc = user_docs.get(uid, {})
        user_meals = [m for m in meals if m.get("user_id") == uid]
        user_acts = [a for a in activities if a.get("user_id") == uid]
        activity_dates = [
            str(doc.get("created_at") or doc.get("date") or "")
            for doc in [*user_meals, *user_acts]
            if doc.get("created_at") or doc.get("date")
        ]
        rows.append({
            "uid": uid,
            "email": auth_user.get("email") or user_doc.get("email", ""),
            "display_name": auth_user.get("display_name") or user_doc.get("display_name", ""),
            "provider_ids": auth_user.get("provider_ids") or [],
            "created_at": auth_user.get("created_at", ""),
            "last_sign_in_at": auth_user.get("last_sign_in_at", ""),
            "last_seen_at": user_doc.get("last_seen_at", ""),
            "last_app_activity_at": max(activity_dates) if activity_dates else "",
            "meal_count": len(user_meals),
            "activity_count": len(user_acts),
            "strava_connected": bool(user_doc.get("strava_connected") and user_doc.get("strava_refresh_token")),
            "strava_last_sync_at": user_doc.get("strava_last_sync_at", ""),
            "disabled": bool(auth_user.get("disabled", False)),
        })
    rows.sort(key=lambda row: row.get("last_seen_at") or row.get("last_sign_in_at") or row.get("created_at") or "", reverse=True)
    return {"total": len(rows), "auth_provider": AUTH_PROVIDER, "users": rows}


@app.get("/api/dashboard")
def dashboard(period: str="week", anchor: str|None=None, insight: bool=False, user_id: str=Depends(get_user_id)):
    period, start, end = _period_bounds(period, anchor)
    prev_start, prev_end = _previous_bounds(period, start, end)
    month_start, month_end = _previous_month_bounds(start)
    targets = _user_targets(user_id)

    meals=storage.query_docs("meals",user_id=user_id)
    acts=storage.query_docs("activities",user_id=user_id)
    current = _analytics(meals, acts, start, end)
    previous = _analytics(meals, acts, prev_start, prev_end)
    previous_month = _analytics(meals, acts, month_start, month_end)
    result=scoring.compute_score(current["meals"], current["activities"], targets=targets, start_date=start, end_date=end)
    day_rows = _day_log(current["meals"], current["activities"], start, end, targets)
    result.update({
        "period": {
            "mode": period,
            "start": _iso(start),
            "end": _iso(end),
            "label": f"{start.strftime('%b %d')} - {end.strftime('%b %d, %Y')}" if period == "week" else start.strftime("%B %Y"),
            "days": max((end-start).days+1,1),
        },
        "summary": current["summary"],
        "food": current["food"],
        "movement": current["movement"],
        "comparisons": _comparisons(current, previous, previous_month),
        "day_log": day_rows,
        "trend": _trend(day_rows, current["activities"]),
        "targets": {**targets, **result.get("targets", {})},
    })
    user=storage.get_user(user_id)
    result["strava_connected"]=bool(user.get("strava_connected") and user.get("strava_refresh_token"))
    result["strava_last_sync_at"]=user.get("strava_last_sync_at","")
    if insight and (current["meals"] or current["activities"]):
        insight_data={k:result[k] for k in ("score","band","components","weekly","signals","period","food","movement","comparisons")}
        try:
            result["insight"]=gemini_client.weekly_insight(insight_data)
            result["insight_source"]="gemini"
        except RuntimeError as e:
            result["insight"]=str(e)
            result["insight_source"]="configuration"
        except Exception as e:
            result["insight"]=_fallback_weekly_insight(insight_data)
            result["insight_source"]="local_fallback"
            result["insight_note"]="Gemini was temporarily unavailable, so VitalLens generated this from the local score data."
    return result


class ChatIn(BaseModel):
    message: str
    history: list[dict]=[]


@app.post("/api/chat")
def chat(body: ChatIn, user_id: str=Depends(get_user_id)):
    since=(datetime.now(timezone.utc)-timedelta(days=8)).date().isoformat()
    meals=storage.query_docs("meals",user_id=user_id,since_iso=since)
    acts=storage.query_docs("activities",user_id=user_id,since_iso=since)
    score=scoring.compute_score(meals,acts)
    try:
        reply=gemini_client.chat(body.message,{k:score[k] for k in ("score","band","weekly","signals")},meals,acts,body.history)
    except RuntimeError as e:
        raise HTTPException(503, str(e)) from e
    except Exception as e:
        raise HTTPException(503, gemini_client.user_facing_error(e)) from e
    return {"reply": reply}


WARDS=["Saket","Dwarka","Rohini","Lajpat Nagar","Karol Bagh","Vasant Kunj"]
DEMO_SCENARIOS=[
    {
        "key":"thriving",
        "label":"balanced high-activity week",
        "activity":[35,40,30,45,35,30,50],
        "intensity":"moderate",
        "meals":[
            ("Moong dal chilla + curd",420,24,52,12,8,9,540),
            ("Dal, brown rice + salad",610,24,86,14,7,13,780),
            ("Paneer tikka, roti + vegetables",590,34,58,20,8,9,720),
        ],
    },
    {
        "key":"on_track",
        "label":"mostly steady week",
        "activity":[25,20,30,0,35,25,30],
        "intensity":"moderate",
        "meals":[
            ("Idli sambhar + chutney",500,16,84,10,8,6,920),
            ("Rajma chawal + salad",690,22,106,14,9,14,1080),
            ("Chicken curry, roti + curd",720,42,72,24,10,5,980),
        ],
    },
    {
        "key":"caution",
        "label":"high-salt low-activity week",
        "activity":[0,20,0,15,0,20,0],
        "intensity":"moderate",
        "meals":[
            ("Aloo paratha + sweet chai",760,16,104,30,28,8,1280),
            ("Veg pulao + raita",820,18,122,24,16,6,1520),
            ("Paneer butter masala + naan",920,28,96,44,18,5,1720),
        ],
    },
    {
        "key":"at_risk",
        "label":"sugary sedentary week",
        "activity":[0,0,10,0,0,15,0],
        "intensity":"moderate",
        "meals":[
            ("Chole bhature + sweet lassi",1080,22,142,44,44,10,1850),
            ("Chicken biryani + cola",1080,36,136,36,48,4,1760),
            ("Paneer butter masala, naan + gulab jamun",1260,34,138,58,54,5,2120),
        ],
    },
]
LEGACY_DEMO_MEAL_NAMES={
    "Aloo paratha + curd",
    "Dal tadka + jeera rice",
    "Chicken biryani",
    "Rajma chawal",
    "Masala dosa",
    "Paneer butter masala",
    "Chole bhature",
}
DEMO_MEAL_NAMES={name for scenario in DEMO_SCENARIOS for name, *_ in scenario["meals"]}|LEGACY_DEMO_MEAL_NAMES


@app.get("/api/community")
def community():
    meals=storage.all_docs("meals"); acts=storage.all_docs("activities")
    users={m.get("user_id") for m in meals}|{a.get("user_id") for a in acts}
    sod,sug,act=[],[],[]
    for u in users:
        um=[m for m in meals if m.get("user_id")==u]; ua=[a for a in acts if a.get("user_id")==u]
        days=max(len({str(m.get("date"))[:10] for m in um}),1)
        if um: sod.append(sum(float(m.get("sodium_mg") or 0) for m in um)/days); sug.append(sum(float(m.get("sugar_g") or 0) for m in um)/days)
        act.append(sum(float(a.get("minutes") or 0) for a in ua))
    med=lambda xs,fb: round(statistics.median(xs)) if xs else fb
    rng=random.Random(42)
    wards=[{"ward":w,"avg_active_min":rng.randint(60,190),"avg_sodium_mg":rng.randint(1700,3400),"elevated_risk_pct":rng.randint(12,41)} for w in WARDS]
    return {"platform_users":len(users),"median_daily_sodium_mg":med(sod,2450),"median_daily_sugar_g":med(sug,58),"median_weekly_active_min":med(act,95),"wards":wards,"note":"Ward figures are illustrative demo data."}


@app.post("/api/demo/seed")
def demo_seed(user_id: str=Depends(get_user_id)):
    rng=random.Random()
    for doc in storage.query_docs("meals",user_id=user_id):
        if doc.get("source")=="demo" or doc.get("items_summary") in DEMO_MEAL_NAMES:
            storage.delete_doc("meals",doc["id"])
    for doc in storage.query_docs("activities",user_id=user_id):
        if doc.get("source")=="demo":
            storage.delete_doc("activities",doc["id"])
    scenario=rng.choice(DEMO_SCENARIOS)
    today=datetime.now(timezone.utc).date()
    activity_types=["walk","run","cycling","yoga","gym","swim"]
    for d in range(45):
        day=(today-timedelta(days=d)).isoformat()
        period_factor = 1.0 if d < 7 else rng.uniform(0.78, 1.12)
        for slot,(name,cal,p,c,f,s,fi,na) in enumerate(scenario["meals"]):
            multiplier=rng.uniform(0.92,1.08)*period_factor
            item={
                "name":name,
                "portion":"1 serving",
                "calories":round(cal*multiplier),
                "protein_g":round(p*multiplier,1),
                "carbs_g":round(c*multiplier,1),
                "fat_g":round(f*multiplier,1),
                "sugar_g":round(s*multiplier,1),
                "fiber_g":round(fi*multiplier,1),
                "sodium_mg":round(na*multiplier),
            }
            item["salt_g"]=round(item["sodium_mg"]*2.5/1000,2)
            storage.save_doc("meals",_normalize_meal_doc({
                "user_id":user_id,
                "date":day,
                "meal_guess":["breakfast","lunch","dinner"][slot],
                "source":"demo",
                "items":[item],
                "calories":item["calories"],
                "protein_g":item["protein_g"],
                "carbs_g":item["carbs_g"],
                "fat_g":item["fat_g"],
                "sugar_g":item["sugar_g"],
                "fiber_g":item["fiber_g"],
                "sodium_mg":item["sodium_mg"],
                "salt_g":item["salt_g"],
                "health_notes":[f"Demo scenario: {scenario['label']}."],
            }))
        minutes=max(0,round(scenario["activity"][d%7]*rng.uniform(0.8,1.2)*period_factor))
        if minutes:
            activity_type=rng.choice(activity_types)
            distance = 0
            if activity_type in {"walk","run"}:
                distance = minutes * (85 if activity_type == "walk" else 150)
            elif activity_type == "cycling":
                distance = minutes * 330
            elif activity_type == "swim":
                distance = minutes * 35
            storage.save_doc("activities",_normalize_activity_doc({
                "user_id":user_id,
                "date":day,
                "type":activity_type,
                "name":f"Demo {activity_type}",
                "minutes":minutes,
                "elapsed_minutes":round(minutes*rng.uniform(1,1.18),1),
                "intensity":scenario["intensity"],
                "source":"demo",
                "distance_m":round(distance,1) if distance else None,
                "calories_burned":round(minutes*rng.uniform(4.5,9.5)),
                "average_heartrate":round(rng.uniform(92,154)) if activity_type not in {"yoga"} else round(rng.uniform(78,105)),
                "max_heartrate":round(rng.uniform(130,178)) if activity_type not in {"yoga"} else round(rng.uniform(100,128)),
                "steps":round(distance / 0.78) if activity_type in {"walk","run"} and distance else None,
                "notes":"Demo activity for dashboard comparisons.",
            }))
    start=today-timedelta(days=6)
    meals=storage.query_docs("meals",user_id=user_id,since_iso=start.isoformat())
    acts=storage.query_docs("activities",user_id=user_id,since_iso=start.isoformat())
    result=scoring.compute_score(meals,acts,start_date=start,end_date=today)
    return {"ok":True,"scenario":scenario["key"],"label":scenario["label"],"score":result["score"],"band":result["band"]}


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/{full_path:path}")
def spa_fallback(full_path: str): return FileResponse(os.path.join(STATIC_DIR, "index.html"))
