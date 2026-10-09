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
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.Locale;

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

    // 导入 Excel 用：转成 CSV 放在内部目录，网页分批读取
    private volatile File csvFile;
    private volatile ArrayList<Long> csvOffsets;
    private volatile int csvRows;

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

    /** 把选中的文件复制到 App 内部目录再打开（38MB 左右，后台复制）
     *
     * 顺序很关键：必须「先让文件就位、再打开连接」。
     * 以前是先在 shizhanqu.tmp 上打开、再 rename 成 shizhanqu.db，
     * SQLite 会发现路径上的文件已经不是当初那个，把连接锁成只读，
     * 结果就是：查询正常，一保存就报
     *   attempt to write a readonly database (code 1032 SQLITE_READONLY_DBMOVED)
     */
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

                    // 先在临时文件上以只读方式验一下结构，别急着替换
                    long cnt;
                    SQLiteDatabase chk = SQLiteDatabase.openDatabase(
                            tmp.getPath(), null, SQLiteDatabase.OPEN_READONLY);
                    try {
                        cnt = countMatches(chk);
                    } catch (Exception e) {
                        chk.close();
                        throw new Exception("这个文件里没有 matches 表，请选择 shizhanqu.db");
                    }
                    chk.close();

                    // 关掉旧连接之后再动文件，避免旧连接变成「文件被移走」的只读状态
                    SQLiteDatabase old = db;
                    db = null;
                    if (old != null) {
                        try {
                            old.close();
                        } catch (Exception ignored) {
                        }
                    }

                    // 主库和它的一堆旁车文件（WAL 日志）一起清干净，
                    // 否则残留的 -wal 会挂到新库头上，读出来是旧数据
                    deleteDbSet(dst);
                    deleteDbSet(tmp);   // tmp 只读打开过一次，理论上没日志，保险起见
                    if (!tmp.renameTo(dst) && !tmp.renameTo(dst)) {
                        // 极少数机型 rename 会失败，退回用流拷贝
                        copyFile(tmp, dst);
                        tmp.delete();
                    }
                    if (!dst.exists()) {
                        throw new Exception("写不进 App 内部目录");
                    }

                    SQLiteDatabase ndb = SQLiteDatabase.openDatabase(
                            dst.getPath(), null, SQLiteDatabase.OPEN_READWRITE);
                    db = ndb;
                    dbPath = dst.getPath();
                    savePref("db_uri", uri.toString());
                    notifyDb(true, "已加载 " + cnt + " 条");
                } catch (Exception e) {
                    notifyDb(false, "加载失败：" + e.getMessage());
                }
            }
        }).start();
    }

    /** 删掉一个数据库以及它的 -wal / -shm / -journal 旁车文件 */
    private void deleteDbSet(File f) {
        String[] ext = {"", "-wal", "-shm", "-journal"};
        for (int i = 0; i < ext.length; i++) {
            File x = new File(f.getPath() + ext[i]);
            if (x.exists()) {
                try {
                    x.delete();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private void copyFile(File src, File dst) throws Exception {
        InputStream in = new FileInputStream(src);
        OutputStream out = new FileOutputStream(dst);
        try {
            byte[] buf = new byte[256 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        } finally {
            out.close();
            in.close();
        }
    }

    /** 连接被系统搞成只读时（1032 SQLITE_READONLY_DBMOVED），重新开一次就能救回来 */
    private boolean reopenIfMoved(String errMsg) {
        if (errMsg == null) {
            return false;
        }
        String m = errMsg.toLowerCase(Locale.US);
        if (m.indexOf("readonly") < 0 && m.indexOf("1032") < 0 && m.indexOf("dbmoved") < 0) {
            return false;
        }
        if (dbPath == null) {
            return false;
        }
        try {
            if (db != null) {
                try {
                    db.close();
                } catch (Exception ignored) {
                }
                db = null;
            }
            if (!new File(dbPath).exists()) {
                return false;
            }
            db = SQLiteDatabase.openDatabase(dbPath, null, SQLiteDatabase.OPEN_READWRITE);
            return true;
        } catch (Exception e) {
            db = null;
            return false;
        }
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

    /** 增删改：返回 {"changes":n,"lastId":n}
     *  万一撞上「数据库被移走」变成只读，自动重开一次连接再试一遍 */
    @JavascriptInterface
    public String execChange(String sql, String argsJson) {
        JSONObject out = new JSONObject();
        try {
            if (db == null) {
                out.put("error", "数据库未加载");
                return out.toString();
            }
            try {
                db.execSQL(sql, toArgs(argsJson));
            } catch (Exception e1) {
                if (!reopenIfMoved(e1.getMessage())) {
                    throw e1;
                }
                db.execSQL(sql, toArgs(argsJson));
            }
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

    // ---------------- 导入 Excel ----------------

    /** 弹出系统文件选择器，让用户挑一个 xlsx */
    @JavascriptInterface
    public void pickXlsx() {
        main.post(new Runnable() {
            @Override
            public void run() {
                ((MainActivity) act).pickXlsxFile();
            }
        });
    }

    /** 把选中的 xlsx 转成 CSV 放在内部目录（后台跑，几万行时会回调进度） */
    public void prepareImport(final Uri uri) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File dir = new File(act.getFilesDir(), "import");
                    if (!dir.exists()) {
                        dir.mkdirs();
                    }
                    File out = new File(dir, "incoming.csv");
                    if (out.exists()) {
                        out.delete();
                    }
                    final int[] last = new int[]{0};
                    int rows = XlsxToCsv.convert(act, uri, out, new XlsxToCsv.Progress() {
                        @Override
                        public void onRows(int r) {
                            last[0] = r;
                            notifyImportProgress(r);
                        }
                    });
                    if (rows <= 0) {
                        throw new Exception("这个文件里没有数据行");
                    }
                    csvFile = out;
                    csvOffsets = buildOffsets(out);
                    csvRows = rows + 1;   // 第一行是表头
                    notifyImport(true, "已读取 " + rows + " 行", csvRows);
                } catch (Exception e) {
                    csvRows = 0;
                    notifyImport(false, "读取失败：" + e.getMessage(), 0);
                }
            }
        }).start();
    }

    /** 转出来的 CSV 一共有多少行（含表头） */
    @JavascriptInterface
    public int importCsvRows() {
        return csvRows;
    }

    /** 分批读 CSV：from 起 count 行，按行边界切好，网页直接 split("\n") */
    @JavascriptInterface
    public String readImportLines(int from, int count) {
        try {
            if (csvFile == null || csvOffsets == null || csvOffsets.isEmpty()) {
                return "";
            }
            if (from < 0) {
                from = 0;
            }
            if (from >= csvOffsets.size()) {
                return "";
            }
            int to = Math.min(from + count, csvOffsets.size());
            long start = csvOffsets.get(from);
            long end = (to < csvOffsets.size()) ? csvOffsets.get(to) : csvFile.length();
            int len = (int) (end - start);
            if (len <= 0) {
                return "";
            }
            RandomAccessFile raf = new RandomAccessFile(csvFile, "r");
            byte[] b = new byte[len];
            raf.seek(start);
            raf.readFully(b);
            raf.close();
            return new String(b, "UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    /** 一组 SQL 放在一个事务里跑完，比一条条快得多（导入几万行靠它） */
    @JavascriptInterface
    public String execBatch(String sqlsJson) {
        JSONObject out = new JSONObject();
        try {
            if (db == null) {
                out.put("error", "数据库未加载");
                return out.toString();
            }
            JSONArray arr = new JSONArray(sqlsJson);
            int n = 0;
            db.beginTransaction();
            boolean retried = false;
            try {
                for (int i = 0; i < arr.length(); i++) {
                    String s = arr.getString(i);
                    if (s == null || s.length() == 0) {
                        continue;
                    }
                    try {
                        db.execSQL(s);
                    } catch (Exception e1) {
                        if (retried || !reopenIfMoved(e1.getMessage())) {
                            throw e1;
                        }
                        retried = true;
                        db.beginTransaction();      // 旧事务随旧连接没了，重开一个
                        db.execSQL(s);
                    }
                    n++;
                }
                db.setTransactionSuccessful();
            } finally {
                try {
                    db.endTransaction();
                } catch (Exception ignored) {
                }
            }
            out.put("ok", true);
            out.put("count", n);
        } catch (Exception e) {
            try {
                out.put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
            }
        }
        return out.toString();
    }

    /** 记下每一行的字节位置，好按行号随机读取 */
    private ArrayList<Long> buildOffsets(File f) throws Exception {
        ArrayList<Long> offs = new ArrayList<Long>();
        FileInputStream in = new FileInputStream(f);
        try {
            byte[] buf = new byte[256 * 1024];
            long pos = 0;
            long lineStart = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                for (int i = 0; i < n; i++) {
                    if (buf[i] == '\n') {
                        offs.add(lineStart);
                        lineStart = pos + i + 1;
                    }
                }
                pos += n;
            }
            if (lineStart < f.length()) {
                offs.add(lineStart);
            }
        } finally {
            in.close();
        }
        return offs;
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

    void notifyImport(final boolean ok, final String msg, final int rows) {
        callJs("window.__onImportReady&&window.__onImportReady(" + (ok ? "true" : "false") + "," + q(msg) + "," + rows + ")");
    }

    void notifyImportProgress(final int rows) {
        callJs("window.__onImportProgress&&window.__onImportProgress(" + rows + ")");
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
