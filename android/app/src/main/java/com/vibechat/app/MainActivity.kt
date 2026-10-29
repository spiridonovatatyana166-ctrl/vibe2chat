package com.vibechat.app

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast

/**
 * Единственный экран: веб-интерфейс VibeChat в WebView с нативной обработкой
 * разрешений на камеру и микрофон, полноэкранного режима, ошибок сети и
 * кнопки «Назад». Вся логика видеочата (WebRTC, подбор, чат) — та же, что на сайте.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView
    private lateinit var loading: ProgressBar
    private lateinit var errorView: View
    private lateinit var errorText: TextView
    private lateinit var setupView: View
    private lateinit var serverInput: EditText
    private lateinit var setupError: TextView

    private var serverOrigin: String? = null
    private var mainFrameFailed = false

    /** Запрос страницы, ждущий ответа на системный диалог разрешений. */
    private var pendingPermission: PermissionRequest? = null
    private var pendingResources: List<String> = emptyList()

    private val chrome = Chrome()
    private var customView: View? = null
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        // Во время видеозвонка экран не гаснет, кнопки громкости управляют разговором.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        volumeControlStream = AudioManager.STREAM_VOICE_CALL

        webView = findViewById(R.id.webview)
        loading = findViewById(R.id.loading)
        errorView = findViewById(R.id.error_view)
        errorText = findViewById(R.id.error_text)
        setupView = findViewById(R.id.setup_view)
        serverInput = findViewById(R.id.server_input)
        setupError = findViewById(R.id.setup_error)

        findViewById<Button>(R.id.retry_button).setOnClickListener { reload() }
        findViewById<Button>(R.id.change_server_button).setOnClickListener { showSetup() }
        findViewById<Button>(R.id.connect_button).setOnClickListener { submitServer() }
        serverInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                submitServer()
                true
            } else {
                false
            }
        }

        applyWindowInsets()
        configureWebView()

        if (savedInstanceState != null) webView.restoreState(savedInstanceState)
        val url = savedServerUrl()
        if (url == null) {
            showSetup()
        } else if (savedInstanceState == null || webView.url == null) {
            openServer(url)
        } else {
            serverOrigin = ServerUrl.originOf(url)
        }
    }

    /**
     * С targetSdk 35 приложение рисуется под системными панелями (edge-to-edge),
     * поэтому отступы от статус-бара, навигации и клавиатуры задаём сами.
     */
    @Suppress("DEPRECATION")
    private fun applyWindowInsets() {
        findViewById<View>(R.id.root).setOnApplyWindowInsetsListener { v, insets ->
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val ime = insets.getInsets(WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            } else {
                v.setPadding(
                    insets.systemWindowInsetLeft,
                    insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight,
                    insets.systemWindowInsetBottom,
                )
            }
            insets
        }
    }

    // ─── Адрес сервера ───────────────────────────────────────────────────────

    private fun prefs() = getSharedPreferences("vibechat", Context.MODE_PRIVATE)

    /** Адрес из настроек, иначе — заданный при сборке. */
    private fun savedServerUrl(): String? {
        val stored = prefs().getString(KEY_SERVER, null)
        val candidate = stored ?: BuildConfig.SERVER_URL.takeIf { it.isNotEmpty() }
        return (ServerUrl.parse(candidate) as? ServerUrl.Result.Ok)?.url
    }

    private fun showSetup() {
        errorView.visibility = View.GONE
        setupView.visibility = View.VISIBLE
        serverInput.setText(prefs().getString(KEY_SERVER, null) ?: BuildConfig.SERVER_URL)
        serverInput.setSelection(serverInput.text.length)
        serverInput.requestFocus()
    }

    private fun submitServer() {
        when (val r = ServerUrl.parse(serverInput.text.toString())) {
            is ServerUrl.Result.Error -> {
                setupError.visibility = View.VISIBLE
                setupError.setText(
                    when (r.reason) {
                        ServerUrl.Reason.EMPTY -> R.string.url_error_empty
                        ServerUrl.Reason.NOT_HTTPS -> R.string.url_error_https
                        ServerUrl.Reason.INVALID -> R.string.url_error_invalid
                    },
                )
            }
            is ServerUrl.Result.Ok -> {
                setupError.visibility = View.GONE
                prefs().edit().putString(KEY_SERVER, r.url).apply()
                hideKeyboard()
                setupView.visibility = View.GONE
                webView.clearHistory()
                openServer(r.url)
            }
        }
    }

    private fun openServer(url: String) {
        serverOrigin = ServerUrl.originOf(url)
        mainFrameFailed = false
        webView.loadUrl(url)
    }

    private fun reload() {
        if (!isOnline()) {
            errorText.setText(R.string.error_offline)
            return
        }
        mainFrameFailed = false
        errorView.visibility = View.GONE
        val current = webView.url
        if (current != null && current != "about:blank") webView.reload() else savedServerUrl()?.let(::openServer)
    }

    // ─── WebView ─────────────────────────────────────────────────────────────

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, false)
        }
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Видео собеседника должно запускаться без отдельного касания.
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            setGeolocationEnabled(false)
            userAgentString = "$userAgentString VibeChatAndroid/${BuildConfig.VERSION_NAME}"
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.webViewClient = Client()
        webView.webChromeClient = chrome
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val origin = serverOrigin ?: return false
            if (ServerUrl.isSameOrigin(request.url.toString(), origin)) return false
            // Внешние ссылки (почта поддержки, сторонние сайты) — в системных приложениях.
            openExternal(request.url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            loading.visibility = View.VISIBLE
        }

        override fun onPageFinished(view: WebView, url: String?) {
            loading.visibility = View.GONE
            if (!mainFrameFailed) errorView.visibility = View.GONE
            CookieManager.getInstance().flush()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            mainFrameFailed = true
            loading.visibility = View.GONE
            errorText.setText(if (isOnline()) R.string.error_generic else R.string.error_offline)
            errorView.visibility = View.VISIBLE
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            val origin = serverOrigin
            if (origin == null) {
                request.deny()
                return
            }
            val decision = MediaPermissionPolicy.decide(
                requestOrigin = request.origin?.toString(),
                serverOrigin = origin,
                requestedResources = request.resources.toList(),
                hasCamera = has(MediaPermissionPolicy.CAMERA_PERMISSION),
                hasMicrophone = has(MediaPermissionPolicy.MIC_PERMISSION),
            )
            when {
                decision.grant.isEmpty() -> request.deny()
                decision.missingAndroidPermissions.isEmpty() -> request.grant(decision.grant.toTypedArray())
                else -> {
                    pendingPermission?.deny()
                    pendingPermission = request
                    pendingResources = decision.grant
                    requestPermissions(decision.missingAndroidPermissions.toTypedArray(), REQUEST_MEDIA)
                }
            }
        }

        override fun onPermissionRequestCanceled(request: PermissionRequest) {
            if (pendingPermission == request) pendingPermission = null
        }

        /** Полноэкранный режим видео (кнопка «Полный экран» на сайте). */
        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (customView != null) {
                callback.onCustomViewHidden()
                return
            }
            customView = view
            customViewCallback = callback
            (window.decorView as FrameLayout).addView(
                view,
                FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            setSystemBarsHidden(true)
        }

        override fun onHideCustomView() {
            val view = customView ?: return
            (window.decorView as FrameLayout).removeView(view)
            customView = null
            customViewCallback?.onCustomViewHidden()
            customViewCallback = null
            setSystemBarsHidden(false)
        }
    }

    // ─── Разрешения ──────────────────────────────────────────────────────────

    private fun has(permission: String) = checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_MEDIA) return
        val request = pendingPermission ?: return
        pendingPermission = null
        val allowed = MediaPermissionPolicy.afterSystemPrompt(
            pendingResources,
            hasCamera = has(MediaPermissionPolicy.CAMERA_PERMISSION),
            hasMicrophone = has(MediaPermissionPolicy.MIC_PERMISSION),
        )
        if (allowed.isEmpty()) {
            request.deny()
            // «Больше не спрашивать» — объясняем, где включить доступ.
            val permanentlyDenied = permissions.any { !shouldShowRequestPermissionRationale(it) && !has(it) }
            if (permanentlyDenied) showPermissionSettingsDialog()
        } else {
            request.grant(allowed.toTypedArray())
        }
    }

    private fun showPermissionSettingsDialog() {
        AlertDialog.Builder(this)
            .setMessage(R.string.permission_denied)
            .setPositiveButton(R.string.open_settings) { _, _ ->
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)),
                )
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // ─── Системное ───────────────────────────────────────────────────────────

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.external_link_failed, Toast.LENGTH_SHORT).show()
        }
    }

    private fun isOnline(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return true
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    private fun hideKeyboard() {
        getSystemService(android.view.inputmethod.InputMethodManager::class.java)
            ?.hideSoftInputFromWindow(serverInput.windowToken, 0)
    }

    @Suppress("DEPRECATION")
    private fun setSystemBarsHidden(hidden: Boolean) {
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            val controller = window.insetsController ?: return
            if (hidden) {
                controller.hide(WindowInsets.Type.systemBars())
                controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                controller.show(WindowInsets.Type.systemBars())
            }
        } else {
            window.decorView.systemUiVisibility = if (hidden) {
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
                    View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            } else {
                View.SYSTEM_UI_FLAG_VISIBLE
            }
        }
    }

    @Deprecated("Совместимость с Android 8–12; на 13+ работает так же")
    override fun onBackPressed() {
        when {
            customView != null -> chrome.onHideCustomView()
            setupView.visibility == View.VISIBLE && savedServerUrl() != null && webView.url != null ->
                setupView.visibility = View.GONE
            webView.canGoBack() -> webView.goBack()
            else -> super.onBackPressed()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onStop() {
        super.onStop()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        pendingPermission?.deny()
        pendingPermission = null
        // Уничтожение WebView закрывает WebRTC-соединения и освобождает камеру.
        webView.apply {
            stopLoading()
            loadUrl("about:blank")
            (parent as? ViewGroup)?.removeView(this)
            destroy()
        }
        super.onDestroy()
    }

    private companion object {
        const val KEY_SERVER = "server_url"
        const val REQUEST_MEDIA = 42
    }
}
