'use strict';
/* OPTIM LeadFlow CRM - server
 * Express (REST API) + Socket.IO (real-time) + JSON-file storage.
 * Every change is saved on the server, then pushed instantly to every
 * connected browser that is allowed to see it (admins: everything,
 * staff: only their own leads and calls).
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = +process.env.PORT || 3000;
const TZ = process.env.APP_TZ || 'Asia/Kolkata';           // used for "today" on the server
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const TOKEN_TTL = 12 * 60 * 60 * 1000;                     // 12 hours
const DEFAULT_STATUSES = ['Very Interested', 'Interested', 'Call Again', 'Not Attending', 'Not Interested', 'Pending'];

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- security helpers ---------- */
function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  try { return fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch (e) { /* create below */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

function hashPass(p) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(p, salt, 64).toString('hex');
}
function checkPass(p, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(p, salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(userId) {
  const p = Buffer.from(userId).toString('base64url') + '.' + (Date.now() + TOKEN_TTL);
  return p + '.' + sign(p);
}
function userFromToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const p = parts[0] + '.' + parts[1];
  const a = Buffer.from(parts[2]), b = Buffer.from(sign(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (+parts[1] < Date.now()) return null;
  const id = Buffer.from(parts[0], 'base64url').toString();
  return db.users.find(u => u.id === id) || null;
}

/* ---------- storage ---------- */
function seed() {
  const pass = process.env.ADMIN_PASSWORD || 'admin123';
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('WARNING: using the default admin password "admin123". Set ADMIN_PASSWORD before first start for real use.');
  }
  return {
    seq: 0,
    users: [{ id: 'admin', pass: hashPass(pass), name: 'Administrator', role: 'Admin' }],
    sources: [], leads: [], calls: [], statuses: [...DEFAULT_STATUSES]
  };
}
function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;                       // corrupt file: stop, never overwrite it
    const d = seed();
    fs.writeFileSync(DB_FILE, JSON.stringify(d));
    return d;
  }
}
const db = load();

let saveTimer = null;
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);                              // atomic replace
}
function persist() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 250); }
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { try { flush(); } finally { process.exit(0); } }));

/* ---------- small helpers ---------- */
const str = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
const nextId = () => ++db.seq;
const isAdmin = u => u.role === 'Admin';
const pub = u => ({ id: u.id, name: u.name, role: u.role });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^\d{2}:\d{2}$/;
const okDate = v => (DATE_RE.test(v) ? v : '');
const okTime = v => (TIME_RE.test(v) ? v : '');
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

function newLead(f, assignedTo) {
  return {
    id: nextId(), name: f.name, className: f.className || '', phone1: f.phone1 || '', phone2: f.phone2 || '',
    source: f.source || '', campus: f.campus || '', status: 'Pending', active: true, assignedTo,
    lastCall: '', nextDate: '', nextTime: '', createdAt: new Date().toISOString()
  };
}

/* ---------- app + sockets ---------- */
const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);     // set when running behind nginx / a PaaS proxy
app.disable('x-powered-by');
const server = http.createServer(app);
const ORIGINS = (process.env.ALLOWED_ORIGIN || '*').split(',').map(x => x.trim().replace(/\/$/, '')).filter(Boolean);
const ANY = ORIGINS.includes('*');
const io = new Server(server, { cors: { origin: ANY ? '*' : ORIGINS } });

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use((req, res, next) => {                               // CORS for the Netlify front-end
  const o = req.headers.origin;
  if (o && (ANY || ORIGINS.includes(o))) {
    res.setHeader('Access-Control-Allow-Origin', ANY ? '*' : o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '8mb' }));

const toAdmins = (ev, d, by) => io.to('admins').emit(ev, { d, by });
const toUser = (id, ev, d, by) => { if (id) io.to('u:' + id).emit(ev, { d, by }); };

/* changes = [{ lead, prev }]  prev = previous assignee ('' if none) */
function emitLeadChanges(changes, by) {
  if (!changes.length) return;
  toAdmins('leads:upsert', changes.map(c => c.lead), by);
  const up = {}, rm = {};
  for (const { lead, prev } of changes) {
    if (lead.assignedTo) (up[lead.assignedTo] = up[lead.assignedTo] || []).push(lead);
    if (prev && prev !== lead.assignedTo) (rm[prev] = rm[prev] || []).push(lead.id);
  }
  for (const k in up) toUser(k, 'leads:upsert', up[k], by);
  for (const k in rm) toUser(k, 'leads:remove', rm[k], by);
}

/* ---------- auth ---------- */
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const u = userFromToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!u) return res.status(401).json({ error: 'Unauthorized' });
  req.user = u;
  next();
}
const adminOnly = (req, res, next) => (isAdmin(req.user) ? next() : res.status(403).json({ error: 'Admin only' }));

const attempts = new Map();
app.post('/api/login', (req, res) => {
  const now = Date.now();
  let a = attempts.get(req.ip);
  if (!a || now - a.t > 10 * 60 * 1000) a = { n: 0, t: now };
  if (a.n >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const b = req.body || {};
  const u = db.users.find(x => x.id === str(b.id, 32).toLowerCase());
  if (!u || !checkPass(String(b.pass || ''), u.pass)) {
    a.n++; attempts.set(req.ip, a);
    return res.status(401).json({ error: 'Invalid login ID or password' });
  }
  attempts.delete(req.ip);
  res.json({ token: makeToken(u.id), me: pub(u) });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

/* ---------- read ---------- */
app.get('/api/bootstrap', auth, (req, res) => {
  const u = req.user, admin = isAdmin(u);
  res.json({
    me: pub(u),
    users: admin ? db.users.map(pub) : [pub(u)],
    sources: db.sources,
    statuses: db.statuses,
    leads: admin ? db.leads : db.leads.filter(l => l.assignedTo === u.id),
    calls: admin ? db.calls : db.calls.filter(c => c.staff === u.id),
    online: admin ? [...online.keys()] : []
  });
});

/* ---------- leads ---------- */
app.post('/api/leads', auth, (req, res) => {
  const b = req.body || {}, name = str(b.name), source = str(b.source);
  if (!name) return res.status(400).json({ error: 'Enter name' });
  if (source && !db.sources.some(s => s.name === source)) return res.status(400).json({ error: 'Unknown school/college' });
  const lead = newLead({
    name, className: str(b.className), phone1: str(b.phone1, 30), phone2: str(b.phone2, 30),
    source, campus: str(b.campus)
  }, isAdmin(req.user) ? '' : req.user.id);                 // staff-created leads belong to that staff member
  db.leads.push(lead); persist();
  emitLeadChanges([{ lead, prev: '' }], req.user.id);
  res.json({ lead });
});

app.post('/api/leads/import', auth, adminOnly, (req, res) => {
  const { source, rows } = req.body || {};
  if (!db.sources.some(s => s.name === source)) return res.status(400).json({ error: 'Select a school/college' });
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows to import' });
  if (rows.length > 10000) return res.status(400).json({ error: 'Maximum 10,000 rows per import' });
  const leads = [];
  for (const r of rows) {
    const name = str(r && r.name);
    if (!name) continue;
    const lead = newLead({ name, className: str(r.className), phone1: str(r.phone1, 30), phone2: str(r.phone2, 30), source }, '');
    leads.push(lead); db.leads.push(lead);
  }
  persist();
  emitLeadChanges(leads.map(lead => ({ lead, prev: '' })), req.user.id);
  res.json({ count: leads.length, leads });
});

app.post('/api/leads/assign', auth, adminOnly, (req, res) => {
  const { ids, staff } = req.body || {};
  const target = db.users.find(u => u.id === staff && !isAdmin(u));
  if (!target) return res.status(400).json({ error: 'Select a staff member' });
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Select at least one lead' });
  const set = new Set(ids.map(Number)), changes = [];
  for (const l of db.leads) {
    if (set.has(l.id) && l.assignedTo !== target.id) { changes.push({ lead: l, prev: l.assignedTo }); l.assignedTo = target.id; }
  }
  persist();
  emitLeadChanges(changes, req.user.id);
  res.json({ leads: changes.map(c => c.lead) });
});

/* ---------- calls ---------- */
app.post('/api/calls', auth, (req, res) => {
  const u = req.user, b = req.body || {};
  const lead = db.leads.find(l => l.id === +b.leadId);
  if (!lead || (!isAdmin(u) && lead.assignedTo !== u.id)) return res.status(403).json({ error: 'This lead is not available to you (it may have been reassigned).' });
  const status = str(b.status, 40);
  if (!db.statuses.includes(status)) return res.status(400).json({ error: 'Invalid call outcome' });
  const nextDate = okDate(b.nextDate), nextTime = okTime(b.nextTime), date = todayStr();
  lead.status = status; lead.nextDate = nextDate; lead.nextTime = nextTime; lead.lastCall = date;
  const call = {
    id: nextId(), lead: lead.id, name: lead.name, staff: u.id, date, ts: new Date().toISOString(),
    status, nextDate, nextTime, remarks: str(b.remarks, 1000)
  };
  db.calls.push(call); persist();
  emitLeadChanges([{ lead, prev: lead.assignedTo }], u.id);
  toAdmins('call:new', call, u.id);
  if (!isAdmin(u)) toUser(u.id, 'call:new', call, u.id);
  res.json({ lead, call });
});

/* ---------- schools / colleges ---------- */
app.post('/api/sources', auth, adminOnly, (req, res) => {
  const b = req.body || {}, name = str(b.name);
  if (!name) return res.status(400).json({ error: 'Enter a name' });
  if (db.sources.some(s => sameName(s.name, name))) return res.status(400).json({ error: 'This school/college already exists' });
  const s = { id: nextId(), type: b.type === 'College' ? 'College' : 'School', name, campus: str(b.campus) };
  db.sources.push(s); persist();
  io.emit('source:upsert', { d: s, by: req.user.id });
  res.json({ source: s });
});
app.delete('/api/sources/:id', auth, adminOnly, (req, res) => {
  const id = +req.params.id;
  db.sources = db.sources.filter(s => s.id !== id); persist();
  io.emit('source:remove', { d: id, by: req.user.id });
  res.json({ ok: true });
});

/* ---------- staff ---------- */
app.post('/api/users', auth, adminOnly, (req, res) => {
  const b = req.body || {};
  const id = str(b.id, 32).toLowerCase(), name = str(b.name, 80), pass = String(b.pass || '');
  const role = b.role === 'Manager' ? 'Manager' : 'Telecaller';
  if (!id || !name || !pass) return res.status(400).json({ error: 'Complete all fields' });
  if (!/^[a-z0-9_.-]{2,32}$/.test(id)) return res.status(400).json({ error: 'Login ID: 2-32 letters, numbers, dot, dash or underscore' });
  if (pass.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (db.users.some(u => u.id === id)) return res.status(400).json({ error: 'Login ID already exists' });
  const u = { id, pass: hashPass(pass), name, role };
  db.users.push(u); persist();
  toAdmins('user:upsert', pub(u), req.user.id);
  res.json({ user: pub(u) });
});

/* ---------- call outcomes ---------- */
app.post('/api/statuses', auth, adminOnly, (req, res) => {
  const name = str(req.body && req.body.name, 40);
  if (!name) return res.status(400).json({ error: 'Enter an outcome name' });
  if (db.statuses.some(s => sameName(s, name))) return res.status(400).json({ error: 'Outcome already exists' });
  db.statuses.push(name); persist();
  io.emit('statuses:set', { d: db.statuses, by: req.user.id });
  res.json({ statuses: db.statuses });
});
app.post('/api/statuses/remove', auth, adminOnly, (req, res) => {
  const name = str(req.body && req.body.name, 40);
  if (DEFAULT_STATUSES.includes(name)) return res.status(400).json({ error: 'Built-in outcomes cannot be removed' });
  db.statuses = db.statuses.filter(s => s !== name); persist();
  io.emit('statuses:set', { d: db.statuses, by: req.user.id });
  res.json({ statuses: db.statuses });
});

/* ---------- one-time import of the old browser-only data ---------- */
app.post('/api/migrate', auth, adminOnly, (req, res) => {
  const o = req.body || {}, arr = k => (Array.isArray(o[k]) ? o[k] : []);
  const added = { users: 0, sources: 0, leads: 0, calls: 0 };
  for (const u of arr('users')) {
    const id = str(u.id, 32).toLowerCase();
    if (!id || id === 'admin' || u.role === 'Admin' || db.users.some(x => x.id === id)) continue;
    db.users.push({ id, pass: hashPass(String(u.pass || '1234')), name: str(u.name, 80) || id, role: u.role === 'Manager' ? 'Manager' : 'Telecaller' });
    added.users++;
  }
  for (const s of arr('sources')) {
    const name = str(s.name);
    if (!name || db.sources.some(x => sameName(x.name, name))) continue;
    db.sources.push({ id: nextId(), type: s.type === 'College' ? 'College' : 'School', name, campus: str(s.campus) });
    added.sources++;
  }
  for (const st of arr('statuses')) { const n = str(st, 40); if (n && !db.statuses.includes(n)) db.statuses.push(n); }
  const idMap = new Map();
  for (const l of arr('leads')) {
    const name = str(l.name);
    if (!name) continue;
    const id = nextId(); idMap.set(l.id, id);
    const at = str(l.assignedTo, 32).toLowerCase();
    db.leads.push({
      id, name, className: str(l.className), phone1: str(l.phone1, 30), phone2: str(l.phone2, 30),
      source: str(l.source), campus: str(l.campus), status: db.statuses.includes(l.status) ? l.status : 'Pending',
      active: l.active !== false, assignedTo: db.users.some(u => u.id === at && !isAdmin(u)) ? at : '',
      lastCall: okDate(l.lastCall), nextDate: okDate(l.nextDate), nextTime: okTime(l.nextTime), createdAt: new Date().toISOString()
    });
    added.leads++;
  }
  for (const c of arr('calls')) {
    const lead = idMap.get(c.lead);
    if (!lead) continue;
    db.calls.push({
      id: nextId(), lead, name: str(c.name), staff: str(c.staff, 32).toLowerCase(), date: okDate(c.date) || todayStr(),
      ts: typeof c.ts === 'string' ? c.ts.slice(0, 40) : new Date().toISOString(), status: str(c.status, 40) || 'Pending',
      nextDate: okDate(c.nextDate), nextTime: okTime(c.nextTime), remarks: str(c.remarks, 1000)
    });
    added.calls++;
  }
  persist();
  io.emit('resync');
  res.json(added);
});

/* ---------- sockets: auth + presence ---------- */
const online = new Map();                                   // userId -> open connections
io.use((socket, next) => {
  const u = userFromToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!u) return next(new Error('unauthorized'));
  socket.user = u;
  next();
});
io.on('connection', socket => {
  const u = socket.user;
  socket.join('u:' + u.id);
  if (isAdmin(u)) socket.join('admins');
  online.set(u.id, (online.get(u.id) || 0) + 1);
  toAdmins('presence', [...online.keys()]);
  socket.on('disconnect', () => {
    const n = (online.get(u.id) || 1) - 1;
    if (n > 0) online.set(u.id, n); else online.delete(u.id);
    toAdmins('presence', [...online.keys()]);
  });
});

/* ---------- root + errors ---------- */
app.get('/', (req, res) => res.send('OPTIM LeadFlow API is running'));
app.use((err, req, res, next) => {                          // eslint-disable-line no-unused-vars
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'File too large' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: 'Bad request' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

server.listen(PORT, () => console.log('OPTIM LeadFlow running on http://localhost:' + PORT));
