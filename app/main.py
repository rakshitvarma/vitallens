import base64, hashlib, hmac, json, os, random, statistics
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode
import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from app import gemini_client, scoring, storage
from app.auth import (
    AUTH_CONFIG_ERROR,
    AUTH_CONFIGURED,
    AUTH_PROVIDER,
    get_user_id,
)

app = FastAPI(title="VitalLens")
STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
STRAVA_ID = os.environ.get("STRAVA_CLIENT_ID", "")
STRAVA_SECRET = os.environ.get("STRAVA_CLIENT_SECRET", "")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8080")
STRAVA_SCOPE = "activity:read_all"
MAX_IMAGE_BYTES = 8_000_000

def _fallback_weekly_insight(score_data: dict) -> str:
    weekly = score_data.get("weekly", {})
    signals = score_data.get("signals", [])
    signal = next((s for s in signals if s.get("level") != "healthy"), signals[0] if signals else {})
    action = "Log meals on at least 5 days this week so the score has a stronger baseline."
    if weekly.get("active_minutes", 0) < 150:
        action = "Add three 20-minute brisk walks this week to move closer to the 150-minute activity target."
    elif weekly.get("avg_sodium_mg", 0) > 2000:
        action = "Choose one lower-salt swap each day, such as less packaged food or asking for less salt in cooked meals."
    elif weekly.get("avg_sugar_g", 0) > 50:
        action = "Replace one sweet drink or dessert with fruit, curd, or unsweetened tea on most days."
    elif weekly.get("avg_protein_g", 0) < 55:
        action = "Add one protein serving such as dal, paneer, eggs, curd, chana, or lean meat to one meal daily."
    return (
        f"Your VitalScore is {score_data.get('score')} ({score_data.get('band')}). "
        f"This week you logged {weekly.get('active_minutes', 0)} active minutes, "
        f"{weekly.get('avg_sugar_g', 0)}g sugar/day, and {weekly.get('avg_sodium_mg', 0)}mg sodium/day. "
        f"Main signal: {str(signal.get('type', 'overall balance')).replace('_', ' ')} - "
        f"{signal.get('why', 'your recent logs need a little more consistency')}. {action}"
    )

@app.get("/api/health")
def health(): return {"ok": True}

@app.get("/api/config")
def config():
    return {
        "auth_provider": AUTH_PROVIDER,
        "gemini_enabled": gemini_client.is_configured(),
        "gemini_model": gemini_client.MODEL,
        "strava_enabled": bool(STRAVA_ID),
        "auth_enabled": AUTH_CONFIGURED,
        "auth_error": AUTH_CONFIG_ERROR,
    }

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

class MealIn(BaseModel):
    date: str|None=None; meal_guess: str="meal"; portion_note: str=""; source: str="manual"; confidence: float=0; health_notes: list[str]=Field(default_factory=list); items: list[dict]=Field(default_factory=list); calories: float=0; protein_g: float=0; carbs_g: float=0; fat_g: float=0; sugar_g: float=0; fiber_g: float=0; sodium_mg: float=0; salt_g: float=0

@app.post("/api/meals")
def save_meal(meal: MealIn, user_id: str=Depends(get_user_id)):
    doc=meal.model_dump(); doc["date"]=doc["date"] or datetime.now(timezone.utc).date().isoformat()
    if not doc.get("salt_g") and doc.get("sodium_mg"):
        doc["salt_g"]=round(float(doc.get("sodium_mg") or 0)*2.5/1000,2)
    for item in doc.get("items", []):
        if not item.get("salt_g") and item.get("sodium_mg"):
            item["salt_g"]=round(float(item.get("sodium_mg") or 0)*2.5/1000,2)
    doc["user_id"]=user_id; doc["items_summary"]=", ".join(i.get("name","?") for i in doc["items"])[:200]
    return {"id": storage.save_doc("meals", doc)}

@app.get("/api/meals")
def list_meals(days: int=7, user_id: str=Depends(get_user_id)):
    since=(datetime.now(timezone.utc)-timedelta(days=days)).date().isoformat()
    return storage.query_docs("meals", user_id=user_id, since_iso=since)

class ActivityIn(BaseModel):
    date: str|None=None; type: str="walk"; minutes: float=30; intensity: str="moderate"; source: str="manual"

@app.post("/api/activities")
def save_activity(act: ActivityIn, user_id: str=Depends(get_user_id)):
    doc=act.model_dump(); doc["date"]=doc["date"] or datetime.now(timezone.utc).date().isoformat()
    doc["user_id"]=user_id; return {"id": storage.save_doc("activities", doc)}

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
    avg_hr=float(activity.get("average_heartrate") or 0)
    return {
        "id": f"strava-{activity['id']}",
        "user_id": user_id,
        "date": start or datetime.now(timezone.utc).date().isoformat(),
        "type": str(activity.get("sport_type") or activity.get("type") or "workout").replace("_"," ").lower(),
        "minutes": round(float(activity.get("moving_time") or activity.get("elapsed_time") or 0)/60,1),
        "intensity": "high" if avg_hr>140 else "moderate",
        "source": "strava",
        "strava_id": str(activity.get("id")),
        "name": activity.get("name","Strava activity"),
        "distance_m": round(float(activity.get("distance") or 0),1),
        "average_heartrate": avg_hr or None,
    }

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

@app.get("/api/dashboard")
def dashboard(insight: bool=False, user_id: str=Depends(get_user_id)):
    since=(datetime.now(timezone.utc)-timedelta(days=8)).date().isoformat()
    meals=storage.query_docs("meals",user_id=user_id,since_iso=since)
    acts=storage.query_docs("activities",user_id=user_id,since_iso=since)
    result=scoring.compute_score(meals,acts)
    trend={}
    for m in meals:
        d=str(m.get("date",""))[:10]; trend.setdefault(d,{"calories":0,"active_min":0}); trend[d]["calories"]+=float(m.get("calories") or 0)
    for a in acts:
        d=str(a.get("date",""))[:10]; trend.setdefault(d,{"calories":0,"active_min":0}); trend[d]["active_min"]+=float(a.get("minutes") or 0)
    result["trend"]=[{"date":d,**v} for d,v in sorted(trend.items())]
    user=storage.get_user(user_id)
    result["strava_connected"]=bool(user.get("strava_connected") and user.get("strava_refresh_token"))
    result["strava_last_sync_at"]=user.get("strava_last_sync_at","")
    if insight and (meals or acts):
        insight_data={k:result[k] for k in ("score","band","components","weekly","signals")}
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
    message: str; history: list[dict]=[]

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
    rng=random.Random(); menu=[("Aloo paratha + curd",520,12,68,22,8,7,780),("Dal tadka + jeera rice",640,22,92,18,6,12,1150),("Chicken biryani",780,34,96,28,9,5,1450),("Rajma chawal",560,19,88,12,7,13,980),("Masala dosa",480,11,74,16,10,5,1120),("Paneer butter masala",820,26,72,46,14,4,1380),("Chole bhature",760,18,94,34,11,10,1350)]
    today=datetime.now(timezone.utc).date()
    for d in range(7):
        day=(today-timedelta(days=d)).isoformat()
        for _ in range(rng.randint(2,3)):
            name,cal,p,c,f,s,fi,na=rng.choice(menu)
            sodium=na*rng.uniform(0.85,1.25)
            storage.save_doc("meals",{"user_id":user_id,"date":day,"meal_guess":"meal","items":[{"name":name,"portion":"1 serving","calories":cal,"protein_g":p,"carbs_g":c,"fat_g":f,"sugar_g":s,"fiber_g":fi,"sodium_mg":na,"salt_g":round(na*2.5/1000,2)}],"items_summary":name,"calories":cal*rng.uniform(0.85,1.15),"protein_g":p,"carbs_g":c,"fat_g":f,"sugar_g":s*rng.uniform(0.8,1.4),"fiber_g":fi,"sodium_mg":sodium,"salt_g":round(sodium*2.5/1000,2),"health_notes":["Demo estimate based on typical Indian serving sizes."]})
        if rng.random()<0.6:
            storage.save_doc("activities",{"user_id":user_id,"date":day,"type":rng.choice(["walk","run","cycling","yoga"]),"minutes":rng.choice([20,30,45]),"intensity":rng.choice(["moderate","moderate","high"]),"source":"demo"})
    return {"ok":True}

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/{full_path:path}")
def spa_fallback(full_path: str): return FileResponse(os.path.join(STATIC_DIR, "index.html"))
