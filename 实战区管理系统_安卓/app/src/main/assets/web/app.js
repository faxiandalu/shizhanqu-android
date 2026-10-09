/* 入库实战区管理系统 - 前端逻辑（pywebview 原生桥接） */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DEFAULT_COLS = ["new_id", "match_time", "match_no", "league", "teams",
  "handicap",
  "s_win", "s_draw", "s_lose",
  "s_h_win", "s_h_draw", "s_h_lose",
  "wl", "lw",
  "half_score", "full_score", "half", "full", "half_full", "ou",
  "handicap_result", "status", "record", "review"];
/* 这三组赔率列左侧画一条分割线：初胜组 / 初让胜组 / 胜负组 */
const SEP_COLS = ["s_win", "s_h_win", "wl"];
const COLS_KEY = "szq_cols_v2";
const PIN_KEY = "szq_pin_v1";
const TOL_KEY = "szq_tol_v1";
/* 快捷检索：胜负 / 负胜 取固定值（精确等于），初让胜 / 初让负 取浮动范围 */
const QF_FIXED = ["wl", "lw"];
const QF_RANGE = ["s_h_win", "s_h_lose"];
const QF_KEYS = QF_FIXED.concat(QF_RANGE);
const TOL_LIST = [0.01, 0.02, 0.03, 0.05];
const GROUP_ORDER = ["基本信息", "赛果", "赔率", "记录复盘"];
const RESULT_STYLE = { "胜": "win", "平": "draw", "负": "lose", "让胜": "win", "让平": "draw", "让负": "lose" };
/* 状态栏统计：只统计这两个字段，按指定顺序展示 */
const STAT_FIELDS = [
  { key: "full", label: "全", order: ["胜", "平", "负"] },
  { key: "handicap_result", label: "让盘", order: ["让胜", "让平", "让负"] }
];
/* 常用筛选：按块分隔；single=true 的字段只输入一个固定值 */
const QUICK_BLOCKS = [
  { title: "让球", fields: ["handicap"] },
  { title: "初胜 / 初平 / 初负", fields: ["s_win", "s_draw", "s_lose"] },
  { title: "初让胜 / 初让平 / 初让负", fields: ["s_h_win", "s_h_draw", "s_h_lose"] },
  { title: "胜负 / 负胜（固定值）", fields: ["wl", "lw"], single: true }
];
const QUICK_KEYS = QUICK_BLOCKS.reduce((a, b) => a.concat(b.fields), []);
/* 有「下拉列表」的字段（胜负 / 负胜 是固定值输入，没有列表） */
const QUICK_LIST_KEYS = QUICK_BLOCKS.filter(b => !b.single).reduce((a, b) => a.concat(b.fields), []);

const S = {
  fields: [], fmap: {}, textMax: 50,
  enumFields: [], suggestFields: [],
  filters: {},
  sort: { field: "new_id", dir: "asc" },
  page: 1, size: 50, total: 0, rows: [],
  cols: DEFAULT_COLS.slice(),
  distinct: {},
  quick: {},          // 常用筛选：{ key: {dir, items:[{value,count}], sel:[...]} }
  sel: null, editing: null,
  pin: null,          // 置顶行：{ id, new_id, label }，筛选后仍排第一行
  tol: 0.02,          // 快捷检索里「初让胜 / 初让负」的浮动范围
  stats: {}, envPath: ""
};

/* ---------------- 本地存储（file:// 下可能不可用，做保护） ---------------- */
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { } }
};

/* ---------------- 桥接调用 ---------------- */
/* 手机版：window.Android 是安卓桥，数据走本地 SQLite；桌面版走 pywebview */
const MOBILE = !!window.Android;

/** 手机上部分按钮不存在（导入 / 同步已移除），判空绑定避免报错 */
function on(sel, fn) { const el = $(sel); if (el) el.onclick = fn; return el; }

function P() {
  const a = window.pywebview && window.pywebview.api;
  if (!a) throw new Error("本地接口尚未就绪，请稍候再试");
  return a;
}

/** 等待 pywebview 桥接注入完成（页面脚本往往比桥接更早执行） */
function whenReady() {
  if (MOBILE) return Promise.resolve();
  if (window.pywebview && window.pywebview.api) return Promise.resolve();
  return new Promise(res => {
    let n = 0;
    const done = () => res();
    window.addEventListener("pywebviewready", done, { once: true });
    const t = setInterval(() => {
      if (window.pywebview && window.pywebview.api) { clearInterval(t); res(); }
      else if (++n > 150) { clearInterval(t); res(); }
    }, 100);
  });
}
async function api(method, ...args) {
  if (MOBILE) {
    const r = window.MB.call(method, args);
    if (r && r.error) throw new Error(r.error);
    return r;
  }
  const fn = P()[method];
  if (typeof fn !== "function") throw new Error("接口不存在：" + method);
  const r = await fn(...args);
  if (r && r.error) throw new Error(r.error);
  return r;
}

function toast(msg, opts = {}) {
  const el = document.createElement("div");
  el.className = "toast" + (opts.err ? " err" : "");
  el.innerHTML = `<div>${msg}</div>` +
    (opts.path ? `<div class="tpath">${esc(opts.path)}</div>` : "") +
    (opts.actions ? `<div class="tact">${opts.actions.map(a => `<button class="btn sm" data-act="${a.act}">${a.label}</button>`).join("")}</div>` : "");
  if (opts.actions) {
    el.addEventListener("click", e => {
      const b = e.target.closest("button[data-act]");
      if (b) {
        const act = opts.actions.find(a => a.act === b.dataset.act);
        if (act) act.fn();
      }
    });
  }
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), opts.err ? 9000 : 6000);
}
function busy(on, text = "处理中…") {
  $("#loadingText").textContent = text;
  $("#loading").classList.toggle("show", !!on);
}
const esc = s => (s === null || s === undefined) ? "" : String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* ---------------- 通用弹窗 ---------------- */
function openModal(html) { $("#modal").innerHTML = html; $("#mask").classList.add("show"); }
function closeModal() { $("#mask").classList.remove("show"); }
$("#mask").addEventListener("click", e => { if (e.target.id === "mask") closeModal(); });

function confirmBox(title, msg) {
  return new Promise(res => {
    openModal(`<h3>${esc(title)}</h3><div class="mbody"><div style="line-height:1.7">${esc(msg)}</div></div>
      <div class="mfoot"><button class="btn" id="cfNo">取消</button><button class="btn danger" id="cfYes">确定</button></div>`);
    $("#cfNo").onclick = () => { closeModal(); res(false); };
    $("#cfYes").onclick = () => { closeModal(); res(true); };
  });
}

/* ---------------- 初始化 ---------------- */
async function boot() {
  const meta = await api("meta");
  S.fields = meta.fields;
  S.fmap = {}; meta.fields.forEach(f => S.fmap[f.key] = f);
  S.textMax = meta.textMaxLen || 50;
  S.enumFields = meta.enumFields || [];
  S.suggestFields = meta.suggestFields || [];

  const saved = LS.get(COLS_KEY);
  if (saved) { try { S.cols = JSON.parse(saved); } catch (e) { } }
  LS.del("szq_cols");   // 旧版默认列缓存作废

  /* 置顶行 / 浮动范围：记住上次的选择，重开 App 还在 */
  const sp = LS.get(PIN_KEY);
  if (sp) { try { const p = JSON.parse(sp); if (p && p.new_id !== undefined) S.pin = p; } catch (e) { } }
  const st = LS.get(TOL_KEY);
  if (st) { const t = parseFloat(st); if (!isNaN(t)) S.tol = t; }

  buildSortSelect();
  buildColPopover();
  await loadDistinct();
  buildQuickPanel();   // 列表在展开时按需取，启动不预拉，首屏更快
  buildFilterPanel();
  await loadStats();
  await refresh();

  if (!S.stats.total) { MOBILE ? openDbPanel(true) : openImport(true); }
}

function buildSortSelect() {
  const sel = $("#sortField");
  sel.innerHTML = S.fields.map(f => `<option value="${f.key}">${esc(f.label)}</option>`).join("");
  sel.value = "new_id";
  sel.onchange = () => { S.sort.field = sel.value; S.page = 1; refresh(); };
  $("#sortDir").onchange = e => { S.sort.dir = e.target.value; S.page = 1; refresh(); };
  $("#pageSize").onchange = e => { S.size = +e.target.value; S.page = 1; refresh(); };
}

async function loadDistinct() {
  const keys = S.enumFields.concat(S.suggestFields);
  for (const k of keys) {
    try {
      const j = await api("distinct", k, S.suggestFields.includes(k) ? 500 : 200);
      S.distinct[k] = (j.values || []).map(v => v.value);
    } catch (e) { S.distinct[k] = []; }
  }
}

async function loadStats() {
  S.stats = await api("stats");
  renderStats();
}
function renderStats() {
  const s = S.stats || {};
  $("#stats").innerHTML = [
    `总记录 <b>${s.total ?? 0}</b>`,
    `已写记录 <b>${s.has_record ?? 0}</b>`,
    `已写复盘 <b>${s.has_review ?? 0}</b>`,
    s.date_min ? `时间跨度 <b>${esc(String(s.date_min).slice(0, 10))} ~ ${esc(String(s.date_max).slice(0, 10))}</b>` : ""
  ].filter(Boolean).map(t => `<span class="chip green">${t}</span>`).join("");
}

/* ---------------- 筛选面板 ---------------- */
function buildFilterPanel() {
  const panel = $("#filterPanel");
  panel.innerHTML = "";
  GROUP_ORDER.forEach(g => {
    const items = S.fields.filter(f => f.group === g);
    if (!items.length) return;
    const wrap = document.createElement("div");
    wrap.className = "group";
    wrap.innerHTML = `<div class="group-title"><span class="caret">▼</span>${g}（${items.length}）</div><div class="group-items"></div>`;
    const box = $(".group-items", wrap);
    items.forEach(f => box.appendChild(filterRow(f)));
    $(".group-title", wrap).onclick = () => wrap.classList.toggle("collapsed");
    panel.appendChild(wrap);
  });
  const odds = $$(".group", panel).find(x => x.textContent.includes("赔率（"));
  if (odds) odds.classList.add("collapsed");
}

function filterRow(f) {
  const row = document.createElement("div");
  row.className = "frow";
  row.dataset.key = f.key;

  if (S.enumFields.includes(f.key)) {
    row.innerHTML = `<label>${esc(f.label)}</label><div class="chips-wrap"></div>`;
    const wrap = $(".chips-wrap", row);
    (S.distinct[f.key] || []).forEach(v => {
      const b = document.createElement("span");
      b.className = "opt"; b.textContent = v; b.dataset.v = v;
      b.onclick = () => {
        b.classList.toggle("on");
        const vals = $$(".opt.on", wrap).map(x => x.dataset.v);
        setFilter(f.key, vals.length ? { field: f.key, op: "in", value: vals } : null);
      };
      wrap.appendChild(b);
    });
    return row;
  }

  if (f.type === "int" || f.type === "real") {
    row.innerHTML = `<label>${esc(f.label)}</label>
      <div class="ctl"><input class="inp" placeholder="最小"><input class="inp" placeholder="最大"></div>`;
    const [a, b] = $$(".inp", row);
    const apply = () => {
      const lo = a.value.trim(), hi = b.value.trim();
      setFilter(f.key, (lo || hi) ? { field: f.key, op: "between", value: [lo === "" ? null : Number(lo), hi === "" ? null : Number(hi)] } : null);
    };
    a.onchange = apply; b.onchange = apply;
    return row;
  }

  if (f.type === "datetime") {
    row.innerHTML = `<label>${esc(f.label)}</label>
      <div class="ctl"><input class="inp" type="date"><input class="inp" type="date"></div>`;
    const [a, b] = $$(".inp", row);
    const apply = () => setFilter(f.key, (a.value || b.value) ? { field: f.key, op: "between", value: [a.value || null, b.value || null] } : null);
    a.onchange = apply; b.onchange = apply;
    return row;
  }

  const suggest = S.suggestFields.includes(f.key) ? (S.distinct[f.key] || []) : null;
  const id = "dl_" + f.key;
  row.innerHTML = `<label>${esc(f.label)}</label>
    <div class="ctl">
      <select class="sel w70">
        <option value="contains">包含</option><option value="eq">等于</option>
        <option value="startswith">开头</option><option value="empty">为空</option><option value="notempty">不为空</option>
      </select>
      <input class="inp" list="${id}" placeholder="输入关键词">
    </div>` +
    (suggest ? `<datalist id="${id}">${suggest.map(v => `<option value="${esc(v)}"></option>`).join("")}</datalist>` : "");
  const sel = $(".sel", row), inp = $(".inp", row);
  const apply = () => {
    const op = sel.value;
    if (op === "empty" || op === "notempty") { inp.disabled = true; inp.value = ""; setFilter(f.key, { field: f.key, op }); }
    else { inp.disabled = false; const v = inp.value.trim(); setFilter(f.key, v ? { field: f.key, op, value: v } : null); }
  };
  sel.onchange = apply; inp.onchange = apply;
  inp.onkeydown = e => { if (e.key === "Enter") { apply(); refresh(); } };
  return row;
}

/* ---------------- 常用筛选（列表随其他筛选条件动态变化） ---------------- */

/** 某字段「排除自身条件」后的筛选签名：签名没变就不必重算它的列表 */
function quickSig(filters, key) {
  return JSON.stringify((filters || []).filter(f => f.field !== key));
}

/** 按当前升降序重排列表（列表项已全量取回，排序在本地做，不用重新查库） */
function sortQuickItems(key) {
  const q = S.quick[key];
  if (!q || !q.items) return;
  q.items.sort((a, b) => cmpVal(a.value, b.value, q.dir));
}

/** 刷新常用筛选的取值列表：只算「已展开」的行，折叠行展开时再单独取 */
async function refreshQuickDistinct(filters, seq, force) {
  const need = [];
  QUICK_LIST_KEYS.forEach(k => {
    const q = S.quick[k] || (S.quick[k] = { dir: "asc", items: [], sel: [], sig: undefined });
    const row = $(`#quickPanel .qf-row[data-key="${k}"]`);
    if (force) q.sig = undefined;
    if (!row || row.classList.contains("collapsed")) return;   // 折叠：展开时再取
    if (q.sig !== undefined && q.sig === quickSig(filters, k)) return;
    need.push(k);
  });
  if (need.length) {
    try {
      const j = await api("quickDistinct", { fields: need, filters, order: "asc", excludeSelf: true });
      if (seq !== undefined && seq !== QSEQ) return;           // 结果过期，丢弃
      need.forEach(k => {
        const q = S.quick[k];
        q.items = (j && j[k]) || [];
        q.sig = quickSig(filters, k);
        sortQuickItems(k);
        renderQuickList(k);
      });
    } catch (e) { }
  }
  QUICK_LIST_KEYS.forEach(renderQuickTotal);
}

/** 展开某一行时，按需单独取一次该字段的剩余取值 */
async function loadQuickOne(key) {
  const q = S.quick[key];
  if (!q) return;
  const filters = currentFilters();
  const sig = quickSig(filters, key);
  if (q.sig === sig) return;
  const seq = QSEQ;
  try {
    const j = await api("quickDistinct", { fields: [key], filters, order: "asc", excludeSelf: true });
    if (seq !== QSEQ) return;
    q.items = (j && j[key]) || [];
    q.sig = sig;
    sortQuickItems(key);
    renderQuickList(key);
  } catch (e) { }
  renderQuickTotal(key);
}

function buildQuickPanel() {
  const panel = $("#quickPanel");
  panel.innerHTML = `<div class="qf-hint">列表随其他筛选条件动态变化 · 数字为剩余条数</div>`;
  QUICK_BLOCKS.forEach((b, bi) => {
    const blk = document.createElement("div");
    blk.className = "qf-block" + (bi ? " sep" : "");
    blk.innerHTML = `<div class="qf-block-title">${esc(b.title)}</div>`;
    b.fields.forEach(k => blk.appendChild(quickRow(k, !!b.single)));
    panel.appendChild(blk);
  });
}

function numKey(v) {
  const s = String(v).replace(/[()（）\s]/g, "").replace("+", "");
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
function cmpVal(a, b, dir) {
  const na = numKey(a), nb = numKey(b);
  let r;
  if (na === null && nb === null) r = String(a).localeCompare(String(b), "zh");
  else if (na === null) r = 1;
  else if (nb === null) r = -1;
  else r = na - nb;
  return dir === "desc" ? -r : r;
}

function quickRow(key, single) {
  const f = S.fmap[key] || { label: key, type: "text" };
  const row = document.createElement("div");
  row.className = "qf-row";
  row.dataset.key = key;

  if (single) {
    row.innerHTML = `<div class="qf-line">
        <span class="qf-name">${esc(f.label)}</span>
        <input class="inp qf-val" type="number" step="0.01" placeholder="输入固定值">
        <button class="qf-clr" title="清除">×</button>
      </div>`;
    const inp = $(".qf-val", row);
    const apply = () => {
      const v = (inp.value || "").trim();
      setFilter(key, v === "" ? null : { field: key, op: "eq", value: Number(v) }, "quick");
    };
    inp.onchange = apply;
    inp.onkeydown = e => { if (e.key === "Enter") apply(); };
    $(".qf-clr", row).onclick = () => { inp.value = ""; setFilter(key, null, "quick"); };
    return row;
  }

  const q = S.quick[key] || { dir: "asc", items: [], sel: [] };
  S.quick[key] = q;
  row.classList.add("collapsed");
  row.innerHTML = `<div class="qf-head">
      <span class="caret">▸</span>
      <span class="qf-name">${esc(f.label)}</span>
      <span class="qf-badge"></span>
      <span class="qf-total" title="当前筛选条件下剩余的可选值个数（不含本字段自己的条件），展开后显示"></span>
      <span class="spacer"></span>
      <span class="qf-sort" title="切换升序 / 降序">升序</span>
    </div>
    <div class="qf-body">
      <div class="qf-tools">
        <input class="inp qf-search" placeholder="搜索数值…">
        <button class="qf-mini" data-act="all">全选</button>
        <button class="qf-mini" data-act="none">清空</button>
      </div>
      <div class="qf-list"></div>
    </div>`;

  $(".qf-head", row).onclick = e => {
    if (e.target.closest(".qf-sort")) return;
    row.classList.toggle("collapsed");
    const open = !row.classList.contains("collapsed");
    if (open) { renderQuickList(key); loadQuickOne(key); }   // 展开时才取剩余取值
    renderQuickTotal(key);
  };

  const sortBtn = $(".qf-sort", row);
  sortBtn.textContent = q.dir === "desc" ? "降序" : "升序";
  sortBtn.onclick = () => {
    q.dir = q.dir === "asc" ? "desc" : "asc";
    sortBtn.textContent = q.dir === "desc" ? "降序" : "升序";
    sortQuickItems(key);
    renderQuickList(key);
  };

  const search = $(".qf-search", row);
  search.oninput = () => renderQuickList(key);

  $$(".qf-mini", row).forEach(btn => btn.onclick = () => {
    const visible = $$(".qf-item input", row).map(x => String(x.value));
    if (btn.dataset.act === "all") {
      visible.forEach(v => { if (!q.sel.includes(v)) q.sel.push(v); });
    } else {
      q.sel = q.sel.filter(v => !visible.includes(v));
    }
    renderQuickList(key);
    applyQuickSel(key);
  });

  return row;
}

function renderQuickList(key) {
  const row = $(`#quickPanel .qf-row[data-key="${key}"]`);
  const q = S.quick[key];
  if (!row || !q) return;
  const list = $(".qf-list", row);
  if (!list) { renderQuickBadge(key); return; }   // 固定值行没有列表
  const s = $(".qf-search", row);
  const kw = s ? (s.value || "").trim() : "";
  const scrollTop = list.scrollTop;
  const hit = i => !kw || String(i.value).indexOf(kw) >= 0;
  let items = (q.items || []).filter(hit);
  /* 已勾选、但在当前条件下已经 0 条的值：置顶灰色显示，免得勾选项"凭空消失" */
  const has = {};
  items.forEach(i => has[String(i.value)] = 1);
  const zero = q.sel.map(String).filter(v => !has[v] && (!kw || v.indexOf(kw) >= 0))
    .map(v => ({ value: v, count: 0 }));
  items = zero.concat(items);
  list.innerHTML = items.length
    ? items.map(i => {
      const on = q.sel.indexOf(String(i.value)) >= 0;
      const z = i.count === 0 ? " zero" : "";
      return `<label class="qf-item${on ? " on" : ""}${z}" title="${esc(i.value)}${z ? " · 当前条件下 0 条" : ""}">
          <input type="checkbox" value="${esc(i.value)}"${on ? " checked" : ""}>
          <span>${esc(i.value)}</span><i>${i.count}</i></label>`;
    }).join("")
    : `<div class="qf-none">${(q.sig === undefined) ? "读取中…" : "当前条件下无可选值"}</div>`;
  $$(".qf-item input", list).forEach(cb => cb.onchange = () => {
    const v = String(cb.value);
    if (cb.checked) { if (q.sel.indexOf(v) < 0) q.sel.push(v); }
    else q.sel = q.sel.filter(x => x !== v);
    cb.closest(".qf-item").classList.toggle("on", cb.checked);
    renderQuickBadge(key);      // 只更新计数，不整体重绘，避免滚动跳回顶部
    applyQuickSel(key);
  });
  list.scrollTop = scrollTop;
  renderQuickBadge(key);
}

/** 行头「余 N」：当前筛选条件下还剩多少个可选值 */
function renderQuickTotal(key) {
  const row = $(`#quickPanel .qf-row[data-key="${key}"]`);
  const q = S.quick[key];
  if (!row) return;
  const el = $(".qf-total", row);
  if (!el) return;
  const expanded = !row.classList.contains("collapsed");
  if (!expanded || !q || q.sig === undefined) { el.textContent = ""; el.className = "qf-total"; return; }
  const n = (q.items || []).length;
  el.textContent = `余 ${n}`;
  el.className = "qf-total" + (n ? "" : " warn");
  el.title = n ? `当前条件下（不含本字段自身）剩余 ${n} 个可选值`
    : "当前条件下已无可选值，放宽其他条件试试";
}

function renderQuickBadge(key) {
  const row = $(`#quickPanel .qf-row[data-key="${key}"]`);
  const q = S.quick[key];
  if (!row || !q) return;
  const n = q.sel.length;
  const badge = $(".qf-badge", row);
  if (badge) { badge.textContent = n ? `已选 ${n}` : ""; badge.classList.toggle("on", !!n); }
  row.classList.toggle("active", !!n);
}

function applyQuickSel(key) {
  const q = S.quick[key];
  if (!q) return;
  const t = (S.fmap[key] || {}).type;
  const vals = q.sel.map(v => (t === "real" || t === "int") ? Number(v) : v);
  setFilter(key, vals.length ? { field: key, op: "in", value: vals } : null, "quick");
}

/** 清掉「常用筛选」里某个字段的勾选 / 输入（供别处改动同一字段时同步） */
function refreshQuickUI(key) {
  const q = S.quick[key];
  if (q) { q.sel = []; renderQuickList(key); renderQuickBadge(key); }
  const row = $(`#quickPanel .qf-row[data-key="${key}"]`);
  if (row) { const i = $(".qf-val", row); if (i) i.value = ""; }
}

/** 清掉「全部字段」面板里某个字段的输入（供常用筛选改动同一字段时同步） */
function refreshNormalUI(key) {
  const row = $(`#filterPanel [data-key="${key}"]`);
  if (!row) return;
  $$(".opt.on", row).forEach(o => o.classList.remove("on"));
  $$(".inp", row).forEach(i => { i.value = ""; i.disabled = false; });
  const sl = $(".sel.w70", row);
  if (sl) sl.value = "contains";
}

function clearQuickAll() {
  QUICK_KEYS.forEach(k => {
    const q = S.quick[k];
    if (q) q.sel = [];
    refreshQuickUI(k);
    delete S.filters[k];
  });
  S.page = 1; renderTags(); refresh();
}

/* ---------------- 筛选写入 / 清除 ---------------- */
function setFilter(key, f, src) {
  src = src || "normal";
  if (f) S.filters[key] = f; else delete S.filters[key];
  if (src !== "quick") refreshQuickUI(key);
  if (src !== "normal") refreshNormalUI(key);
  S.page = 1; renderTags(); refresh();
}

function removeFilter(key) {
  delete S.filters[key];
  refreshQuickUI(key);
  refreshNormalUI(key);
  S.page = 1; renderTags(); refresh();
}

function clearAllFilters() {
  S.filters = {}; $("#kw").value = "";
  $$("#filterPanel .opt.on").forEach(x => x.classList.remove("on"));
  $$("#filterPanel .inp").forEach(x => { x.value = ""; x.disabled = false; });
  $$("#filterPanel .sel.w70").forEach(x => x.value = "contains");
  QUICK_KEYS.forEach(k => { if (S.quick[k]) S.quick[k].sel = []; refreshQuickUI(k); });
  S.page = 1; renderTags(); refresh();
}

/* ---------------- 置顶行 ----------------
 * 选中一条比赛后就把它记住：以后不管怎么筛，它都排在窗口第一行，
 * 用来当参照物跟别的比赛对比。纯粹在前端挪位置，不动 SQL、不影响命中数。 */

function setPin(row) {
  if (!row || !row.id) return;
  S.pin = { id: row.id, new_id: row.new_id, label: row.teams || ("#" + (row.new_id || row.id)) };
  LS.set(PIN_KEY, JSON.stringify(S.pin));
}
function clearPin() {
  S.pin = null;
  LS.del(PIN_KEY);
}

/** 在当前这批行里把置顶行挪到最前（不发请求，立刻见效） */
function pinToFrontLocal() {
  if (!S.pin || !S.rows.length) return;
  const i = S.rows.findIndex(r =>
    r.id === S.pin.id || (S.pin.new_id != null && String(r.new_id) === String(S.pin.new_id)));
  if (i > 0) { const r = S.rows.splice(i, 1)[0]; S.rows.unshift(r); }
  S.rows.forEach(r => { delete r.__pin; });
}

/** 刷新时调用：能挪就挪；被当前条件筛掉了，就在第 1 页把它补到最前面当参照 */
async function applyPinRow(rows) {
  S.rows.forEach(r => { delete r.__pin; });
  rows.forEach(r => { delete r.__pin; });
  if (!S.pin) return rows;
  const i = rows.findIndex(r =>
    r.id === S.pin.id || (S.pin.new_id != null && String(r.new_id) === String(S.pin.new_id)));
  if (i === 0) return rows;
  if (i > 0) { const r = rows.splice(i, 1)[0]; rows.unshift(r); return rows; }
  if (S.page !== 1 || S.pin.new_id === undefined || S.pin.new_id === null) return rows;
  try {
    const j = await api("query", {
      filters: [{ field: "new_id", op: "eq", value: S.pin.new_id }],
      sort: S.sort, page: 1, size: 1
    });
    const r = (j.rows || [])[0];
    if (r) { r.__pin = 1; rows.unshift(r); }
    else clearPin();          // 数据里已经没有这条了（导入后可能变了），自动取消
  } catch (e) { }
  return rows;
}

function togglePin() {
  if (!S.sel) { toast("先点开一条比赛再置顶", { err: true }); return; }
  if (S.pin && S.pin.id === S.sel) {
    clearPin();
    toast("已取消置顶");
  } else {
    setPin(S.editing);
    pinToFrontLocal();
    toast("已置顶，筛选后它仍排第一行");
  }
  renderPinUI(); renderTags(); renderTable();
}

function renderPinUI() {
  const b = $("#btnPin");
  if (!b) return;
  const on = !!(S.pin && S.sel && S.pin.id === S.sel);
  b.textContent = on ? "取消置顶" : "置顶";
  b.classList.toggle("primary", on);
}

/* ---------------- 快捷检索 ----------------
 * 以选中那条为基准：胜负 / 负胜 取固定值，初让胜 / 初让负 取 ±tol 的范围。
 * 写进的是普通筛选条件，所以之后还能继续叠加、修改、删掉其中任何一个。 */

function syncRangeInputs(key, lo, hi) {
  const row = $(`#filterPanel [data-key="${key}"]`);
  if (!row) return;
  const ins = $$(".inp", row);
  if (ins.length >= 2) { ins[0].value = lo; ins[1].value = hi; }
}

/** 常用筛选里「固定值」那两行（胜负 / 负胜）也跟着填上，两边保持一致 */
function syncQuickSingle(key, v) {
  const row = $(`#quickPanel .qf-row[data-key="${key}"]`);
  if (!row) return;
  const i = $(".qf-val", row);
  if (i) i.value = (v === null || v === undefined) ? "" : v;
}

async function quickFindFromSel() {
  const row = S.editing;
  if (!row || !row.id) { toast("先点开一条比赛，再按它检索", { err: true }); return; }
  const tol = S.tol;
  const parts = [], miss = [];
  QF_KEYS.forEach(k => {
    const v = row[k];
    if (v === null || v === undefined || v === "") {
      delete S.filters[k]; refreshQuickUI(k); refreshNormalUI(k);
      miss.push(S.fmap[k].label); return;
    }
    const n = Number(v);
    if (QF_FIXED.indexOf(k) >= 0) {
      // 胜负 / 负胜：固定值，精确等于
      S.filters[k] = { field: k, op: "eq", value: n };
      refreshQuickUI(k); refreshNormalUI(k); syncQuickSingle(k, n);
      parts.push(`${S.fmap[k].label}=${n}`);
    } else {
      const lo = +(n - tol).toFixed(4), hi = +(n + tol).toFixed(4);
      S.filters[k] = { field: k, op: "between", value: [lo, hi] };
      refreshQuickUI(k); refreshNormalUI(k); syncRangeInputs(k, lo, hi);
      parts.push(`${S.fmap[k].label} ${lo}~${hi}`);
    }
  });
  S.page = 1;
  renderTags();
  renderPinUI();
  closeDrawer();
  refresh();
  toast(parts.join(" · ") + (miss.length ? `（${miss.join("、")}为空，已跳过）` : ""));
}

function cycleTol() {
  const i = TOL_LIST.indexOf(S.tol);
  S.tol = TOL_LIST[(i + 1) % TOL_LIST.length];
  LS.set(TOL_KEY, String(S.tol));
  renderTolUI();
  toast("初让胜 / 初让负 的浮动范围改为 ±" + S.tol);
}
function renderTolUI() {
  const b = $("#btnTol"), t = $("#tolTxt");
  if (b) b.textContent = "±" + S.tol;
  if (t) t.textContent = String(S.tol);
}

function renderTags() {
  const box = $("#tagbar");
  const list = Object.values(S.filters);
  const pinTag = S.pin
    ? `<span class="ftag pin"><b>置顶</b>${esc(S.pin.label)}<span class="x" data-pin="1">×</span></span>` : "";
  if (!list.length) {
    box.innerHTML = pinTag +
      `<span style="color:var(--muted);font-size:12px">${pinTag ? "" : "未设置筛选条件，" }当前显示全部 ${S.total} 条</span>`;
    bindTagX(box);
    return;
  }
  box.innerHTML = pinTag + list.map(f => {
    const label = S.fmap[f.field].label;
    let txt;
    if (f.op === "in") {
      const vs = (f.value || []).map(String);
      txt = vs.length <= 4 ? "属于 " + vs.join("/") : `属于 ${vs.slice(0, 3).join("/")} 等 ${vs.length} 项`;
    }
    else if (f.op === "between") txt = (f.value[0] ?? "不限") + " ~ " + (f.value[1] ?? "不限");
    else if (f.op === "empty") txt = "为空";
    else if (f.op === "notempty") txt = "不为空";
    else if (f.op === "any") txt = "含 " + f.value;
    else if (f.op === "eq") txt = "= " + f.value;
    else txt = ({ contains: "包含", eq: "等于", startswith: "开头" })[f.op] + " " + f.value;
    return `<span class="ftag"><b>${esc(label)}</b>${esc(txt)}<span class="x" data-k="${f.field}">×</span></span>`;
  }).join("") + `<span style="color:var(--muted);font-size:12px">共 ${list.length} 个条件 · 命中 ${S.total} 条</span>`;
  bindTagX(box);
}

/** 标签上的 ×：普通条件删筛选，置顶标签取消置顶 */
function bindTagX(box) {
  $$(".x[data-k]", box).forEach(x => x.onclick = () => removeFilter(x.dataset.k));
  $$(".x[data-pin]", box).forEach(x => x.onclick = () => {
    clearPin(); renderPinUI(); renderTags(); renderTable();
  });
}

/* ---------------- 查询与表格 ---------------- */
let QSEQ = 0;   // 查询序号：连续改条件时丢弃过期的返回，避免旧结果覆盖新结果
function currentFilters() {
  const filters = Object.values(S.filters).slice();
  const kw = ($("#kw").value || "").trim();
  if (kw) filters.push({ field: "teams", op: "any", value: kw, fields: ["teams", "league", "match_no"] });
  return filters;
}
async function refresh(opts) {
  const filters = currentFilters();
  const seq = ++QSEQ;
  try {
    const j = await api("query", { filters, sort: S.sort, page: S.page, size: S.size });
    if (seq !== QSEQ) return;
    S.total = j.total; S.rows = await applyPinRow(j.rows || []);
    renderTable(); renderPager(); renderTags();
  } catch (e) { if (seq === QSEQ) toast("查询失败：" + e.message, { err: true }); }
  // 统计栏与常用筛选的剩余取值一起刷新，省一轮等待
  await Promise.all([loadStatBar(filters, seq), refreshQuickDistinct(filters, seq, opts && opts.force)]);
}

/* ---------------- 统计状态栏 ---------------- */
async function loadStatBar(filters, seq) {
  try {
    const data = await api("groupCount", { filters, fields: STAT_FIELDS.map(s => s.key) });
    if (seq !== undefined && seq !== QSEQ) return;
    renderStatBar(data);
  } catch (e) {
    $("#statbar").classList.remove("show");
  }
}

function renderStatBar(data) {
  const box = $("#statbar");
  if (!S.total) { box.classList.remove("show"); box.innerHTML = ""; return; }
  let html = `<span class="stat-title">筛选结果统计 · ${S.total} 条</span>`;
  STAT_FIELDS.forEach(sf => {
    const items = (data && data[sf.key]) || [];
    const map = {};
    items.forEach(i => { map[String(i.value)] = i.count; });
    let keys = sf.order.filter(k => map[k] !== undefined);
    Object.keys(map).forEach(k => { if (!keys.includes(k)) keys.push(k); });
    if (!keys.length) return;
    const cur = S.filters[sf.key];
    html += `<span class="stat-group"><b>${esc(sf.label)}</b>` + keys.map(k => {
      const c = map[k];
      const pct = (c / S.total * 100).toFixed(1);
      const on = !!cur && cur.op === "in" && (cur.value || []).map(String).includes(k);
      const cls = RESULT_STYLE[k] || "";
      return `<span class="stat-item ${on ? "on" : ""} ${cls}" data-f="${sf.key}" data-v="${esc(k)}"
        title="点击按「${esc(sf.label)} = ${esc(k)}」筛选，再点一次取消">${esc(k)}<i>${c}</i><em>${pct}%</em></span>`;
    }).join("") + `</span>`;
  });
  box.innerHTML = html;
  box.classList.add("show");
  $$(".stat-item", box).forEach(el => el.onclick = () => toggleQuick(el.dataset.f, el.dataset.v));
}

function toggleQuick(field, value) {
  const cur = S.filters[field];
  const isEmptyVal = (value === "（空）");
  let next = null;
  if (isEmptyVal) {
    next = (cur && cur.op === "empty") ? null : { field, op: "empty" };
  } else if (cur && cur.op === "in" && (cur.value || []).length === 1 && String(cur.value[0]) === value) {
    next = null;
  } else {
    next = { field, op: "in", value: [value] };
  }
  setFilter(field, next, "stat");
  syncChips(field, next && next.op === "in" ? next.value : []);
}

/** 让左侧筛选面板的标签与状态栏点击保持同步 */
function syncChips(field, values) {
  const row = $(`#filterPanel [data-key="${field}"]`);
  if (!row) return;
  const vs = (values || []).map(String);
  $$(".opt", row).forEach(o => o.classList.toggle("on", vs.includes(String(o.dataset.v))));
}

function fmtCell(key, v) {
  if (v === null || v === undefined || v === "") return `<span class="cell-empty">—</span>`;
  if (key === "half" || key === "full") return `<span class="badge ${RESULT_STYLE[v] || ""}">${esc(v)}</span>`;
  if (key === "record" || key === "review") return `<span class="cell-note">${esc(v)}</span>`;
  if (key === "teams") return `<span title="${esc(v)}">${esc(v)}</span>`;
  if (typeof v === "number") return String(v);
  return esc(v);
}

function renderTable() {
  const wrap = $("#tableWrap");
  if (!S.rows.length) {
    wrap.innerHTML = `<div class="empty-tip">没有符合条件的数据<br><span style="font-size:12px">试试清空筛选条件，或导入数据</span></div>`;
    return;
  }
  const sepOf = (k, i) => (i > 0 && SEP_COLS.indexOf(k) >= 0) ? " sep" : "";
  const cols = S.cols.filter(k => S.fmap[k]);
  let html = `<table class="grid"><thead><tr>`;
  cols.forEach((k, i) => {
    const f = S.fmap[k];
    const arrow = S.sort.field === k ? `<span class="arrow">${S.sort.dir === "asc" ? "▲" : "▼"}</span>` : "";
    html += `<th data-k="${k}" class="${sepOf(k, i)}">${esc(f.label)}${arrow}</th>`;
  });
  html += `</tr></thead><tbody>`;
  S.rows.forEach(r => {
    const cls = [S.sel === r.id ? "sel" : "", r.__pin ? "pin" : ""].filter(Boolean).join(" ");
    const mark = r.__pin ? `<span class="pinmark" title="置顶参照行：它本身不符合当前筛选条件">置顶</span>` : "";
    html += `<tr data-id="${r.id}" class="${cls}">` +
      cols.map((k, i) => `<td class="${sepOf(k, i)}">${i === 0 ? mark : ""}${fmtCell(k, r[k])}</td>`).join("") + `</tr>`;
  });
  html += `</tbody></table>`;
  wrap.innerHTML = html;
  $$("th", wrap).forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    if (S.sort.field === k) S.sort.dir = S.sort.dir === "asc" ? "desc" : "asc";
    else { S.sort.field = k; S.sort.dir = "asc"; }
    $("#sortField").value = k; $("#sortDir").value = S.sort.dir;
    S.page = 1; refresh();
  });
  $$("tbody tr", wrap).forEach(tr => {
    if (MOBILE) {
      tr.onclick = () => openDrawer(+tr.dataset.id);    // 手机：点一下直接打开详情
      return;
    }
    tr.onclick = () => {   // 桌面：单击仅高亮该行
      $$("tbody tr", wrap).forEach(x => x.classList.toggle("sel", x === tr));
    };
    tr.ondblclick = () => openDrawer(+tr.dataset.id);   // 双击：打开详情
  });
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(S.total / S.size));
  if (S.page > pages) S.page = pages;
  const cur = S.page;
  const nums = [];
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - cur) <= 2) nums.push(i);
    else if (nums[nums.length - 1] !== "…") nums.push("…");
  }
  $("#pager").innerHTML =
    `<span class="info">共 ${S.total} 条 · 第 ${cur}/${pages} 页</span>
     <div class="pages">
       <button class="pg" data-p="1" ${cur === 1 ? "disabled" : ""}>«</button>
       <button class="pg" data-p="${cur - 1}" ${cur === 1 ? "disabled" : ""}>‹</button>
       ${nums.map(n => n === "…" ? `<span style="color:var(--muted)">…</span>`
        : `<button class="pg ${n === cur ? "on" : ""}" data-p="${n}">${n}</button>`).join("")}
       <button class="pg" data-p="${cur + 1}" ${cur === pages ? "disabled" : ""}>›</button>
       <button class="pg" data-p="${pages}" ${cur === pages ? "disabled" : ""}>»</button>
     </div>
     <div class="spacer"></div>
     <span class="info">双击任意一行可查看 / 编辑完整 34 项</span>`;
  $$("#pager .pg").forEach(b => b.onclick = () => {
    if (b.disabled) return;
    const p = +b.dataset.p; if (p < 1 || p > pages) return;
    S.page = p; refresh();
  });
}

/* ---------------- 列设置 ---------------- */
function buildColPopover() {
  const box = $("#colGroups");
  box.innerHTML = GROUP_ORDER.map(g => {
    const items = S.fields.filter(f => f.group === g);
    if (!items.length) return "";
    return `<div style="margin-bottom:8px"><div style="font-size:11px;color:var(--muted);margin-bottom:3px">${g}</div>
      <div class="colgrid">${items.map(f =>
      `<label><input type="checkbox" value="${f.key}" ${S.cols.includes(f.key) ? "checked" : ""}> ${esc(f.label)}</label>`).join("")}</div></div>`;
  }).join("");
  $("#colOk").onclick = () => {
    S.cols = $$("#colGroups input:checked").map(x => x.value);
    if (!S.cols.length) S.cols = ["new_id"];
    LS.set(COLS_KEY, JSON.stringify(S.cols));
    $("#colPop").classList.remove("show");
    renderTable();
  };
  $("#colAll").onclick = () => $$("#colGroups input").forEach(x => x.checked = true);
  $("#colNone").onclick = () => $$("#colGroups input").forEach(x => x.checked = false);
  $("#btnCols").onclick = e => {
    const p = $("#colPop");
    p.classList.toggle("show");
    if (p.classList.contains("show")) {
      const r = e.target.getBoundingClientRect();
      p.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 480)) + "px";
      p.style.top = (r.bottom + 6) + "px";
    }
  };
  $("#btnResetCols").onclick = () => { S.cols = DEFAULT_COLS.slice(); LS.del(COLS_KEY); buildColPopover(); renderTable(); };
  document.addEventListener("click", e => {
    if (!e.target.closest("#colPop") && !e.target.closest("#btnCols")) $("#colPop").classList.remove("show");
  });
}

/* ---------------- 详情抽屉 ---------------- */
async function openDrawer(id) {
  S.sel = id || null;
  $("#drawer").classList.add("open");
  let row;
  if (id) {
    row = await api("getRow", id);
    $("#dTitle").textContent = `记录 #${row.new_id || id}　详情`;
    S.editing = Object.assign({}, row);
    /* 选中即置顶：以后筛选时它始终排第一行，方便拿它当参照 */
    setPin(row);
    pinToFrontLocal();
    renderPinUI();
  } else {
    row = {}; S.editing = {};
    $("#dTitle").textContent = "新增记录";
  }
  renderDrawer(row, !!id);
  renderTable();
}

function renderDrawer(row, isEdit) {
  const box = $("#dBody");
  let html = "";
  ["record", "review"].forEach(k => {
    const f = S.fmap[k];
    const v = row[k] || "";
    html += `<div class="notebox highlight">
      <div class="field">
        <label><span>${esc(f.label)} <span style="color:var(--muted)">（最多 ${S.textMax} 字）</span></span>
          <span class="counter" data-c="${k}">${String(v).length}/${S.textMax}</span></label>
        <textarea data-f="${k}" maxlength="${S.textMax}" placeholder="输入${esc(f.label)}内容，最多 ${S.textMax} 个字">${esc(v)}</textarea>
      </div></div>`;
  });
  ["基本信息", "赛果", "赔率"].forEach(g => {
    html += `<div class="sect">${g}</div><div class="grid2">`;
    S.fields.filter(f => f.group === g).forEach(f => {
      const v = row[f.key] ?? "";
      const type = (f.type === "int" || f.type === "real") ? "number" : "text";
      const step = f.type === "real" ? ' step="0.01"' : "";
      let ctl = `<input class="inp" type="${type}"${step} data-f="${f.key}" value="${esc(v)}" placeholder="${esc(f.label)}">`;
      const opts = S.distinct[f.key] || [];
      if (S.enumFields.includes(f.key) && opts.length) {
        const has = opts.map(String).includes(String(v));
        ctl = `<select class="sel" data-f="${f.key}"><option value="">— 未填 —</option>` +
          opts.map(o => `<option value="${esc(o)}" ${String(v) === String(o) ? "selected" : ""}>${esc(o)}</option>`).join("") +
          (String(v) && !has ? `<option value="${esc(v)}" selected>${esc(v)}</option>` : "") + `</select>`;
      }
      html += `<div class="field"><label>${esc(f.label)}</label>${ctl}</div>`;
    });
    html += `</div>`;
  });
  if (isEdit && row.updated_at) html += `<div style="color:var(--muted);font-size:11.5px;margin-top:10px">最后更新：${esc(row.updated_at)}　（数据库 ID ${row.id}）</div>`;
  box.innerHTML = html;
  $$("textarea[data-f]", box).forEach(t => {
    t.oninput = () => {
      const c = $(`.counter[data-c="${t.dataset.f}"]`, box);
      if (!c) return;
      c.textContent = `${t.value.length}/${S.textMax}`;
      c.classList.toggle("over", t.value.length > S.textMax);
    };
  });
  $("#btnDelete").style.display = isEdit ? "" : "none";
}

function collectForm() {
  const data = {};
  $$("#dBody [data-f]").forEach(el => {
    const k = el.dataset.f;
    const t = S.fmap[k].type;
    let v = el.value;
    if (v === "") data[k] = null;
    else data[k] = (t === "int" || t === "real") ? Number(v) : v;
  });
  return data;
}

/** 与原始记录对比，找出「记录 / 复盘」之外被改动的字段 */
function diffFields(data) {
  const orig = S.editing || {};
  const out = [];
  Object.keys(data).forEach(k => {
    if (k === "record" || k === "review") return;
    const f = S.fmap[k];
    if (!f) return;
    const a = orig[k], b = data[k];
    const sa = (a === null || a === undefined || a === "") ? "" : String(a);
    const sb = (b === null || b === undefined || b === "") ? "" : String(b);
    let same = (sa === sb);
    if (!same && (f.type === "real" || f.type === "int")) {
      const na = parseFloat(sa), nb = parseFloat(sb);
      if (!isNaN(na) && !isNaN(nb) && Math.abs(na - nb) < 1e-9) same = true;
      else if (sa === "" && sb === "") same = true;
    }
    if (!same) out.push({ label: f.label, from: sa, to: sb });
  });
  return out;
}

/** 改动确认弹窗：列出「原值 → 新值」 */
function confirmChanges(diffs) {
  return new Promise(res => {
    const rows = diffs.slice(0, 40).map(d =>
      `<div class="diff-row"><span class="dk">${esc(d.label)}</span>` +
      `<b class="dv old">${esc(d.from || "（空）")}</b><span class="darw">→</span>` +
      `<b class="dv new">${esc(d.to || "（空）")}</b></div>`).join("");
    openModal(`<h3>确认修改数据</h3>
      <div class="mbody">
        <div style="margin-bottom:8px;line-height:1.7">检测到除「记录 / 复盘」外，有 <b style="color:var(--danger)">${diffs.length}</b> 项数据被改动。请核对后再保存：</div>
        <div class="diff-list">${rows}</div>
        ${diffs.length > 40 ? `<div style="color:var(--muted);font-size:11.5px;margin-top:6px">仅显示前 40 项，共 ${diffs.length} 项</div>` : ""}
        <div class="hint" style="margin-top:10px">只改了「记录 / 复盘」时不会弹这个确认框。</div>
      </div>
      <div class="mfoot">
        <button class="btn" id="cfNo">取消</button>
        <button class="btn primary" id="cfYes">确定保存</button>
      </div>`);
    $("#cfNo").onclick = () => { closeModal(); res(false); };
    $("#cfYes").onclick = () => { closeModal(); res(true); };
  });
}

/* ---------------- 导入 ---------------- */
function openImport(first) {
  openModal(`
    <h3>${first ? "首次使用 · 请先导入数据" : "导入数据"}</h3>
    <div class="mbody">
      <div class="mrow">
        <label>方式一：直接填写 Excel / CSV 文件路径（推荐，适合理大文件）</label>
        <input class="inp" id="impPath" value="${esc(S.envPath)}" placeholder="如 D:\\工作文档\\入库实战区.xlsx">
      </div>
      <div class="mrow">
        <label>方式二：从磁盘选择文件（文件会被复制到程序目录再导入）</label>
        <input type="file" id="impFile" accept=".xlsx,.xls,.csv">
      </div>
      <div class="mrow">
        <label>导入方式</label>
        <div class="radio-col">
          <label><input type="radio" name="mode" value="update" checked> <b>按新ID更新（推荐）</b>：新ID 已存在的，内容有变化就覆盖、没变化就保留；新ID 没有的，新增</label>
          <label><input type="radio" name="mode" value="replace"> 覆盖重建：清空全部数据后重新导入（会丢掉系统里已写的 记录 / 复盘）</label>
          <label><input type="radio" name="mode" value="append"> 追加：全部作为新行插入（会产生重复）</label>
        </div>
      </div>
      <div class="mrow">
        <label class="chk-line"><input type="checkbox" id="impKeepText" checked>
          保留系统内已有的「记录 / 复盘」（导入表里这两列为空时，不清掉我写的）</label>
      </div>
      <div class="hint">表头需与原表一致（新ID、比赛时间、竞彩场次、联赛、主队（让球）vs客队 …）。<br>
        8 万行导入约需 20~60 秒，可在状态栏查看进度，请勿关闭窗口。</div>
    </div>
    <div class="mfoot">
      <button class="btn" id="impCancel">取消</button>
      <button class="btn primary" id="impGo">开始导入</button>
    </div>`);
  $("#impCancel").onclick = closeModal;
  $("#impGo").onclick = doImport;
}

async function doImport() {
  const path = ($("#impPath").value || "").trim();
  const file = $("#impFile").files[0];
  const mode = $('input[name="mode"]:checked').value;
  const keepText = ($("#impKeepText") || {}).checked !== false;
  if (!path && !file) { toast("请填写路径或选择文件", { err: true }); return; }

  let content = "", name = "";
  if (file) {
    if (file.size > 80 * 1024 * 1024) { toast("文件过大，请改用填写路径的方式导入", { err: true }); return; }
    content = await new Promise((ok, no) => {
      const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(file);
    });
    name = file.name;
  }

  busy(true, "正在导入数据，请稍候…");
  try {
    await api("startImport", { path, content, name, mode, keepText });
    const prog = `<div class="progress" id="progBar"><i></i></div><div id="progText" style="font-size:12px;color:var(--text-2);margin-top:6px"></div>`;
    $("#modal").querySelector(".mbody").insertAdjacentHTML("beforeend", prog);
    let last = null;
    for (let i = 0; i < 900; i++) {
      const st = await api("importStatus");
      const bar = $("#progBar");
      if (bar) bar.querySelector("i").style.width = (st.done ? 100 : Math.min(95, (i % 40) + 20)) + "%";
      const t = $("#progText");
      if (t) t.textContent = st.done ? "导入完成" : `已读取 ${st.read} 行，新增 ${st.inserted} 条，更新 ${st.updated} 条…`;
      last = st;
      if (st.done) break;
      await sleep(500);
    }
    busy(false);
    if (last && last.error) { toast("导入失败：" + last.error.split("\n")[0], { err: true }); return; }
    const r = (last && last.result) || {};
    toast(`导入完成：读取 ${r.read ?? 0} 行，新增 ${r.inserted ?? 0} 条，覆盖 ${r.updated ?? 0} 条，未变化保留 ${r.unchanged ?? 0} 条，跳过空行 ${r.skipped ?? 0} 条`);
    closeModal();
    await loadStats();
    buildQuickPanel();
    S.page = 1; await refresh({ force: true });
  } catch (e) {
    busy(false);
    toast("导入失败：" + e.message, { err: true });
  }
}

/* ---------------- 导出 ---------------- */
/** 手机版：生成 CSV 后交给系统保存对话框 */
function exportMobile() {
  openModal(`
    <h3>导出数据</h3>
    <div class="mbody">
      <div class="mrow">
        <label>导出范围</label>
        <div class="radio-line">
          <label><input type="radio" name="scope" value="filtered" checked> 当前筛选结果（${S.total} 条）</label>
          <label><input type="radio" name="scope" value="all"> 全部数据（${S.stats.total ?? 0} 条）</label>
        </div>
      </div>
      <div class="hint">导出为 CSV，Excel 可直接打开。点「开始导出」后会弹出保存位置的选择框。<br>
        数据量大时（几万行）会稍慢几秒，属正常。</div>
    </div>
    <div class="mfoot">
      <button class="btn" id="expCancel">取消</button>
      <button class="btn primary" id="expGo">开始导出</button>
    </div>`);
  on("#expCancel", closeModal);
  on("#expGo", async () => {
    const scope = $('input[name="scope"]:checked').value;
    closeModal();
    busy(true, "正在生成 CSV…");
    await sleep(30);
    try {
      const filters = scope === "all" ? [] : currentFilters();
      const r = window.JSDB.exportCsv(filters, S.sort, 0);
      if (r.error) throw new Error(r.error);
      if (!r.count) { busy(false); toast("没有可导出的数据", { err: true }); return; }
      const d = new Date(), p = n => (n < 10 ? "0" : "") + n;
      const ts = "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes());
      busy(false);
      window.MB.saveText(`实战区导出_${ts}.csv`, r.text);
      toast(`已生成 ${r.count} 行，请在弹出的保存框里选个位置`);
    } catch (e) {
      busy(false);
      toast("导出失败：" + e.message, { err: true });
    }
  });
}

function openExport() {
  if (MOBILE) return exportMobile();
  openModal(`
    <h3>导出数据</h3>
    <div class="mbody">
      <div class="mrow">
        <label>导出范围</label>
        <div class="radio-line">
          <label><input type="radio" name="scope" value="filtered" checked> 当前筛选结果（${S.total} 条）</label>
          <label><input type="radio" name="scope" value="all"> 全部数据（${S.stats.total ?? 0} 条）</label>
        </div>
      </div>
      <div class="mrow">
        <label>文件格式</label>
        <div class="radio-line">
          <label><input type="radio" name="fmt" value="xlsx" checked> Excel（.xlsx）</label>
          <label><input type="radio" name="fmt" value="csv"> CSV（.csv，Excel 可直接打开）</label>
        </div>
      </div>
      <div class="hint">导出文件保存在程序目录下的「导出」文件夹，完成后可直接打开。</div>
    </div>
    <div class="mfoot">
      <button class="btn" id="expCancel">取消</button>
      <button class="btn primary" id="expGo">开始导出</button>
    </div>`);
  $("#expCancel").onclick = closeModal;
  $("#expGo").onclick = async () => {
    const scope = $('input[name="scope"]:checked').value;
    const format = $('input[name="fmt"]:checked').value;
    busy(true, "正在导出…");
    try {
      await api("startExport", { filters: Object.values(S.filters), sort: S.sort, format, scope });
      let st = null;
      for (let i = 0; i < 600; i++) {
        st = await api("exportStatus");
        if (st.done) break;
        await sleep(400);
      }
      busy(false); closeModal();
      if (st && st.error) { toast("导出失败：" + st.error.split("\n")[0], { err: true }); return; }
      const dir = st.path.replace(/[^\\/]+$/, "");
      toast("导出成功", {
        path: st.path,
        actions: [
          { act: "open", label: "打开文件", fn: () => api("openPath", st.path).catch(e => toast(e.message, { err: true })) },
          { act: "dir", label: "打开文件夹", fn: () => api("openPath", dir).catch(e => toast(e.message, { err: true })) }
        ]
      });
    } catch (e) {
      busy(false);
      toast("导出失败：" + e.message, { err: true });
    }
  };
}

/* ---------------- 数据包同步（换机器 / 两台电脑） ---------------- */
function openSync() {
  const st = S.stats || {};
  openModal(`
    <h3>数据同步 · 数据包</h3>
    <div class="mbody">
      <div class="mrow">
        <label>① 在这台机器上导出数据包 —— 把当前全部数据（<b>${st.total ?? 0}</b> 条，含已写的记录 / 复盘）打包成一个 zip</label>
        <button class="btn primary" id="syncExp">导出数据包</button>
        <div id="syncExpInfo" style="margin-top:6px;font-size:11.5px;color:var(--text-2)"></div>
      </div>
      <div class="mrow">
        <label>② 在另一台机器上导入数据包（填路径，或直接选文件）</label>
        <input class="inp" id="syncPath" placeholder="如 D:\\实战区数据包_20261007_080000_84003条.zip">
        <div style="margin-top:6px"><input type="file" id="syncFile" accept=".zip"></div>
        <div id="syncInfo" style="margin-top:6px;font-size:11.5px;color:var(--text-2)"></div>
      </div>
      <div class="mrow">
        <label>导入方式</label>
        <div class="radio-line">
          <label><input type="radio" name="smode" value="merge" checked> 合并（推荐：保留本机，只补本机没有的行、以及本机为空的字段）</label>
          <label><input type="radio" name="smode" value="replace"> 覆盖替换（清空本机数据，完全用数据包）</label>
        </div>
      </div>
      <div class="mrow" id="preferRow">
        <label>两边都有值时以谁为准</label>
        <div class="radio-line">
          <label><input type="radio" name="sprefer" value="local" checked> 保留本机</label>
          <label><input type="radio" name="sprefer" value="remote"> 以数据包为准</label>
        </div>
      </div>
      <div class="hint">
        数据包保存在程序目录的 <b>同步</b> 文件夹里，就是一个 zip（里面是完整数据库 + 清单），拷 U 盘或发微信都行。<br>
        合并按 <b>新ID + 竞彩场次 + 比赛时间</b> 判断是不是同一场比赛，所以两台机器上分别写的记录 / 复盘能合到一起。<br>
        建议流程：A 机导出 → B 机导入（合并）→ B 机改完再导出 → A 机导入（合并）。
      </div>
    </div>
    <div class="mfoot">
      <button class="btn" id="syncClose">关闭</button>
      <button class="btn primary" id="syncGo">开始导入</button>
    </div>`);

  const modeRadios = $$('input[name="smode"]');
  const syncMode = () => {
    const m = ($('input[name="smode"]:checked') || {}).value || "merge";
    $("#preferRow").style.display = m === "merge" ? "" : "none";
  };
  modeRadios.forEach(r => r.onchange = syncMode);
  syncMode();

  $("#syncClose").onclick = closeModal;

  $("#syncExp").onclick = async () => {
    busy(true, "正在打包数据…");
    try {
      const r = await api("exportPack");
      if (r.error) { toast("打包失败：" + r.error.split("\n")[0], { err: true }); return; }
      const m = r.manifest || {};
      $("#syncExpInfo").innerHTML =
        `已生成：<b>${esc(r.path)}</b><br>共 ${m.total ?? 0} 条，已写记录 ${m.has_record ?? 0} 条、复盘 ${m.has_review ?? 0} 条，导出时间 ${esc(m.exported_at || "")}`;
      const dir = r.path.replace(/[^\\/]+$/, "");
      toast("数据包已导出", {
        path: r.path,
        actions: [
          { act: "open", label: "打开文件夹", fn: () => api("openPath", dir).catch(e => toast(e.message, { err: true })) }
        ]
      });
    } catch (e) { toast("打包失败：" + e.message, { err: true }); }
    finally { busy(false); }
  };

  const pathInp = $("#syncPath");
  pathInp.onchange = async () => {
    const p = (pathInp.value || "").trim();
    if (!p) { $("#syncInfo").textContent = ""; return; }
    try {
      const r = await api("peekPack", { path: p });
      const m = r.manifest || {};
      $("#syncInfo").innerHTML = r.error
        ? `<span style="color:var(--danger)">${esc(r.error)}</span>`
        : `数据包内容：<b>${m.total ?? "?"}</b> 条，记录 ${m.has_record ?? 0} / 复盘 ${m.has_review ?? 0}，导出自 ${esc(m.machine || "未知机器")} ${esc(m.exported_at || "")}`;
    } catch (e) { $("#syncInfo").textContent = ""; }
  };

  $("#syncGo").onclick = async () => {
    const path = (pathInp.value || "").trim();
    const file = $("#syncFile").files[0];
    const mode = ($('input[name="smode"]:checked') || {}).value || "merge";
    const prefer = ($('input[name="sprefer"]:checked') || {}).value || "local";
    if (!path && !file) { toast("请填写数据包路径或选择文件", { err: true }); return; }
    if (mode === "replace") {
      const ok = await confirmBox("覆盖替换", "这会清空本机现有数据，完全用数据包里的内容替代。确定继续吗？建议先导出一份本机数据包做备份。");
      if (!ok) return;
    }
    let content = "", name = "";
    if (file) {
      content = await new Promise((ok, no) => {
        const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = no; fr.readAsDataURL(file);
      });
      name = file.name;
    }
    busy(true, "正在合并数据，请稍候…");
    try {
      const r = await api("importPack", { path, content, name, mode, prefer });
      if (r.error) { toast("导入失败：" + r.error.split("\n")[0], { err: true }); return; }
      busy(false);
      if (mode === "replace") {
        toast(`已用数据包覆盖：现在共 ${(r.after || {}).total ?? 0} 条`);
      } else {
        const hits = r.field_hits || {};
        const top = Object.keys(hits).slice(0, 6).map(k => `${k} ${hits[k]}`).join("、");
        toast(`合并完成：数据包 ${r.src_total ?? 0} 条 → 新增 ${r.inserted ?? 0} 行，更新 ${r.updated_rows ?? 0} 行` +
          (top ? `\n补齐字段：${top}${Object.keys(hits).length > 6 ? " 等" : ""}` : ""));
      }
      closeModal();
      await loadStats();
      buildQuickPanel();
      S.page = 1; await refresh({ force: true });
    } catch (e) { toast("导入失败：" + e.message, { err: true }); }
    finally { busy(false); }
  };
}

/* ---------------- 手机端专有：侧栏抽屉 / 数据库文件 ---------------- */
function toggleSidebar(open) {
  const sb = $("#sidebar"), mk = $("#sideMask");
  if (!sb) return;
  const show = open === undefined ? !sb.classList.contains("open") : !!open;
  sb.classList.toggle("open", show);
  if (mk) mk.classList.toggle("show", show);
}

function closeDrawer() {
  $("#drawer").classList.remove("open");
  S.sel = null;
  renderTable();
}

/** 数据库管理：选文件 / 看状态 / 重新读取最新数据 */
function openDbPanel(first) {
  const d = MOBILE ? MB.dbInfo() : {};
  const mb = d.size ? (d.size / 1024 / 1024).toFixed(1) + " MB" : "—";
  openModal(`<h3>${first ? "先选择数据库文件" : "数据库"}</h3>
    <div class="mbody">
      <div class="hint" style="line-height:1.8">
        手机版不内置数据，需要你从电脑把 <b>shizhanqu.db</b> 传过来（微信 / QQ / 数据线都行），
        然后在这里选中它。之后每次电脑上更新了数据，把新的 db 传过来覆盖，点「重新读取」即可。
      </div>
      <div class="dbstat">
        <div><span>当前状态</span><b>${d.ready ? "已加载 " + (d.count || 0) + " 条" : "未加载"}</b></div>
        <div><span>文件大小</span><b>${mb}</b></div>
      </div>
      ${first ? "" : `<div class="hint">选过的文件会被记住，下次点「重新读取」就不用再找一遍。</div>`}
    </div>
    <div class="mfoot">
      <button class="btn" id="dbClose">${first ? "稍后再说" : "关闭"}</button>
      <button class="btn" id="dbReload">重新读取</button>
      <button class="btn primary" id="dbPick">选择数据库文件</button>
    </div>`);
  on("#dbClose", closeModal);
  on("#dbPick", () => { toast("请在弹出的文件选择器里找到 shizhanqu.db"); MB.pickDb(); });
  on("#dbReload", () => { toast("正在重新读取…"); MB.reloadDb(); });
}

/* ---------------- 手机版：从 Excel 导入 ----------------
 * 流程：网页弹窗选模式 -> 调安卓去挑 xlsx -> Java 那边转成 CSV
 *      -> 回调 __onImportReady -> 网页分批读 CSV 写进临时表 -> SQL 比对入库。
 * 判定规则和电脑端完全一致：没有的新ID新增，有变化的覆盖，没变化的原样不动。
 */
function importMobile() {
  openModal(`
    <h3>导入 Excel 表格</h3>
    <div class="mbody">
      <div class="mrow">
        <label>导入方式</label>
        <div class="radio-col">
          <label><input type="radio" name="mode" value="update" checked> <b>按新ID更新（推荐）</b>：新ID 已存在的，内容有变化就覆盖、没变化就保留；新ID 没有的，新增</label>
          <label><input type="radio" name="mode" value="replace"> 覆盖重建：清空全部数据后重新导入（会丢掉已写的 记录 / 复盘）</label>
          <label><input type="radio" name="mode" value="append"> 追加：全部作为新行插入（会产生重复）</label>
        </div>
      </div>
      <div class="mrow">
        <label class="chk-line"><input type="checkbox" id="impKeepText" checked>
          保留系统内已有的「记录 / 复盘」（表格里这两列是空的，就不清掉我写的）</label>
      </div>
      <div class="hint">表头要和原表一致（新ID、比赛时间、竞彩场次、联赛、主队（让球）vs客队 …）。<br>
        8 万行大概要 1~3 分钟，中途别退出。读到哪一步下面会显示。</div>
      <div class="progress" id="impBar"><i></i></div>
      <div id="impText" style="font-size:12px;color:var(--text-2);margin-top:6px"></div>
    </div>
    <div class="mfoot">
      <button class="btn" id="impCancel">取消</button>
      <button class="btn primary" id="impPick">选择 Excel 文件</button>
    </div>`);
  on("#impCancel", closeModal);
  on("#impPick", () => {
    window.__impOpts = {
      mode: ($('input[name="mode"]:checked') || {}).value || "update",
      keepText: ($("#impKeepText") || {}).checked !== false
    };
    const t = $("#impText"); if (t) t.textContent = "正在打开系统文件选择器…";
    MB.pickXlsx();
  });
}

function impBar(pct, text) {
  const b = $("#impBar"); if (b) b.querySelector("i").style.width = Math.max(0, Math.min(100, pct)) + "%";
  const t = $("#impText"); if (t) t.textContent = text || "";
}

async function runMobileImport(opt) {
  const A = window.Android;
  let header = null;
  let from = 0, read = 0;
  const CHUNK = 1200;
  const total = A.importCsvRows();
  try {
    let r = JSDB.beginImport();
    if (r.error) throw new Error(r.error);
    impBar(2, "正在写入临时表…");

    while (true) {
      const txt = A.readImportLines(from, CHUNK);
      if (!txt) break;
      const lines = txt.split("\n");
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      if (!lines.length) break;

      if (!header) {
        header = JSDB.parseCsvLine(lines[0]).map(s => String(s).trim());
        const pos = JSDB.ALL_KEYS.map(k => header.indexOf(JSDB.FIELD_MAP[k][1]));
        const iId = JSDB.ALL_KEYS.indexOf("new_id");
        const iTime = JSDB.ALL_KEYS.indexOf("match_time");
        if (pos[iId] < 0 && pos[iTime] < 0) {
          throw new Error("表头不符合预期，没找到「新ID」或「比赛时间」列");
        }
      }
      const consumed = lines.length;
      const body = (from === 0) ? lines.slice(1) : lines;

      const pos = JSDB.ALL_KEYS.map(k => header.indexOf(JSDB.FIELD_MAP[k][1]));
      const rows = [];
      for (const ln of body) {
        if (!ln) continue;
        const cells = JSDB.parseCsvLine(ln);
        const row = pos.map(p => (p >= 0 ? cells[p] : ""));
        let blank = true;
        for (const v of row) { if (v !== "" && v !== null && v !== undefined) { blank = false; break; } }
        if (blank) continue;
        rows.push(row);
      }
      if (rows.length) {
        const rr = JSDB.pushImportRows(rows);
        if (rr.error) throw new Error(rr.error);
      }
      read += consumed;
      from += consumed;
      impBar(2 + Math.round(read / Math.max(total, 1) * 88),
        `已读取 ${read} 行 / 共 ${total} 行`);
      await sleep(0);           // 让界面有机会刷新
      if (consumed < CHUNK) break;
    }

    impBar(92, "正在比对入库…");
    await sleep(20);
    const res = JSDB.finishImport(opt.mode, opt.keepText, "xlsx");
    if (res.error) throw new Error(res.error);
    impBar(100, "导入完成");
    closeModal();
    toast(`导入完成：共 ${res.total} 行，新增 ${res.inserted} 条，覆盖 ${res.updated} 条，没变化 ${res.unchanged} 条`);
    await loadStats();
    buildQuickPanel();
    S.page = 1;
    await refresh({ force: true });
  } catch (e) {
    try { JSDB.cancelImport(); } catch (_) { }
    impBar(0, "");
    toast("导入失败：" + (e.message || e), { err: true });
  }
}

/* 安卓那边转完 CSV 会调这两个回调 */
window.__onImportProgress = function (rows) {
  impBar(Math.min(90, 5 + Math.round(rows / 3000)), `正在解析表格…已转换 ${rows} 行`);
};
window.__onImportReady = async function (ok, msg, rows) {
  if (!ok) {
    if (/取消/.test(msg || "")) { impBar(0, "已取消"); return; }
    impBar(0, "");
    toast("读取失败：" + msg, { err: true });
    return;
  }
  if (!MB.ready()) { toast("数据库还没加载，先点「数据」选一下 db 文件", { err: true }); return; }
  const opt = window.__impOpts || { mode: "update", keepText: true };
  await runMobileImport(opt);
};

/* ---------------- 事件绑定 ---------------- */
on("#btnImport", () => (MOBILE ? importMobile() : openImport(false)));
on("#btnExport", openExport);
on("#btnSync", openSync);
on("#btnDb", () => openDbPanel(false));
on("#btnSide", () => toggleSidebar(true));
on("#btnSideClose", () => toggleSidebar(false));
on("#sideMask", () => toggleSidebar(false));
on("#btnNew", () => openDrawer(null));
on("#btnRefresh", async () => { await loadStats(); await refresh(); toast("已刷新"); });
on("#btnClearFilter", clearAllFilters);
on("#btnClearQuick", () => { clearQuickAll(); toast("已清空常用筛选"); });
on("#btnFoldQuick", e => {
  const p = $("#quickPanel");
  const folded = p.classList.toggle("folded");
  e.target.textContent = folded ? "展开" : "收起";
});
on("#btnSearch", () => { S.page = 1; refresh(); });
$("#kw").onkeydown = e => { if (e.key === "Enter") { S.page = 1; refresh(); } };
on("#btnCloseDrawer", closeDrawer);
on("#btnPin", togglePin);
on("#btnQuickFind", quickFindFromSel);
on("#btnTol", cycleTol);
renderTolUI();

$("#btnSave").onclick = async () => {
  const data = collectForm();
  for (const k of ["record", "review"]) {
    if ((data[k] || "").length > S.textMax) {
      toast(`${S.fmap[k].label}最多 ${S.textMax} 个字，当前 ${data[k].length} 个，请精简后再保存`, { err: true });
      return;
    }
  }
  if (S.sel) {
    // 已有记录：除「记录 / 复盘」外若有改动，先弹确认框
    const diffs = diffFields(data);
    if (diffs.length) {
      const ok = await confirmChanges(diffs);
      if (!ok) { toast("已取消保存"); return; }
    }
  }
  busy(true, "保存中…");
  try {
    if (S.sel) { await api("updateRow", S.sel, data); toast("已保存"); }
    else { const r = await api("newRow", data); S.sel = r.id; toast("已新增记录"); }
    await loadStats(); await refresh(); await openDrawer(S.sel);
  } catch (e) { toast("保存失败：" + e.message, { err: true }); }
  finally { busy(false); }
};

$("#btnDelete").onclick = async () => {
  if (!S.sel) return;
  const ok = await confirmBox("删除记录", "确定删除这条记录吗？删除后不可恢复。");
  if (!ok) return;
  try {
    await api("deleteRow", S.sel);
    toast("已删除");
    S.sel = null; $("#drawer").classList.remove("open");
    await loadStats(); await refresh();
  } catch (e) { toast("删除失败：" + e.message, { err: true }); }
};

/* ---------------- 手机：系统返回键 / 数据库加载回调 ---------------- */
window.__onBack = () => {
  if ($("#mask").classList.contains("show")) { closeModal(); return true; }
  if ($("#drawer").classList.contains("open")) { closeDrawer(); return true; }
  if ($("#sidebar").classList.contains("open")) { toggleSidebar(false); return true; }
  return false;
};

function startBoot() {
  return boot().then(() => { window.__booted = true; }).catch(e => {
    console.error(e);
    window.__bootError = String((e && e.message) || e);
    toast("初始化失败：" + e.message, { err: true });
  });
}

/** Java 复制完数据库后回调 */
window.__onDbResult = (ok, msg) => {
  if (!ok) { toast("数据库加载失败：" + msg, { err: true }); return; }
  toast(msg || "数据库已加载");
  closeModal();
  startBoot();
};

/** 导出保存完成回调 */
window.__onSaveResult = (ok, msg) => {
  if (ok) toast("已保存：" + msg);
  else toast("保存失败：" + msg, { err: true });
};

/** 等 App 把上次用过的数据库打开（后台复制 38MB 需要一点时间） */
async function waitDbReady(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (window.MB && window.MB.ready()) return true;
    await sleep(120);
  }
  return !!(window.MB && window.MB.ready());
}

/* ---------------- 启动 ---------------- */
(async function () {
  await whenReady();
  if (MOBILE) {
    if (!(await waitDbReady(5000))) { openDbPanel(true); return; }
    await startBoot();
    return;
  }
  try {
    const env = await api("env");
    S.envPath = env.defaultImportPath || "";
  } catch (e) { }
  try { await boot(); window.__booted = true; }
  catch (e) {
    console.error(e);
    window.__bootError = String((e && e.message) || e);
    toast("初始化失败：" + e.message, { err: true });
  }
})();
