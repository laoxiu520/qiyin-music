package com.qiyin.music;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 本地网页与 Android 之间的桥：
 * 负责解析网易云公开歌单、下载音频到应用私有缓存目录。
 * 不读取账号信息，也不向第三方上传任何数据。
 */
public class QiyinBridge {
    private static final String UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
            + "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NeteaseMusic/9.1.40";
    static final int IMPORT_REQUEST = 1002;
    private static final long MIN_AUDIO_BYTES = 60000L;
    private static final long MAX_AUDIO_BYTES = 40L * 1024 * 1024;
    private static final long MAX_IMPORT_BYTES = 200L * 1024 * 1024;
    private static final String[] AUDIO_EXTENSIONS = {
            "mp3", "flac", "m4a", "aac", "wav", "ogg", "opus"
    };
    private static final Pattern URL_PATTERN = Pattern.compile("https?://[^\\s\"'，,。、）)]+");
    private static final Pattern ID_PATTERN = Pattern.compile("[?&]id=(\\d+)");
    private static final Pattern PATH_PATTERN = Pattern.compile("playlist/(\\d+)");
    private static final Pattern DIGITS_PATTERN = Pattern.compile("^\\s*(\\d{5,})\\s*$");

    private final Activity activity;
    private final WebView webView;
    private final File cacheDir;
    private final File importDir;
    private final ExecutorService executor = Executors.newFixedThreadPool(3);

    QiyinBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.cacheDir = new File(activity.getFilesDir(), "songcache");
        this.importDir = new File(activity.getFilesDir(), "imports");
    }

    @JavascriptInterface
    public boolean available() {
        return true;
    }

    @JavascriptInterface
    public void resolvePlaylist(final String shareText) {
        executor.execute(() -> {
            String result;
            try {
                result = doResolve(shareText);
            } catch (Exception exception) {
                result = error(friendly(exception));
            }
            deliver("onPlaylist", result);
        });
    }

    @JavascriptInterface
    public void downloadAudio(final String key, final String url) {
        executor.execute(() -> {
            String result;
            try {
                result = doDownload(key, url);
            } catch (Exception exception) {
                JSONObject failure = new JSONObject();
                try {
                    failure.put("ok", false);
                    failure.put("key", key);
                    failure.put("error", friendly(exception));
                } catch (Exception ignored) {
                    // JSON 组装失败时保持空对象，前端会提示缓存失败
                }
                result = failure.toString();
            }
            deliver("onCached", result);
        });
    }

    @JavascriptInterface
    public String cacheInfo() {
        long bytes = 0;
        int files = 0;
        File[] list = cacheDir.listFiles();
        if (list != null) {
            for (File file : list) {
                if (file.isFile() && file.getName().endsWith(".mp3")) {
                    bytes += file.length();
                    files += 1;
                }
            }
        }
        return "{\"bytes\":" + bytes + ",\"files\":" + files + "}";
    }

    @JavascriptInterface
    public void clearCache() {
        File[] list = cacheDir.listFiles();
        if (list == null) return;
        for (File file : list) {
            if (file.isFile()) file.delete();
        }
    }

    @JavascriptInterface
    public boolean exists(String path) {
        if (path == null || path.isEmpty()) return false;
        return new File(stripFileScheme(path)).isFile();
    }

    @JavascriptInterface
    public void deleteAudio(String path) {
        if (path == null || path.isEmpty()) return;
        try {
            File file = new File(stripFileScheme(path));
            if (file.getCanonicalPath().startsWith(importDir.getCanonicalPath())) {
                file.delete();
            }
        } catch (IOException ignored) {
            // 路径异常时保持文件不动
        }
    }

    @JavascriptInterface
    public void importAudio() {
        activity.runOnUiThread(() -> {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("audio/*");
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
                activity.startActivityForResult(intent, IMPORT_REQUEST);
            } catch (Exception exception) {
                deliver("onImported", error("无法打开文件选择器"));
            }
        });
    }

    void handleImportResult(Intent data) {
        executor.execute(() -> {
            String result;
            try {
                result = doImport(data);
            } catch (Exception exception) {
                result = error("导入失败：" + friendly(exception));
            }
            deliver("onImported", result);
        });
    }

    @JavascriptInterface
    public void searchCc(final String clientId, final String query) {
        executor.execute(() -> {
            String result;
            try {
                result = doSearchCc(clientId, query);
            } catch (Exception exception) {
                result = error(friendly(exception));
            }
            deliver("onCcResults", result);
        });
    }

    void shutdown() {
        executor.shutdownNow();
    }

    private String doImport(Intent data) throws Exception {
        List<Uri> uris = new ArrayList<>();
        if (data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int index = 0; index < clip.getItemCount(); index++) {
                    Uri uri = clip.getItemAt(index).getUri();
                    if (uri != null) uris.add(uri);
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
        }
        if (uris.isEmpty()) return error("没有选择文件");

        importDir.mkdirs();
        JSONArray tracks = new JSONArray();
        String lastError = "";
        for (Uri uri : uris) {
            try {
                tracks.put(importOne(uri));
            } catch (Exception exception) {
                lastError = friendly(exception);
            }
        }
        if (tracks.length() == 0) {
            return error(lastError.isEmpty() ? "导入失败，请选择 MP3、FLAC、M4A 等音频文件" : lastError);
        }
        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("tracks", tracks);
        return result.toString();
    }

    private JSONObject importOne(Uri uri) throws Exception {
        String displayName = queryName(uri);
        String extension = extensionOf(displayName);
        ContentResolver resolver = activity.getContentResolver();
        if (!isAudioExtension(extension)) {
            extension = extensionFromMime(resolver.getType(uri));
        }
        if (!isAudioExtension(extension)) throw new IOException("不支持的文件格式：" + displayName);

        InputStream input = resolver.openInputStream(uri);
        if (input == null) throw new IOException("无法读取文件：" + displayName);

        String id = "local-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        File target = new File(importDir, id + "." + extension);
        long size;
        try {
            size = copy(input, target, MAX_IMPORT_BYTES);
        } catch (Exception exception) {
            target.delete();
            throw exception;
        }
        if (size <= 0) {
            target.delete();
            throw new IOException("文件为空：" + displayName);
        }

        String base = displayName.replaceFirst("\\.[^.]+$", "").trim();
        JSONObject item = new JSONObject();
        item.put("id", id);
        item.put("title", base.isEmpty() ? "本地音频" : base);
        item.put("artist", "本地导入");
        item.put("duration", readDuration(target));
        item.put("size", size);
        item.put("format", extension);
        item.put("src", "file://" + target.getAbsolutePath());
        return item;
    }

    private String queryName(Uri uri) {
        String name = null;
        Cursor cursor = null;
        try {
            cursor = activity.getContentResolver().query(uri, null, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) name = cursor.getString(index);
            }
        } catch (Exception ignored) {
            // 某些提供方不支持查询，回退到路径名
        } finally {
            if (cursor != null) cursor.close();
        }
        if (name == null || name.trim().isEmpty()) {
            name = uri.getLastPathSegment();
            if (name != null) name = name.substring(name.lastIndexOf('/') + 1);
        }
        return name == null || name.trim().isEmpty() ? "本地音频" : name;
    }

    private static int readDuration(File file) {
        MediaMetadataRetriever retriever = new MediaMetadataRetriever();
        try {
            retriever.setDataSource(file.getAbsolutePath());
            String value = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (value == null) return 0;
            return (int) Math.round(Long.parseLong(value) / 1000.0);
        } catch (Exception exception) {
            return 0;
        } finally {
            try {
                retriever.release();
            } catch (Exception ignored) {
                // 释放失败无需中断导入
            }
        }
    }

    private static String extensionOf(String name) {
        if (name == null) return "";
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return "";
        return name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static boolean isAudioExtension(String extension) {
        if (extension == null) return false;
        for (String allowed : AUDIO_EXTENSIONS) {
            if (allowed.equals(extension)) return true;
        }
        return false;
    }

    private static String extensionFromMime(String mime) {
        if (mime == null) return "";
        switch (mime.toLowerCase(Locale.ROOT)) {
            case "audio/mpeg":
            case "audio/mp3":
                return "mp3";
            case "audio/flac":
            case "audio/x-flac":
                return "flac";
            case "audio/mp4":
            case "audio/x-m4a":
            case "audio/m4a":
                return "m4a";
            case "audio/aac":
                return "aac";
            case "audio/wav":
            case "audio/x-wav":
            case "audio/wave":
                return "wav";
            case "audio/ogg":
            case "application/ogg":
                return "ogg";
            case "audio/opus":
                return "opus";
            default:
                return "";
        }
    }

    private static String stripFileScheme(String path) {
        return path.startsWith("file://") ? path.substring(7) : path;
    }

    private static String sanitizeKey(String key) {
        String safe = key == null ? "" : key.replaceAll("[^A-Za-z0-9_-]", "_");
        return safe.isEmpty() ? "audio" : safe;
    }

    private String doSearchCc(String clientId, String query) throws Exception {
        if (clientId == null || clientId.trim().isEmpty()) return error("请先填写 Jamendo Client ID");
        String keyword = query == null || query.trim().isEmpty() ? "piano" : query.trim();
        String url = "https://api.jamendo.com/v3.0/tracks/?client_id="
                + URLEncoder.encode(clientId.trim(), "UTF-8")
                + "&format=json&limit=20&include=licenses&audioformat=mp32&imagesize=300&search="
                + URLEncoder.encode(keyword, "UTF-8");
        JSONObject data = fetchJson(url);
        JSONObject headers = data.optJSONObject("headers");
        if (headers != null && headers.optInt("status", 200) != 200) {
            String message = headers.optString("error_message", "请求被拒绝");
            return error("Jamendo 返回错误：" + message);
        }
        JSONArray results = data.optJSONArray("results");
        JSONArray tracks = new JSONArray();
        if (results != null) {
            for (int index = 0; index < results.length(); index++) {
                JSONObject item = results.optJSONObject(index);
                if (item == null) continue;
                String audio = item.optString("audio", "");
                if (audio.isEmpty()) continue;
                JSONObject track = new JSONObject();
                track.put("id", item.optString("id"));
                track.put("title", item.optString("name", "未命名曲目"));
                track.put("artist", item.optString("artist_name", "未知音乐人"));
                track.put("duration", item.optInt("duration", 0));
                track.put("audio", audio);
                track.put("license", item.optString("license_ccurl", ""));
                track.put("shareUrl", item.optString("shareurl", ""));
                tracks.put(track);
            }
        }
        if (tracks.length() == 0) return error("没有找到 CC 音乐，换个关键词试试");
        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("tracks", tracks);
        return result.toString();
    }

    private String doResolve(String shareText) throws Exception {
        String playlistId = extractPlaylistId(shareText);
        if (playlistId == null) return error("没有识别到歌单 ID，请粘贴完整的分享链接");

        JSONObject data = fetchJson("https://music.163.com/api/v6/playlist/detail?id="
                + playlistId + "&n=1000&s=0");
        JSONObject playlist = data.optJSONObject("playlist");
        if (playlist == null) {
            data = fetchJson("https://music.163.com/api/playlist/detail?id=" + playlistId);
            playlist = data.optJSONObject("playlist");
        }
        if (playlist == null) return error("无法读取该歌单，请确认链接有效且歌单公开");

        JSONArray sourceTracks = playlist.optJSONArray("tracks");
        JSONArray tracks = new JSONArray();
        if (sourceTracks != null) {
            for (int index = 0; index < sourceTracks.length(); index++) {
                JSONObject track = sourceTracks.optJSONObject(index);
                if (track == null || track.optLong("id", 0L) == 0L) continue;
                JSONObject item = new JSONObject();
                item.put("id", String.valueOf(track.optLong("id")));
                item.put("title", track.optString("name", "未知歌曲"));
                item.put("artist", readArtists(track));
                item.put("album", readAlbum(track));
                long milliseconds = track.optLong("dt", track.optLong("duration", 0L));
                item.put("duration", milliseconds > 0 ? Math.round(milliseconds / 1000.0) : 0);
                int fee = track.optInt("fee", 0);
                item.put("vip", fee == 1 || fee == 4);
                tracks.put(item);
            }
        }
        if (tracks.length() == 0) return error("歌单里没有可读取的歌曲");

        JSONObject summary = new JSONObject();
        summary.put("id", playlistId);
        summary.put("name", playlist.optString("name", "未命名歌单"));
        summary.put("cover", playlist.optString("coverImgUrl", ""));
        summary.put("trackCount", playlist.optInt("trackCount", tracks.length()));
        summary.put("tracks", tracks);

        JSONObject result = new JSONObject();
        result.put("ok", true);
        result.put("playlist", summary);
        return result.toString();
    }

    private String doDownload(String key, String url) throws Exception {
        String safeKey = sanitizeKey(key);
        if (url == null || !url.startsWith("http")) throw new IOException("音频地址无效");
        cacheDir.mkdirs();
        File target = new File(cacheDir, safeKey + ".mp3");
        if (target.exists() && target.length() >= MIN_AUDIO_BYTES) {
            return cachedResult(safeKey, key, target.length());
        }

        HttpURLConnection connection = open(url, 6);
        long total;
        try {
            int code = connection.getResponseCode();
            if (code != 200) throw new IOException("该曲目可能受版权限制（HTTP " + code + "）");
            String contentType = connection.getContentType();
            if (contentType != null && contentType.toLowerCase().contains("text/html")) {
                throw new IOException("该曲目需要 VIP 或暂无版权");
            }
            File temp = new File(cacheDir, safeKey + ".part");
            total = copy(connection.getInputStream(), temp, MAX_AUDIO_BYTES);
            if (total < MIN_AUDIO_BYTES) {
                temp.delete();
                throw new IOException("该曲目需要 VIP 或暂无版权");
            }
            if (target.exists()) target.delete();
            if (!temp.renameTo(target)) {
                temp.delete();
                throw new IOException("缓存写入失败，请检查存储空间");
            }
        } finally {
            connection.disconnect();
        }
        return cachedResult(safeKey, key, total);
    }

    private String cachedResult(String safeKey, String key, long bytes) {
        JSONObject result = new JSONObject();
        try {
            File file = new File(cacheDir, safeKey + ".mp3");
            result.put("ok", true);
            result.put("key", key);
            result.put("path", "file://" + file.getAbsolutePath());
            result.put("bytes", bytes);
        } catch (Exception ignored) {
            // 字段写入失败时返回空对象，前端按失败处理
        }
        return result.toString();
    }

    private static String readArtists(JSONObject track) {
        JSONArray artists = track.optJSONArray("ar");
        if (artists == null) artists = track.optJSONArray("artists");
        if (artists == null) return "未知歌手";
        StringBuilder builder = new StringBuilder();
        for (int index = 0; index < artists.length(); index++) {
            JSONObject artist = artists.optJSONObject(index);
            if (artist == null) continue;
            String name = artist.optString("name", "");
            if (name.isEmpty()) continue;
            if (builder.length() > 0) builder.append(" / ");
            builder.append(name);
        }
        return builder.length() > 0 ? builder.toString() : "未知歌手";
    }

    private static String readAlbum(JSONObject track) {
        JSONObject album = track.optJSONObject("al");
        if (album == null) album = track.optJSONObject("album");
        return album == null ? "" : album.optString("name", "");
    }

    private String extractPlaylistId(String shareText) throws Exception {
        if (shareText == null || shareText.trim().isEmpty()) return null;
        Matcher urlMatcher = URL_PATTERN.matcher(shareText);
        String url = urlMatcher.find() ? urlMatcher.group() : null;
        if (url != null && (url.contains("163cn.tv") || url.contains("163cn.com"))) {
            url = followRedirects(url);
        }
        String source = url != null ? url : shareText;
        Matcher idMatcher = ID_PATTERN.matcher(source);
        if (idMatcher.find()) return idMatcher.group(1);
        Matcher pathMatcher = PATH_PATTERN.matcher(source);
        if (pathMatcher.find()) return pathMatcher.group(1);
        Matcher digitsMatcher = DIGITS_PATTERN.matcher(shareText);
        if (digitsMatcher.find()) return digitsMatcher.group(1);
        return null;
    }

    private String followRedirects(String url) throws Exception {
        String current = url;
        for (int hop = 0; hop < 5; hop++) {
            HttpURLConnection connection = (HttpURLConnection) new URL(current).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setRequestProperty("User-Agent", UA);
            int code = connection.getResponseCode();
            String location = connection.getHeaderField("Location");
            connection.disconnect();
            if (code >= 300 && code < 400 && location != null) {
                current = new URL(new URL(current), location).toString();
            } else {
                return current;
            }
        }
        return current;
    }

    private JSONObject fetchJson(String url) throws Exception {
        HttpURLConnection connection = open(url, 5);
        try {
            int code = connection.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            InputStream input = connection.getInputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = input.read(chunk)) != -1) buffer.write(chunk, 0, read);
            input.close();
            return new JSONObject(new String(buffer.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            connection.disconnect();
        }
    }

    private HttpURLConnection open(String url, int redirectsLeft) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(25000);
        connection.setRequestProperty("User-Agent", UA);
        connection.setRequestProperty("Accept", "*/*");
        String host = new URL(url).getHost();
        if (host != null && (host.endsWith("163.com") || host.endsWith("126.net"))) {
            connection.setRequestProperty("Referer", "https://music.163.com/");
            connection.setRequestProperty("Cookie", "os=pc; appver=8.7.01;");
        }
        connection.connect();
        int code = connection.getResponseCode();
        if (code >= 300 && code < 400 && redirectsLeft > 0) {
            String location = connection.getHeaderField("Location");
            connection.disconnect();
            if (location != null) {
                String next = location.startsWith("http")
                        ? location
                        : new URL(new URL(url), location).toString();
                return open(next, redirectsLeft - 1);
            }
        }
        return connection;
    }

    private static long copy(InputStream input, File target, long maxBytes) throws IOException {
        FileOutputStream output = new FileOutputStream(target);
        long total = 0;
        try {
            byte[] buffer = new byte[16384];
            int read;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > maxBytes) throw new IOException("文件过大，已停止导入");
                output.write(buffer, 0, read);
            }
            output.flush();
        } finally {
            output.close();
            input.close();
        }
        return total;
    }

    private void deliver(String callback, String json) {
        String script = "window.QiyinNativeCallback && window.QiyinNativeCallback."
                + callback + "(" + JSONObject.quote(json) + ");";
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    private static String friendly(Exception exception) {
        if (exception instanceof UnknownHostException || exception instanceof ConnectException) {
            return "网络不可用，请检查手机网络后重试";
        }
        String message = exception.getMessage();
        return message == null || message.isEmpty() ? "操作失败，请稍后重试" : message;
    }

    private static String error(String message) {
        JSONObject result = new JSONObject();
        try {
            result.put("ok", false);
            result.put("error", message);
        } catch (Exception ignored) {
            // 忽略：调用方会按失败处理
        }
        return result.toString();
    }
}
