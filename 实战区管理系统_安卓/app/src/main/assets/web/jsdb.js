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
    ["ll", "负负", "real", "赔率"]
  ];
  var FIELD_MAP = {};
  FIELDS.forEach(function (f) { FIELD_MAP[f[0]] = f; });
  var ALL_KEYS = FIELDS.map(function (f) { return f[0]; });
  var ENUM_FIELDS = ["status", "half", "full", "half_full", "handicap_result", "handicap", "ou"];
  var SUGGEST_FIELDS = ["league", "match_no"];
  var TEXT_FIELDS_LIMITED = ["record", "review"];

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

  global.JSDB = {
    FIELDS: FIELDS, FIELD_MAP: FIELD_MAP, ALL_KEYS: ALL_KEYS,
    ENUM_FIELDS: ENUM_FIELDS, SUGGEST_FIELDS: SUGGEST_FIELDS,
    TEXT_MAXLEN: TEXT_MAXLEN, TEXT_FIELDS_LIMITED: TEXT_FIELDS_LIMITED,
    setRunner: setRunner,
    buildWhere: buildWhere,
    query: query, getRow: getRow, updateRow: updateRow, insertRow: insertRow,
    deleteRow: deleteRow, deleteMany: deleteMany,
    groupCount: groupCount, distinct: distinct, distinctMulti: distinctMulti,
    stats: stats, exportCsv: exportCsv
  };
})(typeof window !== "undefined" ? window : globalThis);
