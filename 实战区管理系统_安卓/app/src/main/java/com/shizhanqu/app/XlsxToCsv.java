package com.shizhanqu.app;

import android.content.Context;
import android.net.Uri;

import org.xmlpull.v1.XmlPullParser;
import org.xmlpull.v1.XmlPullParserFactory;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.TimeZone;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 把 xlsx 转成一份中间 CSV，交给网页那边导入。
 *
 * 只用系统自带的 ZipInputStream 和 XmlPullParser，不引任何第三方库，
 * 打包出来的 APK 不会变大。转出来的 CSV 放在 App 内部目录，
 * 网页分批读取，避免一次把几万行塞进内存。
 *
 * 日期的处理和电脑版（openpyxl）对齐：
 *   Excel 里日期/时间其实都是数字，到底是日期还是普通数字，要看单元格的数字格式。
 *   所以这里会先读 xl/styles.xml，记下哪些样式是日期格式；
 *   整天的（>=1）转成 2021-01-01 13:40，不到一天的（比分那两列）转成 1:0。
 */
public class XlsxToCsv {

    public interface Progress {
        void onRows(int rows);
    }

    /** 解析整个文件，返回数据行数（不含表头） */
    public static int convert(Context ctx, Uri uri, File out, Progress prog) throws Exception {
        ArrayList<String> sst = readSharedStrings(ctx, uri);
        boolean[] dateStyle = readDateStyles(ctx, uri);
        return writeSheet(ctx, uri, sst, dateStyle, out, prog);
    }

    // ---------------- 共享字符串 ----------------

    private static ArrayList<String> readSharedStrings(Context ctx, Uri uri) throws Exception {
        ArrayList<String> sst = new ArrayList<String>();
        InputStream in = ctx.getContentResolver().openInputStream(uri);
        if (in == null) {
            return sst;
        }
        ZipInputStream zis = null;
        try {
            zis = new ZipInputStream(in);
            ZipEntry e;
            while ((e = zis.getNextEntry()) != null) {
                String n = e.getName();
                if (n != null && n.equals("xl/sharedStrings.xml")) {
                    parseSst(zis, sst);
                    break;
                }
            }
        } finally {
            try {
                zis.close();
            } catch (Exception ignored) {
            }
        }
        return sst;
    }

    private static void parseSst(InputStream in, ArrayList<String> sst) throws Exception {
        XmlPullParser xpp = newParser(in);
        StringBuilder sb = null;
        int ev = xpp.getEventType();
        while (ev != XmlPullParser.END_DOCUMENT) {
            if (ev == XmlPullParser.START_TAG) {
                String n = xpp.getName();
                if ("si".equals(n)) {
                    sb = new StringBuilder();
                } else if ("t".equals(n) && sb != null) {
                    sb.append(xpp.nextText());
                }
            } else if (ev == XmlPullParser.END_TAG) {
                if ("si".equals(xpp.getName()) && sb != null) {
                    sst.add(sb.toString());
                    sb = null;
                }
            }
            ev = xpp.next();
        }
    }

    // ---------------- 样式：判断哪些格子是日期 ----------------

    /** 返回「样式下标 -> 是不是日期/时间格式」 */
    private static boolean[] readDateStyles(Context ctx, Uri uri) throws Exception {
        HashMap<Integer, String> custom = new HashMap<Integer, String>();
        ArrayList<Integer> xfs = new ArrayList<Integer>();
        InputStream in = ctx.getContentResolver().openInputStream(uri);
        if (in == null) {
            return new boolean[0];
        }
        ZipInputStream zis = new ZipInputStream(in);
        try {
            ZipEntry e;
            while ((e = zis.getNextEntry()) != null) {
                String n = e.getName();
                if (n != null && n.equals("xl/styles.xml")) {
                    parseStyles(zis, custom, xfs);
                    break;
                }
            }
        } finally {
            try {
                zis.close();
            } catch (Exception ignored) {
            }
        }
        boolean[] out = new boolean[xfs.size()];
        for (int i = 0; i < xfs.size(); i++) {
            int id = xfs.get(i);
            String code = custom.get(Integer.valueOf(id));
            if (code == null) {
                code = builtinFmt(id);
            }
            out[i] = code != null && hasDateTimeChar(code);
        }
        return out;
    }

    private static void parseStyles(InputStream in, HashMap<Integer, String> custom,
                                    ArrayList<Integer> xfs) throws Exception {
        XmlPullParser xpp = newParser(in);
        boolean inNumFmts = false;
        boolean inCellXfs = false;
        int ev = xpp.getEventType();
        while (ev != XmlPullParser.END_DOCUMENT) {
            if (ev == XmlPullParser.START_TAG) {
                String n = xpp.getName();
                if ("numFmts".equals(n)) {
                    inNumFmts = true;
                } else if ("cellXfs".equals(n)) {
                    inCellXfs = true;
                } else if ("numFmt".equals(n) && inNumFmts) {
                    String id = xpp.getAttributeValue(null, "numFmtId");
                    String code = xpp.getAttributeValue(null, "formatCode");
                    if (id != null && code != null) {
                        try {
                            custom.put(Integer.valueOf(Integer.parseInt(id.trim())), code);
                        } catch (Exception ignored) {
                        }
                    }
                } else if ("xf".equals(n) && inCellXfs) {
                    String id = xpp.getAttributeValue(null, "numFmtId");
                    int v = 0;
                    if (id != null) {
                        try {
                            v = Integer.parseInt(id.trim());
                        } catch (Exception ignored) {
                            v = 0;
                        }
                    }
                    xfs.add(Integer.valueOf(v));
                }
            } else if (ev == XmlPullParser.END_TAG) {
                String n = xpp.getName();
                if ("numFmts".equals(n)) {
                    inNumFmts = false;
                } else if ("cellXfs".equals(n)) {
                    inCellXfs = false;
                }
            }
            ev = xpp.next();
        }
    }

    /** 内置数字格式（文件里没写 numFmts 时用它兜底） */
    private static String builtinFmt(int id) {
        switch (id) {
            case 14:
                return "mm-dd-yy";
            case 15:
                return "d-mmm-yy";
            case 16:
                return "d-mmm";
            case 17:
                return "mmm-yy";
            case 18:
                return "h:mm AM/PM";
            case 19:
                return "h:mm:ss AM/PM";
            case 20:
                return "h:mm";
            case 21:
                return "h:mm:ss";
            case 22:
                return "m/d/yy h:mm";
            case 45:
                return "mm:ss";
            case 46:
                return "[h]:mm:ss";
            case 47:
                return "mmss.0";
            default:
                break;
        }
        // 27~36、50~58 是各国语言的日期时间格式
        if ((id >= 27 && id <= 36) || (id >= 50 && id <= 58)) {
            return "yyyy/m/d";
        }
        return null;
    }

    /** 去掉 [ ] 和 " " 里的东西后，还剩 y/m/d/h/s 就说明这是个日期时间格式 */
    private static boolean hasDateTimeChar(String code) {
        if (code == null) {
            return false;
        }
        StringBuilder sb = new StringBuilder();
        boolean inBracket = false;
        boolean inQuote = false;
        for (int i = 0; i < code.length(); i++) {
            char c = code.charAt(i);
            if (c == '[') {
                inBracket = true;
                continue;
            }
            if (inBracket) {
                if (c == ']') {
                    inBracket = false;
                }
                continue;
            }
            if (c == '"') {
                inQuote = !inQuote;
                continue;
            }
            if (inQuote) {
                continue;
            }
            if (c == '\\') {
                i++;
                continue;
            }
            sb.append(Character.toLowerCase(c));
        }
        String s = sb.toString();
        return s.indexOf('y') >= 0 || s.indexOf('m') >= 0 || s.indexOf('d') >= 0
                || s.indexOf('h') >= 0 || s.indexOf('s') >= 0;
    }

    // ---------------- 工作表 ----------------

    private static int writeSheet(Context ctx, Uri uri, ArrayList<String> sst, boolean[] dateStyle,
                                  File out, Progress prog) throws Exception {
        InputStream in = ctx.getContentResolver().openInputStream(uri);
        if (in == null) {
            throw new Exception("读不到这个文件");
        }
        ZipInputStream zis = new ZipInputStream(in);
        ZipEntry entry = null;
        ZipEntry e;
        while ((e = zis.getNextEntry()) != null) {
            String n = e.getName();
            if (n != null && n.startsWith("xl/worksheets/sheet1.xml")) {
                entry = e;
                break;
            }
        }
        if (entry == null) {
            try {
                zis.close();
            } catch (Exception ignored) {
            }
            throw new Exception("这个文件里没找到工作表，请确认是 xlsx 格式");
        }

        BufferedWriter w = null;
        int rows = 0;
        try {
            w = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(out), "UTF-8"), 256 * 1024);
            rows = parseSheet(zis, sst, dateStyle, w, prog);
        } finally {
            try {
                if (w != null) {
                    w.flush();
                    w.close();
                }
            } catch (Exception ignored) {
            }
            try {
                zis.close();
            } catch (Exception ignored) {
            }
        }
        return rows;
    }

    private static int parseSheet(InputStream in, ArrayList<String> sst, boolean[] dateStyle,
                                  BufferedWriter w, Progress prog) throws Exception {
        XmlPullParser xpp = newParser(in);
        int rows = 0;
        int cols = -1;
        int timeCol = -1;
        boolean headerDone = false;
        String[] cur = null;

        int ev = xpp.getEventType();
        while (ev != XmlPullParser.END_DOCUMENT) {
            if (ev == XmlPullParser.START_TAG) {
                String n = xpp.getName();
                if ("row".equals(n)) {
                    cur = new String[cols > 0 ? cols : 64];
                } else if ("c".equals(n) && cur != null) {
                    String r = xpp.getAttributeValue(null, "r");
                    String t = xpp.getAttributeValue(null, "t");
                    String sAttr = xpp.getAttributeValue(null, "s");
                    int ci = colIndex(r);
                    if (ci >= 0) {
                        if (ci >= cur.length) {
                            String[] bigger = new String[ci + 16];
                            System.arraycopy(cur, 0, bigger, 0, cur.length);
                            cur = bigger;
                        }
                        String v = readCell(xpp, t, sst);
                        boolean isDate = false;
                        if (dateStyle.length > 0) {
                            int si = parseIntSafe(sAttr, -1);
                            if (si >= 0 && si < dateStyle.length) {
                                isDate = dateStyle[si];
                            }
                        } else if (ci == timeCol && isSerialDate(v)) {
                            // 没有样式表时的兜底：只认「比赛时间」这一列
                            isDate = true;
                        }
                        if (isDate) {
                            v = fromSerial(v);
                        }
                        cur[ci] = v;
                    }
                }
            } else if (ev == XmlPullParser.END_TAG && "row".equals(xpp.getName()) && cur != null) {
                if (!headerDone) {
                    cols = usedLen(cur);
                    String[] header = new String[cols];
                    System.arraycopy(cur, 0, header, 0, cols);
                    boolean ok = false;
                    for (int i = 0; i < cols; i++) {
                        String h = header[i] == null ? "" : header[i].trim();
                        if ("新ID".equals(h) || "比赛时间".equals(h)) {
                            ok = true;
                            break;
                        }
                    }
                    if (!ok) {
                        throw new Exception("表头不符合预期，没找到「新ID」或「比赛时间」列");
                    }
                    for (int i = 0; i < cols; i++) {
                        if ("比赛时间".equals(header[i] == null ? "" : header[i].trim())) {
                            timeCol = i;
                        }
                    }
                    writeLine(w, header, cols);
                    headerDone = true;
                } else {
                    if (!isBlank(cur, cols)) {
                        writeLine(w, cur, cols);
                        rows++;
                        if (prog != null && rows % 2000 == 0) {
                            prog.onRows(rows);
                        }
                    }
                }
                cur = null;
            }
            ev = xpp.next();
        }
        if (!headerDone) {
            throw new Exception("这个表里一行数据都没有");
        }
        return rows;
    }

    /** 读一个单元格：t=s 走共享字符串，inlineStr 取 <is><t>，其余直接取 <v> */
    private static String readCell(XmlPullParser xpp, String t, ArrayList<String> sst) throws Exception {
        String v = null;
        StringBuilder sb = null;
        boolean inIs = false;
        while (true) {
            int e = xpp.next();
            if (e == XmlPullParser.END_DOCUMENT) {
                break;
            }
            if (e == XmlPullParser.END_TAG) {
                String n = xpp.getName();
                if ("c".equals(n)) {
                    break;
                }
                if ("is".equals(n)) {
                    inIs = false;
                }
                continue;
            }
            if (e == XmlPullParser.START_TAG) {
                String n = xpp.getName();
                if ("v".equals(n)) {
                    String s = xpp.nextText();
                    if (v == null) {
                        v = s;
                    }
                } else if ("is".equals(n)) {
                    inIs = true;
                    if (sb == null) {
                        sb = new StringBuilder();
                    }
                } else if ("t".equals(n) && inIs) {
                    sb.append(xpp.nextText());
                }
            }
        }
        if (sb != null && sb.length() > 0) {
            return sb.toString();
        }
        if (v == null) {
            return "";
        }
        if ("s".equals(t)) {
            try {
                int i = Integer.parseInt(v.trim());
                return (i >= 0 && i < sst.size()) ? sst.get(i) : "";
            } catch (Exception ex) {
                return v;
            }
        }
        return v;
    }

    // ---------------- 小工具 ----------------

    private static XmlPullParser newParser(InputStream in) throws Exception {
        XmlPullParserFactory f = XmlPullParserFactory.newInstance();
        f.setNamespaceAware(false);
        XmlPullParser xpp = f.newPullParser();
        xpp.setInput(in, "UTF-8");
        return xpp;
    }

    private static int parseIntSafe(String s, int def) {
        if (s == null) {
            return def;
        }
        try {
            return Integer.parseInt(s.trim());
        } catch (Exception e) {
            return def;
        }
    }

    /** "AB12" -> 27（A=0） */
    private static int colIndex(String r) {
        if (r == null) {
            return -1;
        }
        int i = 0, v = 0, n = 0;
        while (i < r.length()) {
            char c = r.charAt(i);
            if (c >= 'A' && c <= 'Z') {
                v = v * 26 + (c - 'A' + 1);
                n++;
                i++;
            } else if (c >= 'a' && c <= 'z') {
                v = v * 26 + (c - 'a' + 1);
                n++;
                i++;
            } else {
                break;
            }
        }
        return n == 0 ? -1 : v - 1;
    }

    private static int usedLen(String[] a) {
        int last = -1;
        for (int i = 0; i < a.length; i++) {
            if (a[i] != null && a[i].length() > 0) {
                last = i;
            }
        }
        return last + 1;
    }

    private static boolean isBlank(String[] a, int cols) {
        int n = Math.min(cols, a.length);
        for (int i = 0; i < n; i++) {
            if (a[i] != null && a[i].trim().length() > 0) {
                return false;
            }
        }
        return true;
    }

    private static void writeLine(BufferedWriter w, String[] a, int cols) throws Exception {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < cols; i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(cell(a[i]));
        }
        w.write(sb.toString());
        w.write('\n');
    }

    private static String cell(String s) {
        if (s == null) {
            return "";
        }
        // 单元格里的换行会破坏按行读取，先拍平
        String v = s.replace("\r", " ").replace("\n", " ").trim();
        if (v.indexOf(',') >= 0 || v.indexOf('"') >= 0) {
            return '"' + v.replace("\"", "\"\"") + '"';
        }
        return v;
    }

    /** Excel 里日期其实是数字：45000 这种，转成 2023-03-15 这样的文本 */
    private static boolean isSerialDate(String s) {
        if (s == null) {
            return false;
        }
        String v = s.trim();
        if (v.length() == 0) {
            return false;
        }
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (!((c >= '0' && c <= '9') || c == '.' || c == '-')) {
                return false;
            }
        }
        try {
            double d = Double.parseDouble(v);
            return d >= 20000 && d <= 80000;
        } catch (Exception e) {
            return false;
        }
    }

    /** 不到一天的是时间（比分那两列），整天的是日期
     *
     * 和 openpyxl 对齐的关键：小数部分要先「四舍五入到毫秒」再加回去。
     * 直接截断的话，23:00 会被算成 22:59（原始序列常是 0.95833333333 这种），
     * 几万行里会有几千行差一分钟，重新导入时会被误判成「内容有变化」。
     */
    private static String fromSerial(String s) {
        if (!isNumeric(s)) {
            return s;
        }
        try {
            double d = Double.parseDouble(s.trim());
            double day = Math.floor(d);
            double frac = d - day;
            long ms = Math.round(frac * 86400000.0);
            if (d >= 1) {
                long millis = (long) ((day - 25569.0) * 86400000.0) + ms;
                SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US);
                f.setTimeZone(TimeZone.getTimeZone("UTC"));
                return f.format(new Date(millis));
            }
            long mins = (ms / 1000) / 60;
            return (mins / 60) + ":" + (mins % 60);
        } catch (Exception e) {
            return s;
        }
    }

    private static boolean isNumeric(String s) {
        if (s == null) {
            return false;
        }
        String v = s.trim();
        if (v.length() == 0) {
            return false;
        }
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            if (!((c >= '0' && c <= '9') || c == '.' || c == '-' || c == '+')) {
                return false;
            }
        }
        try {
            Double.parseDouble(v);
            return true;
        } catch (Exception e) {
            return false;
        }
    }
}
