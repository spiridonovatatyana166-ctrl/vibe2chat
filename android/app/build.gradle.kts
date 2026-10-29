import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

fun prop(name: String, default: String = ""): String =
    (project.findProperty(name) as String?)?.trim()?.takeIf { it.isNotEmpty() }
        // vibechatServerUrl → VIBECHAT_SERVER_URL (удобно для CI)
        ?: System.getenv(name.replace(Regex("([A-Z])"), "_$1").uppercase())?.trim()?.takeIf { it.isNotEmpty() }
        ?: default

val serverUrl = prop("vibechatServerUrl")
require(serverUrl.isEmpty() || serverUrl.startsWith("https://")) {
    "vibechatServerUrl должен начинаться с https:// (камера в WebView работает только по HTTPS)"
}

// Подпись релиза: android/keystore.properties (не коммитится) или переменные окружения CI.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun signing(key: String, env: String): String? =
    keystoreProps.getProperty(key) ?: System.getenv(env)?.takeIf { it.isNotEmpty() }

val releaseStoreFile = signing("storeFile", "VIBECHAT_KEYSTORE_PATH")

android {
    namespace = "com.vibechat.app"
    compileSdk = 35

    defaultConfig {
        applicationId = prop("vibechatApplicationId", "com.vibechat.app")
        minSdk = 26
        targetSdk = 35
        versionCode = prop("vibechatVersionCode", "1").toInt()
        versionName = prop("vibechatVersionName", "1.0.0")
        buildConfigField("String", "SERVER_URL", "\"$serverUrl\"")
        resValue("string", "app_name", prop("vibechatAppName", "VibeChat"))
    }

    signingConfigs {
        if (releaseStoreFile != null) {
            create("release") {
                storeFile = file(releaseStoreFile)
                storePassword = signing("storePassword", "VIBECHAT_KEYSTORE_PASSWORD")
                keyAlias = signing("keyAlias", "VIBECHAT_KEY_ALIAS")
                keyPassword = signing("keyPassword", "VIBECHAT_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
