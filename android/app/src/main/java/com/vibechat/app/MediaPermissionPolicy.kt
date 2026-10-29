package com.vibechat.app

/**
 * Какие ресурсы страницы можно разрешить. Камеру и микрофон получает только
 * наш сервер; всё остальное (MIDI, защищённый контент и т. п.) запрещено.
 */
object MediaPermissionPolicy {
    const val VIDEO = "android.webkit.resource.VIDEO_CAPTURE"
    const val AUDIO = "android.webkit.resource.AUDIO_CAPTURE"
    const val CAMERA_PERMISSION = "android.permission.CAMERA"
    const val MIC_PERMISSION = "android.permission.RECORD_AUDIO"

    data class Decision(
        val grant: List<String>,
        /** Нужные системные разрешения Android, которых пока нет. */
        val missingAndroidPermissions: List<String>,
    )

    fun decide(
        requestOrigin: String?,
        serverOrigin: String,
        requestedResources: List<String>,
        hasCamera: Boolean,
        hasMicrophone: Boolean,
    ): Decision {
        if (ServerUrl.originOf(requestOrigin) != serverOrigin) return Decision(emptyList(), emptyList())
        val wanted = requestedResources.filter { it == VIDEO || it == AUDIO }
        val missing = buildList {
            if (VIDEO in wanted && !hasCamera) add(CAMERA_PERMISSION)
            if (AUDIO in wanted && !hasMicrophone) add(MIC_PERMISSION)
        }
        return Decision(wanted, missing)
    }

    /** После ответа пользователя: выдаём странице только то, что разрешила система. */
    fun afterSystemPrompt(wanted: List<String>, hasCamera: Boolean, hasMicrophone: Boolean): List<String> =
        wanted.filter { (it == VIDEO && hasCamera) || (it == AUDIO && hasMicrophone) }
}
