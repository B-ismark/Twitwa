# 1.0.7: what's left before it reaches anyone

`spike/app.json` is already bumped to `version` 1.0.7, `versionCode` 8.
`latest.json` is **not** touched yet, and stays that way until step 4, after
the APK is published. The steps follow `release/README.md`.

This release carries more untested native and build change than any before
it: new Kotlin in the share-in module and in a new pixels module that encodes the card off the JS thread, five new size settings and a locale
filter in Gradle, and three new native dependencies (splash screen, safe area,
SVG). None of it has been compiled. **Install and run it on a phone before
publishing.**

## 1. Build and verify

```
cd spike && npx expo prebuild -p android --clean
node plugins/withAndroidSize.test.mjs      # 88 checks after a prebuild, not 84: the 4 live-tree checks now run
node plugins/withReleaseSigning.test.mjs   # 38 after a prebuild
node plugins/withDebugSuffix.test.mjs      # 18 after a prebuild
cd android && TWITWA_KEYSTORE_PROPERTIES=/path/to/keystore.properties ./gradlew assembleRelease
cd .. && bash tools/verify-apk.sh
unzip -v android/app/build/outputs/apk/release/app-release.apk | sort -k1 -n | tail -25
```

Record the APK size in the README next to the 1.0.6 figure, and replace the
P5 section's EXPECTED numbers with measured ones. The expected size is about
16.8 MB, down from 19,235,347 bytes. Look in the `unzip -v` output for:

- `assets/index.android.bundle` showing **Defl:N**, not Stored
- no `libstatic-webp.so` and no `libnative-imagetranscoder.so`
- a much smaller `resources.arsc`

## 2. Device pass, on the release build

**Opening and the start screen**
- [ ] Splash and launcher icon in light and in dark mode, and the themed (monochrome) icon.
- [ ] `bash tools/coldstart.sh dev.bismark.twitwa 5` on 1.0.6, then on 1.0.7. If 1.0.7 is noticeably slower, the likely cause is bundle compression: set `android.enableBundleCompression` back to false.
- [ ] Choose a screenshot; the importing state shows, then the card fades in.
- [ ] Force-stop mid-edit and relaunch: the card comes back with "Picked up where you left off".

**Editing**
- [ ] Style opens as a sheet, the card glides up above it, and the slider previews while you drag.
- [ ] The second swatch row is usable at 360dp and with the largest font size.
- [ ] Crop: the handles are clear of the back-swipe edge; Cancel and Reset behave.
- [ ] A long scroll capture (about 10 screens): the whole picture shows in Crop, and a one-screen crop stays crisp on the card.

**Getting the card out**
- [ ] Share, Save and Copy each work, with no `UnsatisfiedLinkError` in `adb logcat`.
- [ ] Save shows "Saved to Photos" with View, and View opens the gallery.
- [ ] Turn on Save as JPEG, then Share to a chat app: the file arrives as .jpg.
- [ ] Save the same card again: it asks first. Save it as PNG, then as JPEG: it doesn't ask.
- [ ] Pick a colour, force-stop, share a new screenshot in: it opens with that colour.

**Export (new Kotlin)**
- [ ] A long 10-screen capture's Share does not freeze the UI: the spinner keeps moving while the card is made.
- [ ] Dev panel (long-press), Encoder parity: it reports that pixels match, `auto.encoder` is `native` with no fallback, and shows whether an iCCP or sRGB chunk was added on either side.
- [ ] Save as JPEG still arrives as .jpg, from Share and from Save.
- [ ] `adb logcat` shows no `TwitwaPixels` or `ERR_PIXELS_*` errors, and Render P3 in the dev panel still logs `encoder: skia`.

**Sharing in (new Kotlin)**
- [ ] Share 1 screenshot from Photos, cold and with Twitwa already open.
- [ ] Share 3: the first opens, the chip shows "2 waiting", and Close opens the next.
- [ ] Share 12: 10 cards, and "Skipped 2 that couldn't be opened".
- [ ] Share a video along with images: the video is skipped.
- [ ] Share while editing, choose Keep editing: the chip count goes up.
- [ ] With pictures waiting, Back goes to the start screen and the chip is still there.

## 3. Publish the APK

```
gh release create v1.0.7 /path/to/twitwa-1.0.7.apk \
  --target <the commit whose app.json says 1.0.7> \
  --title "Twitwa 1.0.7" --notes-file release/notes-1.0.7.md \
  -R B-ismark/Twitwa
```

## 4. Only now, `latest.json`

Set `versionCode` 8, `versionName` "1.0.7", the v1.0.7 URL and the APK's
`sha256`. For `notes`, use this text (337 characters; the reader's limit is 500):

> Share several screenshots at once, one card each. Twitwa remembers your padding, background and format. Six new backgrounds, Save as JPEG for chat apps, and View after Save. A new icon and splash, a steadier layout, better colour on white and cream screenshots, and a smaller download. Needs a 64-bit phone. Installs over 1.0.1 to 1.0.6.

Then run `cd spike && node tools/check-release-manifest.mjs`, commit, and
follow README steps 6 and 7: verify the published asset, then watch the update
banner on a phone holding 1.0.6.
