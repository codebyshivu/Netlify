import { initializeApp, deleteApp, getApps } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, getIdTokenResult } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import { getDatabase, ref, get, set, update, remove, push, onValue, off, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';

const STORAGE_KEY = 'jinendra_vani_dashboard_config';
const THEME_KEY = 'jinendra_vani_dashboard_theme';
const DEFAULT_PATHS = { users: 'users', questions: 'questions', reports: 'reports', activity: 'activity' };
const QUESTION_STATUSES = ['active', 'draft', 'archived'];
const REPORT_STATUSES = ['Pending', 'Reviewing', 'Resolved', 'Rejected'];
const PAGE_SIZE = 20;

const state = {
  firebaseApp: null,
  auth: null,
  db: null,
  authUnsubscribe: null,
  listeners: new Map(),
  user: null,
  adminVerified: false,
  currentSection: 'dashboard',
  data: { users: {}, questions: {}, reports: {}, activity: {} },
  filters: { questions: { search: '', category: '', language: '', status: '', sort: 'newest', page: 1 }, reports: { search: '', status: '', date: '', sort: 'newest', page: 1 }, users: { search: '', status: '', page: 1 } },
  theme: localStorage.getItem(THEME_KEY) || 'system',
  apiStatus: 'unknown',
  busy: new Set()
};

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const safeText = (value, fallback = 'Not available') => value === null || value === undefined || value === '' ? fallback : String(value);
const isObject = (v) => v && typeof v === 'object';
const now = () => new Date().toISOString();

function readConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { ...parsed, paths: { ...DEFAULT_PATHS, ...(parsed.paths || {}) } };
  } catch (error) {
    console.warn('Dashboard configuration could not be read:', error);
    return null;
  }
}

function writeConfig(config) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

function clearConfig() {
  localStorage.removeItem(STORAGE_KEY);
}

function validateFirebaseConfig(config) {
  if (!isObject(config)) throw new Error('Firebase config must be a JSON object.');
  const required = ['apiKey', 'authDomain', 'projectId', 'appId'];
  const missing = required.filter((key) => !String(config[key] || '').trim());
  if (missing.length) throw new Error(`Missing Firebase config fields: ${missing.join(', ')}`);
  if (config.databaseURL && !isValidUrl(config.databaseURL)) throw new Error('Firebase databaseURL is not a valid URL.');
}

function isValidUrl(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol); } catch { return false; }
}

function getBackendUrl() {
  const cfg = readConfig();
  return String(cfg?.backendUrl || '').trim().replace(/\/$/, '');
}

const APIClient = {
  async request(path, options = {}) {
    const base = getBackendUrl();
    if (!base) throw new Error('Backend API is not configured. Open Settings → Backend Configuration.');
    const url = new URL(path || '/', base);
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Number(options.timeout || 12000));
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers(options.headers || {});
      if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      const response = await fetch(url, { ...options, headers, signal: controller.signal, credentials: 'omit' });
      const text = await response.text();
      let body = null;
      if (text) {
        try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 1000) }; }
      }
      if (!response.ok) {
        const message = body?.message || body?.error || `Backend returned HTTP ${response.status}.`;
        throw new Error(message);
      }
      return body;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Backend request timed out.');
      throw error;
    } finally { clearTimeout(timer); }
  },
  async testConnection() {
    return this.request('/', { method: 'GET', timeout: 7000 });
  }
};

const FirebaseService = {
  async initialize(config) {
    validateFirebaseConfig(config.firebase);
    if (state.authUnsubscribe) { state.authUnsubscribe(); state.authUnsubscribe = null; }
    for (const [key, listener] of state.listeners) {
      try { off(listener.ref, listener.event, listener.callback); } catch {}
      state.listeners.delete(key);
    }
    if (state.firebaseApp) { try { await deleteApp(state.firebaseApp); } catch {} }
    state.firebaseApp = initializeApp(config.firebase, `jinendra-vani-dashboard-${Date.now()}`);
    state.auth = getAuth(state.firebaseApp);
    state.db = getDatabase(state.firebaseApp);
    state.authUnsubscribe = onAuthStateChanged(state.auth, handleAuthState);
    return state.firebaseApp;
  },
  async get(path) {
    if (!state.db) throw new Error('Firebase is not initialized.');
    const snap = await get(ref(state.db, path));
    return snap.exists() ? snap.val() : {};
  },
  async set(path, value) {
    if (!state.db) throw new Error('Firebase is not initialized.');
    await set(ref(state.db, path), value);
  },
  async update(path, value) {
    if (!state.db) throw new Error('Firebase is not initialized.');
    await update(ref(state.db, path), value);
  },
  async remove(path) {
    if (!state.db) throw new Error('Firebase is not initialized.');
    await remove(ref(state.db, path));
  },
  async create(path, value) {
    if (!state.db) throw new Error('Firebase is not initialized.');
    const newRef = push(ref(state.db, path));
    await set(newRef, value);
    return newRef.key;
  },
  listen(key, path, callback) {
    if (!state.db) return;
    if (state.listeners.has(key)) return;
    const databaseRef = ref(state.db, path);
    onValue(databaseRef, callback, (error) => console.error(`Firebase listener ${key} failed:`, error));
    state.listeners.set(key, { ref: databaseRef, event: 'value', callback });
  },
  cleanup(key) {
    const item = state.listeners.get(key);
    if (!item) return;
    try { off(item.ref, item.event, item.callback); } catch {}
    state.listeners.delete(key);
  },
  cleanupAll() {
    for (const key of [...state.listeners.keys()]) this.cleanup(key);
  }
};

function paths() { return readConfig()?.paths || DEFAULT_PATHS; }
function pathFor(type, id = '') { return `${String(paths()[type] || type).replace(/^\/+|\/+$/g, '')}${id ? `/${encodeURIComponent(id)}` : ''}`; }

function normalizeRecords(value) {
  if (!isObject(value)) return [];
  return Object.entries(value).map(([id, raw]) => ({ id, ...(isObject(raw) ? raw : { value: raw }) }));
}

function timestampValue(record, keys = ['updatedAt', 'updated', 'createdAt', 'created', 'timestamp']) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && value !== '') {
      if (typeof value === 'number') return value;
      const parsed = Date.parse(String(value));
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return 0;
}

function formatDate(value) {
  const t = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!t || Number.isNaN(t)) return 'Not available';
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(t)); } catch { return new Date(t).toLocaleString(); }
}

function shortDate(value) {
  const t = timestampValue({ value }, ['value']);
  return t ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(t)) : 'Not available';
}

function recordName(record) {
  return safeText(record?.name || record?.displayName || record?.fullName || record?.email || record?.uid || record?.id, 'Unnamed');
}

function setBusy(key, busy) {
  if (busy) state.busy.add(key); else state.busy.delete(key);
  document.querySelectorAll(`[data-busy-key="${CSS.escape(key)}"]`).forEach((el) => {
    el.disabled = busy;
    if (busy) el.dataset.originalText = el.textContent;
    el.textContent = busy ? 'Working…' : (el.dataset.originalText || el.textContent);
  });
}

function toast(title, type = 'success', message = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon"></span><div><strong></strong><small></small></div>`;
  el.querySelector('strong').textContent = title;
  el.querySelector('small').textContent = message;
  $('toastRoot').appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function setGlobalLoader(show, text = 'Working…') {
  $('globalLoader').classList.toggle('hidden', !show);
  const label = $('globalLoader').querySelector('span'); if (label) label.textContent = text;
}

function showAuth() { $('authScreen').classList.remove('hidden'); $('setupScreen').classList.add('hidden'); $('appShell').classList.add('hidden'); }
function showSetup() { $('authScreen').classList.add('hidden'); $('setupScreen').classList.remove('hidden'); $('appShell').classList.add('hidden'); }
function showApp() { $('authScreen').classList.add('hidden'); $('setupScreen').classList.add('hidden'); $('appShell').classList.remove('hidden'); }

async function handleAuthState(user) {
  state.user = user || null;
  state.adminVerified = false;
  if (!user) {
    FirebaseService.cleanupAll();
    showAuth();
    return;
  }
  try {
    const cfg = readConfig();
    if (cfg?.requireAdminClaim !== false) {
      const token = await getIdTokenResult(user, true);
      if (token.claims?.admin !== true) throw new Error('This account is authenticated but does not have the required admin claim.');
    }
    state.adminVerified = true;
    showApp();
    updateProfile();
    await loadSection(state.currentSection, true);
  } catch (error) {
    console.error('Admin authorization failed:', error);
    await signOut(state.auth).catch(() => {});
    $('loginError').textContent = error.message || 'Admin authorization failed.';
    showAuth();
  }
}

function updateProfile() {
  const email = state.user?.email || 'Authenticated admin';
  $('profileEmail').textContent = email;
  $('profileUid').textContent = state.user?.uid || '—';
  $('profileButton').textContent = (email[0] || 'A').toUpperCase();
}

function initTheme() {
  document.documentElement.dataset.theme = state.theme;
  updateThemeButton();
}
function updateThemeButton() {
  const btn = $('themeCycle');
  const icon = state.theme === 'light' ? 'sun' : state.theme === 'dark' ? 'moon' : 'system';
  btn.dataset.icon = icon; btn.title = `Theme: ${state.theme}`;
}
function cycleTheme() {
  state.theme = state.theme === 'system' ? 'light' : state.theme === 'light' ? 'dark' : 'system';
  localStorage.setItem(THEME_KEY, state.theme); initTheme(); toast(`Theme set to ${state.theme}`, 'success');
}

function setNetworkState() {
  const online = navigator.onLine;
  $('offlineBar').classList.toggle('hidden', online);
  $('onlineText').textContent = online ? 'Online' : 'Offline';
  $('onlineDot').className = `network-dot ${online ? 'ok' : 'bad'}`;
}
function requireOnline() { if (!navigator.onLine) throw new Error('You are offline. Reconnect before performing this operation.'); }

function setSection(section) {
  state.currentSection = section;
  document.querySelectorAll('.nav-item[data-section]').forEach((el) => el.classList.toggle('active', el.dataset.section === section));
  document.querySelectorAll('.page-section').forEach((el) => el.classList.toggle('active', el.id === `${section}Section`));
  const meta = { dashboard: ['Overview','Dashboard'], questions: ['Content management','Spiritual Questions'], reports: ['Support & moderation','Reports'], users: ['Accounts','Users'], settings: ['Configuration','Settings'] }[section];
  $('sectionEyebrow').textContent = meta?.[0] || 'Dashboard'; $('pageTitle').textContent = meta?.[1] || 'Dashboard';
  closeSidebar();
  loadSection(section).catch((error) => { console.error(error); toast('Unable to load section', 'error', error.message); });
}

async function loadSection(section, force = false) {
  if (!state.user || !state.adminVerified) return;
  if (section === 'dashboard') return renderDashboard(force);
  if (section === 'questions') return renderQuestions(force);
  if (section === 'reports') return renderReports(force);
  if (section === 'users') return renderUsers(force);
  if (section === 'settings') return renderSettings();
}

function setupListeners() {
  FirebaseService.cleanupAll();
  const cfg = readConfig();
  if (!cfg) return;
  FirebaseService.listen('users', pathFor('users'), (snap) => { state.data.users = snap.exists() ? snap.val() : {}; updateDataDependentViews('users'); });
  FirebaseService.listen('questions', pathFor('questions'), (snap) => { state.data.questions = snap.exists() ? snap.val() : {}; updateDataDependentViews('questions'); });
  FirebaseService.listen('reports', pathFor('reports'), (snap) => { state.data.reports = snap.exists() ? snap.val() : {}; updateDataDependentViews('reports'); });
  FirebaseService.listen('activity', pathFor('activity'), (snap) => { state.data.activity = snap.exists() ? snap.val() : {}; updateDataDependentViews('activity'); });
}

function updateDataDependentViews(type) {
  if (type === 'questions') { if (state.currentSection === 'questions') renderQuestions(); updateNavCounts(); }
  if (type === 'reports') { if (state.currentSection === 'reports') renderReports(); updateNavCounts(); }
  if (type === 'users' && state.currentSection === 'users') renderUsers();
  if (type === 'activity' && state.currentSection === 'dashboard') renderDashboard();
  if (state.currentSection === 'dashboard' && ['users','questions','reports'].includes(type)) renderDashboard();
}

function updateNavCounts() {
  const pending = normalizeRecords(state.data.reports).filter(r => String(r.status || 'Pending').toLowerCase() === 'pending').length;
  const q = normalizeRecords(state.data.questions).length;
  $('reportsNavCount').textContent = pending; $('reportsNavCount').classList.toggle('hidden', !pending);
  $('questionsNavCount').textContent = q; $('questionsNavCount').classList.toggle('hidden', !q);
}

function renderDashboard() {
  const users = normalizeRecords(state.data.users), questions = normalizeRecords(state.data.questions), reports = normalizeRecords(state.data.reports), activity = normalizeRecords(state.data.activity);
  const pending = reports.filter(r => String(r.status || 'Pending').toLowerCase() === 'pending').length;
  const activeUsers = users.filter(u => u.active === true || String(u.status || '').toLowerCase() === 'active').length;
  const recent = activity.sort((a,b) => timestampValue(b)-timestampValue(a)).slice(0,7);
  $('dashboardSection').innerHTML = `<div class="page-head"><div><h2>Good to see you.</h2><p>Monitor your backend from one secure workspace.</p></div><div class="page-actions"><button class="btn btn-secondary" data-action="refresh">Refresh data</button><button class="btn btn-primary" data-action="new-question">Add question</button></div></div>
  <div class="stats-grid">
    ${statCard('Total Users', users.length, 'Accounts in configured users path', 'US')}
    ${statCard('Active Users', activeUsers || '—', activeUsers ? 'Active records detected' : 'No active status available', 'AU')}
    ${statCard('Spiritual Questions', questions.length, 'Questions in configured path', 'SQ')}
    ${statCard('Reports', reports.length, 'All submitted reports', 'RP')}
    ${statCard('Pending Reports', pending || '—', pending ? 'Needs attention' : 'No pending reports', 'PR', pending ? 'warning' : '')}
    ${statCard('Recent Activity', activity.length || '—', activity.length ? 'Audit records available' : 'No activity yet', 'AC')}
  </div>
  <div class="dashboard-grid">
    <div class="card"><div class="card-header"><h3>Recent activity</h3><button class="btn btn-ghost" data-section-link="settings">Activity settings</button></div><div class="card-body">${recent.length ? `<div class="activity-list">${recent.map(activityItem).join('')}</div>` : emptyInline('No activity yet.', 'Activity will appear here when actions are logged.')}</div></div>
    <div class="card"><div class="card-header"><h3>Quick actions</h3></div><div class="card-body"><div class="quick-grid"><button class="quick-action" data-action="new-question">Create spiritual question</button><button class="quick-action" data-section-link="reports">Review pending reports</button><button class="quick-action" data-section-link="users">Manage users</button><button class="quick-action" data-section-link="settings">Backend configuration</button></div></div></div>
  </div>`;
  updateNavCounts();
}
function statCard(title,value,meta,icon,metaClass=''){return `<div class="stat-card"><div class="stat-top"><span class="stat-title">${esc(title)}</span><span class="stat-icon">${esc(icon)}</span></div><div class="stat-value">${esc(value)}</div><div class="stat-meta ${metaClass}">${esc(meta)}</div></div>`}
function activityItem(r){return `<div class="activity-item"><span class="activity-dot"></span><div><strong>${esc(r.action || r.type || 'Activity')}</strong><small>${esc(r.message || r.description || recordName(r))} · ${esc(formatDate(r.createdAt || r.timestamp || r.updatedAt))}</small></div></div>`}
function emptyInline(title, text){return `<div class="empty-state" style="padding:20px 0"><div class="empty-icon">—</div><h3>${esc(title)}</h3><p>${esc(text)}</p></div>`}

function getQuestionFields(q={}) { return { question: q.question || q.title || '', answer: q.answer || '', category: q.category || '', language: q.language || '', status: q.status || 'active', metadata: q.metadata ?? '' }; }
function renderQuestions() {
  const f = state.filters.questions; const all = normalizeRecords(state.data.questions); const categories = [...new Set(all.map(q => q.category).filter(Boolean).map(String))].sort(); const languages = [...new Set(all.map(q => q.language).filter(Boolean).map(String))].sort();
  let records = all.filter(q => { const s=f.search.toLowerCase(); const fields=getQuestionFields(q); return (!s || [fields.question,fields.answer,fields.category,fields.language].join(' ').toLowerCase().includes(s)) && (!f.category || String(fields.category)===f.category) && (!f.language || String(fields.language)===f.language) && (!f.status || String(fields.status).toLowerCase()===f.status.toLowerCase()); });
  records.sort((a,b) => f.sort==='alpha' ? String(getQuestionFields(a).question).localeCompare(String(getQuestionFields(b).question)) : f.sort==='oldest' ? timestampValue(a,['createdAt','created'])-timestampValue(b,['createdAt','created']) : timestampValue(b)-timestampValue(a));
  const page = paginate(records,f.page); f.page=page.page;
  $('questionsSection').innerHTML = `<div class="page-head"><div><h2>Spiritual Questions</h2><p>Create, review and maintain the question library.</p></div><div class="page-actions"><button class="btn btn-primary" data-action="new-question">Add question</button></div></div>
  <div class="toolbar"><div class="search-box"><span class="search-icon"></span><input id="questionSearch" value="${esc(f.search)}" placeholder="Search question, answer, category…" aria-label="Search spiritual questions"></div><select id="questionCategory" aria-label="Filter category"><option value="">All categories</option>${categories.map(v=>`<option ${f.category===v?'selected':''}>${esc(v)}</option>`).join('')}</select><select id="questionLanguage" aria-label="Filter language"><option value="">All languages</option>${languages.map(v=>`<option ${f.language===v?'selected':''}>${esc(v)}</option>`).join('')}</select><select id="questionStatus" aria-label="Filter status"><option value="">All status</option>${QUESTION_STATUSES.map(v=>`<option value="${v}" ${f.status===v?'selected':''}>${esc(v)}</option>`).join('')}</select><select id="questionSort" aria-label="Sort questions"><option value="newest" ${f.sort==='newest'?'selected':''}>Newest</option><option value="oldest" ${f.sort==='oldest'?'selected':''}>Oldest</option><option value="alpha" ${f.sort==='alpha'?'selected':''}>Alphabetical</option></select></div>
  <div class="card table-card">${records.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Question</th><th>Category</th><th>Language</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>${page.items.map(questionRow).join('')}</tbody></table></div><div class="mobile-list">${page.items.map(questionCard).join('')}</div>${pagination(page,'questions')}</div>` : emptyState('No questions found.','Try changing your filters or create a new spiritual question.','new-question')}</div>`;
  bindQuestionControls();
}
function questionRow(q){const f=getQuestionFields(q);return `<tr><td><div class="primary-cell">${esc(f.question||'Untitled')}</div><span class="sub-cell">${esc(String(f.answer||'').slice(0,90))}</span></td><td>${esc(safeText(f.category))}</td><td>${esc(safeText(f.language))}</td><td>${statusBadge(f.status)}</td><td>${esc(formatDate(q.updatedAt||q.updated||q.createdAt))}</td><td><div class="row-actions"><button class="mini-btn" data-action="edit-question" data-id="${esc(q.id)}" aria-label="Edit question">Edit</button><button class="mini-btn" data-action="delete-question" data-id="${esc(q.id)}" aria-label="Delete question">×</button></div></td></tr>`}
function questionCard(q){const f=getQuestionFields(q);return `<article class="mobile-record"><div class="record-top"><div class="record-title">${esc(f.question||'Untitled')}</div>${statusBadge(f.status)}</div><div class="record-meta">${esc(safeText(f.category))} · ${esc(safeText(f.language))}</div><div class="record-fields"><div class="record-field"><span>Updated</span><strong>${esc(formatDate(q.updatedAt||q.updated||q.createdAt))}</strong></div><div class="record-field"><span>Answer</span><strong>${esc(String(f.answer||'').slice(0,70)||'Not available')}</strong></div></div><div class="record-actions"><button class="btn btn-secondary" data-action="edit-question" data-id="${esc(q.id)}">Edit</button><button class="btn btn-danger" data-action="delete-question" data-id="${esc(q.id)}">Delete</button></div></article>`}
function bindQuestionControls(){[['questionSearch','search'],['questionCategory','category'],['questionLanguage','language'],['questionStatus','status'],['questionSort','sort']].forEach(([id,key])=>{const el=$(id); if(el) el.addEventListener(key==='search'?'input':'change',debounce((e)=>{state.filters.questions[key]=e.target.value;state.filters.questions.page=1;renderQuestions()}, key==='search'?180:0));});}

function getReportStatus(r){const value=String(r.status||'Pending'); return REPORT_STATUSES.includes(value)?value:'Pending'}
function renderReports(){const f=state.filters.reports;const all=normalizeRecords(state.data.reports);let records=all.filter(r=>{const s=f.search.toLowerCase();const text=[r.id,r.reportId,r.userId,r.user,r.email,r.type,r.description].map(v=>String(v||'')).join(' ').toLowerCase();const t=timestampValue(r,['createdAt','created','timestamp']);const dateOk=!f.date||new Date(t).toISOString().slice(0,10)===f.date;return(!s||text.includes(s))&&(!f.status||getReportStatus(r)===f.status)&&dateOk});records.sort((a,b)=>f.sort==='oldest'?timestampValue(a,['createdAt','created'])-timestampValue(b,['createdAt','created']):timestampValue(b)-timestampValue(a));const page=paginate(records,f.page);f.page=page.page;$('reportsSection').innerHTML=`<div class="page-head"><div><h2>Reports</h2><p>Review user-submitted reports and manage their lifecycle.</p></div></div><div class="toolbar"><div class="search-box"><span class="search-icon"></span><input id="reportSearch" value="${esc(f.search)}" placeholder="Search report, user, type, description…" aria-label="Search reports"></div><select id="reportStatus"><option value="">All status</option>${REPORT_STATUSES.map(v=>`<option ${f.status===v?'selected':''}>${esc(v)}</option>`).join('')}</select><input id="reportDate" type="date" value="${esc(f.date)}" aria-label="Filter reports by date"><select id="reportSort"><option value="newest" ${f.sort==='newest'?'selected':''}>Newest</option><option value="oldest" ${f.sort==='oldest'?'selected':''}>Oldest</option></select></div><div class="card table-card">${records.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>Report</th><th>User</th><th>Type</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>${page.items.map(reportRow).join('')}</tbody></table></div><div class="mobile-list">${page.items.map(reportCard).join('')}</div>${pagination(page,'reports')}`:emptyState('No reports available.','Reports submitted through your configured backend will appear here.','')}</div>`;bindReportControls()}
function reportRow(r){return`<tr><td><div class="primary-cell">${esc(r.reportId||r.id||'Report')}</div><span class="sub-cell">${esc(String(r.description||'').slice(0,85))}</span></td><td>${esc(r.userName||r.name||r.email||r.userId||'Not available')}</td><td>${esc(r.type||'Not available')}</td><td>${statusBadge(getReportStatus(r))}</td><td>${esc(formatDate(r.createdAt||r.created||r.timestamp))}</td><td><div class="row-actions"><button class="mini-btn" data-action="view-report" data-id="${esc(r.id)}">View</button><button class="mini-btn" data-action="delete-report" data-id="${esc(r.id)}">×</button></div></td></tr>`}
function reportCard(r){return`<article class="mobile-record"><div class="record-top"><div class="record-title">${esc(r.reportId||r.id||'Report')}</div>${statusBadge(getReportStatus(r))}</div><div class="record-meta">${esc(r.type||'Not available')} · ${esc(r.userName||r.email||r.userId||'Not available')}</div><div class="record-fields"><div class="record-field"><span>Created</span><strong>${esc(formatDate(r.createdAt||r.created||r.timestamp))}</strong></div><div class="record-field"><span>Description</span><strong>${esc(String(r.description||'').slice(0,80)||'Not available')}</strong></div></div><div class="record-actions"><button class="btn btn-secondary" data-action="view-report" data-id="${esc(r.id)}">Open</button><button class="btn btn-danger" data-action="delete-report" data-id="${esc(r.id)}">Delete</button></div></article>`}
function bindReportControls(){[['reportSearch','search'],['reportStatus','status'],['reportDate','date'],['reportSort','sort']].forEach(([id,key])=>{const el=$(id);if(el)el.addEventListener(key==='search'?'input':'change',debounce((e)=>{state.filters.reports[key]=e.target.value;state.filters.reports.page=1;renderReports()},key==='search'?180:0))})}

function renderUsers(){const f=state.filters.users;const all=normalizeRecords(state.data.users);let records=all.filter(u=>{const s=f.search.toLowerCase();const text=[u.id,u.uid,u.name,u.displayName,u.email,u.phone].map(v=>String(v||'')).join(' ').toLowerCase();const status=String(u.status||((u.active===true)?'Active':u.active===false?'Inactive':'')).toLowerCase();return(!s||text.includes(s))&&(!f.status||status===f.status.toLowerCase())});records.sort((a,b)=>timestampValue(b)-timestampValue(a));const page=paginate(records,f.page);f.page=page.page;$('usersSection').innerHTML=`<div class="page-head"><div><h2>Users</h2><p>Inspect user profiles and update only fields your rules permit.</p></div></div><div class="toolbar"><div class="search-box"><span class="search-icon"></span><input id="userSearch" value="${esc(f.search)}" placeholder="Search name, email or UID…" aria-label="Search users"></div><select id="userStatus"><option value="">All status</option><option value="active" ${f.status==='active'?'selected':''}>Active</option><option value="inactive" ${f.status==='inactive'?'selected':''}>Inactive</option></select></div><div class="card table-card">${records.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>User</th><th>Email</th><th>UID</th><th>Status</th><th>Created</th><th></th></tr></thead><tbody>${page.items.map(userRow).join('')}</tbody></table></div><div class="mobile-list">${page.items.map(userCard).join('')}</div>${pagination(page,'users')}`:emptyState('No users found.','Users will appear when the configured Firebase path contains records.','')}</div>`;bindUserControls()}
function userStatus(u){if(u.active===true||String(u.status||'').toLowerCase()==='active')return'active';if(u.active===false||String(u.status||'').toLowerCase()==='inactive')return'inactive';return''}
function userRow(u){const email=u.email||'Not available';return`<tr><td><div class="primary-cell">${esc(recordName(u))}</div><span class="sub-cell">${esc(u.phone||'Not available')}</span></td><td>${esc(email)}</td><td><span class="config-value">${esc(u.uid||u.id)}</span></td><td>${userStatus(u)?statusBadge(userStatus(u)):statusBadge('Unknown')}</td><td>${esc(formatDate(u.createdAt||u.created||u.creationTime))}</td><td><div class="row-actions"><button class="mini-btn" data-action="view-user" data-id="${esc(u.id)}">View</button><button class="mini-btn" data-action="edit-user" data-id="${esc(u.id)}">Edit</button><button class="mini-btn" data-action="delete-user" data-id="${esc(u.id)}">×</button></div></td></tr>`}
function userCard(u){return`<article class="mobile-record"><div class="record-top"><div class="record-title">${esc(recordName(u))}</div>${userStatus(u)?statusBadge(userStatus(u)):statusBadge('Unknown')}</div><div class="record-meta">${esc(u.email||'Not available')}</div><div class="record-fields"><div class="record-field"><span>UID</span><strong>${esc(u.uid||u.id)}</strong></div><div class="record-field"><span>Created</span><strong>${esc(formatDate(u.createdAt||u.created||u.creationTime))}</strong></div></div><div class="record-actions"><button class="btn btn-secondary" data-action="view-user" data-id="${esc(u.id)}">View</button><button class="btn btn-secondary" data-action="edit-user" data-id="${esc(u.id)}">Edit</button><button class="btn btn-danger" data-action="delete-user" data-id="${esc(u.id)}">Delete</button></div></article>`}
function bindUserControls(){[['userSearch','search'],['userStatus','status']].forEach(([id,key])=>{const el=$(id);if(el)el.addEventListener(key==='search'?'input':'change',debounce((e)=>{state.filters.users[key]=e.target.value;state.filters.users.page=1;renderUsers()},key==='search'?180:0))})}

function renderSettings(){const cfg=readConfig()||{paths:DEFAULT_PATHS};const backend=cfg.backendUrl||'';$('settingsSection').innerHTML=`<div class="page-head"><div><h2>Settings</h2><p>Configure local dashboard services. Firebase public web config is not a service-account secret.</p></div></div><div class="settings-grid"><div class="card settings-card"><h3>Backend Configuration</h3><p>The worker/API URL is stored only in this browser under a namespaced LocalStorage key.</p><div class="connection-state"><span class="status-dot ${backend?'ok':'bad'}"></span><span>${backend?'Configured':'Not Configured'}</span></div><div class="setting-row"><label for="backendUrl">Backend API URL</label><input id="backendUrl" type="url" value="${esc(backend)}" placeholder="https://your-worker.workers.dev" autocomplete="off"><small>Do not enter private credentials here. The browser cannot securely hide a secret stored in LocalStorage.</small></div><div class="settings-actions"><button class="btn btn-primary" data-action="save-backend">Save Configuration</button><button class="btn btn-secondary" data-action="test-backend">Test Connection</button><button class="btn btn-ghost" data-action="clear-backend">Clear Configuration</button></div><p id="apiTestResult" class="form-error"></p></div>
<div class="card settings-card"><h3>Firebase &amp; Database</h3><p>Keep the Firebase web config and schema paths configurable instead of assuming your existing database structure.</p><div class="setting-row"><label for="firebaseConfigSettings">Firebase config JSON</label><textarea id="firebaseConfigSettings" class="code-input" rows="10" spellcheck="false">${esc(JSON.stringify(cfg.firebase||{},null,2))}</textarea></div><div class="setting-row"><label for="usersPath">Users path</label><input id="usersPath" value="${esc(cfg.paths?.users||'users')}"></div><div class="setting-row"><label for="questionsPath">Questions path</label><input id="questionsPath" value="${esc(cfg.paths?.questions||'questions')}"></div><div class="setting-row"><label for="reportsPath">Reports path</label><input id="reportsPath" value="${esc(cfg.paths?.reports||'reports')}"></div><div class="setting-row"><label for="activityPath">Activity path</label><input id="activityPath" value="${esc(cfg.paths?.activity||'activity')}"></div><label class="switch-row"><input id="requireAdminClaim" type="checkbox" ${cfg.requireAdminClaim!==false?'checked':''}><span class="switch-ui"></span><span><strong>Require admin custom claim</strong><small>Recommended. Set <code>admin: true</code> on approved admin accounts.</small></span></label><div class="settings-actions"><button class="btn btn-primary" data-action="save-firebase">Save Firebase settings</button><button class="btn btn-secondary" data-action="reconnect-firebase">Reconnect</button></div></div>
<div class="card settings-card"><h3>Appearance</h3><p>Choose the dashboard theme. The preference is stored locally.</p><div class="toolbar"><button class="btn ${state.theme==='light'?'btn-primary':'btn-secondary'}" data-action="set-theme" data-theme-value="light">Light</button><button class="btn ${state.theme==='dark'?'btn-primary':'btn-secondary'}" data-action="set-theme" data-theme-value="dark">Dark</button><button class="btn ${state.theme==='system'?'btn-primary':'btn-secondary'}" data-action="set-theme" data-theme-value="system">System</button></div></div>
<div class="card settings-card danger-zone"><h3>Local Configuration</h3><p>Clear dashboard configuration from this browser. This does not delete anything from Firebase.</p><div class="settings-actions"><button class="btn btn-danger" data-action="clear-all-config">Clear local configuration</button></div></div></div>`}

function pagination(page, type){const start=page.total?((page.page-1)*PAGE_SIZE+1):0;const end=Math.min(page.page*PAGE_SIZE,page.total);return`<div class="pagination"><span class="pagination-info">${start}–${end} of ${page.total}</span><div class="pagination-buttons"><button class="mini-btn" data-page-type="${type}" data-page="${page.page-1}" ${page.page<=1?'disabled':''}>‹</button><button class="mini-btn" data-page-type="${type}" data-page="${page.page+1}" ${page.page>=page.pages?'disabled':''}>›</button></div></div>`}
function paginate(items,page){const total=items.length;const pages=Math.max(1,Math.ceil(total/PAGE_SIZE));const p=Math.min(Math.max(1,Number(page)||1),pages);return{items:items.slice((p-1)*PAGE_SIZE,p*PAGE_SIZE),total,pages,page:p}}
function emptyState(title,text,action){return`<div class="empty-state"><div class="empty-icon">JV</div><h3>${esc(title)}</h3><p>${esc(text)}</p>${action?`<button class="btn btn-primary" data-action="${esc(action)}">${action==='new-question'?'Create question':'Open'}</button>`:''}</div>`}
function statusBadge(status){const s=String(status||'Unknown');const cls=s.toLowerCase().replace(/\s+/g,'');return`<span class="status-badge ${esc(cls)}">${esc(s)}</span>`}
function debounce(fn,wait){let t;return(...args)=>{clearTimeout(t);t=setTimeout(()=>fn(...args),wait)}}

function modal({title,subtitle='',body='',footer='',small=false}){const root=$('modalRoot');root.innerHTML=`<div class="modal-backdrop" data-modal-backdrop><div class="modal ${small?'small':''}" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="modal-header"><div><h2 id="modalTitle">${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="icon-button" data-close-modal data-icon="close" aria-label="Close"></button></div><div class="modal-body">${body}</div>${footer?`<div class="modal-footer">${footer}</div>`:''}</div></div>`;const backdrop=root.firstElementChild;backdrop.addEventListener('click',(e)=>{if(e.target===backdrop)closeModal()});document.body.style.overflow='hidden';setTimeout(()=>root.querySelector('input,textarea,select,button')?.focus(),20)}
function closeModal(){ $('modalRoot').innerHTML='';document.body.style.overflow=''; }
function confirmDialog(title,message,confirmText='Delete'){return new Promise(resolve=>{modal({title,subtitle:'This action cannot be undone.',body:`<p class="muted">${esc(message)}</p>`,small:true,footer:`<button class="btn btn-secondary" data-confirm-cancel>Cancel</button><button class="btn btn-danger" data-confirm-ok>${esc(confirmText)}</button>`});$('modalRoot').querySelector('[data-confirm-cancel]').onclick=()=>{closeModal();resolve(false)};$('modalRoot').querySelector('[data-confirm-ok]').onclick=()=>{closeModal();resolve(true)}})}

function openQuestionModal(id=''){const existing=id?state.data.questions[id]:null;const q=getQuestionFields(existing||{});const isEdit=Boolean(id);modal({title:isEdit?'Edit spiritual question':'New spiritual question',subtitle:isEdit?'Update the selected record.':'Create a new record in the configured Firebase path.',body:`<form id="questionForm" novalidate><div class="form-grid"><div class="full"><label class="field-label" for="qQuestion">Question *</label><textarea id="qQuestion" required>${esc(q.question)}</textarea></div><div class="full"><label class="field-label" for="qAnswer">Answer *</label><textarea id="qAnswer" required>${esc(q.answer)}</textarea></div><div><label class="field-label" for="qCategory">Category</label><input id="qCategory" value="${esc(q.category)}"></div><div><label class="field-label" for="qLanguage">Language</label><input id="qLanguage" value="${esc(q.language)}"></div><div><label class="field-label" for="qStatus">Status</label><select id="qStatus">${QUESTION_STATUSES.map(v=>`<option ${q.status===v?'selected':''}>${v}</option>`).join('')}</select></div><div><label class="field-label" for="qMetadata">Metadata JSON</label><input id="qMetadata" value="${esc(isObject(q.metadata)?JSON.stringify(q.metadata):q.metadata||'')}"></div></div><p id="questionFormError" class="form-error"></p></form>`,footer:`<button class="btn btn-secondary" data-close-modal>Cancel</button><button class="btn btn-primary" data-save-question data-busy-key="save-question">${isEdit?'Update question':'Create question'}</button>`});$('modalRoot').querySelector('[data-save-question]').onclick=()=>saveQuestion(id)}
async function saveQuestion(id){const button=$('modalRoot').querySelector('[data-save-question]');if(state.busy.has('save-question'))return;const question=$('qQuestion').value.trim(),answer=$('qAnswer').value.trim();const err=$('questionFormError');if(!question||!answer){err.textContent='Question and answer are required.';return}let metadata=$('qMetadata').value.trim();if(metadata){try{metadata=JSON.parse(metadata)}catch{err.textContent='Metadata must be valid JSON.';return}}else metadata={};requireOnline();setBusy('save-question',true);try{const data={question,answer,category:$('qCategory').value.trim(),language:$('qLanguage').value.trim(),status:$('qStatus').value,metadata,updatedAt:serverTimestamp()};if(!id){data.createdAt=serverTimestamp();data.createdBy=state.user.uid;await FirebaseService.create(pathFor('questions'),data);await logActivity('Question created',question)}else{await FirebaseService.update(pathFor('questions',id),data);await logActivity('Question updated',question)}closeModal();toast(id?'Question updated successfully':'Question created successfully');}catch(error){console.error(error);err.textContent=humanError(error);toast('Question save failed','error',humanError(error))}finally{setBusy('save-question',false)}}
async function deleteQuestion(id){const q=state.data.questions[id];if(!await confirmDialog('Delete this spiritual question?',`Permanently delete “${getQuestionFields(q).question||id}”?`,'Delete'))return;requireOnline();try{await FirebaseService.remove(pathFor('questions',id));await logActivity('Question deleted',getQuestionFields(q).question||id);toast('Question deleted successfully')}catch(error){console.error(error);toast('Question deletion failed','error',humanError(error))}}

function openReportModal(id){const r=state.data.reports[id];if(!r)return;modal({title:`Report ${r.reportId||id}`,subtitle:'Review details and update status.',body:`<div class="detail-grid"><div class="detail-item"><span>Report ID</span><strong>${esc(r.reportId||id)}</strong></div><div class="detail-item"><span>Status</span><strong>${statusBadge(getReportStatus(r))}</strong></div><div class="detail-item"><span>User</span><strong>${esc(r.userName||r.email||r.userId||'Not available')}</strong></div><div class="detail-item"><span>Type</span><strong>${esc(r.type||'Not available')}</strong></div><div class="detail-item"><span>Created</span><strong>${esc(formatDate(r.createdAt||r.created||r.timestamp))}</strong></div><div class="detail-item"><span>Updated</span><strong>${esc(formatDate(r.updatedAt||r.updated))}</strong></div></div><div class="setting-row"><label for="reportStatusEdit">Status</label><select id="reportStatusEdit">${REPORT_STATUSES.map(v=>`<option ${getReportStatus(r)===v?'selected':''}>${esc(v)}</option>`).join('')}</select></div><div class="setting-row"><label for="reportResponse">Admin response</label><textarea id="reportResponse" placeholder="Optional response supported by your database schema">${esc(r.adminResponse||r.response||'')}</textarea></div><div class="setting-row"><label>Description</label><div class="json-block">${esc(r.description||'Not available')}</div></div><div class="setting-row"><label>Additional Firebase fields</label><div class="json-block">${esc(JSON.stringify(r,null,2))}</div></div><p id="reportFormError" class="form-error"></p>`,footer:`<button class="btn btn-secondary" data-close-modal>Close</button><button class="btn btn-primary" data-update-report data-busy-key="update-report">Save changes</button>`});$('modalRoot').querySelector('[data-update-report]').onclick=()=>updateReport(id)}
async function updateReport(id){if(state.busy.has('update-report'))return;requireOnline();setBusy('update-report',true);try{const status=$('reportStatusEdit').value,response=$('reportResponse').value.trim();const patch={status,updatedAt:serverTimestamp()};if(response)patch.adminResponse=response;else if(state.data.reports[id]?.adminResponse!==undefined)patch.adminResponse='';await FirebaseService.update(pathFor('reports',id),patch);await logActivity('Report status changed',`${id} → ${status}`);closeModal();toast('Report status updated')}catch(error){console.error(error);$('reportFormError').textContent=humanError(error);toast('Report update failed','error',humanError(error))}finally{setBusy('update-report',false)}}
async function deleteReport(id){if(!await confirmDialog('Delete this report?',`Permanently delete report “${id}”?`,'Delete'))return;requireOnline();try{await FirebaseService.remove(pathFor('reports',id));await logActivity('Report deleted',id);toast('Report deleted')}catch(error){console.error(error);toast('Report deletion failed','error',humanError(error))}}

function openUserModal(id,edit=false){const user=state.data.users[id];if(!user)return;const fields=Object.entries(user).filter(([k])=>k!=='id');const editable=['name','displayName','phone','status','active'];if(edit){modal({title:`Edit ${recordName(user)}`,subtitle:'Only permitted profile fields are editable from this dashboard.',body:`<form id="userEditForm"><div class="form-grid">${editable.map(k=>`<div><label class="field-label" for="user_${esc(k)}">${esc(k)}</label><input id="user_${esc(k)}" value="${esc(user[k] ?? '')}"></div>`).join('')}</div><p id="userFormError" class="form-error"></p></form>`,footer:`<button class="btn btn-secondary" data-close-modal>Cancel</button><button class="btn btn-primary" data-update-user data-busy-key="update-user">Save changes</button>`});$('modalRoot').querySelector('[data-update-user]').onclick=()=>updateUser(id);return}
modal({title:'User Profile',subtitle:recordName(user),body:`<div class="profile-hero"><div class="profile-avatar">${esc((recordName(user)[0]||'U').toUpperCase())}</div><div><h3>${esc(recordName(user))}</h3><p>${esc(user.email||'Not available')}</p></div></div><div class="detail-grid"><div class="detail-item"><span>UID</span><strong>${esc(user.uid||id)}</strong></div><div class="detail-item"><span>Status</span><strong>${userStatus(user)?statusBadge(userStatus(user)):statusBadge('Unknown')}</strong></div><div class="detail-item"><span>Created</span><strong>${esc(formatDate(user.createdAt||user.created||user.creationTime))}</strong></div><div class="detail-item"><span>Last active</span><strong>${esc(formatDate(user.lastActive||user.lastActivity||user.updatedAt))}</strong></div></div><div class="setting-row"><label>User Data</label><div class="json-block">${esc(JSON.stringify(user,null,2))}</div></div>`,footer:`<button class="btn btn-secondary" data-close-modal>Close</button><button class="btn btn-primary" data-edit-user-modal>Edit user</button>`});$('modalRoot').querySelector('[data-edit-user-modal]').onclick=()=>{closeModal();openUserModal(id,true)}}
async function updateUser(id){if(state.busy.has('update-user'))return;requireOnline();setBusy('update-user',true);try{const patch={};['name','displayName','phone','status'].forEach(k=>{const el=$(`user_${k}`);if(el)patch[k]=el.value.trim()});const active=$('user_active');if(active)patch.active=active.value==='true';await FirebaseService.update(pathFor('users',id),patch);await logActivity('User updated',id);closeModal();toast('User updated')}catch(error){console.error(error);$('userFormError').textContent=humanError(error);toast('User update failed','error',humanError(error))}finally{setBusy('update-user',false)}}
async function deleteUser(id){if(!await confirmDialog('Delete this user?',`Permanently delete user data for “${id}”? This does not delete the Firebase Authentication account unless your secure backend also handles that operation.`,'Delete'))return;requireOnline();try{await FirebaseService.remove(pathFor('users',id));await logActivity('User deleted',id);toast('User deleted')}catch(error){console.error(error);toast('User deletion failed','error',humanError(error))}}

async function logActivity(action,message){const cfg=readConfig();if(!cfg?.paths?.activity||!state.db||!state.user)return;try{await FirebaseService.create(pathFor('activity'),{action,message,actorUid:state.user.uid,actorEmail:state.user.email||null,createdAt:serverTimestamp()})}catch(error){console.warn('Activity logging failed:',error)}}
function humanError(error){const code=error?.code||'';const map={'PERMISSION_DENIED':'Firebase permission denied. Check Security Rules and admin authorization.','permission-denied':'Firebase permission denied. Check Security Rules and admin authorization.','auth/invalid-credential':'Email or password is incorrect.','auth/invalid-email':'Enter a valid email address.','auth/too-many-requests':'Too many attempts. Try again later.','NETWORK_ERROR':'Network request failed.'};return map[code]||error?.message||'An unexpected error occurred.'}

function bindPagination(){document.addEventListener('click',(e)=>{const b=e.target.closest('[data-page-type]');if(!b||b.disabled)return;const type=b.dataset.pageType;state.filters[type].page=Number(b.dataset.page);if(type==='questions')renderQuestions();if(type==='reports')renderReports();if(type==='users')renderUsers()})}
function bindGlobalActions(){document.addEventListener('click',async(e)=>{const actionEl=e.target.closest('[data-action]');const sectionEl=e.target.closest('[data-section-link]');const close=e.target.closest('[data-close-modal]');if(close){closeModal();return}if(sectionEl){setSection(sectionEl.dataset.sectionLink);return}if(!actionEl)return;const action=actionEl.dataset.action;try{if(action==='refresh'){await loadSection(state.currentSection,true);toast('Data refreshed')}else if(action==='new-question')openQuestionModal();else if(action==='edit-question')openQuestionModal(actionEl.dataset.id);else if(action==='delete-question')await deleteQuestion(actionEl.dataset.id);else if(action==='view-report')openReportModal(actionEl.dataset.id);else if(action==='delete-report')await deleteReport(actionEl.dataset.id);else if(action==='view-user')openUserModal(actionEl.dataset.id);else if(action==='edit-user')openUserModal(actionEl.dataset.id,true);else if(action==='delete-user')await deleteUser(actionEl.dataset.id);else if(action==='save-backend')saveBackend();else if(action==='test-backend')testBackend();else if(action==='clear-backend')clearBackend();else if(action==='save-firebase')saveFirebaseSettings();else if(action==='reconnect-firebase')await reconnectFirebase();else if(action==='set-theme'){state.theme=actionEl.dataset.themeValue;localStorage.setItem(THEME_KEY,state.theme);initTheme();renderSettings();}else if(action==='clear-all-config')await clearAllConfig();}catch(error){console.error(error);toast('Operation failed','error',humanError(error))}})}
function saveBackend(){const input=$('backendUrl');if(!input)return;const value=input.value.trim();if(value&&!isValidUrl(value)){$('apiTestResult').textContent='Enter a valid http:// or https:// URL.';return}const cfg=readConfig()||{firebase:{},paths:DEFAULT_PATHS};cfg.backendUrl=value;writeConfig(cfg);toast('Configuration saved');renderSettings();}
async function testBackend(){const out=$('apiTestResult');if(!out)return;try{requireOnline();setBusy('test-backend',true);out.textContent='Testing connection…';await APIClient.testConnection();state.apiStatus='ok';out.style.color='var(--success)';out.textContent='Backend connection successful.';toast('Backend connected')}catch(error){state.apiStatus='bad';out.style.color='var(--danger)';out.textContent=humanError(error);toast('Backend connection failed','error',humanError(error))}finally{setBusy('test-backend',false)}}
function clearBackend(){const cfg=readConfig()||{firebase:{},paths:DEFAULT_PATHS};delete cfg.backendUrl;writeConfig(cfg);toast('Backend configuration cleared','success');renderSettings()}
async function saveFirebaseSettings(){const err=document.querySelector('#settingsSection .form-error');try{const firebaseConfig=JSON.parse($('firebaseConfigSettings').value);validateFirebaseConfig(firebaseConfig);const cfg=readConfig()||{};cfg.firebase=firebaseConfig;cfg.paths={users:$('usersPath').value.trim()||'users',questions:$('questionsPath').value.trim()||'questions',reports:$('reportsPath').value.trim()||'reports',activity:$('activityPath').value.trim()||'activity'};cfg.requireAdminClaim=$('requireAdminClaim').checked;writeConfig(cfg);await reconnectFirebase();toast('Firebase configuration saved')}catch(error){console.error(error);if(err)err.textContent=humanError(error);toast('Firebase settings could not be saved','error',humanError(error))}}
async function reconnectFirebase(){requireOnline();const cfg=readConfig();if(!cfg?.firebase){showSetup();return}setGlobalLoader(true,'Connecting to Firebase…');try{await FirebaseService.initialize(cfg);setupListeners();toast('Firebase connected')}catch(error){console.error(error);toast('Firebase connection failed','error',humanError(error))}finally{setGlobalLoader(false)}}
async function clearAllConfig(){if(!await confirmDialog('Clear local dashboard configuration?','This removes the locally stored Firebase and backend configuration from this browser. Firebase data itself will not be deleted.','Clear configuration'))return;FirebaseService.cleanupAll();if(state.auth)await signOut(state.auth).catch(()=>{});clearConfig();showSetup();toast('Local configuration cleared','success')}

function initSetupForm(){const cfg=readConfig();if(cfg){$('firebaseConfigInput').value=JSON.stringify(cfg.firebase||{},null,2);$('setupUsersPath').value=cfg.paths?.users||'users';$('setupQuestionsPath').value=cfg.paths?.questions||'questions';$('setupReportsPath').value=cfg.paths?.reports||'reports';$('setupActivityPath').value=cfg.paths?.activity||'activity';$('setupRequireAdmin').checked=cfg.requireAdminClaim!==false}}
async function submitSetup(e){e.preventDefault();const err=$('setupError');err.textContent='';try{const firebaseConfig=JSON.parse($('firebaseConfigInput').value);validateFirebaseConfig(firebaseConfig);const cfg={firebase:firebaseConfig,backendUrl:readConfig()?.backendUrl||'',paths:{users:$('setupUsersPath').value.trim()||'users',questions:$('setupQuestionsPath').value.trim()||'questions',reports:$('setupReportsPath').value.trim()||'reports',activity:$('setupActivityPath').value.trim()||'activity'},requireAdminClaim:$('setupRequireAdmin').checked};writeConfig(cfg);setGlobalLoader(true,'Initializing Firebase…');await FirebaseService.initialize(cfg);setupListeners();showAuth();toast('Configuration saved');}catch(error){console.error(error);err.textContent=humanError(error)}finally{setGlobalLoader(false)}}

function bindUI(){
  $('loginForm').addEventListener('submit',async(e)=>{e.preventDefault();$('loginError').textContent='';if(!navigator.onLine){$('loginError').textContent='You are offline.';return}const email=$('loginEmail').value.trim(),password=$('loginPassword').value;if(!email||!password){$('loginError').textContent='Enter your email and password.';return}if(!state.auth){$('loginError').textContent='Firebase is not configured. Open Firebase setup.';return}setBusy('login',true);$('loginButton').dataset.busyKey='login';try{await signInWithEmailAndPassword(state.auth,email,password)}catch(error){console.error('Login failed:',error);$('loginError').textContent=humanError(error)}finally{setBusy('login',false)}});
  $('setupForm').addEventListener('submit',submitSetup);$('setupDemoReset').addEventListener('click',()=>{clearConfig();initSetupForm();toast('Local setup cleared','success')});$('openSetupFromLogin').addEventListener('click',()=>{initSetupForm();showSetup()});$('themeCycle').addEventListener('click',cycleTheme);$('refreshButton').dataset.icon='refresh';$('refreshButton').addEventListener('click',()=>loadSection(state.currentSection,true).then(()=>toast('Data refreshed')).catch(e=>toast('Refresh failed','error',humanError(e))));$('menuButton').dataset.icon='menu';$('menuButton').addEventListener('click',openSidebar);$('sidebarClose').dataset.icon='close';$('sidebarClose').addEventListener('click',closeSidebar);$('sidebarBackdrop').addEventListener('click',closeSidebar);$('profileButton').addEventListener('click',()=>{const p=$('profilePopover');p.classList.toggle('hidden');$('profileButton').setAttribute('aria-expanded',String(p.classList.contains('hidden')===false))});$('profileSignOut').addEventListener('click',()=>signOut(state.auth));$('signOutButton').addEventListener('click',()=>signOut(state.auth));document.querySelectorAll('.nav-item[data-section]').forEach(el=>el.addEventListener('click',()=>setSection(el.dataset.section)));document.querySelector('[data-close-modal]')?.addEventListener('click',closeModal);bindGlobalActions();bindPagination();window.addEventListener('keydown',(e)=>{if(e.key==='Escape')closeModal()});window.addEventListener('online',setNetworkState);window.addEventListener('offline',setNetworkState);
}
function openSidebar(){$('sidebar').classList.add('open');$('sidebarBackdrop').classList.remove('hidden')}
function closeSidebar(){$('sidebar').classList.remove('open');$('sidebarBackdrop').classList.add('hidden')}

async function boot(){
  initTheme();setNetworkState();bindUI();$('refreshButton').dataset.icon='refresh';
  const cfg=readConfig();
  if(!cfg?.firebase){showSetup();initSetupForm();return}
  try{setGlobalLoader(true,'Initializing services…');await FirebaseService.initialize(cfg);setupListeners();showAuth();}catch(error){console.error('Firebase initialization failed:',error);showSetup();initSetupForm();$('setupError').textContent=humanError(error)}finally{setGlobalLoader(false)}
}

boot().catch(error=>{console.error('Fatal dashboard boot error:',error);showSetup();$('setupError').textContent='Dashboard could not initialize. Check the browser console for technical details.'});
