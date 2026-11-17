/* Highline – theo dõi tiến độ sản xuất theo assembly trên Trimble Connect
 * SEICO · Phòng Thiết kế Sản xuất
 * Dữ liệu khai báo lưu trong thư mục HIGHLINE_DATA của dự án Trimble Connect,
 * mỗi người dùng 1 file nhật ký (HL_<userId>.json) để không ghi đè lẫn nhau.
 */
"use strict";

/* ===================== CẤU HÌNH ===================== */
const DATA_FOLDER = "HIGHLINE_DATA";
const CONFIG_FILE = "HL_config.json";
const USER_FILE_PREFIX = "HL_u_";
const REGIONS_URL = "https://app.connect.trimble.com/tc/api/2.0/regions";
const AUTO_REFRESH_MS = 120000;
const SAVE_DELAY_MS = 2500;

const DEFAULT_STAGES = [
  { name: "Cắt phôi",        short: "CP", color: "#FDD835" },
  { name: "Hàn tổ hợp",      short: "HT", color: "#FB8C00" },
  { name: "Gá tổ hợp",       short: "GA", color: "#E53935" },
  { name: "Hàn hoàn thiện",  short: "HH", color: "#8E24AA" },
  { name: "Làm sạch + sơn",  short: "SƠ", color: "#1E88E5" },
  { name: "Cấp hàng",        short: "CH", color: "#00ACC1" },
  { name: "Lắp dựng",        short: "LD", color: "#43A047" },
];
const C_NONE = "#B0BEC5", C_READY = "#F5F5F5", C_NOTREADY = "#607D8B", C_BAD = "#D50000", C_OK = "#CFD8DC";

/* ===================== TRẠNG THÁI ===================== */
const S = {
  host: null, demo: false,
  user: { id: "", name: "", email: "" }, isAdmin: false, members: [],
  items: [], byGuid: new Map(), byKey: new Map(), childKey: new Map(), marks: new Map(),
  events: [], eventIds: new Set(), myEvents: [], state: new Map(),
  config: { stages: DEFAULT_STAGES.map(s => ({ ...s })), perm: {} },
  tab: "decl", view: "overview",
  list: null,            // {type:'mark'|'sel', mark, items}
  checked: new Set(),
  actStage: 0, actDate: today(),
  search: "", fName: "", fStage: "",
  saving: false, dirty: 0, syncErr: "", lastSync: null,
  repFrom: "", repTo: "",
};
const stages = () => S.config.stages;

/* ===================== TIỆN ÍCH ===================== */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function today() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
const fmtD = d => d ? d.slice(8, 10) + "/" + d.slice(5, 7) : "";
const fmtDF = d => d ? d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4) : "";
const fmtT = kg => (kg / 1000).toLocaleString("vi-VN", { maximumFractionDigits: 2 });
const pct = (a, b) => b ? Math.round(a * 1000 / b) / 10 : 0;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const natCmp = (a, b) => String(a).localeCompare(String(b), "vi", { numeric: true, sensitivity: "base" });
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.style.display = "block"; clearTimeout(toast._t); toast._t = setTimeout(() => t.style.display = "none", ms); }
function setLoading(msg) { const l = $("#loading"); if (msg === false) { l.style.display = "none"; return; } l.style.display = "flex"; $("#loadmsg").textContent = msg; }
async function pool(items, n, fn) { let i = 0; const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }; await Promise.all(Array.from({ length: Math.min(n, items.length) }, run)); }

function modal(html, buttons) {
  return new Promise(res => {
    const m = $("#modal"), b = $("#mbox");
    b.innerHTML = html + `<div class="btns">${buttons.map((x, i) => `<button data-i="${i}" class="${x.cls || ""}">${esc(x.label)}</button>`).join("")}</div>`;
    m.style.display = "flex";
    b.querySelectorAll(".btns button").forEach(el => el.onclick = () => { m.style.display = "none"; res(buttons[+el.dataset.i].value); });
  });
}

/* ===================== HOST: TRIMBLE CONNECT ===================== */
class TCHost {
  constructor() { this.api = null; this.token = null; this.tokenWaiters = []; this.selCb = null; this.suppressUntil = 0; this.origin = null; this.rootId = null; this.folderId = null; this.files = []; this.models = []; }

  async connect() {
    this.api = await TrimbleConnectWorkspace.connect(window.parent, (ev, args) => this.onEvent(ev, args), 30000);
    const u = await this.api.user.getUser();
    let p = null;
    try { p = await this.api.project.getProject(); } catch (e) { }
    if (!p || !p.id) p = await this.api.project.getCurrentProject();
    this.project = p;
    let isAdmin = false, members = [];
    try {
      members = await this.api.project.getMembers();
      const me = members.find(m => m.id === u.id || (m.email && u.email && m.email.toLowerCase() === u.email.toLowerCase()));
      isAdmin = !!me && String(me.role || "").toUpperCase() === "ADMIN";
    } catch (e) { console.warn("getMembers", e); }
    try { await this.api.viewer.setSettings({ assemblySelection: true }); } catch (e) { }
    return { user: { id: u.id, name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email, email: u.email || "" }, isAdmin, members, project: p };
  }

  onEvent(ev, args) {
    const data = args && args.data;
    if (ev === "extension.accessToken") { this.token = data; this.tokenWaiters.splice(0).forEach(f => f(data)); }
    else if (ev === "viewer.onSelectionChanged") {
      if (Date.now() < this.suppressUntil) return;
      this.selCb && this.selCb(data || []);
    } else if (ev === "viewer.onModelStateChanged") { App.onModelsChanged(); }
  }

  async getToken() {
    if (this.token) return this.token;
    let t = await this.api.extension.requestPermission("accesstoken");
    if (t === "pending") {
      setLoading("Vui lòng bấm Cho phép (Allow) để extension truy cập dữ liệu dự án…");
      t = await new Promise(r => this.tokenWaiters.push(r));
    }
    if (!t || t === "denied") throw new Error("Bạn đã từ chối quyền truy cập. Vào Cài đặt extension của Trimble Connect để cấp lại quyền.");
    this.token = t; return t;
  }

  /* ---------- Core API (lưu dữ liệu) ---------- */
  async req(path, opt = {}, retry = true) {
    const url = path.startsWith("http") ? path : `https://${this.origin}/tc/api/2.0/${path}`;
    const headers = Object.assign({ Authorization: "Bearer " + await this.getToken() }, opt.json !== undefined ? { "Content-Type": "application/json" } : {}, opt.headers || {});
    const r = await fetch(url, { method: opt.method || "GET", headers, body: opt.json !== undefined ? JSON.stringify(opt.json) : opt.body });
    if (r.status === 401 && retry) { this.token = null; try { this.token = await this.api.extension.getPermission("accesstoken"); } catch (e) { } return this.req(path, opt, false); }
    if (!r.ok) throw new Error(`${opt.method || "GET"} ${path} → ${r.status} ${await r.text().catch(() => "")}`.slice(0, 300));
    const ct = r.headers.get("content-type") || "";
    return ct.includes("json") ? r.json() : r.text();
  }

  async initStorage() {
    await this.getToken();
    const regions = await (await fetch(REGIONS_URL)).json();
    const origins = (regions || []).map(r => r.origin || r["tc-api"]).filter(Boolean);
    let proj = null;
    for (const o of origins) {
      try { this.origin = o.replace(/^https?:\/\//, "").replace(/\/.*$/, ""); proj = await this.req(`projects/${this.project.id}`); if (proj && proj.rootId) break; } catch (e) { proj = null; }
    }
    if (!proj) throw new Error("Không xác định được máy chủ (region) của dự án.");
    this.rootId = proj.rootId;
    const items = await this.req(`folders/${this.rootId}/items`);
    let f = (items || []).find(x => x.type === "FOLDER" && x.name === DATA_FOLDER);
    if (!f) f = await this.req("folders", { method: "POST", json: { name: DATA_FOLDER, parentId: this.rootId } });
    this.folderId = f.id;
  }

  async listFiles() {
    const items = await this.req(`folders/${this.folderId}/items`);
    this.files = (items || []).filter(x => x.type === "FILE" && /^HL_.*\.json$/i.test(x.name));
    return this.files.map(f => ({ id: f.id, name: f.name, modifiedOn: f.modifiedOn }));
  }

  async readFile(f) {
    const r = await this.req(`files/fs/${f.id}/downloadurl`);
    const url = r.url || r.downloadUrl || r;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Tải file " + f.name + " lỗi " + res.status);
    return res.json();
  }

  async writeFile(name, obj) {
    const init = await this.req("files/fs/initiate", { method: "POST", json: { parentId: this.folderId, parentType: "FOLDER", name } });
    const put = await fetch(init.uploadURL, { method: "PUT", body: new Blob([JSON.stringify(obj)], { type: "application/json" }) });
    if (!put.ok) throw new Error("Upload lỗi " + put.status);
    return this.req("files/fs/commit", { method: "POST", json: { uploadId: init.uploadId } });
  }

  /* ---------- Viewer ---------- */
  async loadInventory(progress) {
    const v = this.api.viewer;
    this.models = (await v.getModels("loaded")) || [];
    if (!this.models.length) return [];
    let found = [];
    for (const cls of ["IFCELEMENTASSEMBLY", "IfcElementAssembly"]) {
      try {
        const res = await v.getObjects({ parameter: { class: cls } });
        const n = (res || []).reduce((a, m) => a + (m.objects || []).length, 0);
        if (n) { found = res; break; }
      } catch (e) { }
    }
    const out = [];
    let all = found;
    let needFilter = false;
    if (!found.length) { all = await v.getObjects(); needFilter = true; }
    const totalCnt = all.reduce((a, m) => a + (m.objects || []).length, 0);
    let done = 0;
    for (const mo of all) {
      const ids = (mo.objects || []).map(o => o.id);
      for (const ck of chunk(ids, 250)) {
        const props = await v.getObjectProperties(mo.modelId, ck);
        let guids = [];
        try { guids = await v.convertToObjectIds(mo.modelId, ck); } catch (e) { }
        props.forEach((p, i) => {
          if (needFilter && !/ELEMENTASSEMBLY/i.test(p.class || "")) return;
          const it = parseProps(p);
          it.modelId = mo.modelId; it.rid = p.id; it.g = guids[i] || pickProp(p, [/^guid$/i, /globalid/i]) || `${mo.modelId}:${p.id}`;
          out.push(it);
        });
        done += ck.length; progress && progress(done, totalCnt);
      }
    }
    return out;
  }

  async mapChildren(items, progress) {
    // tìm part con của từng assembly để tô màu chính xác (chạy nền, có cache)
    const v = this.api.viewer;
    const verKey = this.models.map(m => m.id + "@" + m.versionId).sort().join("|");
    const ck = "hl_children_" + hash(verKey);
    try { const c = JSON.parse(localStorage.getItem(ck) || "null"); if (c) { items.forEach(it => { it.ch = c[it.modelId + ":" + it.rid] || []; }); return true; } } catch (e) { }
    const cache = {}; let n = 0;
    await pool(items, 8, async it => {
      try { const ch = await v.getHierarchyChildren(it.modelId, [it.rid], 4, true); it.ch = (ch || []).map(c => c.id).filter(id => id !== it.rid); }
      catch (e) { it.ch = []; }
      cache[it.modelId + ":" + it.rid] = it.ch;
      if (++n % 200 === 0) progress && progress(n, items.length);
    });
    try { localStorage.setItem(ck, JSON.stringify(cache)); } catch (e) { }
    return true;
  }

  grouped(items, withChildren) {
    const m = new Map();
    for (const it of items) {
      if (!m.has(it.modelId)) m.set(it.modelId, []);
      const a = m.get(it.modelId); a.push(it.rid);
      if (withChildren && it.ch) for (const c of it.ch) a.push(c);
    }
    return [...m].map(([modelId, ids]) => ({ modelId, ids }));
  }

  async resetColors() { await this.api.viewer.setObjectState(undefined, { color: "reset" }); }
  async color(groups) {
    await this.resetColors();
    for (const g of groups) {
      for (const gm of this.grouped(g.items, true)) {
        for (const ids of chunk(gm.ids, 5000)) {
          await this.api.viewer.setObjectState({ modelObjectIds: [{ modelId: gm.modelId, objectRuntimeIds: ids, recursive: true }] }, { color: g.color });
        }
      }
    }
  }
  async select(items) {
    this.suppressUntil = Date.now() + 900;
    const sel = this.grouped(items, false).map(g => ({ modelId: g.modelId, objectRuntimeIds: g.ids }));
    await this.api.viewer.setSelection({ modelObjectIds: sel }, "set");
  }
  async zoom(items) {
    const sel = this.grouped(items, false).map(g => ({ modelId: g.modelId, objectRuntimeIds: g.ids }));
    await this.api.viewer.setCamera({ modelObjectIds: sel }, { animationTime: 400 });
  }
  async isolate(items) {
    await this.api.viewer.isolateEntities(this.grouped(items, true).map(g => ({ modelId: g.modelId, entityIds: g.ids })));
  }
  async showAll() { await this.api.viewer.setObjectState(undefined, { visible: "reset" }); }

  async resolveSelection(sel) {
    // trả về danh sách assembly tương ứng vùng chọn trong viewer
    const res = new Map();
    const unknown = [];
    for (const m of sel || []) for (const rid of m.objectRuntimeIds || []) {
      const k = m.modelId + ":" + rid;
      const it = S.byKey.get(k) || S.byKey.get(S.childKey.get(k));
      if (it) res.set(it.g, it); else unknown.push([m.modelId, rid]);
    }
    for (const [modelId, rid] of unknown.slice(0, 60)) {
      try {
        const ps = await this.api.viewer.getHierarchyParents(modelId, [rid], 4, true);
        for (const p of ps || []) { const it = S.byKey.get(modelId + ":" + p.id); if (it) { res.set(it.g, it); S.childKey.set(modelId + ":" + rid, modelId + ":" + p.id); } }
      } catch (e) { }
    }
    return [...res.values()];
  }
}

function pickProp(p, regs) {
  for (const re of regs) for (const set of p.properties || []) for (const q of set.properties || []) {
    if (re.test(q.name) && q.value !== "" && q.value != null) return String(q.value).trim();
  }
  return "";
}
function parseProps(p) {
  const name = (p.product && p.product.name) || pickProp(p, [/^name$/i]) || "";
  const mark = pickProp(p, [/cast unit mark$/i, /^assembly[_ ]?pos$/i, /^assembly mark$/i, /^mark$/i, /^tag$/i]) || name;
  const w = parseFloat(String(pickProp(p, [/cast unit weight$/i, /^assembly weight$/i, /^weight$/i, /netweight/i]) || "0").replace(",", ".")) || 0;
  return { m: mark, n: name, w: Math.round(w * 100) / 100, pc: pickProp(p, [/position code/i]), el: pickProp(p, [/cast unit bottom elevation/i]) };
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

/* ===================== HOST: DEMO (chạy ngoài Trimble Connect) ===================== */
class DemoHost {
  constructor() { this.selCb = null; this.log = []; }
  async connect() {
    const name = localStorage.getItem("hl_demo_user") || "Người dùng demo";
    return { user: { id: "demo-" + hash(name), name, email: "demo@seico.vn" }, isAdmin: true, members: [{ id: "demo-" + hash(name), firstName: name, lastName: "", email: "demo@seico.vn", role: "ADMIN" }, { id: "u2", firstName: "Tổ trưởng", lastName: "Cắt", email: "totruong.cat@seico.vn", role: "USER" }, { id: "u3", firstName: "Giám sát", lastName: "CT", email: "giamsat@seico.vn", role: "USER" }], project: { id: "demo", name: "Demo" } };
  }
  async initStorage() { }
  async listFiles() { return Object.keys(localStorage).filter(k => k.startsWith("hl_demo_file_")).map(k => ({ id: k, name: k.slice(13) })); }
  async readFile(f) { return JSON.parse(localStorage.getItem(f.id)); }
  async writeFile(name, obj) { localStorage.setItem("hl_demo_file_" + name, JSON.stringify(obj)); }
  async loadInventory(progress) {
    const data = await (await fetch("demo-data.json")).json();
    progress && progress(data.length, data.length);
    return data.map((d, i) => ({ ...d, modelId: "demo", rid: i + 1, ch: [] }));
  }
  async mapChildren() { return true; }
  L(msg) { this.log.push(msg); $("#demo").textContent = "Chế độ DEMO (mở ngoài Trimble Connect) · viewer: " + msg; }
  async resetColors() { this.L("reset màu"); }
  async color(groups) { this.L("tô màu " + groups.map(g => g.color + "×" + g.items.length).join(", ")); }
  async select(items) { this.L("chọn " + items.length + " cấu kiện" + (items.length === 1 ? " (" + items[0].g + ")" : "")); }
  async zoom(items) { this.L("zoom tới " + items.length + " cấu kiện"); }
  async isolate(items) { this.L("cô lập " + items.length + " cấu kiện"); }
  async showAll() { this.L("hiện tất cả"); }
  async resolveSelection(sel) { return sel; }
}

/* ===================== DỮ LIỆU KHAI BÁO ===================== */
const myFileName = () => USER_FILE_PREFIX + S.user.id + ".json";

function addEvents(list, mine) {
  let n = 0;
  for (const e of list || []) {
    if (!e || !e.id || S.eventIds.has(e.id)) continue;
    S.eventIds.add(e.id); S.events.push(e); n++;
    if (mine) S.myEvents.push(e);
  }
  return n;
}
function rebuildState() {
  S.events.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.id < b.id ? -1 : 1));
  const st = new Map(), N = stages().length;
  for (const e of S.events) {
    let a = st.get(e.g); if (!a) { a = new Array(N).fill(null); st.set(e.g, a); }
    a[e.s] = e.a ? { d: e.d, u: e.un, t: e.t } : null;
  }
  S.state = st;
}
const stOf = g => S.state.get(g) || EMPTY;
let EMPTY = new Array(7).fill(null);
const topStage = g => { const a = stOf(g); for (let i = a.length - 1; i >= 0; i--) if (a[i]) return i; return -1; };
function seqIssues(g) {
  const a = stOf(g), out = [];
  for (let i = 1; i < a.length; i++) if (a[i]) {
    for (let j = 0; j < i; j++) {
      if (!a[j]) out.push({ i, j, type: "miss" });
      else if (a[j].d > a[i].d) out.push({ i, j, type: "date" });
    }
  }
  return out;
}

async function loadAllData(silent) {
  const files = await S.host.listFiles();
  let added = 0;
  for (const f of files) {
    try {
      const obj = await S.host.readFile(f);
      if (f.name === CONFIG_FILE) { applyConfig(obj); continue; }
      if (!f.name.startsWith(USER_FILE_PREFIX)) continue;
      added += addEvents(obj.events, f.name === myFileName());
    } catch (e) { console.warn("đọc", f.name, e); if (!silent) toast("Không đọc được " + f.name); }
  }
  rebuildState();
  S.lastSync = new Date();
  return added;
}
function applyConfig(c) {
  if (!c) return;
  if (Array.isArray(c.stages) && c.stages.length === DEFAULT_STAGES.length) S.config.stages = c.stages.map((s, i) => ({ ...DEFAULT_STAGES[i], ...s }));
  S.config.perm = c.perm || {};
}

function record(guids, stage, done, date) {
  const t = new Date().toISOString();
  const evs = guids.map(g => ({ id: uid(), t, u: S.user.id, un: S.user.name, g, m: (S.byGuid.get(g) || {}).m || "", s: stage, a: done ? 1 : 0, d: done ? date : "" }));
  addEvents(evs, true); rebuildState();
  S.dirty += evs.length; scheduleSave(); updSync();
  return evs.length;
}
function scheduleSave() { clearTimeout(scheduleSave._t); scheduleSave._t = setTimeout(saveNow, SAVE_DELAY_MS); }
async function saveNow() {
  if (S.saving) { scheduleSave(); return; }
  if (!S.dirty) return;
  S.saving = true; updSync();
  const pending = S.dirty;
  try {
    // đọc lại file của chính mình (phòng khi mở ở 2 máy) rồi ghi hợp nhất
    try {
      const f = (await S.host.listFiles()).find(x => x.name === myFileName());
      if (f) { const obj = await S.host.readFile(f); addEvents(obj.events, true); rebuildState(); }
    } catch (e) { }
    await S.host.writeFile(myFileName(), { app: "highline", v: 1, user: S.user, savedAt: new Date().toISOString(), events: S.myEvents });
    S.dirty = Math.max(0, S.dirty - pending); S.syncErr = ""; S.lastSync = new Date();
  } catch (e) {
    console.error(e); S.syncErr = e.message || String(e); toast("Lưu lên Trimble Connect lỗi – sẽ thử lại");
    clearTimeout(saveNow._r); saveNow._r = setTimeout(saveNow, 15000);
  } finally { S.saving = false; updSync(); }
}
async function refreshData() {
  try { await saveNow(); const n = await loadAllData(true); if (n) { toast(`Đã cập nhật ${n} khai báo mới`); render(); applyView(); } S.syncErr = ""; }
  catch (e) { S.syncErr = e.message; }
  updSync();
}
function updSync() {
  const el = $("#sync"); el.className = "";
  if (S.syncErr) { el.classList.add("err"); el.textContent = "⚠ Lỗi đồng bộ"; el.title = S.syncErr; return; }
  if (S.saving) { el.textContent = "⟳ Đang lưu…"; return; }
  if (S.dirty) { el.classList.add("dirty"); el.textContent = `● Chưa lưu (${S.dirty})`; return; }
  el.textContent = "✓ Đã đồng bộ " + (S.lastSync ? S.lastSync.toTimeString().slice(0, 5) : "");
  el.title = "Bấm để tải khai báo mới nhất của mọi người";
}

/* ===================== QUYỀN ===================== */
function allowedStages() {
  const p = S.config.perm || {};
  const keys = Object.keys(p).filter(k => Array.isArray(p[k]));
  if (!keys.length) return stages().map((_, i) => i);           // chưa phân quyền → ai cũng được
  const mine = p[S.user.id] || p[(S.user.email || "").toLowerCase()];
  if (S.isAdmin && !mine) return stages().map((_, i) => i);
  return mine || [];
}

/* ===================== CHẾ ĐỘ XEM (TÔ MÀU) ===================== */
async function applyView() {
  if (!S.items.length) return;
  const v = S.view, st = stages();
  try {
    if (v === "off") { await S.host.resetColors(); return; }
    const groups = new Map();
    const put = (c, it) => { if (!groups.has(c)) groups.set(c, []); groups.get(c).push(it); };
    if (v === "overview") for (const it of S.items) { const t = topStage(it.g); put(t < 0 ? C_NONE : st[t].color, it); }
    else if (v === "issues") for (const it of S.items) put(seqIssues(it.g).length ? C_BAD : C_OK, it);
    else if (v.startsWith("s")) {
      const i = +v.slice(1);
      for (const it of S.items) { const a = stOf(it.g); put(a[i] ? st[i].color : (i === 0 || a[i - 1]) ? C_READY : C_NOTREADY, it); }
    }
    await S.host.color([...groups].map(([color, items]) => ({ color, items })));
  } catch (e) { console.error(e); toast("Không tô màu được: " + e.message); }
}

/* ===================== KHAI BÁO ===================== */
function openMark(mark, checkGuids) {
  const items = (S.marks.get(mark) || []).slice();
  S.list = { type: "mark", mark, items };
  S.checked = new Set(checkGuids || []);
  S.tab = "decl"; render();
  S.host.select(checkGuids && checkGuids.length ? items.filter(i => S.checked.has(i.g)) : items).catch(() => { });
}
function openSelection(items) {
  S.list = { type: "sel", items: items.slice().sort((a, b) => natCmp(a.m, b.m) || natCmp(a.pc, b.pc)) };
  S.checked = new Set(items.map(i => i.g)); S.tab = "decl"; render();
}
async function onViewerSelection(sel) {
  const items = await S.host.resolveSelection(sel);
  if (!items.length) return;
  if (S.list && S.list.type === "mark" && items.every(i => i.m === S.list.mark)) { S.checked = new Set(items.map(i => i.g)); render(); return; }
  const ms = new Set(items.map(i => i.m));
  if (ms.size === 1) openMark(items[0].m, items.map(i => i.g)); else openSelection(items);
}

async function doDeclare(done) {
  const s = S.actStage, date = S.actDate, st = stages();
  const guids = [...S.checked];
  if (!guids.length) return toast("Chưa chọn cấu kiện nào");
  if (!allowedStages().includes(s)) return toast("Bạn không có quyền khai báo công đoạn " + st[s].name);
  if (done && !date) return toast("Chọn ngày hoàn thành");
  const warn = [], fixPrev = new Map();
  let skip = 0;
  for (const g of guids) {
    const a = stOf(g), it = S.byGuid.get(g), lbl = `${it.m} ${it.pc ? "(" + it.pc + ")" : ""}`;
    if (done) {
      if (a[s] && a[s].d === date) { skip++; continue; }
      const miss = []; for (let j = 0; j < s; j++) if (!a[j]) miss.push(j);
      if (miss.length) { warn.push(`${lbl}: chưa xong ${miss.map(j => st[j].name).join(", ")}`); fixPrev.set(g, miss); }
      const late = []; for (let j = 0; j < s; j++) if (a[j] && a[j].d > date) late.push(j);
      if (late.length) warn.push(`${lbl}: ngày ${fmtDF(date)} sớm hơn ngày xong ${late.map(j => st[j].name + " (" + fmtDF(a[j].d) + ")").join(", ")}`);
      for (let j = s + 1; j < a.length; j++) if (a[j] && a[j].d < date) warn.push(`${lbl}: ${st[j].name} đã xong ngày ${fmtDF(a[j].d)}, trước ngày này`);
    } else {
      if (!a[s]) { skip++; continue; }
      const later = []; for (let j = s + 1; j < a.length; j++) if (a[j]) later.push(j);
      if (later.length) warn.push(`${lbl}: đã khai báo xong ${later.map(j => st[j].name).join(", ")}`);
    }
  }
  if (done && date > today()) warn.unshift(`Ngày hoàn thành ${fmtDF(date)} là ngày trong tương lai`);
  const targets = guids.filter(g => done ? !(stOf(g)[s] && stOf(g)[s].d === date) : !!stOf(g)[s]);
  if (!targets.length) return toast(done ? "Các cấu kiện đã chọn đã xong công đoạn này" : "Các cấu kiện đã chọn chưa khai báo công đoạn này");
  let mode = "go";
  if (warn.length) {
    const lines = warn.slice(0, 12).map(w => `<li>${esc(w)}</li>`).join("") + (warn.length > 12 ? `<li>… và ${warn.length - 12} cảnh báo khác</li>` : "");
    const btns = [{ label: "Hủy", value: "cancel" }];
    if (done && fixPrev.size && allowedStages().length && [...fixPrev.values()].every(m => m.every(j => allowedStages().includes(j))))
      btns.push({ label: "Lưu + đánh dấu cả công đoạn trước", value: "fix" });
    btns.push({ label: "Vẫn lưu", value: "go", cls: "pri" });
    mode = await modal(`<h3>⚠ Cảnh báo sai trình tự sản xuất</h3><div class="small mut" style="margin-bottom:6px">${done ? "Khai báo XONG" : "Hủy xong"} “${esc(st[s].name)}” cho ${targets.length} cấu kiện. Trình tự chuẩn: ${st.map(x => esc(x.name)).join(" → ")}</div><ul class="small" style="padding-left:18px;margin:6px 0">${lines}</ul>`, btns);
    if (mode === "cancel") return;
  }
  if (mode === "fix") {
    const byStage = new Map();
    for (const [g, miss] of fixPrev) for (const j of miss) { if (!byStage.has(j)) byStage.set(j, []); byStage.get(j).push(g); }
    for (const [j, gs] of [...byStage].sort((a, b) => a[0] - b[0])) record(gs, j, true, date);
  }
  record(targets, s, done, date);
  toast(`${done ? "Đã khai báo xong" : "Đã hủy"} “${st[s].name}” cho ${targets.length} cấu kiện`);
  render(); applyView();
}

function pickQty(q) {
  const s = S.actStage;
  const cand = S.list.items.filter(it => !stOf(it.g)[s]);
  cand.sort((a, b) => { const ra = s === 0 || stOf(a.g)[s - 1] ? 0 : 1, rb = s === 0 || stOf(b.g)[s - 1] ? 0 : 1; return ra - rb || natCmp(a.pc, b.pc); });
  S.checked = new Set(cand.slice(0, q).map(i => i.g));
  if (cand.length < q) toast(`Chỉ còn ${cand.length} cấu kiện chưa xong công đoạn này`);
  render();
  S.host.select(S.list.items.filter(i => S.checked.has(i.g))).catch(() => { });
}

/* ===================== GIAO DIỆN ===================== */
function render() {
  document.querySelectorAll("nav button").forEach(b => b.classList.toggle("on", b.dataset.tab === S.tab));
  const m = $("#main");
  m.innerHTML = S.tab === "decl" ? (S.list ? vList() : vMarks()) : S.tab === "view" ? vView() : S.tab === "report" ? vReport() : vSettings();
  bind[S.tab] && bind[S.tab](m);
}

function bar7(items) {
  const st = stages(), n = items.length || 1;
  return `<div class="bar7">${st.map((s, i) => { const d = items.filter(it => stOf(it.g)[i]).length; return `<i title="${esc(s.name)}: ${d}/${items.length}"><b style="width:${d * 100 / n}%;background:${s.color}"></b></i>`; }).join("")}</div>`;
}
function legend() { return `<div class="legend">${stages().map((s, i) => `<span><span class="sw" style="background:${s.color}"></span>${i + 1}. ${esc(s.name)}</span>`).join("")}</div>`; }

function vMarks() {
  const st = stages();
  const names = [...new Set(S.items.map(i => i.n))].sort(natCmp);
  let marks = [...S.marks.keys()];
  const q = S.search.trim().toLowerCase();
  if (q) marks = marks.filter(k => k.toLowerCase().includes(q) || (S.marks.get(k)[0].n || "").toLowerCase().includes(q));
  if (S.fName) marks = marks.filter(k => S.marks.get(k)[0].n === S.fName);
  if (S.fStage !== "") { const i = +S.fStage; marks = marks.filter(k => S.marks.get(k).some(it => !stOf(it.g)[i])); }
  marks.sort(natCmp);
  const shown = marks.slice(0, 300);
  return `
  <div class="card">
    <div class="row"><input id="q" class="grow" placeholder="🔍 Tìm mark (VD: C1, B12-3) hoặc tên cấu kiện" value="${esc(S.search)}"></div>
    <div class="row" style="margin-top:6px">
      <select id="fName" class="grow"><option value="">Tất cả loại cấu kiện</option>${names.map(n => `<option ${n === S.fName ? "selected" : ""}>${esc(n)}</option>`).join("")}</select>
      <select id="fStage" class="grow"><option value="">Mọi trạng thái</option>${st.map((s, i) => `<option value="${i}" ${String(i) === S.fStage ? "selected" : ""}>Chưa xong: ${esc(s.name)}</option>`).join("")}</select>
    </div>
    <div class="small mut" style="margin-top:6px">💡 Chọn cấu kiện trực tiếp trên mô hình 3D (giữ Ctrl để chọn nhiều) hoặc chọn mark bên dưới.</div>
  </div>
  <div class="card" style="padding:4px 8px">
    <div class="row small mut" style="padding:4px 0"><span class="grow">${marks.length} mark · ${S.items.length} cấu kiện</span>${legendMini()}</div>
    <ul class="marks">${shown.map(k => { const its = S.marks.get(k); return `<li data-mark="${esc(k)}"><span class="mk">${esc(k)}</span><span class="grow nm">${esc(its[0].n)} · SL ${its.length}</span>${bar7(its)}</li>`; }).join("")}</ul>
    ${marks.length > shown.length ? `<div class="small mut" style="padding:8px">… còn ${marks.length - shown.length} mark, hãy gõ để lọc.</div>` : ""}
  </div>`;
}
function legendMini() { return `<span>${stages().map(s => `<span class="sw" title="${esc(s.name)}" style="background:${s.color};margin-right:1px"></span>`).join("")}</span>`; }

function vList() {
  const L = S.list, st = stages(), allowed = allowedStages();
  if (!allowed.includes(S.actStage) && allowed.length) S.actStage = allowed[0];
  const items = L.items.slice().sort((a, b) => natCmp(a.m, b.m) || natCmp(a.pc, b.pc) || natCmp(a.el, b.el));
  const w = items.reduce((a, i) => a + i.w, 0);
  const head = L.type === "mark"
    ? `<div class="row"><button class="ghost" id="back">← Danh sách</button><div class="grow"><b style="font-size:15px">${esc(L.mark)}</b> <span class="mut">${esc(items[0] ? items[0].n : "")}</span></div></div>
       <div class="small mut" style="margin:4px 0 8px">SL ${items.length} · ${items[0] ? items[0].w.toLocaleString("vi-VN") : 0} kg/cái · tổng ${fmtT(w)} tấn</div>`
    : `<div class="row"><button class="ghost" id="back">← Danh sách</button><div class="grow"><b>Vùng chọn trên mô hình</b></div></div>
       <div class="small mut" style="margin:4px 0 8px">${items.length} cấu kiện · ${new Set(items.map(i => i.m)).size} mark · ${fmtT(w)} tấn</div>`;
  const sum = `<div class="row wrap small" style="gap:4px 10px">${st.map((s, i) => { const d = items.filter(it => stOf(it.g)[i]).length; return `<span><span class="sw" style="background:${s.color}"></span>${esc(s.short)} ${d}/${items.length}</span>`; }).join("")}</div>`;
  const rows = items.map((it, k) => {
    const a = stOf(it.g), iss = new Set(seqIssues(it.g).map(x => x.i));
    return `<tr data-g="${esc(it.g)}" class="${S.checked.has(it.g) ? "chk" : ""}">
      <td><input type="checkbox" class="ck" ${S.checked.has(it.g) ? "checked" : ""}></td>
      <td><div class="pos" title="GUID ${esc(it.g)}${it.el ? " · cao độ " + esc(it.el) : ""}">${L.type === "sel" ? "<b>" + esc(it.m) + "</b> " : "#" + (k + 1) + " "}${esc(it.pc || "")}</div></td>
      ${a.map((x, i) => `<td><div class="cell ${iss.has(i) ? "bad" : ""}" style="${x ? "background:" + st[i].color : ""}" title="${esc(st[i].name)}${x ? ": xong " + fmtDF(x.d) + " – " + esc(x.u) : ": chưa xong"}">${x ? fmtD(x.d) : ""}</div></td>`).join("")}
      <td><button class="ghost zm" title="Zoom tới cấu kiện">🎯</button></td></tr>`;
  }).join("");
  return `
  <div class="card">${head}${sum}
    <div class="row wrap" style="margin-top:8px">
      <button id="selAll">Chọn hết</button><button id="selNone">Bỏ chọn</button>
      <button id="iso" title="Chỉ hiện các cấu kiện này">Cô lập</button><button id="showAll">Hiện tất cả</button>
    </div>
  </div>
  <div class="card" style="padding:6px">
    <table class="tbl inst"><thead><tr><th></th><th>Vị trí</th>${st.map(s => `<th class="stg-h" title="${esc(s.name)}"><span class="sw" style="background:${s.color};margin:0"></span><br>${esc(s.short)}</th>`).join("")}<th></th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="small mut" style="margin-top:6px">Rê chuột lên dòng để sáng cấu kiện trên mô hình · ô viền đỏ = sai trình tự</div>
  </div>
  <div class="act">
    ${allowed.length ? `
    <div class="row"><select id="aStage" class="grow">${st.map((s, i) => `<option value="${i}" ${i === S.actStage ? "selected" : ""} ${allowed.includes(i) ? "" : "disabled"}>${i + 1}. ${esc(s.name)}</option>`).join("")}</select>
      <input type="date" id="aDate" value="${S.actDate}" max="${today()}" style="width:138px"></div>
    ${L.type === "mark" ? `<div class="row" style="margin-top:6px"><span class="small mut">Theo số lượng:</span><input id="qty" type="number" min="1" max="${items.length}" style="width:64px" placeholder="SL"><button id="pickQty" title="Tự chọn các cấu kiện chưa xong công đoạn này">Chọn</button></div>` : ""}
    <div class="row" style="margin-top:6px"><span class="small grow"><b>${S.checked.size}</b> cấu kiện đang chọn</span>
      <button id="undo" ${S.checked.size ? "" : "disabled"}>↺ Hủy xong</button>
      <button id="ok" class="pri" ${S.checked.size ? "" : "disabled"}>✓ Xác nhận xong</button></div>`
    : `<div class="note w">Bạn chưa được phân quyền khai báo công đoạn nào. Liên hệ quản trị dự án.</div>`}
  </div>`;
}

function vView() {
  const st = stages(), v = S.view;
  const opt = (k, label, sub) => `<div class="chip ${v === k ? "on" : ""}" data-v="${k}">${label}${sub ? ` <span class="mut">${sub}</span>` : ""}</div>`;
  let leg = "";
  if (v === "overview") leg = `<span><span class="sw" style="background:${C_NONE}"></span>Chưa bắt đầu</span>` + st.map((s, i) => `<span><span class="sw" style="background:${s.color}"></span>${i + 1}. ${esc(s.name)}</span>`).join("");
  else if (v.startsWith("s")) { const i = +v.slice(1); leg = `<span><span class="sw" style="background:${st[i].color}"></span>Đã xong</span><span><span class="sw" style="background:${C_READY}"></span>Sẵn sàng (công đoạn trước đã xong)</span><span><span class="sw" style="background:${C_NOTREADY}"></span>Chưa tới</span>`; }
  else if (v === "issues") leg = `<span><span class="sw" style="background:${C_BAD}"></span>Sai trình tự / sai ngày</span><span><span class="sw" style="background:${C_OK}"></span>Bình thường</span>`;
  const cnt = i => S.items.filter(it => stOf(it.g)[i]).length;
  const nIss = S.items.filter(it => seqIssues(it.g).length).length;
  return `
  <div class="card"><h3>Tổng hợp</h3><div class="row wrap">${opt("overview", "🎨 Theo công đoạn cao nhất")}${opt("issues", "⚠ Sai trình tự", nIss)}${opt("off", "Tắt màu")}</div></div>
  <div class="card"><h3>Theo từng công đoạn</h3><div class="row wrap">${st.map((s, i) => opt("s" + i, `<span class="sw" style="background:${s.color}"></span>${i + 1}. ${esc(s.name)}`, `${pct(cnt(i), S.items.length)}%`)).join("")}</div></div>
  <div class="card"><h3>Chú giải</h3><div class="legend" style="flex-direction:column;gap:5px">${leg || "Không tô màu"}</div>
    <div class="row" style="margin-top:10px"><button id="reapply">⟳ Tô lại màu</button><button id="showAll2">Hiện tất cả</button></div></div>
  ${nIss && v === "issues" ? `<div class="card"><h3>Cấu kiện sai trình tự</h3><ul class="marks">${S.items.filter(it => seqIssues(it.g).length).slice(0, 100).map(it => `<li data-mark="${esc(it.m)}" data-g="${esc(it.g)}"><span class="mk">${esc(it.m)}</span><span class="grow nm">${esc(it.pc)} · ${seqIssues(it.g).map(x => (x.type === "miss" ? "thiếu " : "ngày ") + stages()[x.j].short).slice(0, 3).join(", ")}</span></li>`).join("")}</ul></div>` : ""}`;
}

function reportData(from, to) {
  const st = stages(), totW = S.items.reduce((a, i) => a + i.w, 0);
  return st.map((s, i) => {
    let n = 0, w = 0, rn = 0, rw = 0;
    for (const it of S.items) { const x = stOf(it.g)[i]; if (x) { n++; w += it.w; if ((!from || x.d >= from) && (!to || x.d <= to)) { rn++; rw += it.w; } } }
    return { s, i, n, w, rn, rw, tot: S.items.length, totW };
  });
}
function vReport() {
  const rd = reportData(S.repFrom, S.repTo), ranged = S.repFrom || S.repTo;
  return `
  <div class="card"><h3>Tiến độ toàn dự án</h3>
    <div class="small mut" style="margin-bottom:8px">${S.items.length} cấu kiện · ${fmtT(rd[0] ? rd[0].totW : 0)} tấn · ${S.marks.size} mark</div>
    <table class="tbl"><thead><tr><th>Công đoạn</th><th style="text-align:right">SL xong</th><th style="text-align:right">Tấn xong</th><th style="width:30%">%KL</th></tr></thead><tbody>
    ${rd.map(r => `<tr><td><span class="sw" style="background:${r.s.color}"></span>${esc(r.s.name)}</td><td style="text-align:right">${r.n}/${r.tot}</td><td style="text-align:right">${fmtT(r.w)}</td>
      <td><div class="row"><div class="prog grow"><b style="width:${pct(r.w, r.totW)}%;background:${r.s.color}"></b></div><span class="small" style="width:40px;text-align:right">${pct(r.w, r.totW)}%</span></div></td></tr>`).join("")}
    </tbody></table></div>
  <div class="card"><h3>Sản lượng theo khoảng ngày</h3>
    <div class="row"><input type="date" id="rFrom" value="${S.repFrom}" class="grow"><span>→</span><input type="date" id="rTo" value="${S.repTo}" class="grow"></div>
    <div class="row wrap" style="margin-top:6px"><button data-rng="week">Tuần này</button><button data-rng="lastweek">Tuần trước</button><button data-rng="month">Tháng này</button><button data-rng="clear">Xóa</button></div>
    ${ranged ? `<table class="tbl" style="margin-top:8px"><thead><tr><th>Công đoạn</th><th style="text-align:right">SL</th><th style="text-align:right">Tấn</th></tr></thead><tbody>${rd.map(r => `<tr><td><span class="sw" style="background:${r.s.color}"></span>${esc(r.s.name)}</td><td style="text-align:right">${r.rn}</td><td style="text-align:right">${fmtT(r.rw)}</td></tr>`).join("")}</tbody></table>` : `<div class="small mut" style="margin-top:8px">Chọn khoảng ngày để xem sản lượng hoàn thành trong kỳ (dùng cho báo cáo tuần).</div>`}
  </div>
  <div class="card"><h3>Xuất dữ liệu</h3>
    <div class="small mut" style="margin-bottom:8px">File Excel gồm: Tổng hợp · Theo ngày · Theo mark · Chi tiết từng cấu kiện (GUID) · Nhật ký khai báo</div>
    <button class="pri" id="xls">⬇ Xuất Excel</button></div>`;
}

function vSettings() {
  const st = stages(), members = (S.members || []).filter(m => m.status !== "REMOVED");
  const p = S.config.perm || {};
  const hasPerm = Object.keys(p).length > 0;
  return `
  <div class="card"><h3>Thông tin</h3><div class="kv">
    <span class="mut">Người dùng</span><span>${esc(S.user.name)} ${S.isAdmin ? '<span class="pill">Quản trị</span>' : ""}</span>
    <span class="mut">Cấu kiện</span><span>${S.items.length} assembly · ${S.marks.size} mark</span>
    <span class="mut">Khai báo</span><span>${S.events.length} lượt (của bạn: ${S.myEvents.length})</span>
    <span class="mut">Lưu tại</span><span>Thư mục <b>${DATA_FOLDER}</b> của dự án</span>
    <span class="mut">Quyền của bạn</span><span>${allowedStages().map(i => esc(st[i].short)).join(", ") || "—"}</span>
  </div>
  <div class="row wrap" style="margin-top:8px"><button id="reload">⟳ Tải lại mô hình</button><button id="sync2">⇅ Đồng bộ ngay</button><button id="backup">⬇ Sao lưu JSON</button></div></div>
  <div class="card"><h3>Màu công đoạn ${S.isAdmin ? "" : '<span class="small mut">(chỉ quản trị sửa)</span>'}</h3>
    ${st.map((s, i) => `<div class="row" style="margin-bottom:4px"><input type="color" data-ci="${i}" value="${s.color}" ${S.isAdmin ? "" : "disabled"} style="width:36px;padding:0 2px;height:26px"><span class="grow">${i + 1}. ${esc(s.name)}</span></div>`).join("")}
  </div>
  <div class="card"><h3>Phân quyền khai báo</h3>
    <div class="small mut" style="margin-bottom:6px">${hasPerm ? "Chỉ người được tick mới khai báo được công đoạn tương ứng." : "Chưa phân quyền: mọi thành viên dự án đều khai báo được mọi công đoạn."} Quản trị dự án luôn có toàn quyền.</div>
    ${S.isAdmin ? `<div style="overflow:auto"><table class="tbl perm"><thead><tr><th>Thành viên</th>${st.map(s => `<th class="stg-h" title="${esc(s.name)}">${esc(s.short)}</th>`).join("")}</tr></thead><tbody>
      ${members.map(m => { const mine = p[m.id] || []; return `<tr data-uid="${esc(m.id)}"><td><div class="pos" style="max-width:130px" title="${esc(m.email)}">${esc([m.firstName, m.lastName].join(" ").trim() || m.email)}</div></td>${st.map((s, i) => `<td style="text-align:center"><input type="checkbox" data-pi="${i}" ${mine.includes(i) ? "checked" : ""}></td>`).join("")}</tr>`; }).join("")}
    </tbody></table></div>
    <div class="row" style="margin-top:8px"><button class="pri" id="savePerm">Lưu phân quyền & màu</button><button id="clearPerm">Bỏ phân quyền</button></div>` : `<div class="note i">Chỉ quản trị dự án (Admin) mới thay đổi được phân quyền.</div>`}
  </div>`;
}

/* ===================== GẮN SỰ KIỆN ===================== */
let hoverT = null;
const bind = {
  decl(m) {
    if (!S.list) {
      const q = $("#q", m);
      q.oninput = () => { S.search = q.value; const pos = q.selectionStart; render(); const n = $("#q"); n.focus(); n.setSelectionRange(pos, pos); };
      $("#fName", m).onchange = e => { S.fName = e.target.value; render(); };
      $("#fStage", m).onchange = e => { S.fStage = e.target.value; render(); };
      m.querySelectorAll(".marks li").forEach(li => li.onclick = () => openMark(li.dataset.mark));
      return;
    }
    const L = S.list, byG = g => S.byGuid.get(g);
    $("#back", m).onclick = () => { S.list = null; S.checked.clear(); render(); };
    $("#selAll", m).onclick = () => { S.checked = new Set(L.items.map(i => i.g)); render(); S.host.select(L.items).catch(() => { }); };
    $("#selNone", m).onclick = () => { S.checked.clear(); render(); };
    $("#iso", m).onclick = () => S.host.isolate(L.items).catch(e => toast(e.message));
    $("#showAll", m).onclick = () => S.host.showAll().catch(e => toast(e.message));
    const tb = m.querySelector(".inst tbody");
    tb.onmouseover = e => { const tr = e.target.closest("tr"); if (!tr) return; clearTimeout(hoverT); hoverT = setTimeout(() => S.host.select([byG(tr.dataset.g)]).catch(() => { }), 160); };
    tb.onmouseleave = () => { clearTimeout(hoverT); hoverT = setTimeout(() => { const its = L.items.filter(i => S.checked.has(i.g)); S.host.select(its.length ? its : L.items).catch(() => { }); }, 250); };
    tb.onclick = e => {
      const tr = e.target.closest("tr"); if (!tr) return; const g = tr.dataset.g;
      if (e.target.closest(".zm")) { S.host.zoom([byG(g)]).catch(() => { }); return; }
      if (S.checked.has(g)) S.checked.delete(g); else S.checked.add(g);
      tr.classList.toggle("chk", S.checked.has(g)); tr.querySelector(".ck").checked = S.checked.has(g);
      const b = m.querySelector(".act b"); if (b) b.textContent = S.checked.size;
      m.querySelectorAll("#ok,#undo").forEach(x => x.disabled = !S.checked.size);
    };
    const as = $("#aStage", m); if (as) as.onchange = () => { S.actStage = +as.value; };
    const ad = $("#aDate", m); if (ad) ad.onchange = () => { S.actDate = ad.value; };
    const pq = $("#pickQty", m); if (pq) pq.onclick = () => { const q = parseInt($("#qty", m).value); if (q > 0) pickQty(q); };
    const ok = $("#ok", m); if (ok) ok.onclick = () => doDeclare(true);
    const un = $("#undo", m); if (un) un.onclick = () => doDeclare(false);
  },
  view(m) {
    m.querySelectorAll(".chip[data-v]").forEach(c => c.onclick = () => { S.view = c.dataset.v; localStorage.setItem("hl_view", S.view); render(); applyView(); });
    $("#reapply", m).onclick = () => applyView();
    $("#showAll2", m).onclick = () => S.host.showAll().catch(() => { });
    m.querySelectorAll(".marks li").forEach(li => li.onclick = () => openMark(li.dataset.mark, [li.dataset.g]));
  },
  report(m) {
    $("#rFrom", m).onchange = e => { S.repFrom = e.target.value; render(); };
    $("#rTo", m).onchange = e => { S.repTo = e.target.value; render(); };
    m.querySelectorAll("[data-rng]").forEach(b => b.onclick = () => {
      const d = new Date(today() + "T00:00:00"), dow = (d.getDay() + 6) % 7, iso = x => { const y = new Date(x); y.setMinutes(y.getMinutes() - y.getTimezoneOffset()); return y.toISOString().slice(0, 10); };
      const k = b.dataset.rng;
      if (k === "week") { const s = new Date(d); s.setDate(d.getDate() - dow); S.repFrom = iso(s); S.repTo = today(); }
      if (k === "lastweek") { const s = new Date(d); s.setDate(d.getDate() - dow - 7); const e = new Date(s); e.setDate(s.getDate() + 6); S.repFrom = iso(s); S.repTo = iso(e); }
      if (k === "month") { S.repFrom = today().slice(0, 8) + "01"; S.repTo = today(); }
      if (k === "clear") { S.repFrom = S.repTo = ""; }
      render();
    });
    $("#xls", m).onclick = exportExcel;
  },
  settings(m) {
    $("#reload", m).onclick = () => App.loadModel();
    $("#sync2", m).onclick = () => refreshData();
    $("#backup", m).onclick = () => download(`highline_backup_${today()}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), config: S.config, events: S.events }, null, 1), "application/json");
    const sp = $("#savePerm", m);
    if (sp) sp.onclick = async () => {
      const perm = {};
      m.querySelectorAll("tr[data-uid]").forEach(tr => { const a = [...tr.querySelectorAll("input[data-pi]")].filter(x => x.checked).map(x => +x.dataset.pi); if (a.length) perm[tr.dataset.uid] = a; });
      const cols = [...m.querySelectorAll("input[data-ci]")].map(x => x.value);
      const cfg = { app: "highline", v: 1, updatedBy: S.user.name, updatedAt: new Date().toISOString(), perm, stages: stages().map((s, i) => ({ ...s, color: cols[i] })) };
      try { await S.host.writeFile(CONFIG_FILE, cfg); applyConfig(cfg); toast("Đã lưu cấu hình cho cả dự án"); render(); applyView(); }
      catch (e) { toast("Lưu cấu hình lỗi: " + e.message, 5000); }
    };
    const cp = $("#clearPerm", m);
    if (cp) cp.onclick = () => { m.querySelectorAll("input[data-pi]").forEach(x => x.checked = false); toast("Đã bỏ tick – bấm Lưu để áp dụng"); };
  },
};

/* ===================== EXCEL ===================== */
function download(name, data, type) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportExcel() {
  if (!window.XLSX) return toast("Thư viện Excel chưa tải xong, thử lại sau giây lát");
  const st = stages(), wb = XLSX.utils.book_new(), rd = reportData();
  const proj = (S.host.project && S.host.project.name) || "";
  const s1 = [["BÁO CÁO TIẾN ĐỘ SẢN XUẤT – " + proj], ["Ngày xuất", fmtDF(today())], [], ["Công đoạn", "SL xong", "SL tổng", "%SL", "KL xong (kg)", "KL tổng (kg)", "%KL"]];
  rd.forEach(r => s1.push([r.s.name, r.n, r.tot, pct(r.n, r.tot) / 100, Math.round(r.w * 10) / 10, Math.round(r.totW * 10) / 10, pct(r.w, r.totW) / 100]));
  const ws1 = XLSX.utils.aoa_to_sheet(s1); ws1["!cols"] = [{ wch: 20 }, { wch: 9 }, { wch: 9 }, { wch: 8 }, { wch: 14 }, { wch: 14 }, { wch: 8 }];
  for (let r = 4; r < 4 + st.length; r++) for (const c of [3, 6]) { const ref = XLSX.utils.encode_cell({ r, c }); if (ws1[ref]) ws1[ref].z = "0.0%"; }
  XLSX.utils.book_append_sheet(wb, ws1, "Tổng hợp");
  // theo ngày
  const days = new Map();
  for (const it of S.items) stOf(it.g).forEach((x, i) => { if (!x) return; if (!days.has(x.d)) days.set(x.d, st.map(() => [0, 0])); const a = days.get(x.d)[i]; a[0]++; a[1] += it.w; });
  const s2 = [["Ngày", ...st.flatMap(s => [s.name + " (SL)", s.name + " (kg)"])]];
  [...days.keys()].sort().forEach(d => s2.push([fmtDF(d), ...days.get(d).flatMap(a => [a[0], Math.round(a[1] * 10) / 10])]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s2), "Theo ngày");
  // theo mark
  const s3 = [["Mark", "Tên", "SL", "KL/cái (kg)", "KL tổng (kg)", ...st.map(s => s.name)]];
  [...S.marks.keys()].sort(natCmp).forEach(k => { const its = S.marks.get(k); s3.push([k, its[0].n, its.length, its[0].w, Math.round(its.reduce((a, i) => a + i.w, 0) * 10) / 10, ...st.map((s, i) => its.filter(it => stOf(it.g)[i]).length)]); });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s3), "Theo mark");
  // chi tiết
  const s4 = [["GUID", "Mark", "Tên", "Vị trí (position code)", "Cao độ đáy", "KL (kg)", "Công đoạn cao nhất", ...st.map(s => "Ngày xong: " + s.name), "Sai trình tự"]];
  [...S.items].sort((a, b) => natCmp(a.m, b.m) || natCmp(a.pc, b.pc)).forEach(it => { const a = stOf(it.g), t = topStage(it.g); s4.push([it.g, it.m, it.n, it.pc, it.el, it.w, t < 0 ? "" : st[t].name, ...a.map(x => x ? fmtDF(x.d) : ""), seqIssues(it.g).length ? "Có" : ""]); });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s4), "Chi tiết cấu kiện");
  // nhật ký
  const s5 = [["Thời điểm ghi", "Người khai báo", "GUID", "Mark", "Công đoạn", "Thao tác", "Ngày xong"]];
  S.events.forEach(e => s5.push([new Date(e.t).toLocaleString("vi-VN"), e.un, e.g, e.m, (st[e.s] || {}).name, e.a ? "Xong" : "Hủy", e.d ? fmtDF(e.d) : ""]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s5), "Nhật ký");
  XLSX.writeFile(wb, `TienDoSX_${proj.replace(/[^\w-]+/g, "_")}_${today()}.xlsx`);
}

/* ===================== KHỞI ĐỘNG ===================== */
const App = {
  async start() {
    const inTC = window.parent !== window;
    S.demo = (!inTC && !/[?&]tc=1/.test(location.search)) || /[?&]demo=1/.test(location.search);
    S.host = S.demo ? new DemoHost() : new TCHost();
    if (S.demo) { $("#demo").style.display = "block"; $("#demo").textContent = "Chế độ DEMO – mở ngoài Trimble Connect, dữ liệu mẫu từ file IFC, lưu tạm trong trình duyệt."; }
    try {
      setLoading("Đang kết nối Trimble Connect…");
      const info = await S.host.connect();
      S.user = info.user; S.isAdmin = info.isAdmin; S.members = info.members || []; S.host.project = info.project;
      $("#who").textContent = S.user.name + (info.project && info.project.name ? " · " + info.project.name : "");
      S.view = localStorage.getItem("hl_view") || "overview";
      setLoading("Đang mở kho dữ liệu dự án…");
      await S.host.initStorage();
      setLoading("Đang tải dữ liệu khai báo…");
      await loadAllData();
      await this.loadModel();
      S.host.selCb = sel => onViewerSelection(sel).catch(e => console.warn(e));
      setInterval(() => refreshData(), AUTO_REFRESH_MS);
      window.addEventListener("beforeunload", e => { if (S.dirty) { saveNow(); e.preventDefault(); e.returnValue = ""; } });
    } catch (e) {
      console.error(e);
      setLoading(false);
      $("#main").innerHTML = `<div class="note e"><b>Không khởi động được.</b><br>${esc(e.message || e)}</div><button onclick="location.reload()">Thử lại</button>`;
    }
    document.querySelectorAll("nav button").forEach(b => b.onclick = () => { S.tab = b.dataset.tab; render(); });
    $("#sync").onclick = () => refreshData();
    updSync();
  },
  async loadModel() {
    setLoading("Đang đọc danh sách assembly từ mô hình…");
    const items = await S.host.loadInventory((d, t) => setLoading(`Đang đọc thuộc tính cấu kiện… ${d}/${t}`));
    S.items = items; S.byGuid = new Map(); S.byKey = new Map(); S.marks = new Map(); S.childKey = new Map();
    for (const it of items) {
      S.byGuid.set(it.g, it); S.byKey.set(it.modelId + ":" + it.rid, it);
      if (!S.marks.has(it.m)) S.marks.set(it.m, []); S.marks.get(it.m).push(it);
    }
    EMPTY = new Array(stages().length).fill(null);
    setLoading(false);
    if (!items.length) { $("#main").innerHTML = `<div class="note w">Chưa có mô hình nào được mở, hoặc mô hình không có assembly (IfcElementAssembly).<br>Hãy mở file IFC xuất từ Tekla (bật <b>Assemblies</b> khi xuất) rồi bấm “Tải lại”.</div><button onclick="App.loadModel()">⟳ Tải lại</button>`; return; }
    render(); applyView();
    // map part con chạy nền để tô màu chính xác
    S.host.mapChildren(items, (d, t) => { $("#demo").style.display = "block"; $("#demo").textContent = `Đang chuẩn bị tô màu chi tiết… ${d}/${t}`; })
      .then(() => {
        for (const it of items) for (const c of it.ch || []) S.childKey.set(it.modelId + ":" + c, it.modelId + ":" + it.rid);
        if (!S.demo) $("#demo").style.display = "none";
        applyView();
      }).catch(e => console.warn("mapChildren", e));
  },
  onModelsChanged() { clearTimeout(this._mc); this._mc = setTimeout(() => toast("Mô hình thay đổi – vào Cài đặt › Tải lại mô hình để cập nhật", 5000), 1500); },
};
window.App = App; window.S = S; window.onViewerSelection = onViewerSelection;
App.start();
