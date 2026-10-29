package com.vibechat.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerUrlTest {

    @Test
    fun `домен без схемы дополняется https`() {
        val r = ServerUrl.parse(" vibechat.example.com ") as ServerUrl.Result.Ok
        assertEquals("https://vibechat.example.com/", r.url)
        assertEquals("https://vibechat.example.com", r.origin)
    }

    @Test
    fun `путь отбрасывается, нестандартный порт сохраняется`() {
        val r = ServerUrl.parse("https://Chat.Example.com:8443/rules?x=1") as ServerUrl.Result.Ok
        assertEquals("https://chat.example.com:8443", r.origin)
    }

    @Test
    fun `http и пустой адрес отклоняются`() {
        assertEquals(ServerUrl.Result.Error(ServerUrl.Reason.NOT_HTTPS), ServerUrl.parse("http://example.com"))
        assertEquals(ServerUrl.Result.Error(ServerUrl.Reason.EMPTY), ServerUrl.parse("  "))
        assertEquals(ServerUrl.Result.Error(ServerUrl.Reason.INVALID), ServerUrl.parse("https://user@evil.com"))
        assertEquals(ServerUrl.Result.Error(ServerUrl.Reason.INVALID), ServerUrl.parse("https://"))
    }

    @Test
    fun `сравнение origin`() {
        assertTrue(ServerUrl.isSameOrigin("https://chat.example.com:443/admin", "https://chat.example.com"))
        assertFalse(ServerUrl.isSameOrigin("https://chat.example.com.evil.com/", "https://chat.example.com"))
        assertFalse(ServerUrl.isSameOrigin("mailto:support@example.com", "https://chat.example.com"))
    }
}

class MediaPermissionPolicyTest {
    private val server = "https://chat.example.com"
    private val both = listOf(MediaPermissionPolicy.VIDEO, MediaPermissionPolicy.AUDIO)

    @Test
    fun `чужой сайт не получает камеру`() {
        val d = MediaPermissionPolicy.decide("https://evil.com/", server, both, hasCamera = true, hasMicrophone = true)
        assertTrue(d.grant.isEmpty())
    }

    @Test
    fun `наш сервер получает камеру и микрофон, лишние ресурсы отбрасываются`() {
        val d = MediaPermissionPolicy.decide(
            "https://chat.example.com/",
            server,
            both + "android.webkit.resource.MIDI_SYSEX",
            hasCamera = true,
            hasMicrophone = true,
        )
        assertEquals(both, d.grant)
        assertTrue(d.missingAndroidPermissions.isEmpty())
    }

    @Test
    fun `без системных разрешений их нужно запросить`() {
        val d = MediaPermissionPolicy.decide(server, server, both, hasCamera = false, hasMicrophone = true)
        assertEquals(listOf(MediaPermissionPolicy.CAMERA_PERMISSION), d.missingAndroidPermissions)
    }

    @Test
    fun `после отказа в камере странице выдаётся только микрофон`() {
        val granted = MediaPermissionPolicy.afterSystemPrompt(both, hasCamera = false, hasMicrophone = true)
        assertEquals(listOf(MediaPermissionPolicy.AUDIO), granted)
    }
}
