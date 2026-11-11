package app.bezdna;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Оболочка игры: WebView показывает игру из памяти телефона.
 * Сначала это копия, зашитая в APK; кнопка «Обновить» скачивает свежую
 * версию из репозитория и дальше игра запускается уже из неё.
 */
public class MainActivity extends Activity {
    static final String REPO = "zlontp98-bit/Bezdna";
    static final String HOST = "bezdna.game";
    static final String START = "https://" + HOST + "/index.html";

    WebView web;
    File gameDir;
    volatile boolean busy;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        gameDir = new File(getFilesDir(), "game");

        // после установки нового APK скачанная ранее версия может быть старее зашитой — убираем её
        SharedPreferences p = getPreferences(MODE_PRIVATE);
        long installed = 0;
        try { installed = getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime; } catch (Exception ignored) { }
        if (p.getLong("apk", 0) != installed) {
            deleteTree(gameDir);
            p.edit().putLong("apk", installed).apply();
        }

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setBackgroundColor(0xFFCFE2EE);
        web.addJavascriptInterface(new Bridge(), "BezdnaApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                if (!HOST.equals(r.getUrl().getHost())) return null;
                String path = r.getUrl().getPath();
                if (path == null || path.equals("/")) path = "/index.html";
                path = path.substring(1);
                try {
                    if (path.contains("..")) throw new Exception("bad path");
                    File f = new File(gameDir, path);
                    InputStream in = f.isFile() ? new FileInputStream(f) : getAssets().open("game/" + path);
                    WebResourceResponse res = new WebResourceResponse(mime(path), "utf-8", in);
                    res.setResponseHeaders(java.util.Collections.singletonMap("Cache-Control", "no-store"));
                    return res;
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                            new java.util.HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
                }
            }
        });
        setContentView(web);
        web.loadUrl(START);
    }

    static String mime(String p) {
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg")) return "image/jpeg";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".mp3")) return "audio/mpeg";
        if (p.endsWith(".ogg")) return "audio/ogg";
        return "application/octet-stream";
    }

    @Override
    public void onWindowFocusChanged(boolean has) {
        super.onWindowFocusChanged(has);
        if (has) getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    @Override protected void onPause() { super.onPause(); web.onPause(); }
    @Override protected void onResume() { super.onResume(); web.onResume(); }

    /** Версия игры, которая сейчас запущена (короткий номер коммита). */
    String currentVersion() {
        try {
            File f = new File(gameDir, "version.txt");
            InputStream in = f.isFile() ? new FileInputStream(f) : getAssets().open("game/version.txt");
            byte[] buf = new byte[64];
            int n = in.read(buf);
            in.close();
            return new String(buf, 0, Math.max(n, 0), "UTF-8").trim();
        } catch (Exception e) {
            return "";
        }
    }

    void report(final String state, final String text) {
        runOnUiThread(new Runnable() {
            public void run() {
                String t = text.replace("\\", "\\\\").replace("'", "\\'");
                web.evaluateJavascript("window.onBezdnaUpdate&&window.onBezdnaUpdate('" + state + "','" + t + "')", null);
            }
        });
    }

    HttpURLConnection open(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(12000);
        c.setReadTimeout(20000);
        c.setRequestProperty("User-Agent", "game-updater");
        return c;
    }

    String latestVersion() throws Exception {
        // последний коммит, который менял папку game/ (сама игра, без оболочки)
        HttpURLConnection c = open("https://api.github.com/repos/" + REPO + "/commits?path=game&per_page=1");
        if (c.getResponseCode() != 200) throw new Exception("сервер ответил " + c.getResponseCode());
        InputStream in = c.getInputStream();
        byte[] buf = new byte[512];
        int n = 0, r;
        while (n < buf.length && (r = in.read(buf, n, buf.length - n)) > 0) n += r;
        in.close();
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("\"sha\"\\s*:\\s*\"([0-9a-f]{40})\"")
                .matcher(new String(buf, 0, n, "UTF-8"));
        if (!m.find()) throw new Exception("неожиданный ответ сервера");
        return m.group(1);
    }

    /** Скачивает архив версии и распаковывает из него только файлы игры. */
    void download(String sha) throws Exception {
        HttpURLConnection c = open("https://codeload.github.com/" + REPO + "/zip/" + sha);
        if (c.getResponseCode() != 200) throw new Exception("сервер ответил " + c.getResponseCode());
        File tmp = new File(getFilesDir(), "game_new");
        deleteTree(tmp);
        tmp.mkdirs();
        String root = tmp.getCanonicalPath() + File.separator;
        ZipInputStream zip = new ZipInputStream(c.getInputStream());
        byte[] buf = new byte[32768];
        long total = 0;
        int files = 0;
        ZipEntry e;
        while ((e = zip.getNextEntry()) != null) {
            String name = e.getName();
            int cut = name.indexOf('/');
            if (cut < 0 || e.isDirectory()) continue;
            name = name.substring(cut + 1); // без папки «Bezdna-<версия>/»
            if (!name.startsWith("game/")) continue; // берём только саму игру
            name = name.substring(5);
            File out = new File(tmp, name);
            if (!out.getCanonicalPath().startsWith(root)) continue; // защита от «../» в архиве
            out.getParentFile().mkdirs();
            OutputStream os = new FileOutputStream(out);
            int n;
            while ((n = zip.read(buf)) > 0) {
                os.write(buf, 0, n);
                total += n;
            }
            os.close();
            files++;
            report("downloading", "Скачиваем… " + (total / 1024) + " КБ");
        }
        zip.close();
        if (!new File(tmp, "index.html").isFile() || files < 3) throw new Exception("архив неполный");
        OutputStream v = new FileOutputStream(new File(tmp, "version.txt"));
        v.write(sha.getBytes("UTF-8"));
        v.close();
        deleteTree(gameDir);
        if (!tmp.renameTo(gameDir)) throw new Exception("не удалось сохранить файлы");
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }

    class Bridge {
        @JavascriptInterface
        public String version() { return currentVersion(); }

        /** Только проверить, вышло ли обновление. */
        @JavascriptInterface
        public void check() {
            new Thread(new Runnable() {
                public void run() {
                    try {
                        String latest = latestVersion();
                        report(latest.equals(currentVersion()) ? "uptodate" : "available", "");
                    } catch (Exception e) {
                        report("offline", "");
                    }
                }
            }).start();
        }

        /** Проверить и, если есть новая версия, скачать её и перезапустить игру. */
        @JavascriptInterface
        public void update() {
            if (busy) return;
            busy = true;
            new Thread(new Runnable() {
                public void run() {
                    try {
                        report("checking", "Проверяем…");
                        String latest = latestVersion();
                        if (latest.equals(currentVersion())) {
                            report("uptodate", "У тебя последняя версия");
                        } else {
                            report("downloading", "Скачиваем…");
                            download(latest);
                            report("done", "Готово, перезапуск…");
                            runOnUiThread(new Runnable() {
                                public void run() { web.clearCache(true); web.loadUrl(START); }
                            });
                        }
                    } catch (Exception e) {
                        report("error", "Не получилось: " + (e.getMessage() == null ? "нет сети" : e.getMessage()));
                    } finally {
                        busy = false;
                    }
                }
            }).start();
        }
    }
}
