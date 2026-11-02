package com.campfire.wanttoplay

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Self-updater: finds the latest GitHub release, downloads its APK into the cache and hands it to Android's installer. */
object Updater {
    private const val LATEST = "https://api.github.com/repos/Campfirecrucifix/want-to-play/releases/latest"
    const val ALLOWED = "https://github.com/Campfirecrucifix/want-to-play/releases/download/"

    data class Release(val version: Int, val apkUrl: String)

    fun latest(): Release? = try {
        val (code, body) = httpGet(LATEST)
        if (code != 200) null else {
            val j = JSONObject(String(body))
            val v = j.getString("tag_name").filter { it.isDigit() }.toInt()
            val assets = j.getJSONArray("assets")
            (0 until assets.length()).map { assets.getJSONObject(it) }
                .firstOrNull { it.getString("name").endsWith(".apk") }
                ?.let { Release(v, it.getString("browser_download_url")) }
        }
    } catch (e: Exception) { null }

    private fun dir(ctx: Context) = File(ctx.cacheDir, "updates").apply { mkdirs() }
    fun apkFile(ctx: Context, version: Int) = File(dir(ctx), "WantToPlay-v$version.apk")

    /** Downloads (or reuses an already-downloaded) APK. progress gets 0..100. */
    fun download(ctx: Context, url: String, version: Int, progress: (Int) -> Unit = {}): File {
        require(url.startsWith(ALLOWED)) { "Untrusted update URL" }
        val out = apkFile(ctx, version)
        if (out.exists() && out.length() > 0) { progress(100); return out }
        val tmp = File(out.path + ".part")
        val c = URL(url).openConnection() as HttpURLConnection   // follows GitHub's https redirect
        c.connectTimeout = 15000; c.readTimeout = 60000
        try {
            if (c.responseCode != 200) throw Exception("HTTP ${c.responseCode}")
            val total = c.contentLengthLong
            var done = 0L; var last = -1
            c.inputStream.use { inp -> tmp.outputStream().use { o ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = inp.read(buf); if (n < 0) break
                    o.write(buf, 0, n); done += n
                    val pct = if (total > 0) (done * 100 / total).toInt() else 0
                    if (pct != last) { last = pct; progress(pct) }
                }
            } }
            if (total > 0 && done != total) throw Exception("Download incomplete")
            tmp.renameTo(out)
            return out
        } finally { c.disconnect(); tmp.delete() }
    }

    fun installIntent(ctx: Context, apk: File): Intent =
        Intent(Intent.ACTION_VIEW)
            .setDataAndType(FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", apk), "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)

    /** Remove APKs for versions we're already running. */
    fun cleanup(ctx: Context) = dir(ctx).listFiles()?.forEach {
        val v = it.name.filter { ch -> ch.isDigit() }.toIntOrNull() ?: 0
        if (v <= BuildConfig.VERSION_CODE) it.delete()
    }
}
