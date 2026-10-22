'use strict';
/* OPTIM LeadFlow CRM - browser app
 * Data lives on the server. Every change is sent to the API, and the server
 * pushes it over Socket.IO to every other connected user in real time.
 */
const API_BASE = ((window.APP_CONFIG && window.APP_CONFIG.BACKEND_URL) || '').replace(/\/$/, '');   // set in config.js
const TOKEN_KEY = 'leadflow_token';
const OLD_KEY = 'optimLeadFlow_v1';      // data saved by the old single-file version
const DEFAULT_CC = '91';                 // country code added to 10-digit numbers for WhatsApp
const MAX_ROWS = 500;                    // rows drawn per table (use search / filters for the rest)
const BASE_STATUSES = 6;                 // built-in outcomes cannot be removed

const NAV_ADMIN = [['dashboard', 'Dashboard'], ['leads', 'All Leads'], ['import', 'Upload Leads'], ['assign', 'Assign Leads'], ['sources', 'Schools & Colleges'], ['staff', 'Telecallers'], ['activity', 'Call Activity'], ['reports', 'Reports'], ['settings', 'Settings']];
const NAV_STAFF = [['dashboard', 'Dashboard'], ['today', 'Start Today'], ['myLeads', 'My Leads'], ['followups', 'Follow-ups'], ['history', 'Call History']];

let token = localStorage.getItem(TOKEN_KEY) || '';
let db = emptyDb();
let current = null, currentLead = null, importType = 'School', importRows = [];
let socket = null, renderTimer = null, activePage = 'dashboard', lastDay = '', assignShown = [];
const selected = new Set();
const $ = id => document.getElementById(id);

function emptyDb() { return { users: [], sources: [], leads: [], calls: [], statuses: [], online: [] }; }
const isAdmin = () => !!current && current.role === 'Admin';
function today() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }
function nameOf(id) { const u = db.users.find(x => x.id === id); return u ? u.name : id; }

/* ===================== API + notifications ===================== */
async function api(method, url, body) {
  let r;
  try {
    r = await fetch(API_BASE + url, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body ? JSON.stringify(body) : undefined });
  } catch (e) { throw new Error('Network error - please check your connection'); }
  let j = {};
  try { j = await r.json(); } catch (e) { /* empty body */ }
  if (r.status === 401 && url !== '/api/login') { forceLogout('Session expired. Please sign in again.'); throw new Error('unauthorized'); }
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}
async function act(fn) { try { return await fn(); } catch (e) { if (e.message !== 'unauthorized') toast(e.message, 'err'); } }

function toast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast ' + (type || 'info');
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.classList.add('out'), 4000);
  setTimeout(() => t.remove(), 4500);
}

/* ===================== Session ===================== */
async function doLogin(e) {
  if (e) e.preventDefault();
  loginMsg.textContent = '';
  try {
    const r = await api('POST', '/api/login', { id: loginId.value.trim(), pass: loginPass.value });
    token = r.token; localStorage.setItem(TOKEN_KEY, token);
    await start();
  } catch (err) { loginMsg.textContent = err.message; }
}
function showLogin(msg) {
  loginScreen.style.display = 'grid'; appEl.style.display = 'none';
  loginMsg.textContent = msg || ''; loginPass.value = '';
}
function clearSession() {
  token = ''; localStorage.removeItem(TOKEN_KEY);
  if (socket) { socket.disconnect(); socket = null; }
  current = null; currentLead = null; db = emptyDb(); selected.clear();
}
function logout() { clearSession(); showLogin(); }
function forceLogout(msg) { if (!token) return; clearSession(); showLogin(msg); }

async function start() {
  applyBootstrap(await api('GET', '/api/bootstrap'));
  loginScreen.style.display = 'none'; appEl.style.display = 'block';
  lastDay = today();
  buildNav(); connectSocket(); showPage('dashboard');
}
function applyBootstrap(b) {
  current = b.me; db.users = b.users; db.sources = b.sources; db.statuses = b.statuses;
  db.leads = b.leads; db.calls = b.calls; db.online = b.online || [];
  const ids = new Set(db.leads.map(l => l.id));
  [...selected].forEach(i => { if (!ids.has(i)) selected.delete(i); });
  userName.textContent = current.name + ' · ' + current.role;
  updatePresence();
}
async function resync() { try { applyBootstrap(await api('GET', '/api/bootstrap')); scheduleRender(); } catch (e) { /* offline: retry on next connect */ } }

/* ===================== Real-time (Socket.IO) ===================== */
function setLive(ok, txt) { liveBadge.className = 'live ' + (ok ? 'on' : 'off'); liveText.textContent = txt || (ok ? 'Live' : 'Offline'); }
function updatePresence() {
  if (!isAdmin()) { onlineCount.textContent = ''; return; }
  const n = db.online.filter(id => db.users.some(u => u.id === id && u.role !== 'Admin')).length;
  onlineCount.textContent = '👥 ' + n + ' staff online';
}

function connectSocket() {
  if (socket) socket.disconnect();
  let first = true;
  const sopts = { auth: cb => cb({ token }) };
  socket = API_BASE ? io(API_BASE, sopts) : io(sopts);
  socket.on('connect', () => { setLive(true); if (!first) resync(); first = false; });   // re-sync after any gap
  socket.on('disconnect', () => setLive(false));
  socket.on('connect_error', e => { setLive(false); if (e && e.message === 'unauthorized') forceLogout('Session expired. Please sign in again.'); });
  socket.io.on('reconnect_attempt', () => setLive(false, 'Reconnecting…'));

  socket.on('leads:upsert', ({ d, by }) => {
    const added = upsertLeads(d);
    if (added && !isAdmin() && by !== current.id) toast(added + ' new lead' + (added > 1 ? 's' : '') + ' assigned to you', 'ok');
    scheduleRender();
  });
  socket.on('leads:remove', ({ d, by }) => {
    const set = new Set(d), had = db.leads.filter(l => set.has(l.id)).length;
    removeLeads(d);
    if (had && by !== current.id) toast(had + ' lead' + (had > 1 ? 's were' : ' was') + ' reassigned to someone else', 'info');
    scheduleRender();
  });
  socket.on('call:new', ({ d, by }) => {
    if (upsertCall(d) && isAdmin() && by !== current.id) toast(nameOf(d.staff) + ' · ' + d.name + ' → ' + d.status, 'info');
    scheduleRender();
  });
  socket.on('source:upsert', ({ d }) => { upsertById(db.sources, d); scheduleRender(); });
  socket.on('source:remove', ({ d }) => { db.sources = db.sources.filter(s => s.id !== d); scheduleRender(); });
  socket.on('user:upsert', ({ d }) => { upsertById(db.users, d); scheduleRender(); });
  socket.on('statuses:set', ({ d }) => { db.statuses = d; scheduleRender(); });
  socket.on('presence', ({ d }) => { db.online = d; updatePresence(); if (activePage === 'staff') renderStaff(); });
  socket.on('resync', resync);
}

/* local data helpers - safe to call twice (HTTP reply + socket event) */
function upsertById(list, item) { const i = list.findIndex(x => x.id === item.id); if (i < 0) list.push(item); else list[i] = item; }
function upsertLeads(arr) {
  const idx = new Map(db.leads.map((l, i) => [l.id, i]));
  let added = 0;
  for (const l of arr) { const i = idx.get(l.id); if (i === undefined) { idx.set(l.id, db.leads.push(l) - 1); added++; } else db.leads[i] = l; }
  return added;
}
function removeLeads(ids) { const s = new Set(ids); db.leads = db.leads.filter(l => !s.has(l.id)); ids.forEach(i => selected.delete(i)); }
function upsertCall(c) { if (db.calls.some(x => x.id === c.id)) return false; db.calls.push(c); return true; }

function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(renderActive, 120); }
function renderActive() {
  if (!current) return;
  renderDashboard(); fillSelects();
  const fn = { today: renderToday, myLeads: renderMyLeads, followups: renderFollowups, history: renderHistory, leads: renderLeads, assign: renderAssign, sources: renderSources, staff: renderStaff, activity: renderActivity, reports: renderReports, settings: renderSettings }[activePage];
  if (fn) fn();
}
setInterval(() => { if (current && today() !== lastDay) { lastDay = today(); renderActive(); } }, 60000);   // new day: refresh "today" lists

/* ===================== Navigation ===================== */
function buildNav() {
  const items = isAdmin() ? NAV_ADMIN : NAV_STAFF;
  nav.innerHTML = items.map(([id, label]) => `<button data-page="${id}" onclick="showPage('${id}')">${label}</button>`).join('');
  mobileNav.innerHTML = items.map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
}
function showPage(id) {
  activePage = id;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $(id).classList.add('active');
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.page === id));
  if ([...mobileNav.options].some(o => o.value === id)) mobileNav.value = id;
  const h = document.querySelector('#' + id + ' h1');
  topTitle.textContent = h ? h.textContent : 'Dashboard';
  renderActive();
}

/* ===================== Shared renderers ===================== */
function statusBadge(s) {
  s = s || 'Pending';
  const c = s === 'Very Interested' ? 'bhot' : s === 'Interested' ? 'bi' : s === 'Call Again' ? 'ba' : s.includes('Not') ? 'bn' : '';
  return `<span class="badge ${c}">${esc(s)}</span>`;
}
function waNum(d) { return d.length === 10 ? DEFAULT_CC + d : d; }
function buttons(l) {
  const p = (l.phone1 || '').replace(/\D/g, ''), q = (l.phone2 || '').replace(/\D/g, ''), n = esc(l.name);
  return `<button class="action call" aria-label="Call ${n}" onclick="location.href='tel:${p}'">📞</button>`
    + `<button class="action wa" aria-label="WhatsApp ${n}" onclick="window.open('https://wa.me/${waNum(p)}','_blank','noopener')">WhatsApp</button>`
    + (q ? `<button class="action call" aria-label="Call ${n} on second number" onclick="location.href='tel:${q}'">📞 2</button>` : '')
    + `<button class="action light" onclick="openCall(${l.id})">Update</button>`;
}
function table(arr) {
  if (!arr.length) return '<div class="empty">No leads found.</div>';
  const shown = arr.slice(0, MAX_ROWS);
  return `<div class="tablewrap"><table class="table"><thead><tr><th>Name</th><th>Class</th><th>Phone</th><th>Source</th><th>Status</th><th>Next Call</th><th>Actions</th></tr></thead><tbody>${shown.map(l => `<tr><td><b>${esc(l.name)}</b></td><td>${esc(l.className)}</td><td>${esc(l.phone1)}</td><td>${esc(l.source)}</td><td>${statusBadge(l.status)}</td><td>${esc(l.nextDate || '-')} ${esc(l.nextTime || '')}</td><td>${buttons(l)}</td></tr>`).join('')}</tbody></table></div>`
    + (arr.length > MAX_ROWS ? `<div class="notice">Showing the first ${MAX_ROWS} of ${arr.length} leads. Use search or filters to narrow down.</div>` : '');
}
function callsTable(arr, emptyMsg) {
  if (!arr.length) return `<div class="empty">${emptyMsg}</div>`;
  const shown = arr.slice(0, MAX_ROWS);
  return `<div class="tablewrap"><table class="table"><thead><tr><th>Date</th><th>Lead</th><th>Staff</th><th>Status</th><th>Next Call</th><th>Remarks</th></tr></thead><tbody>${shown.map(c => `<tr><td>${esc(c.date)}</td><td>${esc(c.name)}</td><td>${esc(nameOf(c.staff))}</td><td>${statusBadge(c.status)}</td><td>${esc(c.nextDate || '-')} ${esc(c.nextTime || '')}</td><td>${esc(c.remarks)}</td></tr>`).join('')}</tbody></table></div>`
    + (arr.length > MAX_ROWS ? `<div class="notice">Showing the latest ${MAX_ROWS} of ${arr.length} calls.</div>` : '');
}
function fillSelects() {
  const set = (id, html) => { const el = $(id); if (!el) return; const v = el.value; el.innerHTML = html; if ([...el.options].some(o => o.value === v)) el.value = v; };
  const src = list => list.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
  const all = src(db.sources);
  set('ls', '<option value="">Select</option>' + all);
  set('importSource', '<option value="">Select ' + importType + '</option>' + src(db.sources.filter(s => s.type === importType)));
  set('todaySchool', '<option value="">All schools / campuses</option>' + all);
  set('leadSchool', '<option value="">All sources</option>' + all);
  set('assignSchool', '<option value="">All schools / colleges</option>' + all);
  const staff = db.users.filter(u => u.role !== 'Admin').map(u => `<option value="${esc(u.id)}">${esc(u.name)}</option>`).join('');
  set('leadAssign', '<option value="">All staff</option><option value="__none">Unassigned</option>' + staff);
  set('assignStaff', '<option value="">Select staff</option>' + staff);
  const st = db.statuses.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  set('todayStatus', '<option value="">All statuses</option>' + st);
  set('myFilter', '<option value="">All</option>' + st);
  set('followFilter', '<option value="">All</option>' + st);
}

/* ===================== Pages ===================== */
function renderDashboard() {
  const mine = isAdmin() ? db.leads : db.leads.filter(l => l.assignedTo === current.id), t = today();
  const count = s => mine.filter(l => (l.status || 'Pending') === s).length;
  kTotal.textContent = mine.length;
  kCalls.textContent = db.calls.filter(c => c.date === t && (isAdmin() || c.staff === current.id)).length;
  kFollow.textContent = mine.filter(l => l.nextDate === t).length;
  kUnassigned.textContent = mine.filter(l => !l.assignedTo).length;
  kHot.textContent = count('Very Interested'); kInt.textContent = count('Interested'); kAgain.textContent = count('Call Again');
  kAttend.textContent = count('Not Attending'); kNot.textContent = count('Not Interested');
  todayDate.textContent = new Date().toLocaleDateString();
  todayTable.innerHTML = table(mine.filter(l => l.nextDate === t || (!l.lastCall && l.assignedTo === current.id)).slice(0, 10));
}
function renderToday() {
  let a = db.leads.filter(l => l.assignedTo === current.id && (l.nextDate === today() || !l.lastCall));
  if (todaySchool.value) a = a.filter(l => l.source === todaySchool.value);
  if (todayStatus.value) a = a.filter(l => (l.status || 'Pending') === todayStatus.value);
  todayLeads.innerHTML = table(a);
}
function renderMyLeads() {
  let a = db.leads.filter(l => l.assignedTo === current.id);
  const q = mySearch.value.toLowerCase();
  if (q) a = a.filter(l => (l.name + l.phone1 + l.phone2).toLowerCase().includes(q));
  if (myFilter.value) a = a.filter(l => (l.status || 'Pending') === myFilter.value);
  myLeadsTable.innerHTML = table(a);
}
function renderFollowups() {
  const d = followDate.value || today();
  let a = db.leads.filter(l => l.assignedTo === current.id && l.nextDate === d);
  if (followFilter.value) a = a.filter(l => l.status === followFilter.value);
  followTable.innerHTML = table(a);
}
function renderHistory() {
  const a = db.calls.filter(c => isAdmin() || c.staff === current.id).sort((x, y) => y.ts.localeCompare(x.ts));
  historyTable.innerHTML = callsTable(a, 'No call history.');
}
function renderLeads() {
  let a = db.leads;
  const q = leadSearch.value.toLowerCase();
  if (q) a = a.filter(l => (l.name + l.phone1 + l.phone2 + l.className).toLowerCase().includes(q));
  if (leadSchool.value) a = a.filter(l => l.source === leadSchool.value);
  if (leadAssign.value === '__none') a = a.filter(l => !l.assignedTo);
  else if (leadAssign.value) a = a.filter(l => l.assignedTo === leadAssign.value);
  leadsTable.innerHTML = table(a);
}
function renderSources() {
  sourcesTable.innerHTML = `<div class="tablewrap"><table class="table"><thead><tr><th>Type</th><th>Name</th><th>Campus</th><th>Leads</th><th>Action</th></tr></thead><tbody>${db.sources.map(s => `<tr><td>${esc(s.type)}</td><td><b>${esc(s.name)}</b></td><td>${esc(s.campus)}</td><td>${db.leads.filter(l => l.source === s.name).length}</td><td><button class="action danger" onclick="deleteSource(${s.id})">Delete</button></td></tr>`).join('')}</tbody></table></div>`;
}
function renderStaff() {
  const on = new Set(db.online);
  staffTable.innerHTML = `<div class="tablewrap"><table class="table"><thead><tr><th>Name</th><th>Login ID</th><th>Role</th><th>Assigned</th><th>Calls</th><th>Now</th></tr></thead><tbody>${db.users.filter(u => u.role !== 'Admin').map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.id)}</td><td>${esc(u.role)}</td><td>${db.leads.filter(l => l.assignedTo === u.id).length}</td><td>${db.calls.filter(c => c.staff === u.id).length}</td><td>${on.has(u.id) ? '<span class="badge bi">● Online</span>' : '<span class="badge">Offline</span>'}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderActivity() {
  activityTable.innerHTML = callsTable(db.calls.slice().sort((x, y) => y.ts.localeCompare(x.ts)), 'No activity.');
}
function renderReports() {
  const active = db.leads.filter(l => l.active !== false);
  const card = (lbl, n) => `<div class="card"><div class="lbl">${lbl}</div><div class="num">${n}</div></div>`;
  reportCards.innerHTML = card('Active Leads', active.length) + card('Calls Recorded', db.calls.length)
    + card('Very Interested', active.filter(l => l.status === 'Very Interested').length) + card('Interested', active.filter(l => l.status === 'Interested').length);
  reportTable.innerHTML = `<div class="tablewrap"><table class="table"><thead><tr><th>Staff</th><th>Assigned</th><th>Called</th><th>Very Interested</th><th>Interested</th><th>Call Again</th></tr></thead><tbody>${db.users.filter(u => u.role !== 'Admin').map(u => {
    const l = active.filter(x => x.assignedTo === u.id), c = db.calls.filter(x => x.staff === u.id);
    return `<tr><td>${esc(u.name)}</td><td>${l.length}</td><td>${c.length}</td><td>${l.filter(x => x.status === 'Very Interested').length}</td><td>${l.filter(x => x.status === 'Interested').length}</td><td>${l.filter(x => x.status === 'Call Again').length}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function renderAssign() {
  let a = db.leads.filter(l => l.active !== false);
  if (assignSchool.value) a = a.filter(l => l.source === assignSchool.value);
  const shown = a.slice(0, MAX_ROWS); assignShown = shown.map(l => l.id);
  if (!shown.length) { assignTable.innerHTML = '<div class="empty">No leads found.</div>'; return; }
  const allOn = shown.every(l => selected.has(l.id));
  assignTable.innerHTML = `<div class="small muted" style="margin-bottom:8px"><span id="selCount">${selected.size}</span> selected</div><div class="tablewrap"><table class="table"><thead><tr><th><input type="checkbox" aria-label="Select all shown" ${allOn ? 'checked' : ''} onchange="selAll(this.checked)"></th><th>Name</th><th>Class</th><th>Source</th><th>Current Staff</th><th>Status</th></tr></thead><tbody>${shown.map(l => `<tr><td><input type="checkbox" aria-label="Select ${esc(l.name)}" ${selected.has(l.id) ? 'checked' : ''} onchange="toggleSel(${l.id},this.checked)"></td><td>${esc(l.name)}</td><td>${esc(l.className)}</td><td>${esc(l.source)}</td><td>${esc(l.assignedTo ? nameOf(l.assignedTo) : 'Unassigned')}</td><td>${statusBadge(l.status)}</td></tr>`).join('')}</tbody></table></div>`
    + (a.length > MAX_ROWS ? `<div class="notice">Showing the first ${MAX_ROWS} of ${a.length}. Filter by school/college to see the rest.</div>` : '');
}
function toggleSel(id, on) { if (on) selected.add(id); else selected.delete(id); const c = $('selCount'); if (c) c.textContent = selected.size; }
function selAll(on) { assignShown.forEach(id => (on ? selected.add(id) : selected.delete(id))); renderAssign(); }

function oldData() {
  try {
    const o = JSON.parse(localStorage.getItem(OLD_KEY) || 'null');
    return o && ((o.leads && o.leads.length) || (o.calls && o.calls.length) || (o.users && o.users.length > 2) || (o.sources && o.sources.length > 1)) ? o : null;
  } catch (e) { return null; }
}
function renderSettings() {
  statusSettings.innerHTML = db.statuses.map((s, i) => `<span class="badge" style="margin:4px">${esc(s)} ${i >= BASE_STATUSES ? `<button aria-label="Remove ${esc(s)}" onclick="removeStatus(${i})">×</button>` : ''}</span>`).join('');
  migratePanel.style.display = oldData() && !localStorage.getItem(OLD_KEY + '_migrated') ? 'block' : 'none';
}

/* ===================== Actions (all go to the server) ===================== */
function openCall(id) {
  currentLead = db.leads.find(l => l.id === id);
  if (!currentLead) return toast('Lead not found', 'err');
  callLeadInfo.innerHTML = `<div class="notice"><b>${esc(currentLead.name)}</b> · ${esc(currentLead.className)} · ${esc(currentLead.source)}<br>${esc(currentLead.phone1)} ${currentLead.phone2 ? ' / ' + esc(currentLead.phone2) : ''}</div>`;
  callStatus.innerHTML = db.statuses.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
  callStatus.value = currentLead.status || 'Pending';
  nextDate.value = currentLead.nextDate || ''; nextTime.value = currentLead.nextTime || ''; remarks.value = '';
  openModal('callModal');
}
function saveCall() {
  if (!currentLead) return;
  act(async () => {
    const r = await api('POST', '/api/calls', { leadId: currentLead.id, status: callStatus.value, nextDate: nextDate.value, nextTime: nextTime.value, remarks: remarks.value });
    upsertLeads([r.lead]); upsertCall(r.call);
    closeModal('callModal'); toast('Call saved', 'ok');
    showPage(isAdmin() ? 'activity' : 'today');
  });
}
function saveLead() {
  const name = ln.value.trim();
  if (!name) return toast('Enter name', 'err');
  act(async () => {
    const r = await api('POST', '/api/leads', { name, className: lc.value, phone1: lp1.value, phone2: lp2.value, source: ls.value, campus: lcamp.value });
    upsertLeads([r.lead]);
    [ln, lc, lp1, lp2, lcamp].forEach(x => { x.value = ''; });
    closeModal('leadModal'); scheduleRender();
  });
}
function saveSource() {
  if (!sn.value.trim()) return;
  act(async () => {
    const r = await api('POST', '/api/sources', { type: st.value, name: sn.value, campus: scampus.value });
    upsertById(db.sources, r.source); closeModal('sourceModal'); scheduleRender();
  });
}
function deleteSource(id) {
  if (!confirm('Delete this source?')) return;
  act(async () => { await api('DELETE', '/api/sources/' + id); db.sources = db.sources.filter(s => s.id !== id); scheduleRender(); });
}
function saveStaff() {
  if (!staffName.value.trim() || !staffId.value.trim() || !staffPass.value) return toast('Complete all fields', 'err');
  act(async () => {
    const r = await api('POST', '/api/users', { name: staffName.value, id: staffId.value, pass: staffPass.value, role: staffRole.value });
    upsertById(db.users, r.user);
    [staffName, staffId, staffPass].forEach(x => { x.value = ''; });
    closeModal('staffModal'); scheduleRender();
  });
}
function assignSelected() {
  const staff = assignStaff.value;
  if (!staff) return toast('Select a staff member', 'err');
  if (!selected.size) return toast('Select at least one lead', 'err');
  act(async () => {
    const r = await api('POST', '/api/leads/assign', { ids: [...selected], staff });
    upsertLeads(r.leads); selected.clear();
    toast(r.leads.length + ' lead(s) assigned to ' + nameOf(staff), 'ok'); scheduleRender();
  });
}
function addStatus() {
  const x = newStatus.value.trim();
  if (!x) return;
  act(async () => { const r = await api('POST', '/api/statuses', { name: x }); db.statuses = r.statuses; newStatus.value = ''; scheduleRender(); });
}
function removeStatus(i) {
  const name = db.statuses[i];
  if (!name) return;
  act(async () => { const r = await api('POST', '/api/statuses/remove', { name }); db.statuses = r.statuses; scheduleRender(); });
}

/* ===================== CSV import ===================== */
function setImportType(t, b) {
  importType = t;
  document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('sel'));
  b.classList.add('sel');
  fillSelects();
}
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; rows.push(row); row = []; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim()));
}
function importFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  if (!f.name.toLowerCase().endsWith('.csv')) { preview.innerHTML = '<div class="notice">Please upload a CSV file. In Excel use File → Save As → CSV.</div>'; importRows = []; return; }
  const r = new FileReader();
  r.onload = () => {
    const lines = parseCSV(String(r.result));
    const head = (lines.shift() || []).map(x => x.trim().toLowerCase());
    const get = (a, ...names) => { const i = head.findIndex(h => names.includes(h)); return i >= 0 ? (a[i] || '').trim() : ''; };
    importRows = lines.map(a => ({
      name: get(a, 'name', 'student name'), className: get(a, 'class', 'class name'),
      phone1: get(a, 'phone 1', 'phone1', 'phone', 'phonenumber1', 'phone number', 'mobile', 'mobile number'),
      phone2: get(a, 'phone 2', 'phone2', 'phonenumber2')
    })).filter(x => x.name);
    preview.innerHTML = `<b>${importRows.length} records ready</b><div class="tablewrap"><table class="table" style="min-width:0"><thead><tr><th>Name</th><th>Class</th><th>Phone 1</th><th>Phone 2</th></tr></thead><tbody>${importRows.slice(0, 8).map(x => `<tr><td>${esc(x.name)}</td><td>${esc(x.className)}</td><td>${esc(x.phone1)}</td><td>${esc(x.phone2)}</td></tr>`).join('')}</tbody></table></div>`;
  };
  r.readAsText(f);
}
function activateImported() {
  const src = importSource.value;
  if (!src || !importRows.length) return toast('Select a school/college and upload data first', 'err');
  act(async () => {
    const r = await api('POST', '/api/leads/import', { source: src, rows: importRows });
    upsertLeads(r.leads); importRows = []; csvFile.value = '';
    preview.innerHTML = `<div class="notice">${r.count} leads activated and ready for assignment.</div>`;
    scheduleRender();
  });
}

/* ===================== One-time migration from the old file ===================== */
function migrateOld() {
  const o = oldData();
  if (!o) return;
  if (!confirm('Import the old browser data into the shared database?')) return;
  act(async () => {
    const r = await api('POST', '/api/migrate', o);
    localStorage.setItem(OLD_KEY + '_migrated', '1');
    toast(`Imported ${r.leads} leads, ${r.calls} calls, ${r.users} staff, ${r.sources} sources`, 'ok');
    await resync();
  });
}

/* ===================== Modals ===================== */
function openModal(id) {
  const m = $(id);
  m.classList.add('show');
  if (id === 'leadModal') fillSelects();
  if (id === 'sourceModal') { sn.value = ''; scampus.value = ''; }
  const first = m.querySelector('input:not([type=hidden]),select');
  if (first) first.focus();
}
function closeModal(id) { $(id).classList.remove('show'); }

document.addEventListener('keydown', e => { if (e.key === 'Escape') document.querySelectorAll('.modal.show').forEach(m => m.classList.remove('show')); });
document.addEventListener('DOMContentLoaded', () => {
  if (token) start().catch(err => { if (err.message !== 'unauthorized') showLogin('Cannot reach the server. Please try again.'); });
  else showLogin();
});
