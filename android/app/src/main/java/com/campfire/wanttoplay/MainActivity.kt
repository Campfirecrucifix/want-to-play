package com.campfire.wanttoplay

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowInsets
import android.webkit.*
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

const val BASE = "https://campfirecrucifix.github.io/want-to-play/"

class MainActivity : Activity() {
    private lateinit var web: WebView

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#171A21"))
        setContentView(web)
        if (Build.VERSION.SDK_INT >= 30) web.setOnApplyWindowInsetsListener { v, ins ->
            val b = ins.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom); ins
        }
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            cacheMode = if (online()) WebSettings.LOAD_DEFAULT else WebSettings.LOAD_CACHE_ELSE_NETWORK
        }
        web.addJavascriptInterface(Bridge(this), "WTP")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, req: WebResourceRequest): WebResourceResponse? {
                val u = req.url
                if (u.toString().startsWith(BASE) && u.path?.endsWith("/__proxy") == true) return proxy(u.getQueryParameter("u"))
                return null
            }

            override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
                if (req.url.toString().startsWith(BASE)) return false
                openExternal(this@MainActivity, req.url.toString()); return true
            }
        }
        if (state == null) web.loadUrl(BASE) else web.restoreState(state)

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        RefreshWorker.schedule(this)
    }

    override fun onSaveInstanceState(out: Bundle) { super.onSaveInstanceState(out); web.saveState(out) }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed() }

    private fun online(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java)
        return cm.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }

    // Fetch Steam APIs natively so the web app isn't blocked by CORS. Only Steam hosts are allowed.
    private fun proxy(target: String?): WebResourceResponse {
        val host = target?.let { Uri.parse(it).host } ?: ""
        if (!(target!!.startsWith("https://") && (host.endsWith("steampowered.com") || host.endsWith("steamstatic.com"))))
            return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null, ByteArrayInputStream(ByteArray(0)))
        return try {
            val (code, body) = httpGet(target)
            WebResourceResponse("application/json", "utf-8", code, if (code == 200) "OK" else "Error",
                mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-store"), ByteArrayInputStream(body))
        } catch (e: Exception) {
            WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", null, ByteArrayInputStream(e.toString().toByteArray()))
        }
    }
}

fun httpGet(url: String): Pair<Int, ByteArray> {
    val c = URL(url).openConnection() as HttpURLConnection
    c.connectTimeout = 15000; c.readTimeout = 30000
    c.setRequestProperty("User-Agent", "WantToPlay/${BuildConfig.VERSION_CODE} (Android)")
    return try {
        val code = c.responseCode
        code to ((if (code < 400) c.inputStream else c.errorStream)?.use { it.readBytes() } ?: ByteArray(0))
    } finally { c.disconnect() }
}

fun openExternal(ctx: Context, url: String) {
    try { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (_: Exception) {}
}

class Bridge(private val ctx: Context) {
    @JavascriptInterface fun shellVersion(): Int = BuildConfig.VERSION_CODE
    @JavascriptInterface fun openExternal(url: String) = openExternal(ctx, url)
    @JavascriptInterface fun setWatch(json: String) = RefreshWorker.setWatch(ctx, json)
    @JavascriptInterface fun share(text: String) {
        ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Export list")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
