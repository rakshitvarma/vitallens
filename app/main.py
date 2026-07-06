import os, random, statistics
from datetime import datetime, timedelta, timezone
import httpx
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from app import gemini_client, scoring, storage
from app.auth import get_user_id

app = FastAPI(title="VitalLens")
STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")
STRAVA_ID = os.environ.get("STRAVA_CLIENT_ID", "")
STRAVA_SECRET = os.environ.get("STRAVA_CLIENT_SECRET", "")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "http://localhost:8080")

@app.get("/api/health")
def health(): return {"ok": True}

@app.get("/api/config")
def config():
    return {"supabase_url": os.environ.get("SUPABASE_URL",""), "supabase_anon_key": os.environ.get("SUPABASE_ANON_KEY",""), "strava_enabled": bool(STRAVA_ID), "auth_enabled": bool(os.environ.get("SUPABASE_JWT_SECRET"))}

@app.post("/api/meals/analyze")
async def analyze_meal(image: UploadFile=File(...), portion_note: str=Form(""), user_id: str=Depends(get_user_id)):
    data = await image.read()
    if len(data) > 8_000_000: raise HTTPException(413, "Image too large")
    try: return gemini_client.analyze_meal_image(data, image.content_type or "image/jpeg", portion_note)
    except Exception as e: raise HTTPException(502, f"Gemini failed: {e}") from e

class MealIn(BaseModel):
    date: str|None=None; meal_guess: str="meal"; items: list[dict]=[]; calories: float=0; protein_g: float=0; carbs_g: float=0; fat_g: float=0; sugar_g: float=0; sodium_mg: float=0

@app.post("/api/meals")
def save_meal(meal: MealIn, user_id: str=Depends(get_user_id)):
    doc=meal.model_dump(); doc["date"]=doc["date"] or datetime.now(timezone.utc).date().isoformat()
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
    if not STRAVA_ID: raise HTTPException(501, "Strava not configured")
    redirect=f"{PUBLIC_BASE_URL.rstrip('/')}/auth/strava/callback"
    return {"url": f"https://www.strava.com/oauth/authorize?client_id={STRAVA_ID}&response_type=code&redirect_uri={redirect}&approval_prompt=auto&scope=activity:read_all&state={user_id}"}

@app.get("/auth/strava/callback")
async def strava_callback(code: str="", state: str=""):
    if not code or not state: return RedirectResponse("/?strava=error")
    async with httpx.AsyncClient() as hx:
        tok=await hx.post("https://www.strava.com/oauth/token",data={"client_id":STRAVA_ID,"client_secret":STRAVA_SECRET,"code":code,"grant_type":"authorization_code"})
        if tok.status_code!=200: return RedirectResponse("/?strava=error")
        access=tok.json()["access_token"]
        after=int((datetime.now(timezone.utc)-timedelta(days=30)).timestamp())
        acts=await hx.get("https://www.strava.com/api/v3/athlete/activities",params={"after":after,"per_page":100},headers={"Authorization":f"Bearer {access}"})
    for a in (acts.json() if acts.status_code==200 else []):
        storage.save_doc("activities",{"id":f"strava-{a['id']}","user_id":state,"date":str(a.get("start_date_local",""))[:10],"type":a.get("type","Workout").lower(),"minutes":round(float(a.get("moving_time",0))/60,1),"intensity":"high" if (a.get("average_heartrate") or 0)>140 else "moderate","source":"strava"})
    storage.set_user(state,{"strava_connected":True}); return RedirectResponse("/?strava=ok")

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
    result["strava_connected"]=bool(storage.get_user(user_id).get("strava_connected"))
    if insight and (meals or acts):
        try: result["insight"]=gemini_client.weekly_insight({k:result[k] for k in ("score","band","components","weekly","signals")})
        except Exception as e: result["insight"]=f"(unavailable: {e})"
    return result

class ChatIn(BaseModel):
    message: str; history: list[dict]=[]

@app.post("/api/chat")
def chat(body: ChatIn, user_id: str=Depends(get_user_id)):
    since=(datetime.now(timezone.utc)-timedelta(days=8)).date().isoformat()
    meals=storage.query_docs("meals",user_id=user_id,since_iso=since)
    acts=storage.query_docs("activities",user_id=user_id,since_iso=since)
    score=scoring.compute_score(meals,acts)
    try: reply=gemini_client.chat(body.message,{k:score[k] for k in ("score","band","weekly","signals")},meals,acts,body.history)
    except Exception as e: raise HTTPException(502,f"Gemini chat failed: {e}") from e
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
    rng=random.Random(); menu=[("Aloo paratha + curd",520,12,68,22,8,780),("Dal tadka + jeera rice",640,22,92,18,6,1150),("Chicken biryani",780,34,96,28,9,1450),("Rajma chawal",560,19,88,12,7,980),("Masala dosa",480,11,74,16,10,1120),("Paneer butter masala",820,26,72,46,14,1380),("Chole bhature",760,18,94,34,11,1350)]
    today=datetime.now(timezone.utc).date()
    for d in range(7):
        day=(today-timedelta(days=d)).isoformat()
        for _ in range(rng.randint(2,3)):
            name,cal,p,c,f,s,na=rng.choice(menu)
            storage.save_doc("meals",{"user_id":user_id,"date":day,"meal_guess":"meal","items":[{"name":name}],"items_summary":name,"calories":cal*rng.uniform(0.85,1.15),"protein_g":p,"carbs_g":c,"fat_g":f,"sugar_g":s*rng.uniform(0.8,1.4),"sodium_mg":na*rng.uniform(0.85,1.25)})
        if rng.random()<0.6:
            storage.save_doc("activities",{"user_id":user_id,"date":day,"type":rng.choice(["walk","run","cycling","yoga"]),"minutes":rng.choice([20,30,45]),"intensity":rng.choice(["moderate","moderate","high"]),"source":"demo"})
    return {"ok":True}

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/{full_path:path}")
def spa_fallback(full_path: str): return FileResponse(os.path.join(STATIC_DIR, "index.html"))
