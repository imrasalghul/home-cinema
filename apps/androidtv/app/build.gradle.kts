plugins {
    id("com.android.application")
}

val homeCinemaUrl = providers.gradleProperty("homeCinemaUrl").orElse("").get().trim()
val escapedHomeCinemaUrl = homeCinemaUrl.replace("\\", "\\\\").replace("\"", "\\\"")

android {
    namespace = "com.alghulventures.tvcinema"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.alghulventures.tvcinema"
        minSdk = 29
        targetSdk = 32
        versionCode = 2
        versionName = "0.1.1"
        buildConfigField("String", "HOME_CINEMA_URL", "\"$escapedHomeCinemaUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }
}
