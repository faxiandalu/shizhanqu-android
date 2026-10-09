package com.shizhanqu.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

/** 极简壳子：一个全屏 WebView 装下整套界面，业务逻辑全在 assets/web 里的 JS */
public class MainActivity extends Activity {

    static final int REQ_PICK_DB = 1001;
    static final int REQ_SAVE_FILE = 1002;
    static final int REQ_PICK_XLSX = 1003;

    private WebView web;
    private DbBridge bridge;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setDefaultTextEncodingName("utf-8");
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new WebChromeClient());

        bridge = new DbBridge(this, web);
        web.addJavascriptInterface(bridge, "Android");

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(web);
        setContentView(root);

        web.loadUrl("file:///android_asset/web/index.html");

        // 后台打开上次用过的数据库，不阻塞界面
        new Thread(new Runnable() {
            @Override
            public void run() {
                bridge.openLastQuiet();
            }
        }).start();
    }

    /** 让手机上的系统文件选择器挑一个 .db 文件 */
    void pickDbFile() {
        try {
            Intent it = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            it.addCategory(Intent.CATEGORY_OPENABLE);
            it.setType("*/*");
            it.putExtra(Intent.EXTRA_MIME_TYPES,
                    new String[]{"application/vnd.sqlite3", "application/x-sqlite3", "application/octet-stream", "*/*"});
            startActivityForResult(it, REQ_PICK_DB);
        } catch (Exception e) {
            showToast("打不开文件选择器：" + e.getMessage());
            bridge.notifyDb(false, "打不开文件选择器");
        }
    }

    /** 让手机上的系统文件选择器挑一个 Excel 文件来导入 */
    void pickXlsxFile() {
        try {
            Intent it = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            it.addCategory(Intent.CATEGORY_OPENABLE);
            it.setType("*/*");
            it.putExtra(Intent.EXTRA_MIME_TYPES,
                    new String[]{
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                            "application/vnd.ms-excel",
                            "text/csv", "text/comma-separated-values",
                            "application/octet-stream", "*/*"});
            startActivityForResult(it, REQ_PICK_XLSX);
        } catch (Exception e) {
            showToast("打不开文件选择器：" + e.getMessage());
            bridge.notifyImport(false, "打不开文件选择器：" + e.getMessage(), 0);
        }
    }

    /** 导出：弹出系统保存对话框，让用户选保存位置 */
    void saveTextFile(String fileName) {
        try {
            Intent it = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            it.addCategory(Intent.CATEGORY_OPENABLE);
            it.setType("text/csv");
            it.putExtra(Intent.EXTRA_TITLE, fileName);
            startActivityForResult(it, REQ_SAVE_FILE);
        } catch (Exception e) {
            showToast("打不开保存对话框：" + e.getMessage());
            bridge.notifySaved(false, "打不开保存对话框");
        }
    }

    void showToast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (res != RESULT_OK || data == null || data.getData() == null) {
            if (req == REQ_PICK_DB) bridge.notifyDb(false, "已取消选择");
            if (req == REQ_PICK_XLSX) bridge.notifyImport(false, "已取消选择", 0);
            return;
        }
        android.net.Uri uri = data.getData();
        if (req == REQ_PICK_DB) {
            try {
                getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
            }
            bridge.copyAndOpen(uri);
        } else if (req == REQ_PICK_XLSX) {
            try {
                getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
            }
            bridge.prepareImport(uri);
        } else if (req == REQ_SAVE_FILE) {
            try {
                getContentResolver().takePersistableUriPermission(uri,
                        Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
            }
            bridge.writeToUri(uri);
        }
    }

    @Override
    public void onBackPressed() {
        // 先问网页：抽屉 / 弹窗开着就让网页自己收起来
        web.evaluateJavascript("(window.__onBack && window.__onBack()) ? true : false",
                new android.webkit.ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (value == null || !value.contains("true")) {
                            finish();
                        }
                    }
                });
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            try {
                web.destroy();
            } catch (Exception ignored) {
            }
        }
        super.onDestroy();
    }
}
