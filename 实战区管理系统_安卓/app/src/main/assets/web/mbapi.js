/* 手机版适配层：把桌面版的「接口调用」接到本地 JSDB / 安卓桥上
 *
 * 桌面版前端调的是 api("query", {...}) 这种形式，这里让它在手机上不用改调用方式：
 *   api("meta")      -> JSDB 常量
 *   api("query")     -> JSDB.query（本地 SQLite）
 *   api("quickDistinct") -> JSDB.distinctMulti（动态列表）
 * 另外补了几个手机版专有的能力：数据库文件选择、导出保存。
 */
(function (global) {
  "use strict";
  var A = global.Android;

  global.MB = {
    isMobile: !!A,
    ready: function () { return !!(A && A.isReady()); },
    dbInfo: function () {
      try { return JSON.parse(A.dbInfo()); } catch (e) { return { ready: false, count: 0, size: 0, uri: "" }; }
    },
    pickDb: function () { A.pickDb(); },
    reloadDb: function () { A.reloadDb(); },
    saveText: function (name, text) { A.saveText(name, text); },
    sysToast: function (msg) { try { A.toast(msg); } catch (e) { } },

    call: function (method, args) {
      args = args || [];
      try {
        switch (method) {
          case "meta":
            return {
              fields: global.JSDB.FIELDS.map(function (f) {
                return { key: f[0], label: f[1], type: f[2], group: f[3] };
              }),
              textMaxLen: global.JSDB.TEXT_MAXLEN,
              enumFields: global.JSDB.ENUM_FIELDS,
              suggestFields: global.JSDB.SUGGEST_FIELDS
            };
          case "env":
            return { defaultImportPath: "" };
          case "stats":
            return global.JSDB.stats();
          case "distinct":
            return { field: args[0], values: global.JSDB.distinct(args[0], args[1], args[2]) };
          case "quickDistinct": {
            var p1 = args[0] || {};
            return global.JSDB.distinctMulti(p1.fields, p1.filters, p1.limit, p1.order, p1.excludeSelf);
          }
          case "query": {
            var p2 = args[0] || {};
            return global.JSDB.query(p2.filters, p2.sort, p2.page, p2.size);
          }
          case "getRow":
            return global.JSDB.getRow(args[0]);
          case "groupCount": {
            var p3 = args[0] || {};
            return global.JSDB.groupCount(p3.filters, p3.fields);
          }
          case "updateRow":
            return global.JSDB.updateRow(args[0], args[1] || {});
          case "newRow":
            return global.JSDB.insertRow(args[0] || {});
          case "deleteRow":
            return global.JSDB.deleteRow(args[0]);
          case "deleteRows":
            return global.JSDB.deleteMany(args[0]);
          default:
            return { error: "手机版暂不支持：" + method };
        }
      } catch (e) {
        return { error: (e && e.message) ? e.message : String(e) };
      }
    }
  };
})(window);
