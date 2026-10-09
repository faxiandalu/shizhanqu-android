package com.shizhanqu.app;

import android.app.Activity;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * 网页与手机 SQLite 之间的桥。
 * 这里只做「执行 SQL / 复制数据库 / 保存文件」三件事，
 * 查什么、怎么查全部由 assets/web/jsdb.js 决定，方便随时改逻辑而不用重新编译。
 */
public class DbBridge {

    private final Activity act;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());

    private volatile SQLiteDatabase db;
    private volatile String dbPath;
    private volatile String pendingText;
    private volatile String pendingName;

    DbBridge(Activity a, WebView w) {
        act = a;
        web = w;
    }

    // ---------------- 数据库状态 ----------------

    @JavascriptInterface
    public boolean isReady() {
        return db != null;
    }

    @JavascriptInterface
    public String dbInfo() {
        JSONObject o = new JSONObject();
        try {
            o.put("ready", db != null);
            o.put("path", dbPath == null ? "" : dbPath);
            File f = dbPath == null ? null : new File(dbPath);
            o.put("size", f == null ? 0 : f.length());
            o.put("uri", pref("db_uri", ""));
            o.put("count", db == null ? 0 : scalar("SELECT COUNT(*) FROM matches"));
        } catch (Exception e) {
            try {
                o.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return o.toString();
    }

    // ---------------- 数据库文件 ----------------

    /** 弹出系统文件选择器，让用户挑 shizhanqu.db */
    @JavascriptInterface
    public void pickDb() {
        main.post(new Runnable() {
            @Override
            public void run() {
                ((MainActivity) act).pickDbFile();
            }
        });
    }

    /** 用上次选过的文件重新复制一份——电脑上数据更新后，手机上点这个就能同步 */
    @JavascriptInterface
    public void reloadDb() {
        String u = pref("db_uri", "");
        if (u.length() == 0) {
            notifyDb(false, "还没选过数据库文件，请先选择");
            return;
        }
        copyAndOpen(Uri.parse(u));
    }

    /** 把选中的文件复制到 App 内部目录再打开（38MB 左右，后台复制） */
    public void copyAndOpen(final Uri uri) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File dir = new File(act.getFilesDir(), "db");
                    if (!dir.exists()) {
                        dir.mkdirs();
                    }
                    File tmp = new File(dir, "shizhanqu.tmp");
                    File dst = new File(dir, "shizhanqu.db");
                    if (tmp.exists()) {
                        tmp.delete();
                    }

                    InputStream in = act.getContentResolver().openInputStream(uri);
                    if (in == null) {
                        throw new Exception("读不到这个文件");
                    }
                    OutputStream out = new FileOutputStream(tmp);
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    long total = 0;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        total += n;
                    }
                    out.close();
                    in.close();

                    if (total < 4096) {
                        throw new Exception("文件只有 " + total + " 字节，不像数据库文件");
                    }

                    SQLiteDatabase ndb = SQLiteDatabase.openDatabase(
                            tmp.getPath(), null, SQLiteDatabase.OPEN_READWRITE);
                    long cnt;
                    try {
                        cnt = countMatches(ndb);
                    } catch (Exception e) {
                        ndb.close();
                        throw new Exception("这个文件里没有 matches 表，请选择 shizhanqu.db");
                    }

                    if (dst.exists()) {
                        dst.delete();
                    }
                    tmp.renameTo(dst);

                    SQLiteDatabase old = db;
                    db = ndb;
                    dbPath = dst.getPath();
                    if (old != null) {
                        try {
                            old.close();
                        } catch (Exception ignored) {
                        }
                    }
                    savePref("db_uri", uri.toString());
                    notifyDb(true, "已加载 " + cnt + " 条");
                } catch (Exception e) {
                    notifyDb(false, "加载失败：" + e.getMessage());
                }
            }
        }).start();
    }

    /** 启动时悄悄打开上次复制好的数据库 */
    public void openLastQuiet() {
        try {
            File dst = new File(new File(act.getFilesDir(), "db"), "shizhanqu.db");
            if (!dst.exists()) {
                return;
            }
            SQLiteDatabase ndb = SQLiteDatabase.openDatabase(dst.getPath(), null, SQLiteDatabase.OPEN_READWRITE);
            countMatches(ndb);   // 顺手校验一下表结构
            db = ndb;
            dbPath = dst.getPath();
        } catch (Exception ignored) {
        }
    }

    private long countMatches(SQLiteDatabase d) {
        Cursor c = d.rawQuery("SELECT COUNT(*) FROM matches", null);
        long v = 0;
        if (c.moveToFirst()) {
            v = c.getLong(0);
        }
        c.close();
        return v;
    }

    // ---------------- SQL 执行 ----------------

    /** 查询：返回 JSON 字符串 {"rows":[...]} */
    @JavascriptInterface
    public String exec(String sql, String argsJson) {
        JSONObject out = new JSONObject();
        try {
            if (db == null) {
                out.put("error", "数据库未加载");
                return out.toString();
            }
            Cursor c = db.rawQuery(sql, toArgs(argsJson));
            String[] names = c.getColumnNames();
            JSONArray rows = new JSONArray();
            while (c.moveToNext()) {
                JSONObject o = new JSONObject();
                for (int i = 0; i < names.length; i++) {
                    int t = c.getType(i);
                    if (t == Cursor.FIELD_TYPE_NULL) {
                        o.put(names[i], JSONObject.NULL);
                    } else if (t == Cursor.FIELD_TYPE_INTEGER) {
                        o.put(names[i], c.getLong(i));
                    } else if (t == Cursor.FIELD_TYPE_FLOAT) {
                        o.put(names[i], c.getDouble(i));
                    } else {
                        o.put(names[i], c.getString(i));
                    }
                }
                rows.put(o);
            }
            c.close();
            out.put("rows", rows);
        } catch (Exception e) {
            try {
                out.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return out.toString();
    }

    /** 增删改：返回 {"changes":n,"lastId":n} */
    @JavascriptInterface
    public String execChange(String sql, String argsJson) {
        JSONObject out = new JSONObject();
        try {
            if (db == null) {
                out.put("error", "数据库未加载");
                return out.toString();
            }
            db.execSQL(sql, toArgs(argsJson));
            out.put("lastId", scalar("SELECT last_insert_rowid()"));
            out.put("changes", scalar("SELECT changes()"));
        } catch (Exception e) {
            try {
                out.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return out.toString();
    }

    /** 纯数字查询（COUNT 之类） */
    private long scalar(String sql) {
        Cursor c = db.rawQuery(sql, null);
        long v = 0;
        if (c.moveToFirst()) {
            v = c.getLong(0);
        }
        c.close();
        return v;
    }

    private String[] toArgs(String json) {
        if (json == null || json.length() == 0) {
            return new String[0];
        }
        try {
            JSONArray a = new JSONArray(json);
            String[] r = new String[a.length()];
            for (int i = 0; i < a.length(); i++) {
                Object v = a.get(i);
                r[i] = (v == null || v == JSONObject.NULL) ? null : String.valueOf(v);
            }
            return r;
        } catch (Exception e) {
            return new String[0];
        }
    }

    // ---------------- 导出文件 ----------------

    /** 先收下要写的内容，再去问用户存到哪 */
    @JavascriptInterface
    public void saveText(String fileName, String content) {
        pendingName = fileName;
        pendingText = content;
        final String fn = fileName;
        main.post(new Runnable() {
            @Override
            public void run() {
                ((MainActivity) act).saveTextFile(fn);
            }
        });
    }

    public void writeToUri(final Uri uri) {
        final String text = pendingText;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    OutputStream os = act.getContentResolver().openOutputStream(uri);
                    if (os == null) {
                        throw new Exception("打不开输出流");
                    }
                    os.write(new byte[]{(byte) 0xEF, (byte) 0xBB, (byte) 0xBF});  // BOM，Excel 打开不乱码
                    os.write(text.getBytes("UTF-8"));
                    os.flush();
                    os.close();
                    notifySaved(true, "已保存");
                } catch (Exception e) {
                    notifySaved(false, "保存失败：" + e.getMessage());
                }
            }
        }).start();
    }

    // ---------------- 杂项 ----------------

    @JavascriptInterface
    public void toast(final String msg) {
        main.post(new Runnable() {
            @Override
            public void run() {
                ((MainActivity) act).showToast(msg);
            }
        });
    }

    // ---------------- 回调网页 ----------------

    void notifyDb(final boolean ok, final String msg) {
        callJs("window.__onDbResult&&window.__onDbResult(" + (ok ? "true" : "false") + "," + q(msg) + ")");
    }

    void notifySaved(final boolean ok, final String msg) {
        callJs("window.__onSaveResult&&window.__onSaveResult(" + (ok ? "true" : "false") + "," + q(msg) + ")");
    }

    private void callJs(final String js) {
        main.post(new Runnable() {
            @Override
            public void run() {
                try {
                    web.evaluateJavascript(js, null);
                } catch (Exception ignored) {
                }
            }
        });
    }

    private static String q(String s) {
        if (s == null) {
            return "\"\"";
        }
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ") + "\"";
    }

    private String pref(String k, String def) {
        SharedPreferences p = act.getSharedPreferences("szq", Activity.MODE_PRIVATE);
        return p.getString(k, def);
    }

    private void savePref(String k, String v) {
        SharedPreferences p = act.getSharedPreferences("szq", Activity.MODE_PRIVATE);
        p.edit().putString(k, v).apply();
    }
}
