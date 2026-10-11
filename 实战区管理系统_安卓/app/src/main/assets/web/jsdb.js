/* 入库实战区手机版 - 数据层
 *
 * 这里是桌面版 db.py 的 JS 版本：拼出和电脑上完全一样的 SQL，交给手机的 SQLite 执行。
 * 之所以把逻辑放在 JS 里，是为了改查询方式时不用重新编译 App。
 *
 * 执行器可替换：
 *   JSDB.setRunner(fn)   fn(sql, args) -> {rows:[...]} 或 {error:"..."}
 * 默认走 window.Android.exec（安卓桥）；测试时可换成别的执行器。
 */
(function (global) {
  "use strict";

  var TEXT_MAXLEN = 50;
  var FIELDS = [
    ["new_id", "新ID", "int", "基本信息"],
    ["review", "复盘", "text", "记录复盘"],
    ["record", "记录", "text", "记录复盘"],
    ["match_time", "比赛时间", "datetime", "基本信息"],
    ["match_no", "竞彩场次", "text", "基本信息"],
    ["league", "联赛", "text", "基本信息"],
    ["teams", "主队（让球）vs客队", "text", "基本信息"],
    ["half_score", "半场比分", "text", "赛果"],
    ["full_score", "全场比分", "text", "赛果"],
    ["w_win", "尾胜", "real", "赔率"],
    ["w_draw", "尾平", "real", "赔率"],
    ["w_lose", "尾负", "real", "赔率"],
    ["status", "状态", "text", "基本信息"],
    ["half", "半", "text", "赛果"],
    ["full", "全", "text", "赛果"],
    ["half_full", "半全", "text", "赛果"],
    ["ou", "大小", "int", "赛果"],
    ["handicap_result", "让盘", "text", "赛果"],
    ["handicap", "让球", "text", "基本信息"],
    ["s_win", "初胜", "real", "赔率"],
    ["s_draw", "初平", "real", "赔率"],
    ["s_lose", "初负", "real", "赔率"],
    ["s_h_win", "初让胜", "real", "赔率"],
    ["s_h_draw", "初让平", "real", "赔率"],
    ["s_h_lose", "初让负", "real", "赔率"],
    ["ww", "胜胜", "real", "赔率"],
    ["wd", "胜平", "real", "赔率"],
    ["wl", "胜负", "real", "赔率"],
    ["dw", "平胜", "real", "赔率"],
    ["dd", "平平", "real", "赔率"],
    ["dl", "平负", "real", "赔率"],
    ["lw", "负胜", "real", "赔率"],
    ["ld", "负平", "real", "赔率"],
    ["ll", "负负", "real", "赔率"],
    // 首推 / 次推：程序按公式算出来的，放在最后（别插中间，会打乱表头位置兜底）
    ["first_push", "首推", "text", "推荐"],
    ["second_push", "次推", "text", "推荐"]
  ];
  var FIELD_MAP = {};
  FIELDS.forEach(function (f) { FIELD_MAP[f[0]] = f; });
  var ALL_KEYS = FIELDS.map(function (f) { return f[0]; });
  var ENUM_FIELDS = ["status", "half", "full", "half_full", "handicap_result", "handicap", "ou"];
  var SUGGEST_FIELDS = ["league", "match_no"];
  var TEXT_FIELDS_LIMITED = ["record", "review"];

  /* ---------------- 首推 / 次推 ----------------
   *
   * 和电脑版 db.py 完全同一套公式：以本行自己为基准去历史库找同型样本，
   *   wl / lw        固定值，精确等于本条
   *   s_h_win / s_h_lose  本条 ±0.02（首推）/ ±0.03（次推）
   * 统计出各结果得了几票，写到 first_push / second_push 两列里。
   */
  var PUSH_FIELDS = ["first_push", "second_push"];
  var PUSH_TOL = { first_push: 0.02, second_push: 0.03 };
  var PUSH_MAX_SEL = 30;
  // 只有这些算有效赛果；「无效场次」「取消」「--」「空」统统不算样本
  var VALID_FULL = ["胜", "平", "负"];
  var VALID_HANDICAP = ["让胜", "让平", "让负"];
  var FULL_ORDER = ["胜", "平", "负"];
  var HANDICAP_ORDER = ["让胜", "让平", "让负"];

  function col(k) { return '"' + k + '"'; }

  /* ---------------- 执行器 ---------------- */
  var runner = null;
  function setRunner(fn) { runner = fn; }

  function run(sql, args) {
    var fn = runner || (global.Android ? function (s, a) {
      return JSON.parse(global.Android.exec(s, JSON.stringify(a || [])));
    } : null);
    if (!fn) return { error: "没有可用的数据库执行器" };
    var r = fn(sql, args || []);
    if (!r) return { error: "执行器没有返回数据" };
    if (r.error) return { error: r.error };
    return { rows: r.rows || [] };
  }

  function runChange(sql, args) {
    if (global.Android) {
      return JSON.parse(global.Android.execChange(sql, JSON.stringify(args || [])));
    }
    // 测试环境：走普通执行器
    var r = run(sql, args);
    if (r.error) return { error: r.error };
    return { changes: 0, lastId: 0 };
  }

  /* ---------------- 类型转换 ---------------- */
  function conv(key, ftype, value) {
    if (value === null || value === undefined) return null;
    if (key === "half_score" || key === "full_score") {
      return String(value).trim() || null;
    }
    if (ftype === "datetime") return String(value).trim() || null;
    if (ftype === "int") {
      var s = String(value).trim();
      if (s === "") return null;
      var n = parseInt(s, 10);
      if (isNaN(n)) {
        var f = parseFloat(s);
        return isNaN(f) ? null : Math.trunc(f);
      }
      return n;
    }
    if (ftype === "real") {
      var s2 = String(value).trim();
      if (s2 === "") return null;
      var f2 = parseFloat(s2);
      return isNaN(f2) ? null : f2;
    }
    if (typeof value === "string") return value.trim() || null;
    return value;
  }

  function now() {
    var d = new Date();
    var p = function (x) { return (x < 10 ? "0" : "") + x; };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  /* ---------------- WHERE ---------------- */
  function buildWhere(filters) {
    var where = [], params = [];
    (filters || []).forEach(function (f) {
      var key = f.field, op = f.op, val = f.value;
      if (!FIELD_MAP[key]) return;
      var ftype = FIELD_MAP[key][2], c = col(key);
      if (op === "empty") { where.push("(" + c + " IS NULL OR " + c + "='')"); }
      else if (op === "notempty") { where.push("(" + c + " IS NOT NULL AND " + c + "<>'')"); }
      else if (op === "any") {
        if (val === null || val === undefined || val === "") return;
        var targets = f.fields || [key], sub = [];
        targets.forEach(function (t) {
          if (!FIELD_MAP[t]) return;
          sub.push(col(t) + " LIKE ?");
          params.push("%" + val + "%");
        });
        if (sub.length) where.push("(" + sub.join(" OR ") + ")");
      }
      else if (op === "contains") {
        if (val === null || val === undefined || val === "") return;
        where.push(c + " LIKE ?"); params.push("%" + val + "%");
      }
      else if (op === "startswith") {
        if (val === null || val === undefined || val === "") return;
        where.push(c + " LIKE ?"); params.push(val + "%");
      }
      else if (op === "eq") {
        if (val === null || val === undefined || val === "") return;
        where.push(c + " = ?"); params.push(val);
      }
      else if (op === "ne") {
        if (val === null || val === undefined || val === "") return;
        where.push("(" + c + " IS NULL OR " + c + " <> ?)"); params.push(val);
      }
      else if (op === "in") {
        var vals = (val || []).filter(function (v) { return v !== null && v !== undefined && v !== ""; });
        if (!vals.length) return;
        where.push(c + " IN (" + vals.map(function () { return "?"; }).join(",") + ")");
        params = params.concat(vals);
      }
      else if (op === "gte" || op === "gt" || op === "lte" || op === "lt") {
        if (val === null || val === undefined || val === "") return;
        var sym = { gte: ">=", gt: ">", lte: "<=", lt: "<" }[op];
        var v2 = val;
        if (ftype === "datetime" && String(val).length === 10) {
          v2 = (op === "gte" || op === "gt") ? val + " 00:00" : val + " 23:59";
        }
        where.push(c + " " + sym + " ?"); params.push(v2);
      }
      else if (op === "between") {
        var lo = (val || [null, null])[0], hi = (val || [null, null])[1];
        if (lo !== null && lo !== undefined && lo !== "") {
          var lo2 = lo;
          if (ftype === "datetime" && String(lo).length === 10) lo2 = String(lo) + " 00:00";
          where.push(c + " >= ?"); params.push(lo2);
        }
        if (hi !== null && hi !== undefined && hi !== "") {
          var hi2 = hi;
          if (ftype === "datetime" && String(hi).length === 10) hi2 = String(hi) + " 23:59";
          where.push(c + " <= ?"); params.push(hi2);
        }
      }
    });
    return { sql: where.length ? where.join(" AND ") : "1=1", params: params };
  }

  function orderBy(sort) {
    if (sort && FIELD_MAP[sort.field]) {
      var dir = String(sort.dir || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
      return col(sort.field) + " " + dir + ", id " + dir;
    }
    return "id ASC";
  }

  /* ---------------- 查询 ---------------- */
  function query(filters, sort, page, size) {
    page = Math.max(1, parseInt(page || 1, 10));
    size = Math.max(1, Math.min(parseInt(size || 50, 10), 2000));
    var w = buildWhere(filters);
    var r1 = run("SELECT COUNT(*) AS c FROM matches WHERE " + w.sql, w.params);
    if (r1.error) return { error: r1.error };
    var total = r1.rows.length ? r1.rows[0].c : 0;
    var sel = ALL_KEYS.map(col).join(", ");
    var sql = "SELECT id, " + sel + ", updated_at FROM matches WHERE " + w.sql +
      " ORDER BY " + orderBy(sort) + " LIMIT ? OFFSET ?";
    var r2 = run(sql, w.params.concat([size, (page - 1) * size]));
    if (r2.error) return { error: r2.error };
    return { total: total, page: page, size: size, rows: r2.rows };
  }

  function getRow(id) {
    var sel = ALL_KEYS.map(col).join(", ");
    var r = run("SELECT id, " + sel + ", updated_at FROM matches WHERE id=?", [id]);
    if (r.error) return { error: r.error };
    return r.rows.length ? r.rows[0] : null;
  }

  function updateRow(id, data) {
    var sets = [], params = [];
    ALL_KEYS.forEach(function (k) {
      if (!(k in (data || {}))) return;
      var val = data[k], ftype = FIELD_MAP[k][2];
      if (TEXT_FIELDS_LIMITED.indexOf(k) >= 0) {
        val = String(val === null || val === undefined ? "" : val).trim();
        if (val.length > TEXT_MAXLEN) {
          throw new Error(FIELD_MAP[k][1] + "最多 " + TEXT_MAXLEN + " 个字，当前 " + val.length + " 个");
        }
      }
      val = conv(k, ftype, val);
      if (ftype === "datetime" && val && String(val).length === 10) val = val + " 00:00";
      sets.push(col(k) + "=?");
      params.push(val);
    });
    if (!sets.length) return null;
    params.push(now());
    params.push(id);
    var r = runChange("UPDATE matches SET " + sets.join(", ") + ", updated_at=? WHERE id=?", params);
    if (r.error) return { error: r.error };
    return getRow(id);
  }

  function insertRow(data) {
    var vals = [];
    ALL_KEYS.forEach(function (k) {
      var val = (data || {})[k];
      if (TEXT_FIELDS_LIMITED.indexOf(k) >= 0) {
        val = String(val === null || val === undefined ? "" : val).trim();
        if (val.length > TEXT_MAXLEN) {
          throw new Error(FIELD_MAP[k][1] + "最多 " + TEXT_MAXLEN + " 个字，当前 " + val.length + " 个");
        }
      }
      vals.push(conv(k, FIELD_MAP[k][2], val));
    });
    var ph = ALL_KEYS.map(function () { return "?"; }).join(", ");
    var r = runChange("INSERT INTO matches (" + ALL_KEYS.map(col).join(", ") +
      ", updated_at) VALUES (" + ph + ", ?)", vals.concat([now()]));
    if (r.error) return { error: r.error };
    var rid = r.lastId || r.lastInsertRowId;
    if (!rid) {
      var g = run("SELECT last_insert_rowid() AS id", []);
      rid = g.rows && g.rows.length ? g.rows[0].id : 0;
    }
    return getRow(rid);
  }

  function deleteRow(id) {
    var r = runChange("DELETE FROM matches WHERE id=?", [id]);
    if (r.error) return { error: r.error };
    return { ok: true };
  }

  function deleteMany(ids) {
    if (!ids || !ids.length) return { ok: true };
    var ph = ids.map(function () { return "?"; }).join(",");
    var r = runChange("DELETE FROM matches WHERE id IN (" + ph + ")", ids);
    if (r.error) return { error: r.error };
    return { ok: true };
  }

  /* ---------------- 分组计数 / 取值列表 ---------------- */
  function groupCount(filters, fields) {
    var w = buildWhere(filters), out = {};
    (fields || []).forEach(function (f) {
      if (!FIELD_MAP[f]) return;
      var r = run("SELECT " + col(f) + " AS v, COUNT(*) AS c FROM matches WHERE " + w.sql +
        " GROUP BY " + col(f) + " ORDER BY c DESC", w.params);
      if (r.error) { out[f] = []; return; }
      out[f] = r.rows.map(function (x) {
        return { value: (x.v === null || x.v === undefined || x.v === "") ? "（空）" : x.v, count: x.c };
      });
    });
    return out;
  }

  function numKey(v) {
    var s = String(v === null || v === undefined ? "" : v).trim();
    s = s.replace(/[()（）+\s]/g, "");
    var n = parseFloat(s);
    if (isNaN(n)) return [1, String(v)];
    return [0, n];
  }
  function cmpNum(a, b) {
    var x = numKey(a), y = numKey(b);
    if (x[0] !== y[0]) return x[0] - y[0];
    if (x[0] === 0) return x[1] - y[1];
    return String(x[1]).localeCompare(String(y[1]), "zh");
  }

  function distinct(field, limit, order) {
    if (!FIELD_MAP[field]) return [];
    limit = parseInt(limit || 2000, 10);
    var r = run("SELECT " + col(field) + " AS v, COUNT(*) AS c FROM matches WHERE " + col(field) +
      " IS NOT NULL AND " + col(field) + "<>'' GROUP BY " + col(field) +
      " ORDER BY c DESC LIMIT ?", [limit]);
    if (r.error) return [];
    var items = r.rows.map(function (x) { return { value: x.v, count: x.c }; });
    if (order === "asc" || order === "desc") {
      items.sort(function (a, b) { return order === "desc" ? -cmpNum(a.value, b.value) : cmpNum(a.value, b.value); });
    }
    return items;
  }

  /** 常用筛选的动态列表：排除自身条件，只看「其他筛选下还剩下哪些值」 */
  function distinctMulti(fields, filters, limit, order, excludeSelf) {
    var out = {};
    limit = parseInt(limit || 3000, 10);
    (fields || []).forEach(function (f) {
      if (!FIELD_MAP[f]) return;
      var fs = filters || [];
      if (excludeSelf !== false) {
        fs = fs.filter(function (x) { return x.field !== f; });
      }
      var w = buildWhere(fs);
      var r = run("SELECT " + col(f) + " AS v, COUNT(*) AS c FROM matches WHERE " + w.sql +
        " AND " + col(f) + " IS NOT NULL AND " + col(f) + "<>'' GROUP BY " + col(f), w.params);
      if (r.error) { out[f] = []; return; }
      var items = r.rows.map(function (x) { return { value: x.v, count: x.c }; });
      if (order === "count") items.sort(function (a, b) { return b.count - a.count; });
      else if (order === "asc" || order === "desc") {
        items.sort(function (a, b) { return order === "desc" ? -cmpNum(a.value, b.value) : cmpNum(a.value, b.value); });
      }
      if (limit && items.length > limit) items = items.slice(0, limit);
      out[f] = items;
    });
    return out;
  }

  function stats() {
    var r = run("SELECT COUNT(*) AS total," +
      " SUM(CASE WHEN record IS NOT NULL AND record<>'' THEN 1 ELSE 0 END) AS has_record," +
      " SUM(CASE WHEN review IS NOT NULL AND review<>'' THEN 1 ELSE 0 END) AS has_review," +
      " MIN(match_time) AS date_min, MAX(match_time) AS date_max FROM matches", []);
    if (r.error) return { error: r.error };
    var s = r.rows.length ? r.rows[0] : {};
    var last = null;
    try {
      var m = run("SELECT v FROM meta WHERE k='last_import'", []);
      if (m.rows && m.rows.length) last = m.rows[0].v;
    } catch (e) { last = null; }
    return {
      total: s.total || 0,
      has_record: s.has_record || 0,
      has_review: s.has_review || 0,
      date_min: s.date_min || null,
      date_max: s.date_max || null,
      last_import: last
    };
  }

  /* ---------------- 导入 ----------------
   *
   * 手机上的做法：安卓那边把 xlsx 转成一份中间 CSV，这边分批读进来先写进临时表，
   * 再用 SQL 一次性比对、更新、插入 —— 几万行也不会把手机内存撑爆。
   * 判定规则与电脑版 db.py 的「按新ID更新」完全一致：
   *   系统里没有的新ID → 新增；内容有变化 → 覆盖；没变化 → 原样不动。
   */
  var TYPE_SQL = { int: "INTEGER", real: "REAL", text: "TEXT", datetime: "TEXT" };
  var LABEL_MAP = {};
  FIELDS.forEach(function (f) { LABEL_MAP[f[1]] = f[0]; });
  var impSeq = 0;

  /* ------------------------------------------------------------------
   * 表头容错（与电脑版 db.py 的 _map_header 同一套规则）
   * 数据源每次重新导出列名都可能变：2026-10-11 那版把「尾胜/尾平/尾负」和
   * 「初胜/初平/初负」统统改叫「胜/平/负」，半全场赔率加了「（初）」后缀。
   * 只看列名的话这几列会整列丢失，所以做两层兜底。
   * ------------------------------------------------------------------ */
  var HDR_SUFFIX = ["（初）", "（终）", "（即时）", "（完）", "(初)", "(终)", "(即时)", "(完)"];
  var ALIAS = {
    "终胜": "w_win", "终平": "w_draw", "终负": "w_lose",
    "尾盘胜": "w_win", "尾盘平": "w_draw", "尾盘负": "w_lose",
    "让球胜": "s_h_win", "让球平": "s_h_draw", "让球负": "s_h_lose"
  };

  /** 去空白 + 反复去掉版本后缀 */
  function normHeader(h) {
    h = String(h == null ? "" : h).trim();
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < HDR_SUFFIX.length; i++) {
        var s = HDR_SUFFIX[i];
        if (h.length > s.length && h.substring(h.length - s.length) === s) {
          h = h.substring(0, h.length - s.length).trim();
          changed = true;
        }
      }
    }
    return h;
  }

  /**
   * 表头 → 每个字段在第几列。
   * 1) 按列名匹配（原名 → 去后缀 → 别名）
   * 2) 认不出来的按「标准列序」同位置兜底（前提是该标准 key 没被别的列占用）
   * 新版表里两组赔率都叫「胜/平/负」，重名没法靠名字分，正靠第 2 层按位置分开。
   * 返回 { pos: 按 ALL_KEYS 顺序的列号(-1 表示没来源),
   *        unknown: 没敢配的列名,
   *        guessed: 靠位置补上的 [{col, name, label}] —— 这些是猜的，要报给用户抽查 }
   */
  function mapHeader(header) {
    var n = header.length, i;
    var keys = new Array(n), used = {}, unknown = [], guessed = [];
    for (i = 0; i < n; i++) keys[i] = null;
    for (i = 0; i < n; i++) {
      var h = String(header[i] == null ? "" : header[i]).trim();
      var nh = normHeader(h);
      var k = LABEL_MAP[h] || LABEL_MAP[nh] || ALIAS[h] || ALIAS[nh];
      if (k && !used[k]) { keys[i] = k; used[k] = 1; }
    }
    var named = 0;
    for (i = 0; i < n; i++) if (keys[i]) named++;
    if (named >= 10) {                       // 认出的够多才敢按位置配，免得拿陌生表乱点鸳鸯
      for (i = 0; i < n; i++) {
        if (keys[i]) continue;
        if (i < ALL_KEYS.length) {
          var std = ALL_KEYS[i];
          if (!used[std]) {
            keys[i] = std; used[std] = 1;
            guessed.push({ col: i + 1, name: String(header[i] == null ? "" : header[i]).trim(), label: FIELD_MAP[std][1] });
          }
        }
      }
    }
    for (i = 0; i < n; i++) if (!keys[i] && String(header[i] == null ? "" : header[i]).trim()) unknown.push(String(header[i]).trim());
    var pos = ALL_KEYS.map(function (k) {
      for (var j = 0; j < n; j++) if (keys[j] === k) return j;
      return -1;
    });
    return { pos: pos, unknown: unknown, keys: keys, guessed: guessed };
  }

  /** 一批 SQL 放进一个事务里跑（安卓桥提供 execBatch；测试环境退化成逐条执行） */
  function runBatch(sqls) {
    if (!sqls || !sqls.length) return { ok: true, count: 0 };
    if (global.Android && global.Android.execBatch) {
      var r = JSON.parse(global.Android.execBatch(JSON.stringify(sqls)));
      if (r && r.error) return { error: r.error };
      return { ok: true, count: r.count || 0 };
    }
    for (var i = 0; i < sqls.length; i++) {
      var x = run(sqls[i], []);
      if (x && x.error) return { error: x.error };
    }
    return { ok: true, count: sqls.length };
  }

  function lit(v) {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return isFinite(v) ? String(v) : "NULL";
    if (typeof v === "boolean") return v ? "1" : "0";
    return "'" + esc(v) + "'";
  }

  /** 只做单引号转义，不带外层引号 */
  function esc(v) {
    return String(v).replace(/'/g, "''");
  }

  function beginImport() {
    impSeq = 0;
    var defs = ALL_KEYS.map(function (k) {
      return col(k) + " " + (TYPE_SQL[FIELD_MAP[k][2]] || "TEXT");
    }).join(", ") + ", src_row INTEGER";
    var r = runChange("DROP TABLE IF EXISTS imp_tmp", []);
    if (r && r.error) return { error: r.error };
    var r2 = runChange("CREATE TEMP TABLE imp_tmp (" + defs + ")", []);
    if (r2 && r2.error) return { error: r2.error };
    return { ok: true };
  }

  function cancelImport() {
    var r = runChange("DROP TABLE IF EXISTS imp_tmp", []);
    if (r && r.error) return { error: r.error };
    return { ok: true };
  }

  /** rows: 二维数组，每行按 ALL_KEYS 顺序排列（最后一列不填，src_row 由这里按顺序编号） */
  function pushImportRows(rows, batchSize) {
    batchSize = parseInt(batchSize || 500, 10);
    var colsSql = ALL_KEYS.map(col).join(", ") + ", src_row";
    var sqls = [];
    for (var i = 0; i < rows.length; i += batchSize) {
      var part = rows.slice(i, i + batchSize);
      var vals = part.map(function (r) {
        impSeq++;
        return "(" + ALL_KEYS.map(function (k, j) {
          var ftype = FIELD_MAP[k][2];
          var v = r[j];
          if (TEXT_FIELDS_LIMITED.indexOf(k) >= 0 && typeof v === "string" && v.length > TEXT_MAXLEN) {
            v = v.slice(0, TEXT_MAXLEN);
          }
          return lit(conv(k, ftype, v));
        }).join(", ") + ", " + impSeq + ")";
      }).join(", ");
      sqls.push("INSERT INTO imp_tmp (" + colsSql + ") VALUES " + vals);
    }
    // 每 10 条一批送给桥，一次别塞太大的字符串
    for (var g = 0; g < sqls.length; g += 10) {
      var rb = runBatch(sqls.slice(g, g + 10));
      if (rb.error) return { error: rb.error };
    }
    return { ok: true, batches: sqls.length };
  }

  /* 「两边一样」的判定：复刻 db.py 的 _eqval
   *   空串 与 NULL 视作相同；2 与 2.0 视作相同（数值字段按数值比）
   *   m = matches（库里），t = imp_tmp（这次导入） */
  function normExpr(k, alias) {
    return "nullif(trim(CAST(" + alias + "." + col(k) + " AS TEXT)),'')";
  }
  function sameExpr(k) {
    var ftype = FIELD_MAP[k][2];
    var a = normExpr(k, "m"), b = normExpr(k, "t");
    if (ftype === "int" || ftype === "real") {
      return "(CAST(" + a + " AS REAL) IS CAST(" + b + " AS REAL))";
    }
    return "(" + a + " IS " + b + ")";
  }
  /** 比对「两边是否一样」时用的字段。
   *  首推 / 次推 不参与比对：这两列是程序算出来的，Excel / CSV 里根本没有，
   *  读进来一定是空。要是拿它去比，每一行都会被判成「有变化」，
   *  然后 DELETE + INSERT 一通，算好的值就被空值冲掉了。 */
  var CMP_KEYS = ALL_KEYS.filter(function (k) { return PUSH_FIELDS.indexOf(k) < 0; });
  function sameCond() {
    return CMP_KEYS.map(sameExpr).join(" AND ");
  }
  /** 注意：SQL 里 NOT 比 AND 优先，整串必须再套一层括号 */
  function diffCond() {
    return "NOT (" + sameCond() + ")";
  }

  function finishImport(mode, keepText, srcName) {
    mode = mode || "update";
    var keep = keepText !== false;
    var colsSql = ALL_KEYS.map(col).join(", ");
    var selSql = ALL_KEYS.map(function (k) { return "t." + col(k); }).join(", ");
    var stamp = now();

    // 同一个新ID在表里出现多次时，只留最后一条
    var dd = runChange("DELETE FROM imp_tmp WHERE rowid NOT IN " +
      "(SELECT MAX(rowid) FROM imp_tmp GROUP BY COALESCE(\"new_id\", rowid))", []);
    if (dd && dd.error) return { error: dd.error };

    // 八万行时没有索引会慢到卡死
    var ix = runChange("CREATE INDEX IF NOT EXISTS imp_tmp_newid ON imp_tmp(\"new_id\")", []);
    if (ix && ix.error) return { error: ix.error };

    var t0 = run("SELECT COUNT(*) AS c FROM imp_tmp", []);
    if (t0.error) return { error: t0.error };
    var total = t0.rows.length ? t0.rows[0].c : 0;

    var sqls = [];
    var inserted = 0, updated = 0, unchanged = 0;

    if (mode === "replace") {
      sqls.push("DELETE FROM matches");
      sqls.push("INSERT INTO matches (" + colsSql + ", updated_at, src_row) SELECT " +
        selSql + ", '" + stamp + "', t.src_row FROM imp_tmp t");
      inserted = total;
    } else if (mode === "append") {
      sqls.push("INSERT INTO matches (" + colsSql + ", updated_at, src_row) SELECT " +
        selSql + ", '" + stamp + "', t.src_row FROM imp_tmp t");
      inserted = total;
    } else {
      // 首推 / 次推 只由程序写入，表格里没有这两列。
      // 无条件把库里原有的值填回 imp_tmp，保证后面 DELETE + INSERT 之后它们还在。
      // （跟 record / 复盘 不同：那两列只在勾了「保留」时才回填，这两列无条件保留）
      for (var pi = 0; pi < PUSH_FIELDS.length; pi++) {
        var pk = PUSH_FIELDS[pi], pc = col(pk);
        var pu = runChange("UPDATE imp_tmp SET " + pc + " = " +
          "(SELECT m." + pc + " FROM matches m WHERE m.\"new_id\" = imp_tmp.\"new_id\") " +
          "WHERE EXISTS (SELECT 1 FROM matches m WHERE m.\"new_id\" = imp_tmp.\"new_id\")", []);
        if (pu && pu.error) return { error: pu.error };
      }

      // 保留库里已有的「记录/复盘」：导入里这两列是空白的，就先把库里的值填回来。
      // 填完之后再用统一的比对规则，就自然等价于电脑版的 keep_text 逻辑了。
      if (keep) {
        for (var ti = 0; ti < TEXT_FIELDS_LIMITED.length; ti++) {
          var tk = TEXT_FIELDS_LIMITED[ti], tc = col(tk);
          var up = runChange("UPDATE imp_tmp SET " + tc + " = " +
            "(SELECT m." + tc + " FROM matches m WHERE m.\"new_id\" = imp_tmp.\"new_id\") " +
            "WHERE (" + tc + " IS NULL OR trim(" + tc + ")='') " +
            "AND EXISTS (SELECT 1 FROM matches m WHERE m.\"new_id\" = imp_tmp.\"new_id\")", []);
          if (up && up.error) return { error: up.error };
        }
      }

      var same = sameCond();

      var r1 = run("SELECT COUNT(*) AS c FROM imp_tmp t JOIN matches m ON m.\"new_id\" = t.\"new_id\" WHERE " + same, []);
      if (r1.error) return { error: r1.error };
      unchanged = r1.rows.length ? r1.rows[0].c : 0;

      var r2 = run("SELECT COUNT(*) AS c FROM imp_tmp t WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.\"new_id\" = t.\"new_id\")", []);
      if (r2.error) return { error: r2.error };
      inserted = r2.rows.length ? r2.rows[0].c : 0;
      updated = total - unchanged - inserted;
      if (updated < 0) updated = 0;

      // 只删掉「有变化」的旧行，再把导入的行写进去；库里没变的那些行原地不动
      sqls.push("DELETE FROM matches WHERE rowid IN " +
        "(SELECT m.rowid FROM matches m JOIN imp_tmp t ON t.\"new_id\" = m.\"new_id\" WHERE " + diffCond() + ")");
      sqls.push("INSERT INTO matches (" + colsSql + ", updated_at, src_row) SELECT " +
        selSql + ", '" + stamp + "', t.src_row FROM imp_tmp t " +
        "WHERE NOT EXISTS (SELECT 1 FROM matches m WHERE m.\"new_id\" = t.\"new_id\" AND " + same + ")");
    }

    sqls.push("INSERT OR REPLACE INTO meta(k,v) VALUES('last_import', '" +
      esc((srcName || "xlsx") + "|" + stamp + "|" + mode) + "')");

    var r = runBatch(sqls);
    if (r.error) {
      runChange("DROP TABLE IF EXISTS imp_tmp", []);
      return { error: r.error };
    }
    runChange("DROP TABLE IF EXISTS imp_tmp", []);
    return { total: total, inserted: inserted, updated: updated, unchanged: unchanged };
  }

  /* ---------------- 「记录 / 复盘」专用小表 ----------------
   *
   * 手机上写完复盘要搬回电脑（或反过来），不必动 8 万行的整表：
   * 导出一张只有「新ID + 比赛时间 + 竞彩场次 + 队伍 + 记录 + 复盘」的 CSV，
   * 到对方的机器上按新ID 覆盖 record / review 两列即可。
   *
   * 铁律：applyTextCsv 只 UPDATE record / review，其余字段一律不动，也不新增/删除行。
   */
  var TEXT_PACK_KEYS = ["new_id", "match_time", "match_no", "teams", "record", "review"];

  /** 导出：只包含写了「记录」或「复盘」的行 */
  function exportTextCsv(filters) {
    var w = buildWhere(filters);
    var where = "(" + w.sql + ") AND ((record IS NOT NULL AND record<>'') OR (review IS NOT NULL AND review<>''))";
    var sel = TEXT_PACK_KEYS.map(col).join(", ");
    var parts = [TEXT_PACK_KEYS.map(function (k) { return csvCell(FIELD_MAP[k][1]); }).join(",")];
    var total = 0, offset = 0, chunk = 5000;
    while (true) {
      var r = run("SELECT " + sel + " FROM matches WHERE " + where +
        " ORDER BY id ASC LIMIT " + chunk + " OFFSET " + offset, w.params);
      if (r.error) return { error: r.error };
      if (!r.rows.length) break;
      var lines = [];
      for (var i = 0; i < r.rows.length; i++) {
        var row = r.rows[i], cells = [];
        for (var j = 0; j < TEXT_PACK_KEYS.length; j++) cells.push(csvCell(row[TEXT_PACK_KEYS[j]]));
        lines.push(cells.join(","));
      }
      parts.push(lines.join("\r\n"));
      total += r.rows.length;
      offset += r.rows.length;
      if (r.rows.length < chunk) break;
    }
    return { text: parts.join("\r\n"), count: total };
  }

  /** 导入覆盖：按新ID 定位，**只写 record / review 两列**
   *  allowClear=false（默认）：表格里空的那一格不覆盖本机内容（只做覆盖，不清空）
   */
  function applyTextCsv(text, allowClear) {
    text = String(text == null ? "" : text).replace(/^\uFEFF/, "");
    var lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    var body = [];
    for (var i = 0; i < lines.length; i++) if (lines[i].trim() !== "") body.push(lines[i]);
    if (body.length < 2) return { error: "这个 CSV 里没有数据行" };

    var header = parseCsvLine(body[0]);
    for (var h = 0; h < header.length; h++) header[h] = String(header[h] == null ? "" : header[h]).trim();

    var idxId = -1, idxRec = -1, idxRev = -1;
    for (var c = 0; c < header.length; c++) {
      var hit = null;
      for (var t = 0; t < TEXT_PACK_KEYS.length; t++) {
        if (header[c] === FIELD_MAP[TEXT_PACK_KEYS[t]][1]) { hit = TEXT_PACK_KEYS[t]; break; }
      }
      if (hit === "new_id" && idxId < 0) idxId = c;
      else if (hit === "record" && idxRec < 0) idxRec = c;
      else if (hit === "review" && idxRev < 0) idxRev = c;
    }
    if (idxId < 0 && header.length >= 6) { idxId = 0; idxRec = 4; idxRev = 5; }
    if (idxId < 0) return { error: "没找到「新ID」列，这不是记录 / 复盘专用表" };
    if (idxRec < 0 && idxRev < 0) return { error: "没找到「记录」或「复盘」列，这不是记录 / 复盘专用表" };

    // 一张 map 记住每个新ID 在表格里最后的值（重复出现以最后一次为准）
    var want = [];              // 去重后的 new_id
    var map = {};               // new_id -> {rec, rev}
    var rows = 0, skipped = 0;
    for (var b = 1; b < body.length; b++) {
      rows++;
      var cc = parseCsvLine(body[b]);
      var raw = String(cc[idxId] == null ? "" : cc[idxId]).trim();
      if (!raw) { skipped++; continue; }
      var nid = parseInt(raw, 10);
      if (isNaN(nid)) { skipped++; continue; }
      var recs = idxRec >= 0 ? String(cc[idxRec] == null ? "" : cc[idxRec]).trim() : null;
      var revs = idxRev >= 0 ? String(cc[idxRev] == null ? "" : cc[idxRev]).trim() : null;
      if (recs !== null && recs.length > TEXT_MAXLEN) recs = recs.slice(0, TEXT_MAXLEN);
      if (revs !== null && revs.length > TEXT_MAXLEN) revs = revs.slice(0, TEXT_MAXLEN);
      if (map[nid] === undefined) want.push(nid);
      map[nid] = { rec: recs, rev: revs };
    }
    if (!want.length) return { error: "表格里一行有效数据都没有" };

    // 按批把库里对应的行取出来比对，只对真有变化的拼 UPDATE
    var stamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    var matched = 0, updated = 0, unchanged = 0, cleared = 0, missing = 0;
    var sqls = [];
    for (var s = 0; s < want.length; s += 400) {
      var part = want.slice(s, s + 400);
      var qr = run("SELECT id, new_id, record, review FROM matches WHERE new_id IN (" +
        part.join(",") + ")", []);
      if (qr.error) return { error: qr.error };
      var found = {};
      for (var q = 0; q < qr.rows.length; q++) {
        var rr = qr.rows[q];
        found[rr.new_id] = {
          id: rr.id,
          record: (rr.record == null ? "" : String(rr.record)).replace(/^\s+|\s+$/g, ""),
          review: (rr.review == null ? "" : String(rr.review)).replace(/^\s+|\s+$/g, "")
        };
      }
      for (var p = 0; p < part.length; p++) {
        var nid2 = part[p];
        var cur = found[nid2];
        if (!cur) { missing++; continue; }
        matched++;
        var src = map[nid2];
        var oldRec = cur.record, oldRev = cur.review;
        var newRec = oldRec, newRev = oldRev;
        if (src.rec !== null) newRec = (!allowClear && !src.rec) ? oldRec : src.rec;
        if (src.rev !== null) newRev = (!allowClear && !src.rev) ? oldRev : src.rev;
        if (newRec === oldRec && newRev === oldRev) { unchanged++; continue; }
        sqls.push("UPDATE matches SET record = " + lit(newRec) + ", review = " + lit(newRev) +
          ", updated_at = '" + esc(stamp) + "' WHERE id = " + cur.id);
        updated++;
        if ((newRec === "" && oldRec !== "") || (newRev === "" && oldRev !== "")) cleared++;
      }
    }

    if (sqls.length) {
      var rb = runBatch(sqls);
      if (rb.error) return { error: rb.error };
    }
    return { rows: rows, matched: matched, updated: updated, unchanged: unchanged,
             cleared: cleared, missing: missing, skipped: skipped };
  }

  /** 一行 CSV（支持引号包裹与 "" 转义） */
  function parseCsvLine(s) {
    var out = [], cur = "", inQ = false;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (s.charAt(i + 1) === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { out.push(cur); cur = ""; }
        else cur += c;
      }
    }
    out.push(cur);
    return out;
  }

  /* ---------------- 导出 CSV ---------------- */
  function csvCell(v) {
    if (v === null || v === undefined) return "";
    var s = String(v);
    if (s.indexOf(",") >= 0 || s.indexOf('"') >= 0 || s.indexOf("\n") >= 0 || s.indexOf("\r") >= 0) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  /** 分块拼 CSV：每 5000 行一段，避免几万行时一次性占太多内存（手机内存有限） */
  function exportCsv(filters, sort, limit) {
    var w = buildWhere(filters);
    var sel = ALL_KEYS.map(col).join(", ");
    var order = orderBy(sort);
    var parts = [ALL_KEYS.map(function (k) { return csvCell(FIELD_MAP[k][1]); }).join(",")];
    var max = parseInt(limit || 0, 10);
    var total = 0, offset = 0, chunk = 5000;
    while (true) {
      var size = max > 0 ? Math.min(chunk, max - total) : chunk;
      if (size <= 0) break;
      var r = run("SELECT " + sel + " FROM matches WHERE " + w.sql +
        " ORDER BY " + order + " LIMIT ? OFFSET ?", w.params.concat([size, offset]));
      if (r.error) return { error: r.error };
      if (!r.rows.length) break;
      var lines = [];
      for (var i = 0; i < r.rows.length; i++) {
        var row = r.rows[i], cells = [];
        for (var j = 0; j < ALL_KEYS.length; j++) cells.push(csvCell(row[ALL_KEYS[j]]));
        lines.push(cells.join(","));
      }
      parts.push(lines.join("\r\n"));
      total += r.rows.length;
      offset += r.rows.length;
      if (r.rows.length < size) break;
      if (max > 0 && total >= max) break;
    }
    return { text: parts.join("\r\n"), count: total };
  }

  /* ==================== 首推 / 次推 ==================== */

  /** 老库（还没在电脑上跑过新版的那些）没有这两列，先补上。
   *  手机上用的库是电脑导过来的，电脑那边 ALTER 过了这里就不用动。 */
  function ensurePushColumns() {
    var r = run("PRAGMA table_info(matches)", []);
    if (r.error) return { error: r.error };
    var have = {};
    for (var i = 0; i < r.rows.length; i++) have[String(r.rows[i].name)] = true;
    var added = [];
    for (var p = 0; p < PUSH_FIELDS.length; p++) {
      var k = PUSH_FIELDS[p];
      if (have[k]) continue;
      var ra = runChange("ALTER TABLE matches ADD COLUMN " + col(k) + " TEXT", []);
      if (ra && ra.error) return { error: ra.error };
      added.push(k);
    }
    // 公式要按 wl / lw 精确比对，没索引的话几万行就得全表扫
    for (var q = 0; q < 2; q++) {
      var kk = q === 0 ? "wl" : "lw";
      var ri = runChange("CREATE INDEX IF NOT EXISTS idx_" + kk + " ON matches(" + col(kk) + ")", []);
      if (ri && ri.error) return { error: ri.error };
    }
    return { ok: true, added: added };
  }

  function r4(x) { return Math.round(x * 10000) / 10000; }
  function trimStr(v) { return String(v === null || v === undefined ? "" : v).replace(/^\s+|\s+$/g, ""); }

  /** 把一块（全 或 让盘）的票数拼成文本，例如 胜5、平3。凑齐 3 种 → 返回空串 */
  function fmtPart(cnt, order) {
    var keys = [];
    for (var i = 0; i < order.length; i++) if (cnt[order[i]]) keys.push(order[i]);
    if (keys.length >= 3) return "";
    // 票多的排前面；票一样多按固定顺序写，保证同一份数据每次算出来都一样
    keys.sort(function (a, b) {
      if (cnt[b] !== cnt[a]) return cnt[b] - cnt[a];
      return order.indexOf(a) - order.indexOf(b);
    });
    var out = [];
    for (var j = 0; j < keys.length; j++) out.push(keys[j] + cnt[keys[j]]);
    return out.join("、");
  }

  /** 拼成单元格文本：两块之间「；」，同一块多项「、」，每项带票数
   *  零命中 → 「—」（跟"还没算过"的真空白区分开） */
  function fmtPush(fcnt, hcnt, n) {
    var empty = true;
    for (var k in fcnt) { if (fcnt[k]) { empty = false; break; } }
    if (empty) { for (var k2 in hcnt) { if (hcnt[k2]) { empty = false; break; } } }
    if (n <= 0 || empty) return "—";
    var fs = fmtPart(fcnt, FULL_ORDER), hs = fmtPart(hcnt, HANDICAP_ORDER);
    var parts = [];
    if (fs) parts.push(fs);
    if (hs) parts.push(hs);
    return parts.join("；");
  }

  /** 对选中的行跑公式并写回数据库
   *  exclude: 不参与统计的行 id，默认就是本次这批（自己不算自己，同批也不互相算）
   *  返回 { field, tol, items:[{id,new_id,text,n,fcnt,hcnt,fulls,hds}], updated, skipped } */
  function computePush(ids, field, exclude) {
    field = field || "first_push";
    if (PUSH_FIELDS.indexOf(field) < 0) return { error: "field 只能是 first_push 或 second_push" };
    var tol = PUSH_TOL[field];

    var idList = [];
    var arr = ids || [];
    for (var i = 0; i < arr.length; i++) {
      var v = parseInt(arr[i], 10);
      if (!isNaN(v)) idList.push(v);
    }
    if (!idList.length) {
      return { field: field, tol: tol, items: [], updated: 0, skipped: [], truncated: false };
    }
    var truncated = idList.length > PUSH_MAX_SEL;
    if (truncated) idList = idList.slice(0, PUSH_MAX_SEL);

    var excl;
    if (exclude === undefined || exclude === null) {
      excl = idList.slice();
    } else {
      excl = [];
      for (var e = 0; e < exclude.length; e++) {
        var ev = parseInt(exclude[e], 10);
        if (!isNaN(ev)) excl.push(ev);
      }
    }
    var exclSql = excl.length
      ? " AND id NOT IN (" + excl.map(function () { return "?"; }).join(",") + ")"
      : "";

    var stamp = now();
    var items = [], skipped = [], sqls = [];

    for (var j = 0; j < idList.length; j++) {
      var rid = idList[j];
      var rr = run("SELECT id, new_id, wl, lw, s_h_win, s_h_lose FROM matches WHERE id=?", [rid]);
      if (rr.error) return { error: rr.error };
      if (!rr.rows.length) { skipped.push({ id: rid, reason: "库里已经没有这一条了" }); continue; }
      var row = rr.rows[0];

      var text = "—", n = 0, fcnt = {}, hcnt = {}, fulls = [], hds = [];
      if (row.wl === null || row.wl === undefined || row.lw === null || row.lw === undefined ||
          row.s_h_win === null || row.s_h_win === undefined ||
          row.s_h_lose === null || row.s_h_lose === undefined) {
        // 赔率缺一块就没法比，直接写「—」，不去猜
        text = "—";
      } else {
        var loW = r4(row.s_h_win - tol), hiW = r4(row.s_h_win + tol);
        var loL = r4(row.s_h_lose - tol), hiL = r4(row.s_h_lose + tol);
        var qr = run("SELECT full, handicap_result FROM matches " +
          "WHERE wl=? AND lw=? AND s_h_win BETWEEN ? AND ? AND s_h_lose BETWEEN ? AND ? " +
          "AND full IN (?,?,?)" + exclSql,
          [row.wl, row.lw, loW, hiW, loL, hiL].concat(VALID_FULL).concat(excl));
        if (qr.error) return { error: qr.error };
        for (var t = 0; t < qr.rows.length; t++) {
          n++;
          var f = trimStr(qr.rows[t].full);
          var h = trimStr(qr.rows[t].handicap_result);
          if (VALID_FULL.indexOf(f) >= 0) fcnt[f] = (fcnt[f] || 0) + 1;
          if (VALID_HANDICAP.indexOf(h) >= 0) hcnt[h] = (hcnt[h] || 0) + 1;
        }
        for (var a = 0; a < FULL_ORDER.length; a++) if (fcnt[FULL_ORDER[a]]) fulls.push(FULL_ORDER[a]);
        for (var b = 0; b < HANDICAP_ORDER.length; b++) if (hcnt[HANDICAP_ORDER[b]]) hds.push(HANDICAP_ORDER[b]);
        text = fmtPush(fcnt, hcnt, n);
      }

      sqls.push("UPDATE matches SET " + col(field) + " = " + lit(text) +
        ", updated_at = '" + esc(stamp) + "' WHERE id = " + rid);
      items.push({ id: rid, new_id: row.new_id, text: text, n: n,
                   fcnt: fcnt, hcnt: hcnt, fulls: fulls, hds: hds });
    }

    if (sqls.length) {
      var rb = runBatch(sqls);
      if (rb.error) return { error: rb.error };
    }
    return { field: field, tol: tol, items: items, updated: items.length,
             skipped: skipped, truncated: truncated };
  }

  /** 旧格式（结果里没有票数）升级成带票数的新格式。
   *  票数当时没存库，反推不出来，只能拿赔率重算一遍。
   *  只动「非空、不是 —、且里面一个数字都没有」的格子。 */
  function recalcPushTexts() {
    var done = { first_push: 0, second_push: 0 };
    var r = run("SELECT id, first_push, second_push FROM matches", []);
    if (r.error) return { error: r.error };
    var todo = {}, all = {}, i, k, v;
    for (i = 0; i < r.rows.length; i++) {
      for (var p = 0; p < PUSH_FIELDS.length; p++) {
        k = PUSH_FIELDS[p];
        v = trimStr(r.rows[i][k]);
        if (v && v !== "—" && !/\d/.test(v)) {
          if (!todo[k]) todo[k] = [];
          todo[k].push(r.rows[i].id);
          all[r.rows[i].id] = true;
        }
      }
    }
    var keys = [];
    for (k in todo) keys.push(k);
    if (!keys.length) return done;

    // 这批行彼此当作「同批勾选」，统计时互相排除，跟当初手点时保持一致
    var allIds = [];
    for (var id in all) allIds.push(parseInt(id, 10));

    var stamp = now(), sqls = [];
    for (var q = 0; q < keys.length; q++) {
      var field = keys[q];
      var tol = PUSH_TOL[field];
      var list = todo[field];
      var exclSql = " AND id NOT IN (" + allIds.map(function () { return "?"; }).join(",") + ")";
      for (i = 0; i < list.length; i++) {
        var rr = run("SELECT id, wl, lw, s_h_win, s_h_lose FROM matches WHERE id=?", [list[i]]);
        if (rr.error) return { error: rr.error };
        if (!rr.rows.length) continue;
        var row = rr.rows[0];
        var text = "—", n = 0, fcnt = {}, hcnt = {};
        if (!(row.wl === null || row.wl === undefined || row.lw === null || row.lw === undefined ||
              row.s_h_win === null || row.s_h_win === undefined ||
              row.s_h_lose === null || row.s_h_lose === undefined)) {
          var loW = r4(row.s_h_win - tol), hiW = r4(row.s_h_win + tol);
          var loL = r4(row.s_h_lose - tol), hiL = r4(row.s_h_lose + tol);
          var qr = run("SELECT full, handicap_result FROM matches " +
            "WHERE wl=? AND lw=? AND s_h_win BETWEEN ? AND ? AND s_h_lose BETWEEN ? AND ? " +
            "AND full IN (?,?,?)" + exclSql,
            [row.wl, row.lw, loW, hiW, loL, hiL].concat(VALID_FULL).concat(allIds));
          if (qr.error) return { error: qr.error };
          for (var t = 0; t < qr.rows.length; t++) {
            n++;
            var f = trimStr(qr.rows[t].full);
            var h = trimStr(qr.rows[t].handicap_result);
            if (VALID_FULL.indexOf(f) >= 0) fcnt[f] = (fcnt[f] || 0) + 1;
            if (VALID_HANDICAP.indexOf(h) >= 0) hcnt[h] = (hcnt[h] || 0) + 1;
          }
          text = fmtPush(fcnt, hcnt, n);
        }
        sqls.push("UPDATE matches SET " + col(field) + " = " + lit(text) +
          ", updated_at = '" + esc(stamp) + "' WHERE id = " + list[i]);
        done[field]++;
      }
    }
    if (sqls.length) {
      var rb = runBatch(sqls);
      if (rb.error) return { error: rb.error };
    }
    return done;
  }

  global.JSDB = {
    FIELDS: FIELDS, FIELD_MAP: FIELD_MAP, ALL_KEYS: ALL_KEYS,
    ENUM_FIELDS: ENUM_FIELDS, SUGGEST_FIELDS: SUGGEST_FIELDS,
    TEXT_MAXLEN: TEXT_MAXLEN, TEXT_FIELDS_LIMITED: TEXT_FIELDS_LIMITED,
    TEXT_PACK_KEYS: TEXT_PACK_KEYS,
    PUSH_FIELDS: PUSH_FIELDS, PUSH_TOL: PUSH_TOL, PUSH_MAX_SEL: PUSH_MAX_SEL,
    ensurePushColumns: ensurePushColumns,
    computePush: computePush, recalcPushTexts: recalcPushTexts,
    exportTextCsv: exportTextCsv, applyTextCsv: applyTextCsv,
    setRunner: setRunner,
    buildWhere: buildWhere,
    query: query, getRow: getRow, updateRow: updateRow, insertRow: insertRow,
    deleteRow: deleteRow, deleteMany: deleteMany,
    groupCount: groupCount, distinct: distinct, distinctMulti: distinctMulti,
    stats: stats, exportCsv: exportCsv,
    LABEL_MAP: LABEL_MAP,
    mapHeader: mapHeader,
    parseCsvLine: parseCsvLine,
    beginImport: beginImport, pushImportRows: pushImportRows,
    finishImport: finishImport, cancelImport: cancelImport
  };
})(typeof window !== "undefined" ? window : globalThis);
