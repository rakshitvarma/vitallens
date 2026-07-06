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

const animateNumber=(el,to,duration=650)=>{
  const from=Number(el.textContent)||0;
  const start=performance.now();
  const tick=now=>{
    const p=Math.min(1,(now-start)/duration);
    const eased=1-Math.pow(1-p,3);
    el.textContent=Math.round(from+(to-from)*eased);
    if(p<1)requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

document.body.dataset.activeTab="dashboard";
document.querySelectorAll("#nav button").forEach(b=>b.addEventListener("click",()=>{
  document.querySelectorAll("#nav button,.tab").forEach(el=>el.classList.remove("active"));
  b.classList.add("active");$("tab-"+b.dataset.tab).classList.add("active");
  document.body.dataset.activeTab=b.dataset.tab;
  if(b.dataset.tab==="dashboard") loadDashboard();
  if(b.dataset.tab==="meal") loadMeals();
  if(b.dataset.tab==="activity") loadActivities();
  if(b.dataset.tab==="community") loadCommunity();
}));

let trendChart;
async function loadDashboard(withInsight=false){
  try{
    const d=await api("/api/dashboard"+(withInsight?"?insight=true":""));
    animateNumber($("scoreNum"),d.score);$("scoreBand").textContent=d.band;
    const ring=$("ringFg");
    ring.style.strokeDashoffset=540-(540*d.score)/100;
    ring.style.stroke=d.score>=60?"var(--lime)":d.score>=40?"var(--amber)":"var(--coral)";
    const w=d.weekly;
    $("weeklyStats").innerHTML=[[w.avg_calories,"avg kcal/day"],[w.active_minutes,"active min"],[w.avg_sugar_g+"g","sugar/day"],[w.avg_sodium_mg+"mg","sodium/day"],[w.days_logged+"/7","days logged"]].map(([v,l])=>`<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
    $("signals").innerHTML=d.signals.map(s=>`<div class="signal"><span class="dot ${s.level==="healthy"?"healthy":s.level}"></span><div><b>${s.type.replaceAll("_"," ")}</b> - ${s.level}<p>${s.why}</p></div></div>`).join("");
    $("components").innerHTML=Object.entries(d.components).map(([k,v])=>`<div class="comp"><div class="lbl"><span>${k}</span><span>${v}</span></div><div class="bar"><i style="width:${v}%"></i></div></div>`).join("");
    trendChart?.destroy();
    trendChart=new Chart($("trendChart"),{data:{labels:d.trend.map(t=>t.date.slice(5)),datasets:[{type:"bar",label:"Calories",data:d.trend.map(t=>Math.round(t.calories)),backgroundColor:"#0E3B2E",borderRadius:6,yAxisID:"y"},{type:"line",label:"Active minutes",data:d.trend.map(t=>t.active_min),borderColor:"#8FBF10",backgroundColor:"#8FBF10",tension:.35,yAxisID:"y1"}]},options:{scales:{y:{position:"left"},y1:{position:"right",grid:{display:false}}}}});
    if(d.insight){$("insightCard").hidden=false;$("insightText").textContent=d.insight_note?`${d.insight}\n\n${d.insight_note}`:d.insight;}
    _stravaConnected=!!d.strava_connected;
    $("stravaStatus").textContent=d.strava_connected?`Strava connected${d.strava_last_sync_at?" - last sync "+new Date(d.strava_last_sync_at).toLocaleString():""}`:"";
    $("btnStrava").textContent=d.strava_connected?"Re-sync Strava":"Connect Strava";
  }catch(e){toast("Dashboard: "+e.message);}
}
$("btnInsight").addEventListener("click",async()=>{const b=$("btnInsight");b.disabled=true;b.textContent="Gemini is thinking...";await loadDashboard(true);b.disabled=false;b.textContent="Generate AI weekly insight";});
$("btnSeed").addEventListener("click",async()=>{await api("/api/demo/seed",{method:"POST"});toast("Demo week loaded");loadDashboard();});

let lastAnalysis=null;
let selectedMealFile=null;
let previewUrl=null;
const MAX_UPLOAD_BYTES=7_500_000;
const MAX_IMAGE_DIMENSION=1600;

const drop=$("drop");
const mealImage=$("mealImage");

const setMealFile=file=>{
  if(!file)return;
  if(!file.type?.startsWith("image/")){
    toast("Choose an image file");
    return;
  }
  selectedMealFile=file;
  lastAnalysis=null;
  $("analysisResult").hidden=true;
  drop.classList.add("has-file");
  if(previewUrl)URL.revokeObjectURL(previewUrl);
  previewUrl=URL.createObjectURL(file);
  $("preview").src=previewUrl;
  $("preview").hidden=false;
  $("dropText").hidden=true;
};

const resetMealUpload=()=>{
  selectedMealFile=null;
  mealImage.value="";
  if(previewUrl)URL.revokeObjectURL(previewUrl);
  previewUrl=null;
  $("preview").src="";
  $("preview").hidden=true;
  $("dropText").hidden=false;
  drop.classList.remove("has-file");
  $("portionNote").value="";
};

const loadImage=file=>new Promise((resolve,reject)=>{
  const img=new Image();
  const url=URL.createObjectURL(file);
  img.onload=()=>{URL.revokeObjectURL(url);resolve(img);};
  img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("Could not read this image. Try a JPG, PNG, or WebP photo."));};
  img.src=url;
});

const prepareImageForUpload=async file=>{
  if(file.size<=MAX_UPLOAD_BYTES)return file;
  const img=await loadImage(file);
  const scale=Math.min(1,MAX_IMAGE_DIMENSION/Math.max(img.naturalWidth,img.naturalHeight));
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));
  canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
  canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",0.82));
  if(!blob)throw new Error("Could not prepare this image for upload");
  const name=(file.name||"meal-photo").replace(/\.[^.]+$/,"")+".jpg";
  const prepared=new File([blob],name,{type:"image/jpeg"});
  if(prepared.size>MAX_UPLOAD_BYTES)throw new Error("Image is still too large after compression. Try a smaller photo.");
  return prepared;
};

drop.addEventListener("click",e=>{if(e.target!==mealImage){mealImage.value="";mealImage.click();}});
drop.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();mealImage.value="";mealImage.click();}});
mealImage.addEventListener("change",()=>setMealFile(mealImage.files[0]));
["dragenter","dragover"].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();drop.classList.add("dragover");}));
["dragleave","drop"].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();drop.classList.remove("dragover");}));
drop.addEventListener("drop",e=>setMealFile(e.dataTransfer.files[0]));
$("btnAnalyze").addEventListener("click",async()=>{
  if(!selectedMealFile)return toast("Choose a meal photo first");
  const b=$("btnAnalyze");b.disabled=true;b.textContent="Preparing image...";
  try{
    const uploadFile=await prepareImageForUpload(selectedMealFile);
    const fd=new FormData();fd.append("image",uploadFile,uploadFile.name);fd.append("portion_note",$("portionNote").value);
    b.textContent="Gemini is analyzing...";
    lastAnalysis=await api("/api/meals/analyze",{method:"POST",body:fd});
    renderAnalysis(lastAnalysis);
  }catch(e){toast("Analysis failed: "+e.message);}
  b.disabled=false;b.textContent="Analyze with Gemini";
});

const nutritionFields=[
  ["calories","kcal","Calories",0],
  ["protein_g","g","Protein",1],
  ["carbs_g","g","Carbs",1],
  ["fat_g","g","Fat",1],
  ["sugar_g","g","Sugar",1],
  ["fiber_g","g","Fiber",1],
  ["sodium_mg","mg","Sodium",0],
  ["salt_g","g","Salt",2],
];

const escapeHtml=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[ch]));
const numberValue=(obj,key)=>{
  if(key==="salt_g"&&!(obj?.salt_g)&&obj?.sodium_mg)return Number(obj.sodium_mg)*2.5/1000;
  return Number(obj?.[key]||0);
};
const fmtNutrition=(obj,key,digits=1)=>{
  const value=numberValue(obj,key);
  return digits===0?Math.round(value):value.toFixed(digits).replace(/\.0$/,"");
};
const nutritionGrid=obj=>nutritionFields.map(([key,unit,label,digits])=>`
  <div class="nutrition-chip">
    <b>${fmtNutrition(obj,key,digits)}${unit}</b>
    <span>${label}</span>
  </div>
`).join("");

function renderAnalysis(a){
  $("analysisResult").hidden=false;$("confTag").textContent=`confidence ${Math.round((a.confidence||0)*100)}%`;
  const cols=nutritionFields;
  $("itemsTable").innerHTML=`<tr><th>Item</th><th>Serving</th>${cols.map(([,unit,label])=>`<th>${label}${unit==="kcal"?"":" ("+unit+")"}</th>`).join("")}</tr>`+
    (a.items||[]).map(i=>`<tr><td>${escapeHtml(i.name)}</td><td>${escapeHtml(i.portion||"Estimated serving")}</td>${cols.map(([key,_unit,_label,digits])=>`<td>${fmtNutrition(i,key,digits)}</td>`).join("")}</tr>`).join("")+
    `<tr class="total"><td>Total</td><td></td>${cols.map(([key,_unit,_label,digits])=>`<td>${fmtNutrition(a.totals||{},key,digits)}</td>`).join("")}</tr>`;
  $("healthNotes").innerHTML=(a.health_notes||[]).map(n=>`<p>${escapeHtml(n)}</p>`).join("");
}
$("btnSaveMeal").addEventListener("click",async()=>{
  if(!lastAnalysis)return;
  const body={
    meal_guess:lastAnalysis.meal_guess||"meal",
    portion_note:$("portionNote").value.trim(),
    source:"photo",
    confidence:Number(lastAnalysis.confidence||0),
    health_notes:lastAnalysis.health_notes||[],
    items:lastAnalysis.items||[],
    ...(lastAnalysis.totals||{}),
  };
  await api("/api/meals",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  toast("Meal saved to recent meals");
  $("analysisResult").hidden=true;
  lastAnalysis=null;
  resetMealUpload();
  await loadMeals();
  loadDashboard();
  $("mealList").scrollIntoView({behavior:"smooth",block:"start"});
});

const renderMealItem=item=>`
  <div class="meal-log-item">
    <div>
      <b>${escapeHtml(item.name||"Food item")}</b>
      <span>${escapeHtml(item.portion||"Estimated serving")}</span>
    </div>
    <div class="meal-item-nutrients">
      <span>${fmtNutrition(item,"calories",0)} kcal</span>
      <span>${fmtNutrition(item,"carbs_g",1)}g carbs</span>
      <span>${fmtNutrition(item,"protein_g",1)}g protein</span>
      <span>${fmtNutrition(item,"fiber_g",1)}g fiber</span>
    </div>
  </div>
`;

const renderMealLog=meal=>{
  const title=meal.items_summary||meal.meal_guess||"Logged meal";
  const confidence=meal.confidence?` - ${Math.round(meal.confidence*100)}% confidence`:"";
  const notes=(meal.health_notes||[]).map(n=>`<li>${escapeHtml(n)}</li>`).join("");
  return `
    <article class="meal-log">
      <div class="meal-log-head">
        <div>
          <h4>${escapeHtml(title)}</h4>
          <p>${escapeHtml(meal.date||"")} - ${escapeHtml(meal.meal_guess||"meal")}${confidence}</p>
        </div>
        <strong>${fmtNutrition(meal,"calories",0)} kcal</strong>
      </div>
      ${meal.portion_note?`<p class="portion-note">Portion note: ${escapeHtml(meal.portion_note)}</p>`:""}
      <div class="nutrition-grid">${nutritionGrid(meal)}</div>
      <div class="meal-log-items">${(meal.items||[]).map(renderMealItem).join("")}</div>
      ${notes?`<ul class="meal-log-notes">${notes}</ul>`:""}
    </article>
  `;
};

async function loadMeals(){
  const meals=await api("/api/meals?days=7");
  $("mealList").innerHTML=meals.slice(-12).reverse().map(renderMealLog).join("")||"<p class='sub'>No meals logged yet.</p>";
}

$("btnSaveAct").addEventListener("click",async()=>{await api("/api/activities",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:$("actType").value,minutes:+$("actMin").value,intensity:$("actIntensity").value})});toast("Activity added");loadActivities();});
async function loadActivities(){const a=await api("/api/activities?days=7");$("actList").innerHTML=a.slice(-14).reverse().map(a=>`<div class="rowitem"><div><b style="text-transform:capitalize">${a.type}</b><div class="meta">${a.date} - ${a.source}</div></div><div>${a.minutes} min</div></div>`).join("")||"<p class='sub'>Nothing logged.</p>";}
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
async function sendChat(){const msg=$("chatMsg").value.trim();if(!msg)return;$("chatMsg").value="";bubble("user",msg);const t=bubble("bot","...");try{const{reply}=await api("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg,history:chatHistory})});t.textContent=reply;chatHistory.push({role:"user",text:msg},{role:"model",text:reply});}catch(e){t.textContent="Error: "+e.message;}}
$("btnChat").addEventListener("click",sendChat);
$("chatMsg").addEventListener("keydown",e=>e.key==="Enter"&&sendChat());

let wardA,wardR;
async function loadCommunity(){const c=await api("/api/community");$("communityStats").innerHTML=[[c.platform_users,"active users"],[c.median_weekly_active_min+" min","median weekly activity"],[c.median_daily_sodium_mg+" mg","median daily sodium"],[c.median_daily_sugar_g+" g","median daily sugar"]].map(([v,l])=>`<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");$("communityNote").textContent=c.note;const labels=c.wards.map(w=>w.ward);wardA?.destroy();wardR?.destroy();wardA=new Chart($("wardActive"),{type:"bar",data:{labels,datasets:[{label:"min/week",data:c.wards.map(w=>w.avg_active_min),backgroundColor:"#0E3B2E",borderRadius:6}]},options:{plugins:{legend:{display:false}}}});wardR=new Chart($("wardRisk"),{type:"bar",data:{labels,datasets:[{label:"%",data:c.wards.map(w=>w.elevated_risk_pct),backgroundColor:"#D95245",borderRadius:6}]},options:{plugins:{legend:{display:false}}}});}

initAuth();
