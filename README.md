# Clair — appli Android (Capacitor)

## Contenu
- `www/` : l'appli (HTML, CSS, JS). C'est ici qu'on modifie le code.
- `android/` : projet Android natif (généré par Capacitor, déjà configuré).
- `.github/workflows/build-apk.yml` : compilation automatique de l'APK par GitHub.

## Compiler l'APK
1. Envoyer les fichiers sur la branche `main` du dépôt GitHub.
2. Onglet **Actions** > run « Build APK » > section **Artifacts** > `clair-apk`.
3. Décompresser, installer `app-release.apk` sur le téléphone.

## Secrets GitHub requis (Settings > Secrets and variables > Actions)
- `ANDROID_KEYSTORE_BASE64` : contenu de `keystore-base64.txt`
- `ANDROID_KEYSTORE_PASSWORD` : contenu de `keystore-password.txt`

⚠️ Ne jamais mettre la clé (`clair.keystore`) ni son mot de passe dans le dépôt.

## Nouvelle version
1. Changer `APP_VERSION` dans `www/app.js` et `versionName` dans `android/app/build.gradle`.
2. Envoyer sur GitHub, récupérer l'APK.
3. Le déposer dans `apk/` sur le serveur et mettre à jour `version.json` : les téléphones verront « Nouvelle version disponible ».
