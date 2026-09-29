# Home Cinema for Android TV

The Android TV app is a small native shell for Home Cinema. It opens the web app in Android System WebView, forwards remote-control input, and supports Android TV devices running Android 10 (API 29) or newer. The website provides the interface, account sign-in, and media playback.

## Configure your server

The app source does not contain a server URL. Set the Gradle project property `homeCinemaUrl` to the HTTPS address of the Home Cinema server you want this app to open. HTTPS is required; the app rejects insecure HTTP addresses and invalid TLS certificates.

From PowerShell at the repository root, build a debug APK and pass your server address as a Gradle property:

```powershell
cd apps/androidtv
.\gradlew.bat assembleDebug "-PhomeCinemaUrl=https://home-cinema.example.com"
```

Replace `https://home-cinema.example.com` with your server's HTTPS address. The value is supplied to the local build and embedded in that APK; it is not saved in the app source. The same property can be added to the Gradle arguments when building the `app` configuration in Android Studio.

## Install on an Android TV device

Install Android Studio with Android SDK Platform 37 and Java 17 or newer. Enable Developer options and ADB debugging on the TV, connect ADB, and approve the debugging prompt on the TV:

```powershell
adb connect <android-tv-ip>:5555
adb install -r .\app\build\outputs\apk\debug\app-debug.apk
adb shell monkey -p com.alghulventures.tvcinema 1
```

The app appears in the TV launcher. Use **Sign in with phone** to approve Plex sign-in from a phone, or choose the existing browser sign-in option.
