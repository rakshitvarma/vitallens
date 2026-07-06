/* VitalLens SPA */
let _supabase=null,_user=null,_token=null;
let _stravaConnected=false;

const redirectMessage=()=>{
  const query=new URLSearchParams(location.search);
  const hash=new URLSearchParams((location.hash||"").replace(/^#/,""));
  return query.get("error_description")||hash.get("error_description")||query.get("error")||hash.get("error")||"";
};

const cleanAuthUrl=()=>{
  const params=new URLSearchParams(location.search);
  const before=params.toString();
  ["error","error_description","error_code"].forEach(k=>params.delete(k));
  const after=params.toString();
  if(location.hash||before!==after) window.history.replaceState({},"","/"+(after?`?${after}`:""));
};

const showAuthScreen=(message="")=>{
  document.getElementById("authScreen").hidden=false;
  document.getElementById("appShell").hidden=true;
  const errorEl=document.getElementById("authError");
  if(errorEl){
    errorEl.textContent=message;
    errorEl.hidden=!message;
  }
};

const startGuestSession=()=>{
  const id=localStorage.getItem("vl_uid")||(()=>{const i=crypto.randomUUID();localStorage.setItem("vl_uid",i);return i;})();
  _token=null;
  _user={id,email:"dev@local",user_metadata:{full_name:"Demo User",avatar_url:""}};
  showApp();
};

const handleReturnParams=()=>{
  const sp=new URLSearchParams(location.search);
  if(sp.get("strava")==="ok") toast(`Strava synced ${sp.get("synced")||"latest"} activities`);
  if(sp.get("strava")==="scope") toast("Strava needs activity read permission");
  if(sp.get("strava")==="error") toast("Strava sync failed");
  if(sp.has("strava")){
    ["strava","synced"].forEach(k=>sp.delete(k));
    window.history.replaceState({},"","/"+(sp.toString()?`?${sp}`:""));
  }
};

const parseJwtPayload=(token)=>{
  const base64Url=(token.split(".")[1]||"").replace(/-/g,"+").replace(/_/g,"/");
  const padded=base64Url+"=".repeat((4-base64Url.length%4)%4);
  const bytes=Uint8Array.from(atob(padded),c=>c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
};
const isJwtExpired=(token)=>{
  try{return ((parseJwtPayload(token).exp||0)*1000)<Date.now()+60000;}
  catch{return true;}
};

const waitForGoogle=()=>new Promise(resolve=>{
  if(window.google?.accounts?.id) return resolve(true);
  let attempts=0;
  const timer=setInterval(()=>{
    if(window.google?.accounts?.id){clearInterval(timer);resolve(true);}
    else if(++attempts>50){clearInterval(timer);resolve(false);}
  },100);
});

async function initGoogleAuth(clientId){
  const savedToken=sessionStorage.getItem("vl_google_token");
  const savedUser=sessionStorage.getItem("vl_google_user");
  if(savedToken&&savedUser&&!isJwtExpired(savedToken)){
    _token="google:"+savedToken;
    _user=JSON.parse(savedUser);
    showApp();
    return;
  }
  sessionStorage.removeItem("vl_google_token");
  sessionStorage.removeItem("vl_google_user");
  showAuthScreen();
  document.getElementById("btnGoogleLogin").hidden=true;
  const host=document.getElementById("googleButton");
  host.hidden=false;
  host.innerHTML="";
  if(!(await waitForGoogle())){
    showAuthScreen("Google sign-in client failed to load. Check the network and refresh.");
    return;
  }
  window.google.accounts.id.initialize({
    client_id:clientId,
    callback:response=>{
      if(!response.credential){
        showAuthScreen("Google did not return a sign-in credential.");
        return;
      }
      const claims=parseJwtPayload(response.credential);
      _token="google:"+response.credential;
      _user={
        id:"google:"+claims.sub,
        email:claims.email,
        user_metadata:{full_name:claims.name||claims.email||"User",avatar_url:claims.picture||""}
      };
      sessionStorage.setItem("vl_google_token",response.credential);
      sessionStorage.setItem("vl_google_user",JSON.stringify(_user));
      cleanAuthUrl();
      showApp();
    },
    ux_mode:"popup",
    use_fedcm_for_prompt:true
  });
  window.google.accounts.id.renderButton(host,{theme:"outline",size:"large",text:"continue_with",shape:"pill",width:320});
  window.google.accounts.id.prompt();
}

async function initAuth(){
  let cfg={};
  try{ cfg=await fetch("/api/config").then(r=>r.json()); }
  catch(e){
    showAuthScreen("Could not load app configuration. Please refresh and try again.");
    return;
  }
  if(cfg.auth_partial){
    showAuthScreen(cfg.auth_error||"Supabase auth is partially configured.");
    document.getElementById("btnGoogleLogin").disabled=true;
    return;
  }
  if(cfg.auth_provider==="google"){
    await initGoogleAuth(cfg.google_client_id);
    return;
  }
  if(!cfg.auth_enabled){
    startGuestSession();
    return;
  }
  if(!window.supabase){
    showAuthScreen("Supabase client failed to load. Check the network and refresh.");
    return;
  }
  const loginError=redirectMessage();
  _supabase=window.supabase.createClient(cfg.supabase_url,cfg.supabase_anon_key,{
    auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
  });
  _supabase.auth.onAuthStateChange((_e,s)=>{
    _token=s?.access_token||null;
    _user=s?.user||null;
    if(s&&document.getElementById("appShell").hidden) showApp();
  });
  const{data:{session},error}=await _supabase.auth.getSession();
  if(error){
    showAuthScreen(error.message);
    return;
  }
  if(session){
    _token=session.access_token;_user=session.user;cleanAuthUrl();showApp();
  } else {
    showAuthScreen(loginError);
    if(loginError) cleanAuthUrl();
    document.getElementById("btnGoogleLogin").disabled=false;
    document.getElementById("btnGoogleLogin").onclick=async()=>{
      const{error}=await _supabase.auth.signInWithOAuth({
        provider:"google",
        options:{redirectTo:location.origin+"/"}
      });
      if(error) showAuthScreen(error.message);
    };
  }
}

function showApp(){
  document.getElementById("authScreen").hidden=true;
  document.getElementById("appShell").hidden=false;
  const u=_user;
  document.getElementById("userName").textContent=u.user_metadata?.full_name||u.email||"User";
  const av=document.getElementById("userAvatar");
  if(u.user_metadata?.avatar_url){av.src=u.user_metadata.avatar_url;av.hidden=false;}
  document.getElementById("btnSignOut").onclick=async()=>{
    if(_supabase) await _supabase.auth.signOut();
    sessionStorage.removeItem("vl_google_token");
    sessionStorage.removeItem("vl_google_user");
    window.google?.accounts?.id?.disableAutoSelect();
    location.reload();
  };
  loadDashboard();
  handleReturnParams();
}

const api=async(path,opts={})=>{
  const headers={...(opts.headers||{})};
  if(_token) headers["Authorization"]="Bearer "+_token;
  else headers["X-User-Id"]=_user?.id||"dev";
  const r=await fetch(path,{...opts,headers});
  if(!r.ok) throw new Error((await r.json().catch(()=>({}))).detail||r.statusText);
  return r.json();
};

const toast=(msg)=>{const t=document.createElement("div");t.className="toast";t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),2800);};
const $=id=>document.getElementById(id);

document.querySelectorAll("#nav button").forEach(b=>b.addEventListener("click",()=>{
  document.querySelectorAll("#nav button,.tab").forEach(el=>el.classList.remove("active"));
  b.classList.add("active");$("tab-"+b.dataset.tab).classList.add("active");
  if(b.dataset.tab==="dashboard") loadDashboard();
  if(b.dataset.tab==="meal") loadMeals();
  if(b.dataset.tab==="activity") loadActivities();
  if(b.dataset.tab==="community") loadCommunity();
}));

let trendChart;
async function loadDashboard(withInsight=false){
  try{
    const d=await api("/api/dashboard"+(withInsight?"?insight=true":""));
    $("scoreNum").textContent=d.score;$("scoreBand").textContent=d.band;
    const ring=$("ringFg");
    ring.style.strokeDashoffset=540-(540*d.score)/100;
    ring.style.stroke=d.score>=60?"var(--volt)":d.score>=40?"var(--amber)":"var(--red)";
    const w=d.weekly;
    $("weeklyStats").innerHTML=[[w.avg_calories,"avg kcal/day"],[w.active_minutes,"active min"],[w.avg_sugar_g+"g","sugar/day"],[w.avg_sodium_mg+"mg","sodium/day"],[w.days_logged+"/7","days logged"]].map(([v,l])=>`<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
    $("signals").innerHTML=d.signals.map(s=>`<div class="signal"><span class="dot ${s.level==="healthy"?"healthy":s.level}"></span><div><b>${s.type.replaceAll("_"," ")}</b> · ${s.level}<p>${s.why}</p></div></div>`).join("");
    $("components").innerHTML=Object.entries(d.components).map(([k,v])=>`<div class="comp"><div class="lbl"><span>${k}</span><span>${v}</span></div><div class="bar"><i style="width:${v}%"></i></div></div>`).join("");
    trendChart?.destroy();
    trendChart=new Chart($("trendChart"),{data:{labels:d.trend.map(t=>t.date.slice(5)),datasets:[{type:"bar",label:"Calories",data:d.trend.map(t=>Math.round(t.calories)),backgroundColor:"#0E3B2E",borderRadius:6,yAxisID:"y"},{type:"line",label:"Active minutes",data:d.trend.map(t=>t.active_min),borderColor:"#8FBF10",backgroundColor:"#8FBF10",tension:.35,yAxisID:"y1"}]},options:{scales:{y:{position:"left"},y1:{position:"right",grid:{display:false}}}}});
    if(d.insight){$("insightCard").hidden=false;$("insightText").textContent=d.insight;}
    _stravaConnected=!!d.strava_connected;
    $("stravaStatus").textContent=d.strava_connected?`Strava connected${d.strava_last_sync_at?" - last sync "+new Date(d.strava_last_sync_at).toLocaleString():""}`:"";
    $("btnStrava").textContent=d.strava_connected?"Re-sync Strava":"Connect Strava";
  }catch(e){toast("Dashboard: "+e.message);}
}
$("btnInsight").addEventListener("click",async()=>{const b=$("btnInsight");b.disabled=true;b.textContent="Gemini is thinking…";await loadDashboard(true);b.disabled=false;b.textContent="Generate AI weekly insight";});
$("btnSeed").addEventListener("click",async()=>{await api("/api/demo/seed",{method:"POST"});toast("Demo week loaded");loadDashboard();});

let lastAnalysis=null;
$("drop").addEventListener("click",()=>$("mealImage").click());
$("mealImage").addEventListener("change",()=>{const f=$("mealImage").files[0];if(!f)return;$("preview").src=URL.createObjectURL(f);$("preview").hidden=false;$("dropText").hidden=true;});
$("btnAnalyze").addEventListener("click",async()=>{
  const f=$("mealImage").files[0];if(!f)return toast("Choose a meal photo first");
  const fd=new FormData();fd.append("image",f);fd.append("portion_note",$("portionNote").value);
  const b=$("btnAnalyze");b.disabled=true;b.textContent="Gemini is analyzing…";
  try{lastAnalysis=await api("/api/meals/analyze",{method:"POST",body:fd});renderAnalysis(lastAnalysis);}catch(e){toast("Analysis failed: "+e.message);}
  b.disabled=false;b.textContent="Analyze with Gemini";
});
function renderAnalysis(a){
  $("analysisResult").hidden=false;$("confTag").textContent=`confidence ${Math.round((a.confidence||0)*100)}%`;
  const cols=["calories","protein_g","carbs_g","fat_g","sugar_g","sodium_mg"];
  $("itemsTable").innerHTML=`<tr><th>Item</th><th>Portion</th>${cols.map(c=>`<th>${c.replace("_g","(g)").replace("_mg","(mg)")}</th>`).join("")}</tr>`+a.items.map(i=>`<tr><td>${i.name}</td><td>${i.portion||""}</td>${cols.map(c=>`<td>${Math.round(i[c]||0)}</td>`).join("")}</tr>`).join("")+`<tr class="total"><td>Total</td><td></td>${cols.map(c=>`<td>${Math.round(a.totals[c]||0)}</td>`).join("")}</tr>`;
  $("healthNotes").innerHTML=(a.health_notes||[]).map(n=>`<p>${n}</p>`).join("");
}
$("btnSaveMeal").addEventListener("click",async()=>{if(!lastAnalysis)return;await api("/api/meals",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({meal_guess:lastAnalysis.meal_guess,items:lastAnalysis.items,...lastAnalysis.totals})});toast("Meal saved");$("analysisResult").hidden=true;loadMeals();});
async function loadMeals(){const m=await api("/api/meals?days=7");$("mealList").innerHTML=m.slice(-12).reverse().map(m=>`<div class="rowitem"><div><b>${m.items_summary||m.meal_guess}</b><div class="meta">${m.date}</div></div><div>${Math.round(m.calories)} kcal</div></div>`).join("")||"<p class='sub'>No meals logged yet.</p>";}

$("btnSaveAct").addEventListener("click",async()=>{await api("/api/activities",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:$("actType").value,minutes:+$("actMin").value,intensity:$("actIntensity").value})});toast("Activity added");loadActivities();});
async function loadActivities(){const a=await api("/api/activities?days=7");$("actList").innerHTML=a.slice(-14).reverse().map(a=>`<div class="rowitem"><div><b style="text-transform:capitalize">${a.type}</b><div class="meta">${a.date} · ${a.source}</div></div><div>${a.minutes} min</div></div>`).join("")||"<p class='sub'>Nothing logged.</p>";}
$("btnStrava").addEventListener("click",async()=>{
  const b=$("btnStrava");b.disabled=true;
  try{
    if(_stravaConnected){
      b.textContent="Syncing Strava...";
      const res=await api("/api/strava/sync",{method:"POST"});
      toast(`Strava synced ${res.synced} activities`);
      await loadDashboard();
      await loadActivities();
    }else{
      const{url}=await api("/auth/strava/login");
      location.href=url;
      return;
    }
  }catch(e){toast(e.message);}
  b.disabled=false;
  b.textContent=_stravaConnected?"Re-sync Strava":"Connect Strava";
});

const chatHistory=[];
function bubble(role,text){const b=document.createElement("div");b.className="bubble "+(role==="user"?"user":"bot");b.textContent=text;$("chatLog").appendChild(b);$("chatLog").scrollTop=1e6;return b;}
async function sendChat(){const msg=$("chatMsg").value.trim();if(!msg)return;$("chatMsg").value="";bubble("user",msg);const t=bubble("bot","…");try{const{reply}=await api("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg,history:chatHistory})});t.textContent=reply;chatHistory.push({role:"user",text:msg},{role:"model",text:reply});}catch(e){t.textContent="Error: "+e.message;}}
$("btnChat").addEventListener("click",sendChat);
$("chatMsg").addEventListener("keydown",e=>e.key==="Enter"&&sendChat());

let wardA,wardR;
async function loadCommunity(){const c=await api("/api/community");$("communityStats").innerHTML=[[c.platform_users,"active users"],[c.median_weekly_active_min+" min","median weekly activity"],[c.median_daily_sodium_mg+" mg","median daily sodium"],[c.median_daily_sugar_g+" g","median daily sugar"]].map(([v,l])=>`<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");$("communityNote").textContent=c.note;const labels=c.wards.map(w=>w.ward);wardA?.destroy();wardR?.destroy();wardA=new Chart($("wardActive"),{type:"bar",data:{labels,datasets:[{label:"min/week",data:c.wards.map(w=>w.avg_active_min),backgroundColor:"#0E3B2E",borderRadius:6}]},options:{plugins:{legend:{display:false}}}});wardR=new Chart($("wardRisk"),{type:"bar",data:{labels,datasets:[{label:"%",data:c.wards.map(w=>w.elevated_risk_pct),backgroundColor:"#D95245",borderRadius:6}]},options:{plugins:{legend:{display:false}}}});}

initAuth();
