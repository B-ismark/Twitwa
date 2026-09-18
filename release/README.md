# Publishing a Twitwa release

Twitwa is not on any store. It is an APK, sent to people. `latest.json` in this
directory is how an installed copy finds out that a newer one exists: the app
fetches it over HTTPS, compares `versionCode` against its own, and if the
manifest is newer it offers to open the download link in the browser. Android's
own package manager does the install and the signature check.

`src/update.js` is the reader, and it is the specification: the schema, the
allowlisted download prefix and the refusal rules all live there, with the
reasoning. `tools/check-release-manifest.mjs` runs this file through that same
reader, so the published manifest cannot drift from what the app will accept.

## Order of operations, which matters

`versionCode` must go up before the build, and the manifest must go up after
the release exists. Doing it the other way round points every installed copy at
a download that 404s.

1. **Bump `versionCode` in `spike/app.json`.** Android compares this number and
   nothing else. Two different APKs sharing a `versionCode` are the same build
   as far as the OS and this manifest are concerned. `versionName` is for
   people; it has no effect on anything.
2. **Build and verify.**
   ```
   cd spike && npx expo prebuild -p android
   cd android && TWITWA_KEYSTORE_PROPERTIES=/path/to/keystore.properties ./gradlew assembleRelease
   cd .. && bash tools/verify-apk.sh
   ```
   `verify-apk.sh` is not optional. With the environment variable unset the
   build still succeeds and produces a **debug-signed** APK under the same
   filename, and a debug-signed APK cannot update anything anyone is holding.
3. **Rename the file to `twitwa-<versionName>.apk`** and publish it as an asset
   on a GitHub Release tagged `v<versionName>`. The tag and the filename both
   appear in the URL, and the gate checks that the URL agrees with the
   `versionName` in the manifest.
4. **Now** edit `latest.json` to match, and run
   `cd spike && node tools/check-release-manifest.mjs`.
5. Commit. The app reads the raw file from the default branch, so the commit is
   the publish.

## Why the download link is restricted to one prefix

The app refuses any `url` that is not under
`https://github.com/B-ismark/Twitwa/releases/download/`. That prefix spells out
the scheme, the host and the first three path segments, so one string comparison
pins all three. Without it, a manifest -- which arrives over the network -- could
send someone to install an arbitrary APK under Twitwa's own update prompt.

This is the first line only. The second is that Android refuses to install an
APK signed with a different key than the installed app, which is also the reason
the signing key must never change.
