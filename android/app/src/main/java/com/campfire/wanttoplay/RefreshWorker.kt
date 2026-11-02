package com.campfire.wanttoplay

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.*
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.*
import java.util.concurrent.TimeUnit

/** Background check: every ~12h re-fetch watched games from Steam and notify when a status changes. */
class RefreshWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    companion object {
        private const val PREFS = "wtp"
        private const val CHANNEL = "status"

        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<RefreshWorker>(12, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("refresh", ExistingPeriodicWorkPolicy.KEEP, req)
        }

        @Synchronized fun setWatch(ctx: Context, json: String) =
            ctx.getSharedPreferences(PREFS, 0).edit().putString("watch", json).apply()

        /** MUST stay identical to statusKey() in web/app.js */
        fun statusKey(it: JSONObject): String {
            val r = it.optJSONObject("release") ?: JSONObject()
            val soon = r.optBoolean("is_coming_soon") || it.optBoolean("is_coming_soon")
            val ea = r.optBoolean("is_early_access") || it.optBoolean("is_early_access")
            val demo = (it.optJSONObject("related_items")?.optJSONArray("demo_appid")?.length() ?: 0) > 0
            val ts = r.optLong("steam_release_date", 0)
            val base = if (soon) "${if (ea) "soonEA" else "soon"}|${r.optString("coming_soon_display")}|${if (ts > 0) ts else ""}|${r.optString("custom_release_date_message")}"
                       else if (ea) "ea" else "out"
            return base + if (demo) "|demo" else ""
        }

        fun describe(it: JSONObject): String {
            val r = it.optJSONObject("release") ?: JSONObject()
            val soon = r.optBoolean("is_coming_soon") || it.optBoolean("is_coming_soon")
            val ea = r.optBoolean("is_early_access") || it.optBoolean("is_early_access")
            val ts = r.optLong("steam_release_date", 0) * 1000
            val demo = (it.optJSONObject("related_items")?.optJSONArray("demo_appid")?.length() ?: 0) > 0
            val s = when {
                soon && ts > 0 && r.optString("coming_soon_display") != "text_tba" ->
                    "Release date: " + SimpleDateFormat("MMM d, yyyy", Locale.getDefault()).format(Date(ts)) + if (ea) " (Early Access)" else ""
                soon -> "Release: " + r.optString("custom_release_date_message").ifEmpty { "TBA" }
                ea -> "Now in Early Access!"
                else -> "Released!"
            }
            return s + if (demo) " · Demo available" else ""
        }
    }

    override fun doWork(): Result {
        checkAppUpdate()
        return checkGames()
    }

    /** New release? Pre-download it so tapping the notification goes straight to the installer. */
    private fun checkAppUpdate() {
        val ctx = applicationContext
        val prefs = ctx.getSharedPreferences(PREFS, 0)
        val rel = Updater.latest() ?: return
        if (rel.version <= BuildConfig.VERSION_CODE || prefs.getInt("updateNotified", 0) >= rel.version) return
        val canInstall = ctx.packageManager.canRequestPackageInstalls()
        val intent = if (canInstall) {
            try { Updater.installIntent(ctx, Updater.download(ctx, rel.apkUrl, rel.version)) } catch (e: Exception) { return }
        } else Intent(ctx, MainActivity::class.java)
        notify(-1, "Want to Play update ready", if (canInstall) "Tap to install v${rel.version}" else "Open the app and tap Update (v${rel.version})", intent)
        prefs.edit().putInt("updateNotified", rel.version).apply()
    }

    private fun checkGames(): Result {
        val prefs = applicationContext.getSharedPreferences(PREFS, 0)
        val original = prefs.getString("watch", "[]")
        val watch = try { JSONArray(original) } catch (e: Exception) { return Result.success() }
        if (watch.length() == 0) return Result.success()
        val entries = (0 until watch.length()).map { watch.getJSONObject(it) }
        val fresh = HashMap<Int, JSONObject>()
        try {
            for (chunk in entries.chunked(40)) {
                val ids = JSONArray(chunk.map { JSONObject().put("appid", it.getInt("appid")) })
                val input = JSONObject()
                    .put("ids", ids)
                    .put("context", JSONObject().put("language", "english").put("country_code", "US"))
                    .put("data_request", JSONObject().put("include_release", true).put("include_basic_info", true))
                val (code, body) = httpGet("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=" + URLEncoder.encode(input.toString(), "UTF-8"))
                if (code != 200) return Result.retry()
                val items = JSONObject(String(body)).getJSONObject("response").optJSONArray("store_items") ?: JSONArray()
                for (i in 0 until items.length()) items.getJSONObject(i).let { if (it.optInt("success") == 1) fresh[it.getInt("appid")] = it }
            }
        } catch (e: Exception) { return Result.retry() }

        var n = 0
        for (e in entries) {
            val it = fresh[e.getInt("appid")] ?: continue
            val key = statusKey(it)
            if (key != e.optString("key")) {
                notify(e.getInt("appid"), e.optString("name"), describe(it)); n++
                e.put("key", key)
            }
        }
        // Only write if the web app hasn't replaced the list meanwhile
        if (n > 0) synchronized(Companion) {
            if (prefs.getString("watch", "") == original) prefs.edit().putString("watch", JSONArray(entries).toString()).apply()
        }
        return Result.success()
    }

    private fun notify(id: Int, title: String, text: String, intent: Intent = Intent(applicationContext, MainActivity::class.java)) {
        val ctx = applicationContext
        if (Build.VERSION.SDK_INT >= 33 && ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Game status changes", NotificationManager.IMPORTANCE_DEFAULT))
        val pi = PendingIntent.getActivity(ctx, id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        nm.notify(id, NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(android.R.drawable.star_on)
            .setContentTitle(title).setContentText(text)
            .setContentIntent(pi).setAutoCancel(true).build())
    }
}
