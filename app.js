// app.js — v4.2
// Updates:
// - Today’s Tasks auto-clear on day rollover (no carry-over).
// - Weekly Boss: auto-pick from Library using Settings; resets Monday 00:00 (Sun night). + / – tally controls.
// - Calendar: tap a day to open Day Detail modal (points, coins, habits, tasks, challenges).
// - Stats: new "This Week" card with a 7-bar mini chart.
// - Quick-Add weekday chips fixed (.is-selected) and applied.
// - Manage: dynamic "Recurring Tasks" card to edit/delete weekly rules.

import { loadState, saveState, clearAll, exportJSON, importJSON } from "./db.js";
import { renderBarChart } from "./charts.js";
import { confettiBurst } from "./effects.js";

/* ---------------- Utils ---------------- */
const $ = (s, el=document)=>el.querySelector(s);
const $$ = (s, el=document)=>Array.from(el.querySelectorAll(s));
const fmt = n => new Intl.NumberFormat().format(n);
const uuid = ()=> (crypto.randomUUID ? crypto.randomUUID() : (Math.random().toString(36).slice(2)+Date.now()));
const clamp = (n,min,max)=>Math.max(min,Math.min(max,n));
const isoDay = (d)=>d.toISOString().slice(0,10);
const todayStr = ()=>isoDay(new Date());
const startOfWeekISO = (yyyy_mm_dd)=>{ // Monday start (Sun night reset)
  const d = new Date(yyyy_mm_dd+"T00:00:00");
  const wd = d.getDay(); // 0..6 (Sun..Sat)
  const delta = (wd===0 ? -6 : 1-wd);
  d.setDate(d.getDate()+delta);
  return isoDay(d);
};
const addDaysStr = (yyyy_mm_dd, days)=>{ const d=new Date(yyyy_mm_dd+"T00:00:00"); d.setDate(d.getDate()+days); return isoDay(d); };

function toast(msg){ const t=$("#toast"); if(!t) return; t.textContent=msg; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"), 1800); }
function banner(msg){ const b=$("#banner"); if(!b) return; b.textContent=msg; b.classList.remove("hidden"); requestAnimationFrame(()=>{ b.classList.add("show"); setTimeout(()=>{ b.classList.remove("show"); setTimeout(()=>b.classList.add("hidden"), 260); }, 1200); }); }
function vibrate(ms=40){ try{ if(state.settings.haptics && navigator.vibrate) navigator.vibrate(ms); }catch{} }

/* -------------- Default State -------------- */
function defaultState() {
  return {
    version: 42,
    settings: {
      dailyGoal: 60,
      pointsPerCoin: 100,
      haptics: true,
      resetHour: 0,               // midnight local
      dailyChallengesCount: 3,
      bossTasksPerWeek: 5,
      bossTimesMin: 2,
      bossTimesMax: 5
    },
    profile: { coins: 0, bestStreak: 0 },
    streak: { current: 0 },
    today: {
      day: null,
      points: 0,
      unconvertedPoints: 0,
      lastMilestone: 0,
      habitsStatus: {}
    },
    habits: [],                   // {id,name,type:"binary"|"counter",targetPerDay,pointsOnComplete,active}
    todos: [],                    // {id,name,dueDay,points,done,ruleId?}
    todoRules: [],                // {id,name,points,recurrence:{freq:"weekly",byWeekday:number[]},anchorDay}
    library: [],                  // {id,name,points,cooldownHours?,lastDoneAt?,active}
    challenges: [],
    assigned: {},                 // day -> [challengeIds]
    shop: [],
    powerHour: { active:false, endsAt:null },
    progress: {},                 // day -> { points, coinsEarned, tasksDone, habitsDone, challengesDone }
    logs: [],                     // {ts,type:'habit'|'todo'|'library'|'challenge'|'purchase', id,name, points?, cost?, day}
    weeklyBoss: { weekStartDay:null, goals:[], completed:false },
    economy: { repairsThisMonth: 0 }
  };
}

/* -------------- Migration -------------- */
function migrate(old){
  if (!old) return defaultState();
  if (old.version >= 42) return old;

  // base
  const s = defaultState();

  // carry forward fields safely
  Object.assign(s.settings, old.settings||{});
  s.settings.dailyChallengesCount ??= 3;
  s.settings.bossTasksPerWeek ??= 5;
  s.settings.bossTimesMin ??= 2;
  s.settings.bossTimesMax ??= 5;

  s.profile.coins = old.profile?.coins ?? 0;
  s.profile.bestStreak = old.profile?.bestStreak ?? 0;
  s.streak.current = old.streak?.current ?? 0;

  s.habits = old.habits||[];
  s.todos = (old.todos||[]).map(t=>({ id:t.id||uuid(), name:t.name, dueDay:t.dueDay, points:t.points, done:!!t.done, ruleId:t.ruleId }));
  s.todoRules = (old.todoRules||[]).map(r=>{
    const rec=r.recurrence||{};
    let by=rec.byWeekday;
    if (!by){
      if (rec.freq==="daily") by=[1,2,3,4,5,6,0]; else if(rec.freq==="weekly") by=rec.byWeekday||[]; else by=[];
    }
    return { id:r.id||uuid(), name:r.name, points:r.points, anchorDay:r.anchorDay||old.today?.day||todayStr(), recurrence:{freq:"weekly",byWeekday:by} };
  });

  s.library = old.library||[];
  s.challenges = old.challenges||[];
  s.assigned = old.assigned||{};
  s.shop = old.shop||[];
  s.powerHour = old.powerHour||{active:false,endsAt:null};
  s.progress = old.progress||{};
  s.logs = old.logs||[];

  s.weeklyBoss.weekStartDay = old.weeklyBoss?.weekStartDay || startOfWeekISO(todayStr());
  s.weeklyBoss.goals = (old.weeklyBoss?.goals||[]).map(g=>({ id:g.id||uuid(), label:g.label, target:g.target||0, tally:g.tally||0, linkedTaskIds:g.linkedTaskIds||[] }));
  s.weeklyBoss.completed = !!old.weeklyBoss?.completed;

  s.today.day = old.today?.day===todayStr()? old.today.day : todayStr();
  s.today.points = old.today?.points||0;
  s.today.unconvertedPoints = old.today?.unconvertedPoints||0;
  s.today.lastMilestone = old.today?.lastMilestone||0;
  s.today.habitsStatus = old.today?.habitsStatus||{};

  s.version = 42;
  return s;
}

/* -------------- State -------------- */
let state = null;

/* -------------- Boot -------------- */
window.addEventListener("DOMContentLoaded", init);

async function init(){
  // Header pills
  $("#pillStreak")?.addEventListener("click", ()=> switchView("statsView"));
  $("#pillCoins")?.addEventListener("click", openShopDrawer);

  // Home
  $("#btnAddTodoInline")?.addEventListener("click", ()=> openTodoModal());
  $("#btnOverdueToggle")?.addEventListener("click", ()=> $("#overdueBlock")?.classList.toggle("hidden"));
  $("#btnAddHabit")?.addEventListener("click", ()=> openHabitModal());

  // Manage
  $("#btnAddTask").addEventListener("click", ()=> openLibraryModal());
  $("#btnAddChallenge").addEventListener("click", ()=> openChallengeModal());
  $("#btnAddShop").addEventListener("click", ()=> openShopItemModal());

  // Preferences
  $("#inpDailyGoal").addEventListener("change", onPrefChange);
  $("#inpPPC").addEventListener("change", onPrefChange);
  $("#chkHaptics").addEventListener("change", onPrefChange);
  $("#inpChallengesCount").addEventListener("change", onPrefChange);
  $("#inpBossTasksPerWeek").addEventListener("change", onPrefChange);
  $("#inpBossMinTimes").addEventListener("change", onPrefChange);
  $("#inpBossMaxTimes").addEventListener("change", onPrefChange);

  // Data
  $("#btnExport").addEventListener("click", onExport);
  $("#fileImport").addEventListener("change", onImport);
  $("#btnWipe").addEventListener("click", onWipe);

  // Calendar nav
  $("#calPrev").addEventListener("click", ()=> changeCalendarMonth(-1));
  $("#calNext").addEventListener("click", ()=> changeCalendarMonth(1));
  $("#calToday").addEventListener("click", ()=>{ calendarCursor = new Date(); renderCalendar(); });

  // Quick Add drawer
  $("#tabAdd").addEventListener("click", openQuickAdd);
  $("#drawerQuickClose").addEventListener("click", closeQuickAdd);
  $("#drawerQuickAdd").addEventListener("click", (e)=>{ if(e.target.id==="drawerQuickAdd") closeQuickAdd(); });
  $("#qaTabLib").addEventListener("click", ()=> qaShowTab("lib"));
  $("#qaTabToday").addEventListener("click", ()=> qaShowTab("today"));
  $$("#qaWeekdays .btn").forEach(b=>{
    b.addEventListener("click", ()=> b.classList.toggle("is-selected"));
  });
  $("#qaCreateTodoBtn").addEventListener("click", onCreateQuickTodo);

  // Hide legacy boss template buttons if present
  $("#btnBossTemplate1")?.classList.add("hidden");
  $("#btnBossTemplate2")?.classList.add("hidden");

  // Load + migrate
  const loaded = await loadState();
  state = migrate(loaded);

  // Day/Week engines
  ensureDayRollover();        // resets today, assigns challenges, clears past todos, generates recurring
  ensureWeeklyBoss();         // auto-pick if new week

  renderAll();
  await saveState(state);

  // Header live
  setInterval(()=> renderHeader(), 1000);
}

/* -------------- Day/Week engines -------------- */
function ensureDayRollover(){
  const gd = todayStr();
  if (!state.today.day) {
    state.today.day = gd;
    ensureDailyAssignments(true);
    generateRecurringTodosForDay(gd);
    // purge older todos just in case
    state.todos = state.todos.filter(t=>t.dueDay>=gd);
    return;
  }
  if (gd !== state.today.day) {
    const y = state.today.day;

    // compute yesterday streak: require all habits done OR any activity?
    const yAllHabitsDone = areAllHabitsDoneForDay(y);
    if (yAllHabitsDone) {
      state.streak.current = (state.streak.current||0) + 1;
      state.profile.bestStreak = Math.max(state.profile.bestStreak||0, state.streak.current);
    } else {
      state.streak.current = 0;
    }

    // new day
    state.today.day = gd;
    state.today.points = 0;
    state.today.unconvertedPoints = 0;
    state.today.lastMilestone = 0;
    state.today.habitsStatus = {};

    // assign
    ensureDailyAssignments(true);
    generateRecurringTodosForDay(gd);

    // **no carry-over**: purge all todos with dueDay < today
    state.todos = state.todos.filter(t=>t.dueDay>=gd);
  }

  // weekly boss boundary (Mon 00:00)
  ensureWeeklyBoss();
}

function ensureDailyAssignments(force=false){
  const d = state.today.day;
  const want = clamp(state.settings.dailyChallengesCount ?? 3, 0, 10);
  const cur = state.assigned[d]?.length || 0;
  if (!force && cur === want) return;

  const pool = state.challenges.filter(c=>c.active!==false);
  const ids = pool.map(c=>c.id);
  const y = addDaysStr(d,-1);
  const avoid = new Set(state.assigned[y]||[]);
  const candidates = ids.filter(id=>!avoid.has(id));
  const bag = (candidates.length>=want)?candidates:ids.slice();
  const selected = [];
  while(selected.length<want && bag.length){
    const i = Math.floor(Math.random()*bag.length);
    selected.push(bag.splice(i,1)[0]);
  }
  state.assigned[d] = selected;
}

function generateRecurringTodosForDay(dayStr){
  const weekday = new Date(dayStr+"T00:00:00").getDay(); // 0..6
  for (const r of state.todoRules) {
    const due = (r.recurrence?.byWeekday||[]).includes(weekday);
    if (!due) continue;
    const exists = state.todos.some(t=>t.ruleId===r.id && t.dueDay===dayStr);
    if (!exists) {
      state.todos.push({ id: uuid(), name:r.name, dueDay:dayStr, points:r.points, done:false, ruleId:r.id });
    }
  }
}

function ensureWeeklyBoss(){
  const today = state.today.day || todayStr();
  const weekStart = startOfWeekISO(today);
  if (state.weeklyBoss.weekStartDay === weekStart && state.weeklyBoss.goals?.length) return;

  const want = clamp(state.settings.bossTasksPerWeek ?? 5, 1, 10);
  const minT = clamp(state.settings.bossTimesMin ?? 2, 1, 14);
  const maxT = clamp(state.settings.bossTimesMax ?? 5, minT, 14);

  const tasks = state.library.filter(t=>t.active!==false);
  const goals = [];

  if (tasks.length){
    // Light weighting by last week's usage — surface underused first
    const lastWeek = [];
    for(let i=0;i<7;i++){ lastWeek.push(addDaysStr(weekStart, -1 - i)); }
    const counts = new Map();
    for(const l of state.logs){
      if(l.type!=='library') continue;
      if (lastWeek.includes(l.day)) counts.set(l.id, (counts.get(l.id)||0)+1);
    }
    const pool = tasks.slice().sort((a,b)=>(counts.get(a.id)||0)-(counts.get(b.id)||0)); // ascending
    const bag = pool.slice();
    while(goals.length < Math.min(want, bag.length)){
      const i = Math.floor(Math.random()*bag.length);
      const t = bag.splice(i,1)[0];
      const times = Math.floor(Math.random()*(maxT - minT + 1)) + minT;
      goals.push({ id: uuid(), label: t.name, target: times, tally: 0, linkedTaskIds: [t.id] });
    }
  }

  state.weeklyBoss.weekStartDay = weekStart;
  state.weeklyBoss.goals = goals;
  state.weeklyBoss.completed = false;
}

/* -------------- Render orchestrator -------------- */
function renderAll(){
  renderHeader();
  renderHome();
  renderCalendar();
  renderStats();
  renderManage();
}

/* -------------- Header -------------- */
function renderHeader(){
  $("#statPoints").textContent = fmt(state.today.points||0);
  $("#statCoins").textContent = fmt(state.profile.coins||0);
  $("#statStreak").textContent = fmt(state.streak.current||0);

  const goal = state.settings.dailyGoal||60;
  const pct = clamp(Math.round((state.today.points/goal)*100), 0, 100);
  $("#xpFill").style.width = pct+"%";

  // Ghost tick (same weekday last week)
  const d = new Date(state.today.day+"T00:00:00");
  const ghostDay = isoDay(new Date(d.setDate(d.getDate()-7)));
  const ghostPts = state.progress[ghostDay]?.points || 0;
  const ghostPct = clamp(Math.round((ghostPts/goal)*100), 0, 100);
  $("#goalGhostTick").style.left = ghostPct+"%";

  // Success class when goal met
  $(".app-header").classList.toggle("goal-met", pct >= 100);

  // Label + PowerHour
  let label = `${state.today.points||0} / ${goal} pts`;
  if (state.powerHour?.active && state.powerHour.endsAt) {
    const ms = Date.parse(state.powerHour.endsAt) - Date.now();
    if (ms > 0) {
      const m = Math.max(0, Math.floor(ms/60000));
      const s = Math.max(0, Math.floor((ms%60000)/1000));
      label += ` • ⚡ ${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
    } else {
      state.powerHour.active=false; state.powerHour.endsAt=null;
    }
  }
  $("#goalText").textContent = label;
}

/* -------------- HOME -------------- */
function renderHome(){
  renderTodaysTasks();
  renderHabits();
  renderChallenges();
  renderBoss();
  renderCompletedFeed();
}

/* Today’s Tasks */
function renderTodaysTasks(){
  const list = $("#todaysTasksList"); list.innerHTML="";
  const overdue = $("#overdueBlock"); if (overdue) overdue.innerHTML="";

  const today = state.today.day;
  const todays = state.todos.filter(t=>t.dueDay===today).sort((a,b)=> a.name.localeCompare(b.name));

  if (todays.length===0) {
    const d = document.createElement("div"); d.className="placeholder";
    d.textContent="You’re all caught up. Add a task for today or schedule one.";
    list.appendChild(d);
  } else {
    for (const t of todays) list.appendChild(todoRow(t));
  }
}
function todoRow(t){
  const row = document.createElement("div"); row.className="todo-row"; if (t.done) row.classList.add("done");
  const left = document.createElement("div"); left.className="todo-left";
  const title = document.createElement("div"); title.className="todo-title"; title.textContent = t.name;
  const sub = document.createElement("div"); sub.className="todo-sub"; sub.textContent = `${t.dueDay} • +${t.points} pts`;
  left.appendChild(title); left.appendChild(sub);

  const right = document.createElement("div"); right.className="todo-right";
  const btn = document.createElement("button"); btn.className="btn small"; btn.textContent = t.done ? "Undo" : "Complete";
  btn.addEventListener("click", ()=> toggleTodoDone(t, row));
  right.appendChild(btn);

  const keb = document.createElement("button"); keb.className="icon-btn"; keb.textContent="⋯"; keb.title="Edit or reschedule";
  keb.addEventListener("click", ()=> openTodoModal(t));
  right.appendChild(keb);

  row.appendChild(left); row.appendChild(right);
  return row;
}
async function toggleTodoDone(t, rowEl){
  if (!t.done) { t.done = true; rowEl?.classList.add("success-flash"); await grantPoints(t.points, t.name, "todo", t.id); }
  else { t.done = false; await reversePoints(t.points, "todo", t.id); }
  await saveState(state);
  renderHeader(); renderTodaysTasks(); renderCompletedFeed(); renderCalendar(); renderStats();
}
function openTodoModal(existing=null){
  const modal=$("#modal"), mTitle=$("#modalTitle"), mBody=$("#modalBody"), ok=$("#modalOk");
  const cancel=$("#modalCancel"), close=$("#modalClose");
  const isEdit = !!existing;
  mTitle.textContent = isEdit? "Edit Task" : "Add Task";

  mBody.innerHTML="";
  const name = fieldText("Title", existing?.name || "");
  const points = fieldNum("Points", existing?.points ?? 10, 1, 999);
  const due = fieldDate("Due date", existing?.dueDay || state.today.day);

  // Recurrence chips (Mon..Sun)
  const days = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const chipsWrap = document.createElement("div"); chipsWrap.className="row wrap";
  const chipEls=[];
  for (let i=0;i<7;i++){
    const wd = (i+1)%7;
    const b=document.createElement("button"); b.type="button"; b.className="btn ghost small"; b.dataset.wd=String(wd); b.textContent=days[i];
    b.addEventListener("click", ()=> b.classList.toggle("is-selected"));
    chipEls.push(b); chipsWrap.appendChild(b);
  }
  const recLabel=document.createElement("div"); recLabel.className="muted"; recLabel.textContent="Repeat on (optional)";
  mBody.appendChild(name.wrap); mBody.appendChild(points.wrap); mBody.appendChild(due.wrap); mBody.appendChild(recLabel); mBody.appendChild(chipsWrap);

  // preselect from rule if editing an instance with a rule
  if (existing?.ruleId) {
    const r = state.todoRules.find(x=>x.id===existing.ruleId);
    if (r?.recurrence?.byWeekday) for (const b of chipEls){ if (r.recurrence.byWeekday.includes(parseInt(b.dataset.wd,10))) b.classList.add("is-selected"); }
  }

  ok.onclick = async ()=>{
    const n = name.input.value.trim(); if(!n){ toast("Title required"); return; }
    const p = clamp(parseInt(points.input.value||"10",10), 1, 999);
    const day = due.input.value || state.today.day;
    const selected = chipEls.filter(b=>b.classList.contains("is-selected")).map(b=>parseInt(b.dataset.wd,10));

    if (isEdit) {
      existing.name = n; existing.points = p; existing.dueDay = day;
      if (existing.ruleId) {
        const r = state.todoRules.find(x=>x.id===existing.ruleId);
        if (r && selected.length) r.recurrence = { freq:"weekly", byWeekday: selected };
        if (r && !selected.length) { // remove recurrence
          // detach rule from this item but keep rule unless user deletes in Recurring card
          existing.ruleId = undefined;
        }
      } else if (selected.length){
        // create a new rule from this item
        const rule = { id: uuid(), name:n, points:p, recurrence:{freq:"weekly", byWeekday:selected}, anchorDay: day };
        state.todoRules.push(rule); existing.ruleId = rule.id;
      }
    } else {
      const todo = { id: uuid(), name:n, points:p, dueDay:day, done:false };
      state.todos.push(todo);
      if (selected.length){
        const rule = { id: uuid(), name:n, points:p, recurrence:{freq:"weekly", byWeekday:selected}, anchorDay: day };
        state.todoRules.push(rule);
        const todayWd = new Date(day+"T00:00:00").getDay();
        if (selected.includes(todayWd)) todo.ruleId = rule.id;
      }
    }
    await saveState(state);
    closeModal(); renderTodaysTasks(); renderCalendar(); renderManage(); // recurring card may change
  };

  cancel.onclick = closeModal; close.onclick = closeModal;
  modal.classList.remove("hidden");
  function closeModal(){ modal.classList.add("hidden"); }
}

/* Habits */
function renderHabits(){
  const wrap = $("#habitsList"); wrap.innerHTML="";
  const active = state.habits.filter(h=>h.active!==false);
  if (active.length===0) { const d=document.createElement("div"); d.className="placeholder"; d.textContent="No habits yet. Add 1–3 to start your streak."; wrap.appendChild(d); return; }
  for (const h of active) wrap.appendChild(habitRow(h));
}
function habitRow(h){
  const row=document.createElement("div"); row.className="habit-row";
  const st = state.today.habitsStatus[h.id] || {tally:0,done:false};
  if (st.done) row.classList.add("done");

  const left=document.createElement("div"); left.className="habit-left";
  left.innerHTML = `<div class="habit-title">${h.name}</div><div class="habit-sub">${h.type==="binary" ? `+${h.pointsOnComplete} pts` : `${st.tally||0}/${h.targetPerDay} • +${h.pointsOnComplete} pts when done`}</div>`;
  const right=document.createElement("div"); right.className="habit-right";

  if (h.type==="binary"){
    const toggle=document.createElement("div"); toggle.className="habit-toggle"; toggle.addEventListener("click", ()=> toggleHabitBinary(h, row)); right.appendChild(toggle);
  } else {
    const ctr=document.createElement("div"); ctr.className="counter";
    const minus=document.createElement("button"); minus.textContent="−";
    const num=document.createElement("div"); num.className="num"; num.textContent= String(st.tally||0);
    const plus=document.createElement("button"); plus.textContent="+";
    minus.addEventListener("click", ()=> adjustHabitTally(h,-1, row));
    plus.addEventListener("click", ()=> adjustHabitTally(h,+1, row));
    ctr.append(minus,num,plus); right.appendChild(ctr);
  }
  row.append(left,right); return row;
}
async function toggleHabitBinary(h, rowEl){
  const st = state.today.habitsStatus[h.id] || {tally:0,done:false};
  if (!st.done){ st.done=true; state.today.habitsStatus[h.id]=st; rowEl?.classList.add("success-flash"); await grantPoints(h.pointsOnComplete, h.name, "habit", h.id); }
  else { st.done=false; state.today.habitsStatus[h.id]=st; await reversePoints(h.pointsOnComplete,"habit",h.id); }
  await saveState(state); renderHeader(); renderHabits(); renderCompletedFeed(); renderCalendar(); renderStats();
}
async function adjustHabitTally(h, delta, rowEl){
  const st = state.today.habitsStatus[h.id] || {tally:0,done:false};
  const prevDone = st.done;
  st.tally = clamp((st.tally||0)+delta, 0, h.targetPerDay||1);
  st.done = (st.tally >= (h.targetPerDay||1)); state.today.habitsStatus[h.id]=st;
  if (!prevDone && st.done){ rowEl?.classList.add("success-flash"); await grantPoints(h.pointsOnComplete, h.name, "habit", h.id); }
  else if (prevDone && !st.done){ await reversePoints(h.pointsOnComplete,"habit",h.id); }
  else { await saveState(state); }
  renderHeader(); renderHabits(); renderCompletedFeed(); renderCalendar(); renderStats();
}

/* Challenges */
function renderChallenges(){
  const list=$("#dailyList"); list.innerHTML="";
  const day=state.today.day; const assigned = state.assigned[day] || [];
  if (assigned.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="No challenges assigned. Add some in Manage → Challenge Pool."; list.appendChild(d); return; }
  for(const id of assigned){
    const ch=state.challenges.find(x=>x.id===id); if(!ch) continue;
    const done = !!state.logs.find(l=>l.day===day && l.type==='challenge' && l.id===id);
    const card=document.createElement("div"); card.className="tile"+(done?" done":"");
    const meta=document.createElement("div"); meta.className="meta"; meta.innerHTML=`<div class="title">${ch.name}</div><div class="sub">+${ch.points??10} pts</div>`;
    const btn=document.createElement("button"); btn.className="btn small"; btn.textContent=done?"Undo":"Complete";
    btn.addEventListener("click", ()=> toggleChallenge(ch, done, card));
    card.append(meta,btn); list.appendChild(card);
  }
}
async function toggleChallenge(ch, isDone, cardEl){
  if (!isDone){ cardEl?.classList.add("success-flash"); await grantPoints(ch.points??10, ch.name, "challenge", ch.id); }
  else { await reversePoints(ch.points??10, "challenge", ch.id); }
  await saveState(state); renderHeader(); renderChallenges(); renderCompletedFeed(); renderCalendar(); renderStats(); renderBoss();
}

/* Weekly Boss */
function renderBoss(){
  const ring=$("#bossRing"); const goalsWrap=$("#bossGoals"); goalsWrap.innerHTML="";
  const goals = state.weeklyBoss.goals || [];
  let totalT=0, total=0;
  for(const g of goals){ totalT += (g.target||0); total += Math.min(g.tally||0, g.target||0); }
  const pct = totalT>0 ? Math.round((total/totalT)*100) : 0;
  drawBossRing(ring, pct);

  if(goals.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="Boss goals will appear here."; goalsWrap.appendChild(d); return; }
  for(const g of goals){
    const row=document.createElement("div"); row.className="boss-goal";
    const top=document.createElement("div"); top.className="row";
    const label=document.createElement("div"); label.className="label"; label.textContent=g.label;
    const meta=document.createElement("div"); meta.className="meta"; meta.textContent=`${Math.min(g.tally||0,g.target||0)}/${g.target}`;
    const bar=document.createElement("div"); bar.className="boss-bar"; const fill=document.createElement("div");
    fill.style.width = (g.target>0? Math.round((Math.min(g.tally||0,g.target)/g.target)*100):0)+"%"; bar.appendChild(fill);

    // + / - controls
    const ctr=document.createElement("div"); ctr.className="row";
    const minus=document.createElement("button"); minus.className="btn ghost small"; minus.textContent="−";
    const plus=document.createElement("button"); plus.className="btn small"; plus.textContent="+";
    minus.addEventListener("click", async()=>{ g.tally = Math.max(0, (g.tally||0)-1); await saveState(state); renderBoss(); });
    plus.addEventListener("click", async()=>{ g.tally = Math.min((g.target||0), (g.tally||0)+1); await saveState(state); renderBoss(); });

    top.append(label, meta);
    row.appendChild(top); row.appendChild(bar); row.appendChild(ctr);
    ctr.append(minus, plus);
    goalsWrap.appendChild(row);
  }
}
function drawBossRing(canvas, pct){
  if(!canvas) return; const ctx=canvas.getContext("2d");
  const W=canvas.width, H=canvas.height; const cx=W/2, cy=H/2, r=Math.min(W,H)/2-14;
  ctx.clearRect(0,0,W,H);
  ctx.lineWidth=14; ctx.strokeStyle="#1b2347"; ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2); ctx.stroke();
  const grad=ctx.createLinearGradient(0,0,W,H); grad.addColorStop(0,"#5B8CFF"); grad.addStop?grad.addStop:0; grad.addColorStop(1,"#B85CFF");
  const start=-Math.PI/2; const end=start+(Math.PI*2)*(pct/100);
  ctx.strokeStyle=grad; ctx.beginPath(); ctx.arc(cx,cy,r,start,end); ctx.stroke();
  ctx.fillStyle="rgba(230,233,242,.85)"; ctx.font="24px system-ui, -apple-system, Segoe UI, Roboto"; ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.fillText(`${pct}%`, cx, cy);
}

/* Completed Today feed */
function renderCompletedFeed(){
  const wrap=$("#feedToday"); wrap.innerHTML="";
  const day=state.today.day;
  const items = state.logs.filter(l=>l.day===day && (l.type==='todo'||l.type==='habit'||l.type==='challenge'||l.type==='library'));
  if(items.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="Nothing completed yet. Tap the + to get started."; wrap.appendChild(d); return; }
  for(const log of items){
    const row=document.createElement("div"); row.className="feed-item";
    const left=document.createElement("div"); left.className="feed-left";
    const title=document.createElement("div"); title.className="feed-title"; title.textContent=log.name;
    const sub=document.createElement("div"); sub.className="feed-sub"; const map={todo:"Task",habit:"Habit",challenge:"Challenge",library:"Quick Task"};
    sub.textContent = `${map[log.type]||"Item"} • +${log.points} pts`;
    const right=document.createElement("div"); right.className="feed-right";
    const btn=document.createElement("button"); btn.className="chip-undo"; btn.textContent="Undo";
    btn.addEventListener("click", ()=> undoLogEntry(log));
    left.append(title,sub); right.appendChild(btn); row.append(left,right); wrap.appendChild(row);
  }
}
async function undoLogEntry(log){
  if (log.day!==state.today.day){ toast("Can only undo today"); return; }
  if (log.type==='todo'){ const t=state.todos.find(x=>x.id===log.id); if(t){ t.done=false; } await reversePoints(log.points,'todo',log.id); }
  else if (log.type==='habit'){ const st=state.today.habitsStatus[log.id]||{tally:0,done:false}; st.done=false; state.today.habitsStatus[log.id]=st; await reversePoints(log.points,'habit',log.id); }
  else if (log.type==='challenge'){ await reversePoints(log.points,'challenge',log.id); }
  else if (log.type==='library'){ await reversePoints(log.points,'library',log.id); }
  await saveState(state); renderHeader(); renderHome(); renderCalendar(); renderStats();
}

/* -------------- Economy -------------- */
function ensureProgressBucket(day){
  if(!state.progress[day]) state.progress[day]={ points:0, coinsEarned:0, tasksDone:0, habitsDone:0, challengesDone:0 };
  return state.progress[day];
}
async function grantPoints(points, name, type, id){
  const day=state.today.day;
  if (state.powerHour?.active && state.powerHour.endsAt && Date.now() < Date.parse(state.powerHour.endsAt)) {
    points = Math.round(points * 1.5);
  }
  state.today.points += points;
  state.today.unconvertedPoints += points;

  const rate = state.settings.pointsPerCoin || 100;
  const minted = Math.floor(state.today.unconvertedPoints / rate);
  if (minted>0){ state.today.unconvertedPoints -= minted*rate; state.profile.coins += minted; ensureProgressBucket(day).coinsEarned += minted; }

  const bucket=ensureProgressBucket(day); bucket.points += points;
  if (type==='todo') bucket.tasksDone += 1;
  if (type==='habit') bucket.habitsDone += 1;
  if (type==='challenge') bucket.challengesDone += 1;

  state.logs.unshift({ ts:new Date().toISOString(), type, id, name, points, day });

  // boss: if library task maps to a goal, we increment tally via library flow; here we leave as-is.
  toast(`+${points} pts`); confettiBurst({count:10});

  const nextMilestone = Math.floor((state.today.points)/100)*100;
  if (nextMilestone>0 && nextMilestone>(state.today.lastMilestone||0)){
    state.today.lastMilestone = nextMilestone; banner(`Milestone: ${nextMilestone} points today!`); confettiBurst({count:24, duration:1100});
  }
  await saveState(state);
}
async function reversePoints(points, type, id){
  const day=state.today.day;
  state.today.points = Math.max(0, state.today.points - points);
  const bucket=ensureProgressBucket(day);
  bucket.points = Math.max(0, bucket.points - points);
  if (type==='todo') bucket.tasksDone = Math.max(0, bucket.tasksDone - 1);
  if (type==='habit') bucket.habitsDone = Math.max(0, bucket.habitsDone - 1);
  if (type==='challenge') bucket.challengesDone = Math.max(0, bucket.challengesDone - 1);
  const i=state.logs.findIndex(l=>l.day===day && l.type===type && l.id===id && l.points===points);
  if (i>=0) state.logs.splice(i,1);
  toast("Undone"); await saveState(state);
}

/* -------------- Quick Add -------------- */
function openQuickAdd(){
  qaShowTab("lib");
  $("#qaTodoTitle").value = "";
  $("#qaTodoPoints").value = 10;
  $$("#qaWeekdays .btn").forEach(b=>b.classList.remove("is-selected"));
  renderQuickAdd();
  $("#drawerQuickAdd").classList.remove("hidden");
}
function closeQuickAdd(){ $("#drawerQuickAdd").classList.add("hidden"); }
function qaShowTab(which){
  const tabLib=$("#qaTabLib"), tabToday=$("#qaTabToday");
  const viewLib=$("#qaViewLib"), viewToday=$("#qaViewToday");
  const sel=(btn,on)=>btn.classList.toggle("is-selected", !!on);
  sel(tabLib, which==="lib"); sel(tabToday, which==="today");
  viewLib.classList.toggle("hidden", which!=="lib");
  viewToday.classList.toggle("hidden", which!=="today");
}
function renderQuickAdd(){
  const favRow=$("#quickFavsRow"), favWrap=$("#quickFavs"), grid=$("#quickTaskList");
  favWrap.innerHTML=""; grid.innerHTML="";
  const tasks=state.library.filter(t=>t.active!==false);
  if (tasks.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="Add tasks in Manage → Task Library."; grid.appendChild(d); favRow.classList.add("hidden"); return; }
  const counts=new Map(); for(const l of state.logs){ if(l.type==='library') counts.set(l.id,(counts.get(l.id)||0)+1); }
  const favs=tasks.slice().sort((a,b)=>(counts.get(b.id)||0)-(counts.get(a.id)||0)).slice(0,3);
  if (favs.length>0){ favRow.classList.remove("hidden"); for(const t of favs){ const c=document.createElement("button"); c.className="quick-chip"; c.textContent=t.name; c.addEventListener("click",()=> quickAddLibrary(t)); favWrap.appendChild(c);} } else favRow.classList.add("hidden");
  for(const t of tasks){
    const disabled = isLibraryOnCooldown(t);
    const card=document.createElement("button"); card.className="quick-card"; card.disabled=disabled;
    const sub = disabled ? "Cooling…" : `+${t.points} pts`;
    card.innerHTML = `<div>${t.name}</div><div class="sub">${sub}</div>`;
    card.addEventListener("click", ()=> quickAddLibrary(t));
    grid.appendChild(card);
  }
}
function isLibraryOnCooldown(t){
  if (!t.cooldownHours || !t.lastDoneAt) return false;
  const last = Date.parse(t.lastDoneAt);
  const readyAt = last + t.cooldownHours*3600*1000;
  return Date.now() < readyAt;
}
async function quickAddLibrary(t){
  if (isLibraryOnCooldown(t)) { toast("Cooling down"); return; }
  t.lastDoneAt = new Date().toISOString();
  await grantPoints(t.points, t.name, "library", t.id);
  renderQuickAdd(); renderHeader(); renderCompletedFeed(); renderCalendar(); renderStats(); renderBoss();
}
async function onCreateQuickTodo(){
  const title=$("#qaTodoTitle").value.trim(); const pts=clamp(parseInt($("#qaTodoPoints").value||"10",10),1,999);
  if(!title){ toast("Title required"); return; }
  const selected = $$("#qaWeekdays .btn.is-selected").map(b=>parseInt(b.dataset.wd,10));
  const today=state.today.day;
  const todo={ id:uuid(), name:title, points:pts, dueDay:today, done:false }; state.todos.push(todo);
  if (selected.length){ const rule={ id:uuid(), name:title, points:pts, recurrence:{freq:"weekly",byWeekday:selected}, anchorDay:today }; state.todoRules.push(rule); const wd=new Date(today+"T00:00:00").getDay(); if (selected.includes(wd)) todo.ruleId=rule.id; }
  await saveState(state); closeQuickAdd(); renderTodaysTasks(); renderCalendar(); renderManage();
  toast("Added");
}

/* -------------- Shop -------------- */
function openShopDrawer(){ renderShopDrawer(); $("#drawerShop").classList.remove("hidden"); }
function closeShopDrawer(){ $("#drawerShop").classList.add("hidden"); }
function renderShopDrawer(){
  const wrap=$("#shopDrawerList"); wrap.innerHTML="";
  const items=state.shop.filter(s=>s.active!==false);
  if(items.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="No rewards yet. Add some in Manage → Shop."; wrap.appendChild(d); return; }
  for(const s of items){
    const row=document.createElement("div"); row.className="shop-card";
    const title=document.createElement("div"); title.className="shop-title"; title.textContent=s.name;
    const cost=document.createElement("div"); cost.className="shop-cost"; cost.textContent = `${s.cost} coins`;
    const btn=document.createElement("button"); btn.className="btn small"; btn.textContent="Buy";
    btn.addEventListener("click", ()=> buyShopItem(s));
    row.append(title,cost,btn); wrap.appendChild(row);
  }
}
async function buyShopItem(item){
  if ((state.profile.coins||0) < (item.cost||0)) { toast("Not enough coins"); return; }
  state.profile.coins -= (item.cost||0);
  state.logs.unshift({ ts:new Date().toISOString(), type:'purchase', id:item.id, name:item.name, cost:item.cost, day: state.today.day });
  if (item.type==='powerHour'){ state.powerHour.active=true; state.powerHour.endsAt = new Date(Date.now() + 60*60*1000).toISOString(); toast("Power Hour Active (+50% pts for 60m)"); }
  await saveState(state); renderHeader(); closeShopDrawer();
}

/* -------------- Manage (Library / Challenges / Shop / Recurring / Prefs) -------------- */
function renderManage(){
  renderLibraryAdmin();
  renderChallengesAdmin();
  renderShopAdmin();
  renderRecurringAdmin();   // NEW

  // Prefs
  $("#inpDailyGoal").value = state.settings.dailyGoal||60;
  $("#inpPPC").value = state.settings.pointsPerCoin||100;
  $("#chkHaptics").checked = !!state.settings.haptics;
  $("#inpChallengesCount").value = state.settings.dailyChallengesCount ?? 3;
  $("#inpBossTasksPerWeek").value = state.settings.bossTasksPerWeek ?? 5;
  $("#inpBossMinTimes").value = state.settings.bossTimesMin ?? 2;
  $("#inpBossMaxTimes").value = state.settings.bossTimesMax ?? 5;
}

function renderLibraryAdmin(){
  const el=$("#manageTasks"); el.innerHTML="";
  const items=state.library||[];
  if(items.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="No items yet. Click “+ Add”."; el.appendChild(d); return; }
  for(const it of items){
    const row=document.createElement("div"); row.className="tile";
    const meta=document.createElement("div"); meta.className="meta";
    meta.innerHTML = `<div class="title">${it.name}</div><div class="sub">+${it.points} pts${it.cooldownHours?` • ${it.cooldownHours}h cooldown`:''}</div>`;
    const actions=document.createElement("div"); actions.className="row";
    const edit=document.createElement("button"); edit.className="btn ghost small"; edit.textContent="Edit"; edit.addEventListener("click", ()=> openLibraryModal(it));
    const tog=document.createElement("button"); tog.className="btn small"; const active=it.active!==false; tog.textContent=active?"Archive":"Activate";
    tog.addEventListener("click", async()=>{ it.active = !active; await saveState(state); renderLibraryAdmin(); });
    actions.append(edit,tog); row.append(meta,actions); el.appendChild(row);
  }
}
function openLibraryModal(existing=null){
  const modal=$("#modal"), mTitle=$("#modalTitle"), mBody=$("#modalBody"), ok=$("#modalOk");
  const cancel=$("#modalCancel"), close=$("#modalClose");
  const isEdit=!!existing; mTitle.textContent=isEdit?"Edit Library Item":"Add Library Item";
  mBody.innerHTML="";
  const name=fieldText("Name", existing?.name || "");
  const pts=fieldNum("Points", existing?.points ?? 10, 1, 999);
  const cd=fieldNum("Cooldown hours (optional)", existing?.cooldownHours ?? "", 0, 168, true);
  mBody.append(name.wrap, pts.wrap, cd.wrap);
  ok.onclick = async ()=>{
    const n=name.input.value.trim(); if(!n){ toast("Name required"); return; }
    const item= existing || { id:uuid(), active:true };
    item.name=n; item.points=clamp(parseInt(pts.input.value||"10",10),1,999);
    const c=cd.input.value.trim(); item.cooldownHours = c===""? undefined : clamp(parseInt(c,10),0,168);
    if(!existing) state.library.push(item);
    await saveState(state); closeModal(); renderLibraryAdmin();
  };
  cancel.onclick=closeModal; close.onclick=closeModal; modal.classList.remove("hidden");
  function closeModal(){ modal.classList.add("hidden"); }
}

function renderChallengesAdmin(){
  const el=$("#manageChallenges"); el.innerHTML="";
  const items=state.challenges||[];
  if(items.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="No challenges yet. Click “+ Add”."; el.appendChild(d); return; }
  for(const it of items){
    const row=document.createElement("div"); row.className="tile";
    const meta=document.createElement("div"); meta.className="meta"; meta.innerHTML=`<div class="title">${it.name}</div><div class="sub">+${it.points??10} pts</div>`;
    const actions=document.createElement("div"); actions.className="row";
    const edit=document.createElement("button"); edit.className="btn ghost small"; edit.textContent="Edit"; edit.addEventListener("click", ()=> openChallengeModal(it));
    const tog=document.createElement("button"); tog.className="btn small"; const active=it.active!==false; tog.textContent=active?"Archive":"Activate";
    tog.addEventListener("click", async()=>{ it.active = !active; await saveState(state); renderChallengesAdmin(); });
    actions.append(edit,tog); row.append(meta,actions); el.appendChild(row);
  }
}
function openChallengeModal(existing=null){
  const modal=$("#modal"), mTitle=$("#modalTitle"), mBody=$("#modalBody"), ok=$("#modalOk");
  const cancel=$("#modalCancel"), close=$("#modalClose");
  const isEdit=!!existing; mTitle.textContent=isEdit?"Edit Challenge":"Add Challenge";
  mBody.innerHTML=""; const name=fieldText("Name", existing?.name || ""); const pts=fieldNum("Points", existing?.points ?? 10, 1, 999);
  mBody.append(name.wrap, pts.wrap);
  ok.onclick = async ()=>{
    const n=name.input.value.trim(); if(!n){ toast("Name required"); return; }
    const item= existing || { id:uuid(), active:true };
    item.name=n; item.points=clamp(parseInt(pts.input.value||"10",10),1,999);
    if(!existing) state.challenges.push(item);
    await saveState(state); closeModal(); renderChallengesAdmin(); renderChallenges();
  };
  cancel.onclick=closeModal; close.onclick=closeModal; modal.classList.remove("hidden");
  function closeModal(){ modal.classList.add("hidden"); }
}

function renderShopAdmin(){
  const el=$("#manageShop"); el.innerHTML="";
  const items=state.shop||[];
  if(items.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="No rewards yet. Click “+ Add”."; el.appendChild(d); return; }
  for(const it of items){
    const row=document.createElement("div"); row.className="tile";
    const meta=document.createElement("div"); meta.className="meta"; meta.innerHTML=`<div class="title">${it.name}</div><div class="sub">${it.cost} coins${it.type?` • ${it.type}`:""}</div>`;
    const actions=document.createElement("div"); actions.className="row";
    const edit=document.createElement("button"); edit.className="btn ghost small"; edit.textContent="Edit"; edit.addEventListener("click", ()=> openShopItemModal(it));
    const tog=document.createElement("button"); tog.className="btn small"; const active=it.active!==false; tog.textContent=active?"Archive":"Activate";
    tog.addEventListener("click", async()=>{ it.active = !active; await saveState(state); renderShopAdmin(); });
    actions.append(edit,tog); row.append(meta,actions); el.appendChild(row);
  }
}
function openShopItemModal(existing=null){
  const modal=$("#modal"), mTitle=$("#modalTitle"), mBody=$("#modalBody"), ok=$("#modalOk");
  const cancel=$("#modalCancel"), close=$("#modalClose");
  const isEdit=!!existing; mTitle.textContent=isEdit?"Edit Shop Item":"Add Shop Item";
  mBody.innerHTML="";
  const name=fieldText("Name", existing?.name || "");
  const cost=fieldNum("Cost (coins)", existing?.cost ?? 20, 1, 999);
  const typeWrap=document.createElement("label"); typeWrap.textContent="Type"; typeWrap.style.cssText="color:var(--muted);display:grid;gap:6px";
  const sel=document.createElement("select"); sel.style.cssText="background:#0F1630;border:1px solid var(--border);color:var(--text);border-radius:10px;padding:12px;font-size:16px";
  sel.innerHTML = `<option value="">Generic reward</option><option value="powerHour">Power Hour (+50% / 60m)</option><option value="streakRepair">Streak Repair</option>`;
  sel.value = existing?.type || "";
  typeWrap.appendChild(sel);
  mBody.append(name.wrap, cost.wrap, typeWrap);
  ok.onclick = async ()=>{
    const n=name.input.value.trim(); if(!n){ toast("Name required"); return; }
    const item= existing || { id:uuid(), active:true };
    item.name=n; item.cost=clamp(parseInt(cost.input.value||"20",10),1,999); item.type = sel.value || undefined;
    if(!existing) state.shop.push(item);
    await saveState(state); closeModal(); renderShopAdmin();
  };
  cancel.onclick=closeModal; close.onclick=closeModal; modal.classList.remove("hidden");
  function closeModal(){ modal.classList.add("hidden"); }
}

/* Recurring Tasks (rules) */
function renderRecurringAdmin(){
  // Inject a card before Preferences if not present
  let card = document.getElementById("recurringCard");
  const manageView = $("#manageView");
  if (!card) {
    card = document.createElement("div"); card.id="recurringCard"; card.className="card";
    const head=document.createElement("div"); head.className="card-head";
    const h3=document.createElement("h3"); h3.textContent="Recurring Tasks";
    const addBtn=document.createElement("button"); addBtn.className="btn small"; addBtn.textContent="+ Add";
    addBtn.addEventListener("click", ()=> openRecurringModal());
    head.append(h3, addBtn);
    const list=document.createElement("div"); list.id="recurringList"; list.className="list admin";
    card.append(head, list);
    // Insert before Preferences card
    const prefsCard = $("#manageView .card:last-of-type"); // Data card; prefer insert before Preferences
    manageView.insertBefore(card, prefsCard);
  }
  const list=$("#recurringList"); list.innerHTML="";
  const rules=state.todoRules||[];
  if (rules.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="No recurring tasks yet."; list.appendChild(d); return; }
  for(const r of rules){
    const row=document.createElement("div"); row.className="tile";
    const meta=document.createElement("div"); meta.className="meta";
    const days = (r.recurrence?.byWeekday||[]).map(wd=>["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][wd]).join("·") || "—";
    meta.innerHTML = `<div class="title">${r.name}</div><div class="sub">+${r.points} pts • ${days}</div>`;
    const actions=document.createElement("div"); actions.className="row";
    const edit=document.createElement("button"); edit.className="btn ghost small"; edit.textContent="Edit"; edit.addEventListener("click", ()=> openRecurringModal(r));
    const del=document.createElement("button"); del.className="btn small"; del.textContent="Delete";
    del.addEventListener("click", async()=>{ if(!confirm("Delete this recurrence?")) return; // detach future; keep any generated past todos as history
      const id=r.id; state.todoRules = state.todoRules.filter(x=>x.id!==id);
      // Detach ruleId from any future todos
      const today=state.today.day; state.todos = state.todos.filter(t=> !(t.ruleId===id && t.dueDay>=today) );
      await saveState(state); renderRecurringAdmin(); renderTodaysTasks(); renderCalendar();
    });
    actions.append(edit,del); row.append(meta,actions); list.appendChild(row);
  }
}
function openRecurringModal(existing=null){
  const modal=$("#modal"), mTitle=$("#modalTitle"), mBody=$("#modalBody"), ok=$("#modalOk"); const cancel=$("#modalCancel"), close=$("#modalClose");
  const isEdit=!!existing; mTitle.textContent=isEdit?"Edit Recurring Task":"Add Recurring Task";
  mBody.innerHTML="";
  const name=fieldText("Name", existing?.name || "");
  const pts=fieldNum("Points", existing?.points ?? 10, 1, 999);
  const days=["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const chips=document.createElement("div"); chips.className="row wrap";
  const chipEls=[]; for(let i=0;i<7;i++){ const wd=(i+1)%7; const b=document.createElement("button"); b.type="button"; b.className="btn ghost small"; b.dataset.wd=String(wd); b.textContent=days[i]; b.addEventListener("click",()=> b.classList.toggle("is-selected")); chipEls.push(b); chips.appendChild(b); }
  if (existing?.recurrence?.byWeekday){ for(const b of chipEls){ if(existing.recurrence.byWeekday.includes(parseInt(b.dataset.wd,10))) b.classList.add("is-selected"); } }
  mBody.append(name.wrap, pts.wrap); const lbl=document.createElement("div"); lbl.className="muted"; lbl.textContent="Repeat on"; mBody.append(lbl, chips);
  ok.onclick = async ()=>{
    const n=name.input.value.trim(); if(!n){ toast("Name required"); return; }
    const p=clamp(parseInt(pts.input.value||"10",10),1,999);
    const selected = chipEls.filter(b=>b.classList.contains("is-selected")).map(b=>parseInt(b.dataset.wd,10));
    if (selected.length===0){ toast("Pick at least one weekday"); return; }
    if (isEdit){ existing.name=n; existing.points=p; existing.recurrence={freq:"weekly",byWeekday:selected}; }
    else { state.todoRules.push({ id:uuid(), name:n, points:p, anchorDay:state.today.day, recurrence:{freq:"weekly",byWeekday:selected} }); }
    await saveState(state); closeModal(); renderRecurringAdmin(); generateRecurringTodosForDay(state.today.day); renderTodaysTasks(); renderCalendar();
  };
  cancel.onclick=closeModal; close.onclick=closeModal; modal.classList.remove("hidden");
  function closeModal(){ modal.classList.add("hidden"); }
}

/* -------------- Preferences/Data -------------- */
async function onPrefChange(){
  state.settings.dailyGoal = clamp(parseInt($("#inpDailyGoal").value||"60",10), 10, 1000);
  state.settings.pointsPerCoin = clamp(parseInt($("#inpPPC").value||"100",10), 10, 1000);
  state.settings.haptics = !!$("#chkHaptics").checked;
  state.settings.dailyChallengesCount = clamp(parseInt($("#inpChallengesCount").value||"3",10), 0, 10);
  state.settings.bossTasksPerWeek = clamp(parseInt($("#inpBossTasksPerWeek").value||"5",10), 1, 10);
  state.settings.bossTimesMin = clamp(parseInt($("#inpBossMinTimes").value||"2",10), 1, 14);
  state.settings.bossTimesMax = clamp(parseInt($("#inpBossMaxTimes").value||"5",10), state.settings.bossTimesMin, 14);

  await saveState(state);
  ensureDailyAssignments(true);
  ensureWeeklyBoss();
  renderHeader(); renderChallenges(); renderBoss(); renderManage(); renderStats();
  toast("Saved");
}
async function onExport(){
  const text = await exportJSON();
  const blob = new Blob([text], {type:"application/json"}); const url=URL.createObjectURL(blob);
  const a=document.createElement("a"); a.href=url; a.download=`liferpg-export-${Date.now()}.json`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 300);
}
async function onImport(e){
  const f=e.target.files[0]; if(!f) return;
  const text=await f.text();
  try{ const obj=await importJSON(text); state=migrate(obj); ensureDayRollover(); ensureWeeklyBoss(); renderAll(); toast("Imported"); }catch{ toast("Import failed"); }
  e.target.value="";
}
async function onWipe(){
  if (!confirm("This will erase all data. Continue?")) return;
  await clearAll(); state=defaultState(); state.today.day=todayStr(); ensureDailyAssignments(true); ensureWeeklyBoss(); await saveState(state); renderAll(); toast("Wiped");
}

/* -------------- Stats -------------- */
function renderStats(){
  const statsView=$("#statsView");
  let kpis = statsView.querySelector(".kpis"); if (!kpis) { kpis=document.createElement("div"); kpis.className="kpis"; statsView.insertBefore(kpis, statsView.firstChild); }

  const goal = state.settings.dailyGoal || 60;
  const last30 = getLastNDays(30);

  // Week windows
  const t = new Date(state.today.day + "T00:00:00");
  const ws = new Date(t); const wd=ws.getDay(); const delta=(wd===0?-6:1-wd); ws.setDate(ws.getDate()+delta);
  const lastWs = new Date(ws); lastWs.setDate(ws.getDate()-7);

  const thisWeek = sumWeek(ws), prevWeek = sumWeek(lastWs);
  const deltaPct = prevWeek>0 ? Math.round(((thisWeek - prevWeek) / prevWeek) * 100) : (thisWeek>0?100:0);

  // 30d aggregates
  let over=0,sum30=0; for(const d of last30){ const pts=state.progress[d]?.points||0; sum30+=pts; if(pts>=goal) over++; }
  const avg30 = Math.round(sum30/last30.length);
  const lifetime = state.logs.reduce((acc,l)=> acc + (l.points>0? l.points:0), 0);

  // KPI chips
  kpis.innerHTML="";
  kpis.appendChild(kpi("This week", `${fmt(thisWeek)} pts`, signed(deltaPct)));
  kpis.appendChild(kpi("Consistency (30d)", `${over}/30 days`, null));
  kpis.appendChild(kpi("Avg / day (30)", `${fmt(avg30)} pts`, null));
  kpis.appendChild(kpi("Longest streak", `${fmt(state.profile.bestStreak||0)} days`, null));
  kpis.appendChild(kpi("Lifetime points", `${fmt(lifetime)} pts`, null));

  // Ensure This Week card exists (aesthetic mini chart)
  let weekCard = statsView.querySelector("#weekCard");
  if (!weekCard) {
    weekCard = document.createElement("div"); weekCard.id="weekCard"; weekCard.className="card";
    weekCard.innerHTML = `<div class="card-head"><h3>This Week</h3></div><canvas id="weekBars" width="600" height="140" aria-label="This week bars"></canvas>`;
    const after = statsView.querySelector(".grid.two"); statsView.insertBefore(weekCard, after.nextSibling);
  }
  const weekVals = getLastNDays(7).map(d=> state.progress[d]?.points || 0);
  const cvs=$("#weekBars"); const r=window.devicePixelRatio||1; cvs.style.width="100%"; const w=cvs.clientWidth||600; const h=140;
  cvs.width=Math.floor(w*r); cvs.height=Math.floor(h*r); cvs.getContext("2d").setTransform(r,0,0,r,0,0);
  drawMiniBars(cvs, weekVals);

  // Streak & 30d points chart (existing)
  $("#streakBig").textContent = fmt(state.streak.current||0);
  $("#bestStreak").textContent = fmt(state.profile.bestStreak||0);
  const last7 = getLastNDays(7); let cmp=0; for(const d of last7){ const p=state.progress[d]; cmp += (p?.tasksDone||0)+(p?.habitsDone||0)+(p?.challengesDone||0); }
  $("#cmpWeek").textContent = fmt(cmp);

  const bar30=$("#bar30"); bar30.style.width="100%";
  const w2 = bar30.clientWidth||600, h2=260, r2=window.devicePixelRatio||1;
  bar30.width=Math.floor(w2*r2); bar30.height=Math.floor(h2*r2); bar30.getContext("2d").setTransform(r2,0,0,r2,0,0);
  const vals30 = last30.map(d=> state.progress[d]?.points || 0);
  renderBarChart(bar30, vals30);

  // Habit history rows
  renderHabitHistory(last30);

  function sumWeek(startDate){
    let sum=0; for(let i=0;i<7;i++){ const d=new Date(startDate); d.setDate(startDate.getDate()+i); const key=isoDay(d); sum+=(state.progress[key]?.points||0); } return sum;
  }
  function kpi(label, value, deltaStr){
    const el=document.createElement("div"); el.className="kpi";
    el.innerHTML = `<div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>`;
    if (deltaStr!==null){ const d=document.createElement("div"); d.className="kpi-delta"; d.textContent=deltaStr; if (deltaStr.startsWith("+")) d.classList.add("pos"); if (deltaStr.startsWith("-")) d.classList.add("neg"); el.appendChild(d); }
    return el;
  }
  function signed(n){ return (n>0?`+${n}%` : n<0? `${n}%` : "0%"); }
}

function renderHabitHistory(last30Days){
  const wrap=$("#habitHistory"); wrap.innerHTML="";
  const active = state.habits.filter(h=>h.active!==false);
  if (active.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="No habits yet."; wrap.appendChild(d); return; }
  for (const h of active){
    const row=document.createElement("div"); row.className="habit-30-row";
    const name=document.createElement("div"); name.className="habit-30-name"; name.textContent=h.name;
    const cells=document.createElement("div"); cells.className="habit-30-cells";

    let streak=0, current=0;
    for (const day of last30Days){
      const on = habitDoneOnDay(h.id, day);
      const cell=document.createElement("div"); cell.className="hcell";
      if (on){ const pts=state.progress[day]?.points||0; cell.classList.add(pts >= (state.settings.dailyGoal||60) ? "on-strong" : "on"); current++; streak=Math.max(streak,current); }
      else current=0;
      cells.appendChild(cell);
    }
    const sEl=document.createElement("div"); sEl.className="habit-30-streak"; sEl.textContent = `Streak: ${streak}`;
    row.append(name,cells,sEl); wrap.appendChild(row);
  }
}
function habitDoneOnDay(habitId, dayStr){
  if (dayStr === state.today.day) return !!(state.today.habitsStatus[habitId]?.done);
  return state.logs.some(l=> l.type==='habit' && l.id===habitId && l.day===dayStr);
}
function getLastNDays(n){
  const arr=[]; const base=new Date(); base.setHours(0,0,0,0);
  for(let i=n-1;i>=0;i--){ const d=new Date(base); d.setDate(base.getDate()-i); arr.push(isoDay(d)); }
  return arr;
}
function drawMiniBars(canvas, values){
  const ctx=canvas.getContext("2d"); const W=canvas.width, H=canvas.height;
  ctx.clearRect(0,0,W,H);
  const padL=16, padR=8, padT=8, padB=22; const innerW=W-padL-padR, innerH=H-padT-padB;
  const maxVal=Math.max(1,...values);
  const stepX=innerW/values.length; const gap=Math.min(8, stepX*0.3); const barW=Math.max(3, stepX-gap);
  ctx.save(); ctx.translate(padL,padT);
  // grid
  ctx.strokeStyle="rgba(230,233,242,0.08)"; ctx.lineWidth=1;
  for(let p=0;p<=1.001;p+=0.5){ const y=innerH - p*innerH + .5; ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(innerW,y); ctx.stroke(); }
  // bars
  const grad=ctx.createLinearGradient(0,0,0,innerH); grad.addColorStop(0,"#6CA0FF"); grad.addColorStop(1,"#3A64CC");
  for(let i=0;i<values.length;i++){
    const v=values[i]; const h=(v/maxVal)*innerH; const x=i*stepX+(gap/2); const y=innerH-h;
    roundRect(ctx,x,y,barW,h,Math.min(8,barW*0.45)); ctx.fillStyle=grad; ctx.fill();
  }
  ctx.restore();
  function roundRect(ctx,x,y,w,h,r){ const rr=Math.min(r,w/2,h/2); ctx.beginPath(); ctx.moveTo(x+rr,y); ctx.arcTo(x+w,y,x+w,y+rr,rr); ctx.lineTo(x+w,y+h-rr); ctx.arcTo(x+w,y+h,x+w-rr,y+h,rr); ctx.lineTo(x+rr,y+h); ctx.arcTo(x,y+h,x,y+h-rr,rr); ctx.lineTo(x,y+rr); ctx.arcTo(x,y,x+rr,y,rr); ctx.closePath(); }
}

/* -------------- Calendar -------------- */
let calendarCursor=new Date();
function changeCalendarMonth(delta){ calendarCursor.setMonth(calendarCursor.getMonth()+delta); renderCalendar(); }
function renderCalendar(){
  const grid=$("#monthGrid"); if(!grid) return;
  const y=calendarCursor.getFullYear(); const m=calendarCursor.getMonth();
  $("#calTitle").textContent = new Date(y, m, 1).toLocaleString(undefined,{month:"long", year:"numeric"});
  const first=new Date(y,m,1); const firstW=(first.getDay()||7); const start=new Date(first); start.setDate(1-(firstW-1));
  grid.innerHTML="";
  for(let i=0;i<42;i++){
    const d=new Date(start); d.setDate(start.getDate()+i); const ds=isoDay(d);
    const day=document.createElement("div"); day.className="cal-day"; if(d.getMonth()!==m) day.classList.add("out"); if(ds===state.today.day) day.classList.add("today");

    const date=document.createElement("div"); date.className="date"; date.textContent= String(d.getDate());
    const ring=document.createElement("div"); ring.className="habit-ring"; if(areAllHabitsDoneForDay(ds)) ring.classList.add("done");
    const dotsWrap=document.createElement("div"); dotsWrap.className="task-dots";
    const due=state.todos.filter(t=>t.dueDay===ds).length; const done=state.todos.filter(t=>t.dueDay===ds && t.done).length;
    for(let j=0;j<Math.min(due,6);j++){ const dot=document.createElement("div"); dot.className="task-dot"+(j<done?" done":""); dotsWrap.appendChild(dot); }
    const pts=document.createElement("div"); pts.className="pts-small"; pts.textContent = state.progress[ds]?.points || "";

    day.append(date, ring, dotsWrap, pts);
    day.addEventListener("click", ()=> openDayDetail(ds));
    grid.appendChild(day);
  }
}
function areAllHabitsDoneForDay(dayStr){
  const activeIds = new Set(state.habits.filter(h=>h.active!==false).map(h=>h.id));
  if (activeIds.size===0) return false;
  if (dayStr === state.today.day){
    for(const id of activeIds){ if(!(state.today.habitsStatus[id]?.done)) return false; } return true;
  }
  const completed = new Set(state.logs.filter(l=>l.day===dayStr && l.type==='habit').map(l=>l.id));
  for(const id of activeIds){ if(!completed.has(id)) return false; }
  return true;
}
function openDayDetail(ds){
  const modal=$("#modal"), mTitle=$("#modalTitle"), mBody=$("#modalBody"), ok=$("#modalOk"); const cancel=$("#modalCancel"), close=$("#modalClose");
  mTitle.textContent = `Day Summary — ${ds}`;
  const pts=state.progress[ds]?.points||0; const coins=state.progress[ds]?.coinsEarned||0;
  const logs=state.logs.filter(l=>l.day===ds);
  const habits=logs.filter(l=>l.type==='habit'); const todos=logs.filter(l=>l.type==='todo'); const chals=logs.filter(l=>l.type==='challenge'); const libs=logs.filter(l=>l.type==='library');

  mBody.innerHTML="";
  const top=document.createElement("div"); top.className="tile"; top.innerHTML=`<div class="meta"><div class="title">${pts} pts</div><div class="sub">${coins} coins</div></div>`;
  mBody.appendChild(top);

  function section(title, arr){
    const card=document.createElement("div"); card.className="list"; const head=document.createElement("div"); head.className="quick-title"; head.textContent=title; card.appendChild(head);
    if (arr.length===0){ const d=document.createElement("div"); d.className="placeholder"; d.textContent="—"; card.appendChild(d); }
    else for(const l of arr){ const row=document.createElement("div"); row.className="feed-item"; row.innerHTML=`<div class="feed-left"><div class="feed-title">${l.name}</div><div class="feed-sub">+${l.points} pts</div></div>`; card.appendChild(row); }
    mBody.appendChild(card);
  }
  section("Habits", habits); section("Tasks", todos); section("Challenges / Quick Tasks", chals.concat(libs));

  ok.textContent="Close"; ok.onclick=closeModal; $("#modalCancel").textContent=""; $("#modalCancel").onclick=null;
  modal.classList.remove("hidden");
  function closeModal(){ modal.classList.add("hidden"); }
}

/* -------------- View switching -------------- */
function switchView(id){
  const tabs=$$(".tabbar .tab"); const views=$$(".view");
  tabs.forEach(b=>{ const target=b.getAttribute("data-target"); b.classList.toggle("active", target===id); b.setAttribute("aria-selected", target===id?"true":"false"); });
  views.forEach(v=> v.classList.toggle("active", v.id===id));
  if (id==="statsView") renderStats();
  if (id==="calendarView") renderCalendar();
}

/* -------------- Form helpers -------------- */
function fieldText(label, val=""){ const wrap=document.createElement("label"); wrap.textContent=label; wrap.style.cssText="display:grid;gap:6px;color:var(--muted)"; const input=document.createElement("input"); input.type="text"; styleInput(input); input.value=val; wrap.appendChild(input); return {wrap,input}; }
function fieldNum(label, val=0, min=0, max=999, allowEmpty=false){ const wrap=document.createElement("label"); wrap.textContent=label; wrap.style.cssText="display:grid;gap:6px;color:var(--muted)"; const input=document.createElement("input"); input.type="number"; if(allowEmpty && val==="") input.value=""; else input.value=String(val); input.min=String(min); input.max=String(max); styleInput(input); wrap.appendChild(input); return {wrap,input}; }
function fieldDate(label, val){ const wrap=document.createElement("label"); wrap.textContent=label; wrap.style.cssText="display:grid;gap:6px;color:var(--muted)"; const input=document.createElement("input"); input.type="date"; input.value=val; styleInput(input); wrap.appendChild(input); return {wrap,input}; }
function styleInput(input){ input.style.background="#0F1630"; input.style.border="1px solid var(--border)"; input.style.color="var(--text)"; input.style.borderRadius="10px"; input.style.padding="12px 12px"; input.style.fontSize="16px"; }

