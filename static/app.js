/* VitalLens SPA */
let _user=null;
let _stravaConnected=false;

const localId=()=>{
  try{
    const existing=localStorage.getItem("vl_uid");
    if(existing) return existing;
    const id=crypto.randomUUID();
    localStorage.setItem("vl_uid",id);
    return id;
  }catch{
    return crypto.randomUUID();
  }
};

const startGuestSession=()=>{
  const id=localId();
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

async function initAuth(){
  startGuestSession();
}

function showApp(){
  document.getElementById("appShell").hidden=false;
  const u=_user;
  document.getElementById("userName").textContent=u.user_metadata?.full_name||u.email||"User";
  const av=document.getElementById("userAvatar");
  if(u.user_metadata?.avatar_url){av.src=u.user_metadata.avatar_url;av.hidden=false;}
  loadDashboard();
  handleReturnParams();
}

const api=async(path,opts={})=>{
  const headers={...(opts.headers||{})};
  headers["X-User-Id"]=_user?.id||"demo";
  const r=await fetch(path,{...opts,headers});
  if(!r.ok){
    const message=(await r.json().catch(()=>({}))).detail||r.statusText;
    throw new Error(message);
  }
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
    if(d.insight){$("insightCard").hidden=false;$("insightText").textContent=d.insight_note?`${d.insight}\n\n${d.insight_note}`:d.insight;}
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
