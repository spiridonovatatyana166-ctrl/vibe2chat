package com.vibechat.app

import java.net.URI

/**
 * Проверка и нормализация адреса сервера. Без зависимостей от Android,
 * поэтому покрыта обычными JVM-тестами.
 */
object ServerUrl {

    sealed interface Result {
        data class Ok(val url: String, val origin: String) : Result
        data class Error(val reason: Reason) : Result
    }

    enum class Reason { EMPTY, NOT_HTTPS, INVALID }

    fun parse(input: String?): Result {
        var raw = input?.trim().orEmpty()
        if (raw.isEmpty()) return Result.Error(Reason.EMPTY)
        // Пользователь ввёл просто домен — подставляем https://
        if (!raw.contains("://")) raw = "https://$raw"
        val uri = try {
            URI(raw)
        } catch (e: Exception) {
            return Result.Error(Reason.INVALID)
        }
        if (!uri.scheme.equals("https", ignoreCase = true)) return Result.Error(Reason.NOT_HTTPS)
        val host = uri.host?.lowercase()
        if (host.isNullOrEmpty() || host.contains(' ') || uri.userInfo != null) return Result.Error(Reason.INVALID)
        val port = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
        val origin = "https://$host$port"
        return Result.Ok(url = "$origin/", origin = origin)
    }

    /** Origin произвольного URL или null, если его нельзя разобрать. */
    fun originOf(url: String?): String? {
        if (url.isNullOrEmpty()) return null
        return try {
            val uri = URI(url)
            val scheme = uri.scheme?.lowercase() ?: return null
            val host = uri.host?.lowercase() ?: return null
            val defaultPort = if (scheme == "https") 443 else if (scheme == "http") 80 else -1
            val port = if (uri.port == -1 || uri.port == defaultPort) "" else ":${uri.port}"
            "$scheme://$host$port"
        } catch (e: Exception) {
            null
        }
    }

    /** Ссылка ведёт на наш сервер (остальные открываются во внешнем браузере). */
    fun isSameOrigin(url: String?, serverOrigin: String): Boolean = originOf(url) == serverOrigin
}
