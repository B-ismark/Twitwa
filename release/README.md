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

   Create the release and attach the APK in **one** command, with the title and
   the notes supplied on the command line:

   ```
   gh release create v1.0.1 /path/to/twitwa-1.0.1.apk \
     --target <the commit whose app.json carries this version> \
     --title "Twitwa 1.0.1" --notes-file /path/to/notes.md \
     -R B-ismark/Twitwa
   ```

   Both halves of that are paid for. Omitting `--title` or `--notes` makes
   `gh` go **interactive**, and in a terminal that cannot prompt it leaves an
   untagged draft with no asset behind — twice, on 1.0.0 and again on 1.0.1.
   And creating the release first and uploading second leaves a window in which
   the release exists with nothing attached; if anything deletes that draft in
   between, the upload fails with a bare `HTTP 404` naming a release id that no
   longer exists, which reads like a permissions problem and is not.
4. **Now** edit `latest.json` to match, and run
   `cd spike && node tools/check-release-manifest.mjs`.
5. Commit. The app reads the raw file from the default branch, so the commit is
   the publish.

6. **Verify the published thing, not the local one.** The filename is not
   evidence: 1.0.0 and 1.0.1 are both exactly 32,886,397 bytes, so the only way
   to tell them apart is to read them.

   ```
   gh release view v<versionName> -R B-ismark/Twitwa --json isDraft,assets
   curl -s -o /dev/null -w "%{http_code}\n" -L -r 0-0 <the manifest's url>
   ```

   The asset's `digest` must equal the local file's sha256, `state` must be
   `uploaded`, `isDraft` must be false, and the URL must answer 206. GitHub
   records a digest for every asset, which makes this free.

7. **Watch the banner on a phone holding the previous build**, once per release.
   Nothing else exercises the manifest, the reader, the banner and the browser
   hand-off together.

   The throttle will get in the way, and that is correct behaviour: if the day's
   check already ran, the launch logs `"action":"skipped"` and no banner appears.
   There is no force path in the app, and a release build is not debuggable, so
   `run-as` cannot reach the state file. `adb shell pm clear dev.bismark.twitwa`
   is the only way to re-arm it — it erases Twitwa's app data, which today is the
   check timestamp and the picker resume flag, and will not be that once Library
   exists.

## Why the download link is restricted to one prefix

The app refuses any `url` that is not under
`https://github.com/B-ismark/Twitwa/releases/download/`. That prefix spells out
the scheme, the host and the first three path segments, so one string comparison
pins all three. Without it, a manifest -- which arrives over the network -- could
send someone to install an arbitrary APK under Twitwa's own update prompt.

This is the first line only. The second is that Android refuses to install an
APK signed with a different key than the installed app, which is also the reason
the signing key must never change.
