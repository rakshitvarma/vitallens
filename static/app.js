/* VitalLens SPA */
let _user=null;
let _stravaConnected=false;
let trendChart;
let dashboardPeriod="week";
let dashboardAnchor=new Date();
let lastMeals=[];
let lastActivities=[];
let editingMealId=null;
let editingActivityId=null;
let latestDashboard=null;
const THEME_KEY="vitallens_theme";

const $=id=>document.getElementById(id);
const escapeHtml=value=>String(value??"").replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#039;"}[ch]));
const num=value=>Number(value||0);
const round=(value,digits=1)=>digits===0?Math.round(num(value)):num(value).toFixed(digits).replace(/\.0$/,"");
const pct=value=>Math.max(0,Math.min(100,Math.round(num(value))));
const todayIso=()=>toIsoDate(new Date());
const toIsoDate=date=>{
  const d=new Date(date);
  d.setMinutes(d.getMinutes()-d.getTimezoneOffset());
  return d.toISOString().slice(0,10);
};
const parseIsoDate=value=>{
  const d=new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime())?new Date():d;
};
const fmtDate=value=>{
  if(!value)return "";
  const d=new Date(`${String(value).slice(0,10)}T00:00:00`);
  return d.toLocaleDateString(undefined,{month:"short",day:"numeric"});
};
const fmtDistance=m=>num(m)>=1000?`${round(num(m)/1000,1)} km`:`${Math.round(num(m))} m`;
const toast=msg=>{const t=document.createElement("div");t.className="toast";t.textContent=msg;document.body.appendChild(t);setTimeout(()=>t.remove(),2800);};
const chartPalette=()=>document.body.dataset.theme==="dark"
  ?{calories:"#b8e62e",caloriesBorder:"#d6ff65",burn:"#58d8f0",burnBorder:"#9eeeff",active:"#ffcf6b"}
  :{calories:"#0b3d30",caloriesBorder:"#06261d",burn:"#007c9a",burnBorder:"#005c72",active:"#b35f00"};
const applyChartTheme=()=>{
  if(!window.Chart)return;
  Chart.defaults.color=document.body.dataset.theme==="dark"?"#d7eadf":"#233d32";
  Chart.defaults.borderColor=document.body.dataset.theme==="dark"?"rgba(255,255,255,.16)":"rgba(13,59,46,.18)";
  if(trendChart){
    const palette=chartPalette();
    const [calories,burn,active]=trendChart.data.datasets;
    if(calories){calories.backgroundColor=palette.calories;calories.borderColor=palette.caloriesBorder;}
    if(burn){burn.backgroundColor=palette.burn;burn.borderColor=palette.burnBorder;}
    if(active){active.borderColor=palette.active;active.backgroundColor=palette.active;}
  }
  trendChart?.update();
};
const setTheme=theme=>{
  const selected=theme==="dark"?"dark":"light";
  document.body.dataset.theme=selected;
  localStorage.setItem(THEME_KEY,selected);
  const btn=$("themeToggle");
  if(btn){
    btn.textContent=selected==="dark"?"Light":"Dark";
    btn.setAttribute("aria-label",selected==="dark"?"Switch to light mode":"Switch to dark mode");
  }
  applyChartTheme();
};
const initTheme=()=>{
  const saved=localStorage.getItem(THEME_KEY);
  const prefersDark=window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  setTheme(saved||(prefersDark?"dark":"light"));
};

const localId=()=>{
  try{
    const existing=localStorage.getItem("vl_uid");
    if(existing)return existing;
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
  if(sp.get("strava")==="ok")toast(`Strava synced ${sp.get("synced")||"latest"} activities`);
  if(sp.get("strava")==="scope")toast("Strava needs activity read permission");
  if(sp.get("strava")==="error")toast("Strava sync failed");
  if(sp.has("strava")){
    ["strava","synced"].forEach(k=>sp.delete(k));
    window.history.replaceState({},"","/"+(sp.toString()?`?${sp}`:""));
  }
};

async function initAuth(){startGuestSession();}

function showApp(){
  $("appShell").hidden=false;
  const u=_user;
  $("userName").textContent=u.user_metadata?.full_name||u.email||"User";
  const av=$("userAvatar");
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

const activateTab=tab=>{
  document.querySelectorAll("#nav button,.tab").forEach(el=>el.classList.remove("active"));
  const navButton=document.querySelector(`#nav button[data-tab="${tab}"]`);
  navButton?.classList.add("active");
  $("tab-"+tab)?.classList.add("active");
  document.body.dataset.activeTab=tab;
  if(tab==="dashboard")loadDashboard();
  if(tab==="meal"){loadDashboard();loadMeals();}
  if(tab==="activity"){loadDashboard();loadActivities();}
  if(tab==="community")loadCommunity();
  window.scrollTo({top:0,behavior:"smooth"});
};

document.body.dataset.activeTab="dashboard";
document.querySelectorAll("#nav button").forEach(b=>b.addEventListener("click",()=>activateTab(b.dataset.tab)));

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

const activityTypeOptions=[
  ["walk","Walk"],
  ["run","Run"],
  ["cycling","Cycling"],
  ["swim","Swimming"],
  ["hike","Hiking"],
  ["gym","Gym / strength"],
  ["yoga","Yoga"],
  ["pilates","Pilates"],
  ["dance","Dance"],
  ["sport","Sport"],
  ["football","Football"],
  ["cricket","Cricket"],
  ["basketball","Basketball"],
  ["tennis","Tennis"],
  ["badminton","Badminton"],
  ["rowing","Rowing"],
  ["elliptical","Elliptical"],
  ["workout","General workout"],
];
const activityTypeLabel=value=>activityTypeOptions.find(([key])=>key===value)?.[1]||String(value||"Activity").replaceAll("_"," ");
const activityTypeSelect=(name,id,value="walk")=>`
  <select ${id?`id="${id}"`:""} ${name?`name="${name}"`:""}>
    ${activityTypeOptions.map(([key,label])=>`<option value="${key}" ${key===value?"selected":""}>${escapeHtml(label)}</option>`).join("")}
  </select>
`;

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

const levelForScore=value=>value>=82?"Strong":value>=65?"Good":value>=45?"Watch":"Needs attention";
const goalProgress=(current,target,lowerIsBetter=false)=>{
  if(!target)return 0;
  if(lowerIsBetter)return Math.max(0,Math.min(100,Math.round((1-Math.max(0,current-target)/target)*100)));
  return Math.max(0,Math.min(100,Math.round(current/target*100)));
};
const calorieBalance=(current,target)=>{
  if(!target||!current)return 0;
  const diff=Math.abs(current-target)/target;
  return Math.max(0,Math.min(100,Math.round((1-Math.max(0,diff-.12)/.45)*100)));
};
const meter=(label,value,detail="")=>`
  <div class="balance-meter">
    <div class="balance-head"><span>${escapeHtml(label)}</span><b>${pct(value)}/100</b></div>
    <div class="balance-track"><i style="left:${pct(value)}%"></i></div>
    <div class="balance-foot"><span>${levelForScore(value)}</span><span>${escapeHtml(detail)}</span></div>
  </div>
`;
const miniMeter=(label,value,detail="")=>`
  <div class="mini-meter">
    <div class="mini-meter-head"><span>${escapeHtml(label)}</span><b>${pct(value)}/100</b></div>
    <div class="mini-meter-track"><i style="width:${pct(value)}%"></i></div>
    <div class="mini-meter-foot">${escapeHtml(detail)}</div>
  </div>
`;
const focusIcon=name=>{
  const icons={
    calories:`<path d="M12 3c3 4 5 7 5 10a5 5 0 0 1-10 0c0-3 2-6 5-10z"/><path d="M9.5 13h5"/>`,
    sugar:`<path d="M12 3c3 3 5 6 5 9a5 5 0 0 1-10 0c0-3 2-6 5-9z"/>`,
    sodium:`<path d="M12 4v16M7 7h10M8 11h8M9 15h6"/>`,
    protein:`<path d="M5 12c4-7 10-7 14 0-4 7-10 7-14 0z"/><path d="M12 8v8M8 12h8"/>`,
    active:`<path d="M13 5a2 2 0 1 0-4 0 2 2 0 0 0 4 0z"/><path d="M10 8l-2 5 4 2 2 5"/>`,
    steps:`<path d="M4 17c4-5 8-5 16 0"/><path d="M7 17l2 4M17 17l-2 4"/>`,
    burn:`<path d="M12 3c3 4 5 7 5 10a5 5 0 0 1-10 0c0-3 2-6 5-10z"/>`,
    heart:`<path d="M20 8c0 5-8 11-8 11S4 13 4 8a4 4 0 0 1 8-2 4 4 0 0 1 8 2z"/><path d="M8 12h2.5l1-2 2 4 1-2H17"/>`,
    workout:`<path d="M6 8v8M18 8v8M3 12h18M8 10v4M16 10v4"/>`,
  };
  return `<span class="stat-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[name]||icons.calories}</svg></span>`;
};
const focusStat=(value,label,icon)=>`
  <div class="stat focus-stat">
    ${focusIcon(icon)}
    <div class="focus-stat-text"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>
  </div>
`;
const setFocusRing=(kind,score)=>{
  const value=pct(score);
  const ring=$(kind==="meal"?"mealRingFg":"activityRingFg");
  const scoreEl=$(kind==="meal"?"mealScoreNum":"activityScoreNum");
  const bandEl=$(kind==="meal"?"mealScoreBand":"activityScoreBand");
  if(!ring||!scoreEl||!bandEl)return;
  ring.style.strokeDashoffset=540-(540*value)/100;
  ring.style.stroke=value>=70?"var(--lime)":value>=45?"var(--amber)":"var(--coral)";
  scoreEl.textContent=value;
  bandEl.textContent=value>=70?(kind==="meal"?"Balanced":"On track"):value>=45?"Watch":"Needs attention";
};

const signalIcon=type=>{
  const icons={
    type2_diabetes:`<path d="M12 3c3 4 5 6.8 5 10a5 5 0 0 1-10 0c0-3.2 2-6 5-10z"/><path d="M9.5 13h5M12 10.5v5"/>`,
    hypertension:`<path d="M20.5 8.5c0 5-8.5 10.5-8.5 10.5S3.5 13.5 3.5 8.5A4.5 4.5 0 0 1 12 6a4.5 4.5 0 0 1 8.5 2.5z"/><path d="M7 12h2.3l1.2-2.2 2.1 4.4 1.1-2.2H17"/>`,
    sedentary_lifestyle:`<path d="M13 5a2 2 0 1 0-4 0 2 2 0 0 0 4 0z"/><path d="M10 8l-2 5 4 2 2 5M12 10l4 3 3-1M8 13l-3 6"/>`,
    none:`<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-5"/>`,
  };
  return `<span class="risk-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[type]||icons.none}</svg></span>`;
};

const renderSignals=signals=>(signals||[]).map(s=>`
  <div class="signal ${escapeHtml(s.level)}">
    ${signalIcon(s.type)}
    <div><b>${escapeHtml(String(s.type||"signal").replaceAll("_"," "))}</b> - ${escapeHtml(s.level||"watch")}<p>${escapeHtml(s.why||"")}</p></div>
  </div>
`).join("");

const renderComponents=components=>Object.entries(components||{}).map(([key,value])=>
  meter(key.replaceAll("_"," "),value,levelForScore(value))
).join("");

const renderMetricGrid=(items=[])=>items.map(item=>`
  <div class="metric">
    <b>${escapeHtml(item.value)}</b>
    <span>${escapeHtml(item.label)}</span>
  </div>
`).join("");

const renderMiniList=(title,items=[])=>`
  <div class="mini-list-title">${escapeHtml(title)}</div>
  ${items.length?items.map(i=>`<div class="mini-row"><span>${escapeHtml(i.label)}</span><b>${escapeHtml(i.value)}</b></div>`).join(""):"<p class='sub compact'>Not enough data yet.</p>"}
`;

const renderComparisons=(groups={})=>{
  const renderGroup=(title,rows=[])=>`
    <div class="comparison-group">
      <h4>${escapeHtml(title)}</h4>
      ${rows.map(r=>{
        const change=r.enough_data&&r.change_pct!==null?`${r.change_pct>0?"+":""}${r.change_pct}%`:"No baseline";
        const current=`${round(r.current,r.unit==="mg"||r.unit==="kcal"||r.unit==="min"?0:1)} ${r.unit}`;
        const previous=r.enough_data?`${round(r.previous,r.unit==="mg"||r.unit==="kcal"||r.unit==="min"?0:1)} ${r.unit}`:"-";
        return `<div class="comparison-row ${r.direction||"none"}"><span>${escapeHtml(r.label)}</span><b>${current}</b><em>${escapeHtml(change)}</em><small>vs ${escapeHtml(previous)}</small></div>`;
      }).join("")}
    </div>
  `;
  return renderGroup("Previous period",groups.previous_period||[])+renderGroup("Previous month avg",groups.previous_month_average||[]);
};

const renderDayLog=rows=>(rows||[]).map(row=>`
  <div class="day-card ${escapeHtml(row.status)}">
    <div class="day-date"><b>${fmtDate(row.date)}</b><span>${escapeHtml(new Date(`${row.date}T00:00:00`).toLocaleDateString(undefined,{weekday:"short"}))}</span></div>
    <div class="day-stats">
      <span>${row.calories} kcal</span>
      <span>${row.active_min} active min</span>
      <span>${row.steps||0} steps</span>
      <span>${row.meals} meals / ${row.activities} workouts</span>
    </div>
    <p>${escapeHtml([...(row.meal_names||[]),...(row.activity_names||[])].slice(0,3).join(" - ")||"No logs yet")}</p>
  </div>
`).join("");

const tableValue=value=>value===undefined||value===null||value===""?"-":String(value);
const componentRows=components=>Object.entries(components||{}).map(([key,value])=>[
  key.replaceAll("_"," "),
  `${round(value,0)}/100`,
  levelForScore(value),
]);
const comparisonRows=groups=>[
  ...(groups?.previous_period||[]).map(r=>["Previous period",r]),
  ...(groups?.previous_month_average||[]).map(r=>["Previous month avg",r]),
].map(([group,r])=>[
  group,
  r.label,
  `${round(r.current,r.unit==="mg"||r.unit==="kcal"||r.unit==="min"?0:1)} ${r.unit}`,
  r.enough_data?`${round(r.previous,r.unit==="mg"||r.unit==="kcal"||r.unit==="min"?0:1)} ${r.unit}`:"No baseline",
  r.enough_data&&r.change_pct!==null?`${r.change_pct>0?"+":""}${r.change_pct}%`:"-",
]);
const pdfColor={
  pine:[13,59,46],
  pineDark:[8,34,27],
  lime:[184,230,46],
  lime2:[143,191,16],
  sky:[26,167,200],
  amber:[230,162,58],
  coral:[217,82,69],
  ink:[16,37,29],
  muted:[96,117,108],
  line:[216,229,220],
  soft:[248,251,248],
};
const pdfRgb=(doc,color)=>doc.setTextColor(...color);
const pdfFill=(doc,color)=>doc.setFillColor(...color);
const pdfStroke=(doc,color)=>doc.setDrawColor(...color);
const pdfScoreColor=score=>score>=70?pdfColor.lime:score>=45?pdfColor.amber:pdfColor.coral;
const pdfFitText=(doc,text,x,y,maxWidth,{size=12,minSize=7,align="left"}={})=>{
  const value=String(text);
  let fontSize=size;
  doc.setFontSize(fontSize);
  while(fontSize>minSize&&doc.getTextWidth(value)>maxWidth){
    fontSize-=.5;
    doc.setFontSize(fontSize);
  }
  doc.text(value,x,y,{maxWidth,align});
};
const pdfAddPageIfNeeded=(doc,y,needed=120)=>{
  if(y+needed>760){doc.addPage();return 44;}
  return y;
};
const pdfSection=(doc,title,y)=>{
  y=pdfAddPageIfNeeded(doc,y,54);
  doc.setFont("helvetica","bold");doc.setFontSize(13);pdfRgb(doc,pdfColor.pine);
  doc.text(title,40,y);
  pdfStroke(doc,pdfColor.line);doc.setLineWidth(.8);doc.line(40,y+9,555,y+9);
  return y+28;
};
const pdfMetricCard=(doc,x,y,w,label,value,accent=pdfColor.lime)=>{
  pdfFill(doc,[255,255,255]);pdfStroke(doc,[207,223,213]);
  doc.roundedRect(x,y,w,54,8,8,"FD");
  pdfFill(doc,accent);doc.roundedRect(x,y,5,54,8,8,"F");
  doc.setFont("helvetica","bold");doc.setFontSize(13);pdfRgb(doc,pdfColor.ink);
  pdfFitText(doc,value,x+14,y+22,w-22,{size:13,minSize:8});
  doc.setFont("helvetica","normal");doc.setFontSize(8);pdfRgb(doc,pdfColor.muted);
  const labelLines=doc.splitTextToSize(String(label),w-22).slice(0,2);
  doc.text(labelLines,x+14,y+38);
};
const pdfProgress=(doc,x,y,w,label,value,detail,accent=pdfColor.lime2)=>{
  const score=pct(value);
  doc.setFont("helvetica","bold");doc.setFontSize(9);pdfRgb(doc,pdfColor.ink);
  doc.text(label,x,y);
  doc.setFont("helvetica","normal");doc.setFontSize(8);pdfRgb(doc,pdfColor.muted);
  doc.text(`${score}/100`,x+w-38,y);
  pdfFill(doc,[235,242,238]);doc.roundedRect(x,y+8,w,7,3,3,"F");
  pdfFill(doc,accent);doc.roundedRect(x,y+8,Math.max(5,w*score/100),7,3,3,"F");
  pdfRgb(doc,pdfColor.muted);doc.text(detail,x,y+28,{maxWidth:w});
};
const pdfPill=(doc,x,y,label,color=pdfColor.lime2)=>{
  pdfFill(doc,[241,247,239]);pdfStroke(doc,[216,229,220]);
  doc.roundedRect(x,y,112,24,7,7,"FD");
  pdfFill(doc,color);doc.circle(x+13,y+12,4,"F");
  doc.setFont("helvetica","bold");doc.setFontSize(8);pdfRgb(doc,pdfColor.ink);
  const lines=doc.splitTextToSize(String(label),82).slice(0,2);
  doc.text(lines,x+24,y+10);
};
const pdfTrendFallback=(doc,d,x,y,w,h)=>{
  const rows=d.trend||[];
  pdfFill(doc,[255,255,255]);pdfStroke(doc,pdfColor.line);doc.roundedRect(x,y,w,h,8,8,"FD");
  if(!rows.length){pdfRgb(doc,pdfColor.muted);doc.text("No trend data available.",x+18,y+42);return;}
  const maxCal=Math.max(1,...rows.map(r=>num(r.calories)),...rows.map(r=>num(r.calories_burned)));
  const barW=Math.max(5,(w-40)/Math.max(rows.length,1)-4);
  rows.forEach((row,i)=>{
    const bx=x+20+i*(barW+4);
    const calH=(h-42)*num(row.calories)/maxCal;
    const burnH=(h-42)*num(row.calories_burned)/maxCal;
    pdfFill(doc,pdfColor.pine);doc.rect(bx,y+h-24-calH,barW/2,calH,"F");
    pdfFill(doc,pdfColor.sky);doc.rect(bx+barW/2+1,y+h-24-burnH,barW/2,burnH,"F");
  });
  pdfRgb(doc,pdfColor.muted);doc.setFontSize(7);doc.text("Calories vs calories burned",x+18,y+h-9);
};
const exportDashboardPdf=async()=>{
  const d=latestDashboard||await loadDashboard();
  if(!d){toast("Report unavailable");return;}
  const jsPDF=window.jspdf?.jsPDF;
  if(!jsPDF){toast("PDF tools are still loading");return;}
  const doc=new jsPDF({unit:"pt",format:"a4"});
  if(!doc.autoTable){toast("PDF table tools are still loading");return;}
  const food=d.food||{daily_avg:{},top_foods:[]};
  const movement=d.movement||{};
  const targets=d.targets||{};
  const period=d.period?.label||"Selected period";
  const scoreColor=pdfScoreColor(d.score);
  pdfFill(doc,pdfColor.pineDark);doc.roundedRect(30,28,535,178,12,12,"F");
  pdfFill(doc,pdfColor.lime);doc.rect(30,202,178,4,"F");
  pdfFill(doc,pdfColor.sky);doc.rect(208,202,178,4,"F");
  pdfFill(doc,pdfColor.amber);doc.rect(386,202,179,4,"F");
  pdfStroke(doc,[72,104,90]);doc.setLineWidth(12);doc.circle(110,116,54,"S");
  pdfStroke(doc,scoreColor);doc.setLineWidth(12);doc.circle(110,116,54,"S");
  doc.setFont("helvetica","bold");doc.setFontSize(34);pdfRgb(doc,[255,255,255]);
  doc.text(String(Math.round(d.score||0)),110,111,{align:"center"});
  doc.setFontSize(9);pdfRgb(doc,[202,221,211]);doc.text(String(d.band||"VitalScore").toUpperCase(),110,132,{align:"center"});
  doc.setFont("helvetica","bold");doc.setFontSize(24);pdfRgb(doc,[255,255,255]);
  doc.text(dashboardPeriod==="month"?"Your month, summarized.":"Your week, summarized.",200,74);
  doc.setFont("helvetica","normal");doc.setFontSize(11);pdfRgb(doc,[210,230,220]);
  doc.text(`${period}: meals, movement and risk signals scored transparently.`,200,96,{maxWidth:325});
  pdfMetricCard(doc,200,118,78,"kcal/day",food.daily_avg.calories||0,pdfColor.lime);
  pdfMetricCard(doc,286,118,78,"active min",movement.active_minutes||0,pdfColor.sky);
  pdfMetricCard(doc,372,118,78,"sugar/day",`${food.daily_avg.sugar_g||0}g`,pdfColor.amber);
  pdfMetricCard(doc,458,118,78,"sodium/day",`${food.daily_avg.sodium_mg||0}mg`,pdfColor.coral);
  let y=234;
  y=pdfSection(doc,"Food intelligence",y);
  pdfProgress(doc,42,y,150,"Calories balance",d.components?.calories||0,`${food.daily_avg.calories||0}/${round(targets.calories_per_day,0)} kcal`,pdfColor.lime2);
  pdfProgress(doc,222,y,150,"Sugar control",d.components?.sugar||0,`${food.daily_avg.sugar_g||0}/${round(targets.sugar_g_per_day,0)} g`,pdfColor.amber);
  pdfProgress(doc,402,y,130,"Sodium control",d.components?.sodium||0,`${food.daily_avg.sodium_mg||0}/${round(targets.sodium_mg_per_day,0)} mg`,pdfColor.coral);
  y+=76;
  y=pdfSection(doc,"Movement intelligence",y);
  pdfProgress(doc,42,y,150,"Activity target",d.components?.activity||0,`${movement.active_minutes||0} active min`,pdfColor.sky);
  pdfProgress(doc,222,y,150,"Workout consistency",d.components?.consistency||0,`${movement.workouts||0} workouts`,pdfColor.lime2);
  pdfProgress(doc,402,y,130,"Calorie burn",Math.min(100,Math.round(num(movement.calories_burned)/1200*100)),`${movement.calories_burned||0} cal`,pdfColor.amber);
  y+=76;
  y=pdfSection(doc,"Trend graph",y);
  try{
    const canvas=$("trendChart");
    if(canvas){
      const img=canvas.toDataURL("image/png",1);
      pdfFill(doc,[255,255,255]);pdfStroke(doc,pdfColor.line);doc.roundedRect(40,y,515,158,8,8,"FD");
      const frame={x:56,y:y+16,w:483,h:112};
      const canvasRatio=canvas.width&&canvas.height?canvas.width/canvas.height:frame.w/frame.h;
      const frameRatio=frame.w/frame.h;
      let drawW=frame.w;
      let drawH=frame.h;
      if(canvasRatio>frameRatio){
        drawH=frame.w/canvasRatio;
      }else{
        drawW=frame.h*canvasRatio;
      }
      doc.addImage(img,"PNG",frame.x+(frame.w-drawW)/2,frame.y+(frame.h-drawH)/2,drawW,drawH);
      doc.setFont("helvetica","bold");doc.setFontSize(9);pdfRgb(doc,pdfColor.ink);
      doc.text("Trend - calories, calories burned and active minutes",56,y+142);
    }else{
      pdfTrendFallback(doc,d,40,y,515,158);
    }
  }catch{
    pdfTrendFallback(doc,d,40,y,515,158);
  }
  y+=190;
  y=pdfSection(doc,"Day log markers",y);
  (d.day_log||[]).slice(0,14).forEach((row,i)=>{
    const x=42+(i%7)*72;
    const yy=y+Math.floor(i/7)*46;
    const color=row.status==="elevated"?pdfColor.coral:row.status==="watch"?pdfColor.amber:row.status==="healthy"?pdfColor.lime2:pdfColor.line;
    pdfFill(doc,color);doc.circle(x,yy,5,"F");
    doc.setFont("helvetica","bold");doc.setFontSize(8);pdfRgb(doc,pdfColor.ink);doc.text(fmtDate(row.date),x+10,yy+3);
    doc.setFont("helvetica","normal");doc.setFontSize(7);pdfRgb(doc,pdfColor.muted);doc.text(`${row.calories} kcal | ${row.active_min} min`,x+10,yy+14,{maxWidth:58});
  });
  doc.addPage();
  doc.setFont("helvetica","bold");doc.setFontSize(18);pdfRgb(doc,pdfColor.pine);
  doc.text("Detailed tabular data",40,48);
  doc.setFont("helvetica","normal");doc.setFontSize(9);pdfRgb(doc,pdfColor.muted);
  doc.text("The following tables contain the source metrics used in the report visuals.",40,66);
  const options={theme:"grid",styles:{fontSize:8,cellPadding:5,textColor:pdfColor.ink},headStyles:{fillColor:pdfColor.pine,textColor:255},alternateRowStyles:{fillColor:pdfColor.soft},margin:{left:40,right:40}};
  doc.autoTable({
    ...options,
    startY:88,
    head:[["Metric","Value"]],
    body:[
      ["Average calories/day",`${food.daily_avg.calories||0} kcal`],
      ["Active minutes",`${movement.active_minutes||0} min`],
      ["Sugar/day",`${food.daily_avg.sugar_g||0} g`],
      ["Sodium/day",`${food.daily_avg.sodium_mg||0} mg`],
      ["Days logged",`${food.days_logged||0}/${d.period?.days||7}`],
    ],
  });
  doc.autoTable({
    ...options,
    startY:doc.lastAutoTable.finalY+18,
    head:[["Food metric","Current","Target"]],
    body:[
      ["Calories/day",`${food.daily_avg.calories||0} kcal`,`${round(targets.calories_per_day,0)} kcal`],
      ["Protein/day",`${food.daily_avg.protein_g||0} g`,`${round(targets.protein_g_per_day,0)} g`],
      ["Carbs/day",`${food.daily_avg.carbs_g||0} g`,"-"],
      ["Sugar/day",`${food.daily_avg.sugar_g||0} g`,`${round(targets.sugar_g_per_day,0)} g max`],
      ["Fiber/day",`${food.daily_avg.fiber_g||0} g`,`${round(targets.fiber_g_per_day,0)} g`],
      ["Sodium/day",`${food.daily_avg.sodium_mg||0} mg`,`${round(targets.sodium_mg_per_day,0)} mg max`],
      ["Meals logged",food.meal_count||0,"-"],
    ],
  });
  doc.autoTable({
    ...options,
    startY:doc.lastAutoTable.finalY+18,
    head:[["Movement metric","Current","Target"]],
    body:[
      ["Active minutes",`${movement.active_minutes||0} min`,`${round(targets.activity_minutes_for_period||targets.activity_min_per_week,0)} min`],
      ["Steps",movement.steps||0,`${round(num(targets.steps_per_day)*(d.period?.days||7),0)} steps`],
      ["Workouts",movement.workouts||0,"-"],
      ["Calories burned",movement.calories_burned||0,`${round(num(targets.calories_burned_per_week)*(d.period?.days||7)/7,0)}`],
      ["Distance",fmtDistance(movement.distance_m||0),fmtDistance(num(targets.distance_m_per_week)*(d.period?.days||7)/7)],
      ["Average heart rate",movement.average_heartrate?`${movement.average_heartrate} bpm`:"-","-"],
    ],
  });
  doc.autoTable({
    ...options,
    startY:doc.lastAutoTable.finalY+18,
    head:[["Component","Score","Status"]],
    body:componentRows(d.components),
  });
  const comparisons=comparisonRows(d.comparisons);
  doc.autoTable({
    ...options,
    startY:doc.lastAutoTable.finalY+18,
    head:[["Comparison","Metric","Current","Baseline","Change"]],
    body:comparisons.length?comparisons:[["-","Insufficient comparison data","-","-","-"]],
  });
  doc.autoTable({
    ...options,
    startY:doc.lastAutoTable.finalY+18,
    head:[["Date","Calories","Active min","Steps","Meals","Activities","Notes"]],
    body:(d.day_log||[]).map(row=>[
      tableValue(row.date),
      tableValue(row.calories),
      tableValue(row.active_min),
      tableValue(row.steps),
      tableValue(row.meals),
      tableValue(row.activities),
      tableValue([...(row.meal_names||[]),...(row.activity_names||[])].slice(0,3).join(" / ")),
    ]),
  });
  doc.save(`VitalLens-report-${toIsoDate(dashboardAnchor)}.pdf`);
};

const setTargetForm=targets=>{
  if(!$("targetCalories"))return;
  $("targetCalories").value=round(targets.calories_per_day,0);
  $("targetSugar").value=round(targets.sugar_g_per_day,0);
  $("targetSodium").value=round(targets.sodium_mg_per_day,0);
  $("targetProtein").value=round(targets.protein_g_per_day,0);
  $("targetFiber").value=round(targets.fiber_g_per_day,0);
  $("targetActive").value=round(targets.activity_min_per_week,0);
  $("targetSteps").value=round(targets.steps_per_day,0);
  $("targetBurn").value=round(targets.calories_burned_per_week,0);
};

const collectTargets=()=>({
  calories_per_day:num($("targetCalories").value),
  sugar_g_per_day:num($("targetSugar").value),
  sodium_mg_per_day:num($("targetSodium").value),
  protein_g_per_day:num($("targetProtein").value),
  fiber_g_per_day:num($("targetFiber").value),
  activity_min_per_week:num($("targetActive").value),
  steps_per_day:num($("targetSteps").value),
  calories_burned_per_week:num($("targetBurn").value),
  distance_m_per_week:num(latestDashboard?.targets?.distance_m_per_week||15000),
});

const renderFocusDashboards=d=>{
  latestDashboard=d;
  const food=d.food||{daily_avg:{},meal_count:0};
  const movement=d.movement||{};
  const targets=d.targets||{};
  const periodDays=d.period?.days||7;
  if($("mealFocusStats")){
    const foodMeters=[
      ["Calories",calorieBalance(num(food.daily_avg.calories),num(targets.calories_per_day)),`${food.daily_avg.calories||0}/${round(targets.calories_per_day,0)} kcal`],
      ["Sugar",goalProgress(num(food.daily_avg.sugar_g),num(targets.sugar_g_per_day),true),`${food.daily_avg.sugar_g||0}/${round(targets.sugar_g_per_day,0)}g`],
      ["Sodium",goalProgress(num(food.daily_avg.sodium_mg),num(targets.sodium_mg_per_day),true),`${food.daily_avg.sodium_mg||0}/${round(targets.sodium_mg_per_day,0)}mg`],
      ["Protein",goalProgress(num(food.daily_avg.protein_g),num(targets.protein_g_per_day)),`${food.daily_avg.protein_g||0}/${round(targets.protein_g_per_day,0)}g`],
      ["Fiber",goalProgress(num(food.daily_avg.fiber_g),num(targets.fiber_g_per_day)),`${food.daily_avg.fiber_g||0}/${round(targets.fiber_g_per_day,0)}g`],
    ];
    const foodScore=Math.round(foodMeters.reduce((sum,item)=>sum+item[1],0)/foodMeters.length)||0;
    setFocusRing("meal",foodScore);
    $("mealFocusSub").textContent=`${d.period?.label||"Selected period"} nutrition progress against your daily food targets.`;
    $("mealFocusStats").innerHTML=[
      [food.daily_avg.calories||0,"kcal/day","calories"],
      [`${food.daily_avg.sugar_g||0}g`,"sugar/day","sugar"],
      [`${food.daily_avg.sodium_mg||0}mg`,"sodium/day","sodium"],
      [`${food.daily_avg.protein_g||0}g`,"protein/day","protein"],
      [`${food.meal_count||0}`,"meals logged","calories"],
    ].map(([v,l,i])=>focusStat(v,l,i)).join("");
    $("mealFocusBalance").innerHTML=foodMeters.slice(0,3).map(([label,value,detail])=>miniMeter(label,value,detail)).join("");
  }
  if($("activityFocusStats")){
    const stepTarget=num(targets.steps_per_day)*periodDays;
    const burnTarget=num(targets.calories_burned_per_week)*periodDays/7;
    const distanceTarget=num(targets.distance_m_per_week)*periodDays/7;
    const movementMeters=[
      ["Active min",goalProgress(num(movement.active_minutes),num(targets.activity_minutes_for_period||targets.activity_min_per_week)),`${movement.active_minutes||0}/${round(targets.activity_minutes_for_period||targets.activity_min_per_week,0)} min`],
      ["Steps",goalProgress(num(movement.steps),stepTarget),`${movement.steps||0}/${round(stepTarget,0)} steps`],
      ["Burn",goalProgress(num(movement.calories_burned),burnTarget),`${movement.calories_burned||0}/${round(burnTarget,0)} cal`],
      ["Distance",goalProgress(num(movement.distance_m),distanceTarget),`${fmtDistance(movement.distance_m||0)} / ${fmtDistance(distanceTarget)}`],
    ];
    const movementScore=Math.round(movementMeters.reduce((sum,item)=>sum+item[1],0)/movementMeters.length)||0;
    setFocusRing("activity",movementScore);
    $("activityFocusSub").textContent=`${d.period?.label||"Selected period"} movement progress from workouts, steps and synced activity.`;
    $("activityFocusStats").innerHTML=[
      [movement.active_minutes||0,"active min","active"],
      [movement.steps||0,"steps","steps"],
      [movement.workouts||0,"workouts","workout"],
      [movement.calories_burned||0,"cal burned","burn"],
      [movement.average_heartrate?`${movement.average_heartrate} bpm`:"-","avg heart rate","heart"],
    ].map(([v,l,i])=>focusStat(v,l,i)).join("");
    $("activityFocusBalance").innerHTML=movementMeters.slice(0,3).map(([label,value,detail])=>miniMeter(label,value,detail)).join("");
  }
};

async function loadDashboard(withInsight=false){
  try{
    $("periodWeek").classList.toggle("active",dashboardPeriod==="week");
    $("periodMonth").classList.toggle("active",dashboardPeriod==="month");
    if($("periodDate")&&$("periodDate").value!==toIsoDate(dashboardAnchor))$("periodDate").value=toIsoDate(dashboardAnchor);
    const sp=new URLSearchParams({period:dashboardPeriod,anchor:toIsoDate(dashboardAnchor)});
    if(withInsight)sp.set("insight","true");
    const d=await api(`/api/dashboard?${sp.toString()}`);
    latestDashboard=d;
    setTargetForm(d.targets||{});
    animateNumber($("scoreNum"),d.score);$("scoreBand").textContent=d.band;
    $("periodLabel").textContent=d.period?.label||"Current period";
    $("dashboardTitle").textContent=dashboardPeriod==="month"?"Your month, decoded.":"Your week, decoded.";
    $("dashboardSub").textContent=`${d.period?.label||"Selected period"}: food intake, movement and risk signals scored transparently.`;
    const ring=$("ringFg");
    ring.style.strokeDashoffset=540-(540*d.score)/100;
    ring.style.stroke=d.score>=60?"var(--lime)":d.score>=40?"var(--amber)":"var(--coral)";
    const food=d.food||{daily_avg:{},top_foods:[]};
    const movement=d.movement||{};
    $("weeklyStats").innerHTML=[
      [food.daily_avg.calories||0,"avg kcal/day"],
      [movement.active_minutes||0,"active min"],
      [`${food.daily_avg.sugar_g||0}g`,"sugar/day"],
      [`${food.daily_avg.sodium_mg||0}mg`,"sodium/day"],
      [`${food.days_logged||0}/${d.period?.days||7}`,"days logged"],
    ].map(([v,l])=>`<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");
    $("foodMetrics").innerHTML=renderMetricGrid([
      {value:`${food.daily_avg.calories||0}`,label:"kcal/day"},
      {value:`${food.daily_avg.protein_g||0}g`,label:"protein/day"},
      {value:`${food.daily_avg.fiber_g||0}g`,label:"fiber/day"},
      {value:`${food.meal_count||0}`,label:"meals logged"},
    ]);
    $("foodBalance").innerHTML=[
      meter("Calories balance",d.components?.calories||0,`${food.daily_avg.calories||0} kcal/day`),
      meter("Sugar control",d.components?.sugar||0,`${food.daily_avg.sugar_g||0}g/day`),
      meter("Sodium control",d.components?.sodium||0,`${food.daily_avg.sodium_mg||0}mg/day`),
      meter("Protein coverage",d.components?.protein||0,`${food.daily_avg.protein_g||0}g/day`),
      meter("Fiber coverage",Math.min(100,Math.round(num(food.daily_avg.fiber_g)/25*100)),`${food.daily_avg.fiber_g||0}g/day`),
    ].join("");
    $("topFoods").innerHTML=renderMiniList("Top logged foods",(food.top_foods||[]).map(f=>({label:f.name,value:`${f.count}x` })));
    $("movementMetrics").innerHTML=renderMetricGrid([
      {value:`${movement.active_minutes||0}`,label:"active minutes"},
      {value:`${movement.workouts||0}`,label:"workouts"},
      {value:`${movement.calories_burned||0}`,label:"cal burned"},
      {value:movement.average_heartrate?`${movement.average_heartrate} bpm`:"-",label:"avg heart rate"},
    ]);
    $("movementBalance").innerHTML=[
      meter("Activity target",d.components?.activity||0,`${movement.active_minutes||0} active min`),
      meter("Workout consistency",d.components?.consistency||0,`${d.weekly?.days_logged||0} logged days`),
      meter("Calorie burn",Math.min(100,Math.round(num(movement.calories_burned)/1200*100)),`${movement.calories_burned||0} cal`),
      meter("Distance coverage",Math.min(100,Math.round(num(movement.distance_m)/15000*100)),fmtDistance(movement.distance_m||0)),
    ].join("");
    $("movementBreakdown").innerHTML=renderMiniList("Movement mix",(movement.type_breakdown||[]).map(t=>({label:t.type,value:`${t.minutes} min`})));
    renderFocusDashboards(d);
    $("signals").innerHTML=renderSignals(d.signals);
    $("components").innerHTML=renderComponents(d.components);
    $("comparisonRows").innerHTML=renderComparisons(d.comparisons);
    $("trendTitle").textContent=`${d.period?.label||"Period"} trend - intake vs movement`;
    $("dayLog").innerHTML=renderDayLog(d.day_log);
    trendChart?.destroy();
    const palette=chartPalette();
    trendChart=new Chart($("trendChart"),{
      data:{
        labels:(d.trend||[]).map(t=>t.date.slice(5)),
        datasets:[
          {type:"bar",label:"Calories",data:(d.trend||[]).map(t=>Math.round(t.calories)),backgroundColor:palette.calories,borderColor:palette.caloriesBorder,borderWidth:1,borderRadius:6,yAxisID:"y"},
          {type:"bar",label:"Calories burned",data:(d.trend||[]).map(t=>Math.round(t.calories_burned||0)),backgroundColor:palette.burn,borderColor:palette.burnBorder,borderWidth:1,borderRadius:6,yAxisID:"y"},
          {type:"line",label:"Active minutes",data:(d.trend||[]).map(t=>t.active_min),borderColor:palette.active,backgroundColor:palette.active,borderWidth:3,pointRadius:4,pointHoverRadius:5,tension:.3,yAxisID:"y1"},
        ],
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        plugins:{
          legend:{labels:{color:Chart.defaults.color,font:{weight:"700",size:12},boxWidth:14,boxHeight:10}},
          tooltip:{backgroundColor:"#0d3b2e",titleColor:"#fff",bodyColor:"#fff",padding:10}
        },
        scales:{
          y:{position:"left",ticks:{color:Chart.defaults.color,font:{weight:"700"}},grid:{color:Chart.defaults.borderColor,lineWidth:1.2}},
          y1:{position:"right",ticks:{color:Chart.defaults.color,font:{weight:"700"}},grid:{display:false}},
          x:{ticks:{color:Chart.defaults.color,font:{weight:"700"}},grid:{color:Chart.defaults.borderColor,lineWidth:1.2}},
        },
      },
    });
    if(d.insight){$("insightCard").hidden=false;$("insightText").textContent=d.insight_note?`${d.insight}\n\n${d.insight_note}`:d.insight;}
    _stravaConnected=!!d.strava_connected;
    $("stravaStatus").textContent=d.strava_connected?`Strava connected${d.strava_last_sync_at?" - last sync "+new Date(d.strava_last_sync_at).toLocaleString():""}`:"";
    $("btnStrava").textContent=d.strava_connected?"Re-sync Strava":"Connect Strava";
    return d;
  }catch(e){toast("Dashboard: "+e.message);return null;}
}

$("periodWeek").addEventListener("click",()=>{dashboardPeriod="week";loadDashboard();});
$("periodMonth").addEventListener("click",()=>{dashboardPeriod="month";loadDashboard();});
$("periodDate").addEventListener("change",e=>{dashboardAnchor=parseIsoDate(e.target.value);loadDashboard();});
$("prevPeriod").addEventListener("click",()=>{dashboardAnchor.setDate(dashboardAnchor.getDate()+(dashboardPeriod==="week"?-7:0));if(dashboardPeriod==="month")dashboardAnchor.setMonth(dashboardAnchor.getMonth()-1);loadDashboard();});
$("nextPeriod").addEventListener("click",()=>{dashboardAnchor.setDate(dashboardAnchor.getDate()+(dashboardPeriod==="week"?7:0));if(dashboardPeriod==="month")dashboardAnchor.setMonth(dashboardAnchor.getMonth()+1);loadDashboard();});
$("btnExportPdf").addEventListener("click",async()=>{const b=$("btnExportPdf");b.disabled=true;b.textContent="Exporting...";try{await exportDashboardPdf();}catch(e){toast("Export failed: "+e.message);}b.disabled=false;b.textContent="Export PDF";});
$("themeToggle").addEventListener("click",()=>setTheme(document.body.dataset.theme==="dark"?"light":"dark"));
$("brandHome").addEventListener("click",()=>{activateTab("dashboard");window.scrollTo({top:0,behavior:"smooth"});});

$("btnInsight").addEventListener("click",async()=>{const b=$("btnInsight");b.disabled=true;b.textContent="Gemini is thinking...";await loadDashboard(true);b.disabled=false;b.textContent="Generate AI weekly insight";});
$("btnSeed").addEventListener("click",async()=>{
  const b=$("btnSeed");
  b.disabled=true;b.textContent="Loading demo...";
  try{
    const res=await api("/api/demo/seed",{method:"POST"});
    toast(`Demo loaded: ${res.label} (${res.score}, ${res.band})`);
    dashboardAnchor=new Date();
    await loadDashboard();
    if(document.body.dataset.activeTab==="meal")await loadMeals();
    if(document.body.dataset.activeTab==="activity")await loadActivities();
  }catch(e){toast("Demo failed: "+e.message);}
  b.disabled=false;b.textContent="Load demo week";
});

$("btnSaveTargets").addEventListener("click",async()=>{
  const b=$("btnSaveTargets");
  b.disabled=true;
  try{
    await api("/api/targets",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(collectTargets())});
    toast("Targets updated");
    await loadDashboard();
  }catch(e){toast("Targets failed: "+e.message);}
  b.disabled=false;
});

let lastAnalysis=null;
let lastAnalysisSource="photo";
let mealAnalysisMode="text";
let selectedMealFile=null;
let previewUrl=null;
const MAX_UPLOAD_BYTES=7_500_000;
const MAX_IMAGE_DIMENSION=1600;
const drop=$("drop");
const mealImage=$("mealImage");
const mealForm=document.querySelector(".meal-form");

const setMealInputMode=mode=>{
  mealAnalysisMode=mode==="text"?"text":"photo";
  lastAnalysis=null;
  $("analysisResult").hidden=true;
  $("mealPhotoMode").classList.toggle("active",mealAnalysisMode==="photo");
  $("mealTextMode").classList.toggle("active",mealAnalysisMode==="text");
  mealForm.classList.toggle("text-mode",mealAnalysisMode==="text");
  drop.setAttribute("aria-hidden",mealAnalysisMode==="text"?"true":"false");
  if(mealAnalysisMode==="text"&&selectedMealFile)resetMealUpload(false);
  $("portionNote").placeholder=mealAnalysisMode==="text"
    ?"Type what you ate, e.g. '2 rotis, small bowl dal, half cup rice'"
    :"Add portion details, e.g. '2 rotis, small bowl dal'";
};

const setMealFile=file=>{
  if(!file)return;
  if(!file.type?.startsWith("image/")){toast("Choose an image file");return;}
  selectedMealFile=file;lastAnalysis=null;$("analysisResult").hidden=true;drop.classList.add("has-file");
  if(previewUrl)URL.revokeObjectURL(previewUrl);
  previewUrl=URL.createObjectURL(file);
  $("preview").src=previewUrl;$("preview").hidden=false;$("dropText").hidden=true;
};
const resetMealUpload=(clearNote=true)=>{
  selectedMealFile=null;mealImage.value="";
  if(previewUrl)URL.revokeObjectURL(previewUrl);
  previewUrl=null;$("preview").src="";$("preview").hidden=true;$("dropText").hidden=false;drop.classList.remove("has-file");
  if(clearNote)$("portionNote").value="";
};
const loadImage=file=>new Promise((resolve,reject)=>{
  const img=new Image();const url=URL.createObjectURL(file);
  img.onload=()=>{URL.revokeObjectURL(url);resolve(img);};
  img.onerror=()=>{URL.revokeObjectURL(url);reject(new Error("Could not read this image. Try a JPG, PNG, or WebP photo."));};
  img.src=url;
});
const prepareImageForUpload=async file=>{
  if(file.size<=MAX_UPLOAD_BYTES)return file;
  const img=await loadImage(file);
  const scale=Math.min(1,MAX_IMAGE_DIMENSION/Math.max(img.naturalWidth,img.naturalHeight));
  const canvas=document.createElement("canvas");
  canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
  canvas.getContext("2d").drawImage(img,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",0.82));
  if(!blob)throw new Error("Could not prepare this image for upload");
  const name=(file.name||"meal-photo").replace(/\.[^.]+$/,"")+".jpg";
  const prepared=new File([blob],name,{type:"image/jpeg"});
  if(prepared.size>MAX_UPLOAD_BYTES)throw new Error("Image is still too large after compression. Try a smaller photo.");
  return prepared;
};

$("mealPhotoMode").addEventListener("click",()=>setMealInputMode("photo"));
$("mealTextMode").addEventListener("click",()=>setMealInputMode("text"));
drop.addEventListener("click",e=>{if(mealAnalysisMode==="photo"&&e.target!==mealImage){mealImage.value="";mealImage.click();}});
drop.addEventListener("keydown",e=>{if(mealAnalysisMode==="photo"&&(e.key==="Enter"||e.key===" ")){e.preventDefault();mealImage.value="";mealImage.click();}});
mealImage.addEventListener("change",()=>setMealFile(mealImage.files[0]));
["dragenter","dragover"].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();if(mealAnalysisMode==="photo")drop.classList.add("dragover");}));
["dragleave","drop"].forEach(type=>drop.addEventListener(type,e=>{e.preventDefault();drop.classList.remove("dragover");}));
drop.addEventListener("drop",e=>{if(mealAnalysisMode==="photo")setMealFile(e.dataTransfer.files[0]);});

$("btnAnalyze").addEventListener("click",async()=>{
  const note=$("portionNote").value.trim();
  if(!selectedMealFile&&!note)return toast("Add a meal photo or type what you ate");
  const b=$("btnAnalyze");b.disabled=true;b.textContent=selectedMealFile?"Preparing image...":"Gemini is reading...";
  try{
    b.textContent="Gemini is analyzing...";
    if(selectedMealFile){
      const uploadFile=await prepareImageForUpload(selectedMealFile);
      const fd=new FormData();fd.append("image",uploadFile,uploadFile.name);fd.append("portion_note",note);
      lastAnalysis=await api("/api/meals/analyze",{method:"POST",body:fd});
      lastAnalysisSource="photo";
    }else{
      lastAnalysis=await api("/api/meals/analyze-text",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({portion_note:note})});
      lastAnalysisSource="text";
    }
    renderAnalysis(lastAnalysis);
  }catch(e){toast("Analysis failed: "+e.message);}
  b.disabled=false;b.textContent="Analyze with Gemini";
});

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
  const body={meal_guess:lastAnalysis.meal_guess||"meal",portion_note:$("portionNote").value.trim(),source:lastAnalysisSource,confidence:Number(lastAnalysis.confidence||0),health_notes:lastAnalysis.health_notes||[],items:lastAnalysis.items||[],...(lastAnalysis.totals||{})};
  await api("/api/meals",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  toast("Meal saved to recent meals");
  $("analysisResult").hidden=true;lastAnalysis=null;resetMealUpload();
  await loadMeals();loadDashboard();$("mealList").scrollIntoView({behavior:"smooth",block:"start"});
});

setMealInputMode("text");

const renderMealItem=item=>`
  <div class="meal-log-item">
    <div><b>${escapeHtml(item.name||"Food item")}</b><span>${escapeHtml(item.portion||"Estimated serving")}</span></div>
    <div class="meal-item-nutrients">
      <span>${fmtNutrition(item,"calories",0)} kcal</span><span>${fmtNutrition(item,"carbs_g",1)}g carbs</span><span>${fmtNutrition(item,"protein_g",1)}g protein</span><span>${fmtNutrition(item,"fiber_g",1)}g fiber</span>
    </div>
  </div>
`;

const mealById=id=>lastMeals.find(m=>m.id===id);
const itemEditRow=(item={})=>`
  <div class="meal-edit-row">
    <input name="name" type="text" value="${escapeHtml(item.name||"")}" placeholder="Food item"/>
    <input name="portion" type="text" value="${escapeHtml(item.portion||"")}" placeholder="Serving"/>
    ${nutritionFields.map(([key,_unit,label])=>`<input name="${key}" type="number" step="0.1" value="${escapeHtml(numberValue(item,key)||"")}" placeholder="${label}"/>`).join("")}
    <button class="btn small remove-item" type="button">Remove</button>
  </div>
`;
const renderMealEdit=meal=>`
  <article class="meal-log editing">
    <form class="meal-edit-form" data-id="${escapeHtml(meal.id)}">
      <div class="edit-head"><h4>Edit meal</h4><div><button class="btn small recalc-meal" type="button">Recalculate totals</button><button class="btn small cancel-meal" type="button">Cancel</button><button class="btn primary small save-meal" type="button">Save</button></div></div>
      <div class="form-grid">
        <input name="date" type="date" value="${escapeHtml(meal.date||todayIso())}"/>
        <input name="meal_guess" type="text" value="${escapeHtml(meal.meal_guess||"meal")}" placeholder="Meal label"/>
      </div>
      <input name="portion_note" type="text" value="${escapeHtml(meal.portion_note||"")}" placeholder="Portion note"/>
      <textarea name="health_notes" placeholder="Health notes, one per line">${escapeHtml((meal.health_notes||[]).join("\n"))}</textarea>
      <div class="edit-section-title">Totals</div>
      <div class="totals-edit">${nutritionFields.map(([key,_unit,label])=>`<input name="${key}" type="number" step="0.1" value="${escapeHtml(numberValue(meal,key)||"")}" placeholder="${label}"/>`).join("")}</div>
      <div class="edit-section-title">Items</div>
      <div class="meal-edit-items">${(meal.items&&meal.items.length?meal.items:[{}]).map(itemEditRow).join("")}</div>
      <button class="btn small add-item" type="button">Add item</button>
    </form>
  </article>
`;
const renderMealLog=meal=>{
  if(editingMealId===meal.id)return renderMealEdit(meal);
  const title=meal.items_summary||meal.meal_guess||"Logged meal";
  const confidence=meal.confidence?` - ${Math.round(meal.confidence*100)}% confidence`:"";
  const notes=(meal.health_notes||[]).map(n=>`<li>${escapeHtml(n)}</li>`).join("");
  return `
    <article class="meal-log" data-id="${escapeHtml(meal.id)}">
      <div class="meal-log-head">
        <div><h4>${escapeHtml(title)}</h4><p>${escapeHtml(meal.date||"")} - ${escapeHtml(meal.meal_guess||"meal")}${confidence}</p></div>
        <div class="log-actions"><strong>${fmtNutrition(meal,"calories",0)} kcal</strong><button class="btn small edit-meal" type="button" data-id="${escapeHtml(meal.id)}">Edit</button></div>
      </div>
      ${meal.portion_note?`<p class="portion-note">Portion note: ${escapeHtml(meal.portion_note)}</p>`:""}
      <div class="nutrition-grid">${nutritionGrid(meal)}</div>
      <div class="meal-log-items">${(meal.items||[]).map(renderMealItem).join("")}</div>
      ${notes?`<ul class="meal-log-notes">${notes}</ul>`:""}
    </article>
  `;
};
async function loadMeals(){
  lastMeals=await api("/api/meals?days=45");
  $("mealList").innerHTML=lastMeals.slice(-16).reverse().map(renderMealLog).join("")||"<p class='sub'>No meals logged yet.</p>";
}
const rerenderMeals=()=>$("mealList").innerHTML=lastMeals.slice(-16).reverse().map(renderMealLog).join("")||"<p class='sub'>No meals logged yet.</p>";
const collectMealForm=form=>{
  const data=Object.fromEntries(new FormData(form).entries());
  const items=[...form.querySelectorAll(".meal-edit-row")].map(row=>{
    const item={};
    row.querySelectorAll("input").forEach(input=>{item[input.name]=input.type==="number"?num(input.value):input.value.trim();});
    return item;
  }).filter(item=>item.name||item.portion);
  const body={date:data.date,meal_guess:data.meal_guess||"meal",portion_note:data.portion_note||"",source:mealById(form.dataset.id)?.source||"manual",confidence:num(mealById(form.dataset.id)?.confidence),health_notes:String(data.health_notes||"").split("\n").map(s=>s.trim()).filter(Boolean),items};
  nutritionFields.forEach(([key])=>body[key]=num(data[key]));
  return body;
};
$("mealList").addEventListener("click",async e=>{
  const edit=e.target.closest(".edit-meal");
  if(edit){editingMealId=edit.dataset.id;rerenderMeals();return;}
  if(e.target.closest(".cancel-meal")){editingMealId=null;rerenderMeals();return;}
  if(e.target.closest(".add-item")){e.target.closest(".meal-edit-form").querySelector(".meal-edit-items").insertAdjacentHTML("beforeend",itemEditRow({}));return;}
  if(e.target.closest(".remove-item")){e.target.closest(".meal-edit-row").remove();return;}
  if(e.target.closest(".recalc-meal")){
    const form=e.target.closest(".meal-edit-form");
    const totals={};nutritionFields.forEach(([key])=>totals[key]=0);
    form.querySelectorAll(".meal-edit-row").forEach(row=>nutritionFields.forEach(([key])=>totals[key]+=num(row.querySelector(`[name="${key}"]`)?.value)));
    nutritionFields.forEach(([key])=>{const input=form.querySelector(`.totals-edit [name="${key}"]`);if(input)input.value=round(totals[key],key==="calories"||key==="sodium_mg"?0:1);});
    return;
  }
  if(e.target.closest(".save-meal")){
    const form=e.target.closest(".meal-edit-form");
    try{
      await api(`/api/meals/${form.dataset.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(collectMealForm(form))});
      toast("Meal updated");editingMealId=null;await loadMeals();await loadDashboard();
    }catch(err){toast("Meal update failed: "+err.message);}
  }
});

const activityById=id=>lastActivities.find(a=>a.id===id);
const paceForActivity=a=>{
  const km=num(a.distance_m)/1000;
  const minutes=num(a.minutes);
  const type=String(a.type||"").toLowerCase();
  if(!km||!minutes)return "";
  if(type.includes("swim"))return `${round(minutes/(num(a.distance_m)/100),1)} min/100m`;
  if(type.includes("cycling")||type.includes("ride"))return `${round(km/(minutes/60),1)} km/h`;
  if(type.includes("run")||type.includes("walk")||type.includes("hike"))return `${round(minutes/km,1)} min/km`;
  return km?`${round(km/(minutes/60),1)} km/h`:"";
};
const activityMetrics=a=>[
  [`${round(a.minutes,1)} min`,"Duration"],
  a.elapsed_minutes&&num(a.elapsed_minutes)!==num(a.minutes)?[`${round(a.elapsed_minutes,1)} min`,"Elapsed"]:null,
  a.calories_burned?[`${round(a.calories_burned,0)} cal`,"Burned"]:null,
  a.distance_m?[fmtDistance(a.distance_m),"Distance"]:null,
  a.steps?[`${round(a.steps,0)}`,"Steps"]:null,
  a.average_heartrate?[`${round(a.average_heartrate,0)} bpm`,"Avg HR"]:null,
  a.max_heartrate?[`${round(a.max_heartrate,0)} bpm`,"Max HR"]:null,
  paceForActivity(a)?[paceForActivity(a),"Pace/speed"]:null,
].filter(Boolean);
const renderActivityCard=a=>{
  if(editingActivityId===a.id)return renderActivityEdit(a);
  const canEdit=a.source!=="strava";
  return `
    <article class="activity-card" data-id="${escapeHtml(a.id)}">
      <div class="activity-head">
        <div><h4>${escapeHtml(a.name||activityTypeLabel(a.type))}</h4><p>${escapeHtml(a.date||"")} - ${escapeHtml(activityTypeLabel(a.type))} - ${escapeHtml(a.source||"manual")} - ${escapeHtml(a.intensity||"moderate")}</p></div>
        ${canEdit?`<button class="btn small edit-activity" type="button" data-id="${escapeHtml(a.id)}">Edit</button>`:"<span class='readonly-tag'>Strava</span>"}
      </div>
      <div class="metric-grid compact">${activityMetrics(a).map(([value,label])=>`<div class="metric"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`).join("")}</div>
      ${a.notes?`<p class="portion-note">${escapeHtml(a.notes)}</p>`:""}
    </article>
  `;
};
const renderActivityEdit=a=>`
  <article class="activity-card editing">
    <form class="activity-edit-form" data-id="${escapeHtml(a.id)}">
      <div class="edit-head"><h4>Edit activity</h4><div><button class="btn small cancel-activity" type="button">Cancel</button><button class="btn primary small save-activity" type="button">Save</button></div></div>
      <input name="name" type="text" value="${escapeHtml(a.name||"")}" placeholder="Workout name"/>
      <div class="form-grid">
        <input name="date" type="date" value="${escapeHtml(a.date||todayIso())}"/>
        ${activityTypeSelect("type","",a.type||"walk")}
        <input name="minutes" type="number" step="0.1" value="${escapeHtml(a.minutes||0)}" placeholder="Minutes"/>
        <select name="intensity"><option value="moderate" ${a.intensity!=="high"?"selected":""}>Moderate</option><option value="high" ${a.intensity==="high"?"selected":""}>High intensity</option></select>
        <input name="calories_burned" type="number" step="1" value="${escapeHtml(a.calories_burned||"")}" placeholder="Calories burned"/>
        <input name="distance_km" type="number" step="0.1" value="${escapeHtml(a.distance_m?round(num(a.distance_m)/1000,2):"")}" placeholder="Distance km"/>
        <input name="steps" type="number" step="100" value="${escapeHtml(a.steps||"")}" placeholder="Steps"/>
        <input name="average_heartrate" type="number" step="1" value="${escapeHtml(a.average_heartrate||"")}" placeholder="Avg HR"/>
        <input name="max_heartrate" type="number" step="1" value="${escapeHtml(a.max_heartrate||"")}" placeholder="Max HR"/>
      </div>
      <input name="notes" type="text" value="${escapeHtml(a.notes||"")}" placeholder="Notes"/>
    </form>
  </article>
`;
const collectActivityForm=form=>{
  const data=Object.fromEntries(new FormData(form).entries());
  const existing=activityById(form.dataset.id)||{};
  return {date:data.date,type:data.type,minutes:num(data.minutes),intensity:data.intensity,source:existing.source||"manual",name:data.name||"",distance_m:num(data.distance_km)*1000||null,calories_burned:num(data.calories_burned)||null,steps:num(data.steps)||null,average_heartrate:num(data.average_heartrate)||null,max_heartrate:num(data.max_heartrate)||null,elapsed_minutes:num(data.minutes),notes:data.notes||""};
};
$("btnSaveAct").addEventListener("click",async()=>{
  const body={type:$("actType").value,minutes:+$("actMin").value,intensity:$("actIntensity").value,name:$("actName").value.trim(),calories_burned:num($("actCalories").value)||null,distance_m:num($("actDistance").value)*1000||null,steps:num($("actSteps").value)||null,average_heartrate:num($("actHr").value)||null,max_heartrate:num($("actMaxHr").value)||null,notes:$("actNotes").value.trim()};
  await api("/api/activities",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  toast("Activity added");
  ["actName","actCalories","actDistance","actSteps","actHr","actMaxHr","actNotes"].forEach(id=>$(id).value="");
  await loadActivities();loadDashboard();
});
async function loadActivities(){
  lastActivities=await api("/api/activities?days=45");
  $("actList").innerHTML=lastActivities.slice(-20).reverse().map(renderActivityCard).join("")||"<p class='sub'>Nothing logged.</p>";
}
const rerenderActivities=()=>$("actList").innerHTML=lastActivities.slice(-20).reverse().map(renderActivityCard).join("")||"<p class='sub'>Nothing logged.</p>";
$("actList").addEventListener("click",async e=>{
  const edit=e.target.closest(".edit-activity");
  if(edit){editingActivityId=edit.dataset.id;rerenderActivities();return;}
  if(e.target.closest(".cancel-activity")){editingActivityId=null;rerenderActivities();return;}
  if(e.target.closest(".save-activity")){
    const form=e.target.closest(".activity-edit-form");
    try{
      await api(`/api/activities/${form.dataset.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(collectActivityForm(form))});
      toast("Activity updated");editingActivityId=null;await loadActivities();await loadDashboard();
    }catch(err){toast("Activity update failed: "+err.message);}
  }
});

$("btnStrava").addEventListener("click",async()=>{
  const b=$("btnStrava");b.disabled=true;
  try{
    if(_stravaConnected){
      b.textContent="Syncing Strava...";
      const res=await api("/api/strava/sync",{method:"POST"});
      toast(`Strava synced ${res.synced} activities`);
      await loadDashboard();await loadActivities();
    }else{
      const{url}=await api("/auth/strava/login");
      location.href=url;return;
    }
  }catch(e){toast(e.message);}
  b.disabled=false;b.textContent=_stravaConnected?"Re-sync Strava":"Connect Strava";
});

const chatHistory=[];
function bubble(role,text){const b=document.createElement("div");b.className="bubble "+(role==="user"?"user":"bot");b.textContent=text;$("chatLog").appendChild(b);$("chatLog").scrollTop=1e6;return b;}
async function sendChat(){const msg=$("chatMsg").value.trim();if(!msg)return;$("chatMsg").value="";bubble("user",msg);const t=bubble("bot","...");try{const{reply}=await api("/api/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:msg,history:chatHistory})});t.textContent=reply;chatHistory.push({role:"user",text:msg},{role:"model",text:reply});}catch(e){t.textContent="Error: "+e.message;}}
$("btnChat").addEventListener("click",sendChat);
$("chatMsg").addEventListener("keydown",e=>e.key==="Enter"&&sendChat());

let wardA,wardR;
async function loadCommunity(){const c=await api("/api/community");$("communityStats").innerHTML=[[c.platform_users,"active users"],[c.median_weekly_active_min+" min","median weekly activity"],[c.median_daily_sodium_mg+" mg","median daily sodium"],[c.median_daily_sugar_g+" g","median daily sugar"]].map(([v,l])=>`<div class="stat"><b>${v}</b><span>${l}</span></div>`).join("");$("communityNote").textContent=c.note;const labels=c.wards.map(w=>w.ward);wardA?.destroy();wardR?.destroy();wardA=new Chart($("wardActive"),{type:"bar",data:{labels,datasets:[{label:"min/week",data:c.wards.map(w=>w.avg_active_min),backgroundColor:"#0E3B2E",borderRadius:6}]},options:{plugins:{legend:{display:false}},scales:{x:{ticks:{color:Chart.defaults.color},grid:{color:Chart.defaults.borderColor}},y:{ticks:{color:Chart.defaults.color},grid:{color:Chart.defaults.borderColor}}}}});wardR=new Chart($("wardRisk"),{type:"bar",data:{labels,datasets:[{label:"%",data:c.wards.map(w=>w.elevated_risk_pct),backgroundColor:"#D95245",borderRadius:6}]},options:{plugins:{legend:{display:false}},scales:{x:{ticks:{color:Chart.defaults.color},grid:{color:Chart.defaults.borderColor}},y:{ticks:{color:Chart.defaults.color},grid:{color:Chart.defaults.borderColor}}}}});}

$("actType").innerHTML=activityTypeOptions.map(([key,label])=>`<option value="${key}">${escapeHtml(label)}</option>`).join("");
initTheme();
initAuth();
