# 1.0.7: what's left before it reaches anyone

`spike/app.json` is already bumped to `version` 1.0.7, `versionCode` 8.
`latest.json` is **not** touched yet, and stays that way until step 4, after
the APK is published. The steps follow `release/README.md`.

This release carries more untested native and build change than any before
it: new Kotlin in the share-in module, in a new pixels module that encodes the card off the JS thread, and in a new out module that replaces `expo-sharing`, `expo-clipboard` and `expo-media-library` (Share, Save and Copy), five new size settings and a locale
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
- no `expo.modules.sharing`, `expo.modules.clipboard` or `expo.modules.medialibrary` classes. They are in the
  dex, not the zip listing, so check the dex: `unzip -o app-release.apk 'classes*.dex' -d /tmp/dex && for d in /tmp/dex/classes*.dex; do strings "$d" | grep -E 'expo/modules/(sharing|clipboard|medialibrary)/'; done` prints nothing
  (an unminified build would show the names; R8 may rename them, so also confirm `dev/bismark/twitwa/out/OutModule` is present, and compare dex sizes with 1.0.6)
- the permissions: `aapt2 dump permissions app-release.apk` (or the merged manifest in
  `android/app/build/intermediates/merged_manifests/release*/`) lists `WRITE_EXTERNAL_STORAGE` **only with
  `maxSdkVersion`** (the out module declares 28; expo-file-system and expo-image-picker declare 32 and the merger
  decides which wins, so read what it kept: either is fine, a bare declaration is not), no `READ_EXTERNAL_STORAGE`
  without one, and none of `READ_MEDIA_*` / `ACCESS_MEDIA_LOCATION`
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

**Share, Save and Copy (new Kotlin, `modules/twitwa-out`)**
- [ ] On a phone with Android 13 or later: Share opens the chooser and the card arrives in a chat app (with its preview in the chooser); Save shows "Saved to Photos" with View; Copy puts the card on the clipboard and pastes into a chat app.
- [ ] Copy a card, Share a *different* card, then paste: the pasted card is the one that was **copied**, not the shared one.
- [ ] Saved cards appear in the **same album** as 1.0.6's: `DCIM/`, beside `Twitwa-2026...png` files saved by 1.0.6 (install 1.0.7 over 1.0.6 and look in the gallery and in `adb shell ls /sdcard/DCIM`).
- [ ] Save as JPEG: the file in `DCIM/` is `.jpg`, and Share as JPEG arrives as `.jpg`.
- [ ] Save twice within one second (double tap, "Save again"): both land, neither is lost, and no half-written (pending) row is left.
- [ ] **Android 10 (API 29), if you can:** Save asks for nothing and works.
- [ ] **Android 9 or older (API 28 and below), a phone or an emulator:** the first Save shows the storage permission prompt, Allow saves into `DCIM/` and the notice's View opens it; on a second install, Deny falls back to the share sheet with no error message. Revoke the permission in Settings and Save again to see the prompt return.
- [ ] `adb logcat` shows no `TwitwaOut` or `ERR_OUT_*` errors, and `adb shell run-as dev.bismark.twitwa ls cache/clipboard` shows exactly one file after several Copies.

**Sharing in (new Kotlin)**
- [ ] Share 1 screenshot from Photos, cold and with Twitwa already open.
- [ ] Share 3: the first opens, the chip shows "2 waiting", and Close opens the next.
- [ ] Share 12: 10 cards, and "Skipped 2 that couldn't be opened".
- [ ] Share a video along with images: the video is skipped.
- [ ] Share while editing, choose Keep editing: the chip count goes up.
- [ ] With pictures waiting, Back goes to the start screen and the chip is still there.

**Custom backgrounds (Style sheet, new JS only)**
- [ ] 360dp wide, and again at the largest font size: the third swatch row (Add plus four saved colours) fits on one line with no wrap and no clipped disc, each disc a 48dp target, and the sheet still sits clear of the bar.
- [ ] Add opens the mixer in place of the Background block, opening on the card's current colour. Moving Hue, Strength and Shade repaints the card behind the sheet live, and the Strength and Shade tracks re-tint as Hue moves. The sheet is no taller than before.
- [ ] Cancel puts back the background the card had before Add, and nothing is saved. Done, Back and opening Crop with the mixer open do the same.
- [ ] Add saves the colour first in the row, selected. A fifth colour drops the oldest. Saving the same colour twice leaves one disc.
- [ ] Long-press a saved colour: "Remove this colour?" with Cancel and Remove. Remove takes it out of the row and the card on screen keeps its colour.
- [ ] With TalkBack on: the row reads "Add a colour" and "Your colour, #RRGGBB"; the actions menu on a saved colour offers "Remove this colour"; each mixer track adjusts with volume keys or swipe up and down in steps.
- [ ] Remember: choose a saved colour, open the next screenshot, and it starts on that colour. Remove that colour, open another screenshot, and it starts on Match.
- [ ] Share a card with a custom background, open the exported file and sample a frame pixel: it equals the disc's hex exactly (and the same after Save as JPEG, within JPEG's tolerance).
- [ ] Kill the app mid-edit on a custom colour: the restored card keeps it, even if it has since been removed from the row.

## 3. Publish the APK

```
gh release create v1.0.7 /path/to/twitwa-1.0.7.apk \
  --target <the commit whose app.json says 1.0.7> \
  --title "Twitwa 1.0.7" --notes-file release/notes-1.0.7.md \
  -R B-ismark/Twitwa
```

## 4. Only now, `latest.json`

Set `versionCode` 8, `versionName` "1.0.7", the v1.0.7 URL and the APK's
`sha256`. For `notes`, use this text (358 characters; the reader's limit is 500):

> Share several screenshots at once, one card each. Twitwa remembers your padding, background and format. Six new backgrounds and your own colours, Save as JPEG for chat apps, and View after Save. A new icon and splash, a steadier layout, better colour on white and cream screenshots, and a smaller download. Needs a 64-bit phone. Installs over 1.0.1 to 1.0.6.

Then run `cd spike && node tools/check-release-manifest.mjs`, commit, and
follow README steps 6 and 7: verify the published asset, then watch the update
banner on a phone holding 1.0.6.
