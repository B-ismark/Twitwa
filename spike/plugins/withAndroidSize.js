// Shrinks the Android release APK, which matters here because the APK is the
// distribution channel: it is sent to people over a chat app, by hand. A
// 124.5 MB file is not something you send to a friend.
//
// Every value below was chosen against a measurement of the 124.5 MB build, not
// against a blog post. `unzip -v` on that APK reported:
//
//   lib/x86        31,051,496      \
//   lib/x86_64     30,322,512       |  110,956,700 bytes of native code,
//   lib/arm64-v8a  29,468,664       |  every entry Stored, i.e. NOT compressed
//   lib/armeabi-v7a 20,114,028     /
//   everything else                   165,100,694 -> 12,820,537 compressed
//
// So the whole of the size problem is in lib/, and it has exactly two causes:
// four ABIs where a phone can use one, and no compression on any of them.
//
// Two traps, both of which make a setting silently do nothing:
//
//   1. The Expo SDK 57 template reads `android.enableMinifyInReleaseBuilds`
//      (android/app/build.gradle:69). The property named by nearly every guide,
//      `android.enableProguardInReleaseBuilds`, is from the bare React Native
//      template and is not read here at all. Setting it would leave R8 off and
//      look like it had been turned on.
//   2. `reactNativeArchitectures` is applied as `defaultConfig.ndk.abiFilters`
//      by React Native's own Gradle plugin, and that plugin skips it when
//      `splits.abi` is enabled -- the two are mutually exclusive and RN says so
//      in a comment. Using ABI splits here would therefore have QUIETLY
//      restored all four ABIs to the split that got built.
//
// Because both traps are "the build succeeds and the setting did nothing", this
// plugin re-reads what it wrote and throws if any value is not what it intended.
//
// P5 (2026-11-25) added five more levers, measured on the released 1.0.6 APK
// (19,235,347 bytes; zip entries sum to 19,076,775). Their expected savings are
// EXPECTED, not measured, until a build with them is weighed.

const PROPERTIES = [
  {
    key: 'reactNativeArchitectures',
    value: 'arm64-v8a',
    why:
      'Drops lib/x86 and lib/x86_64 -- 61,374,008 bytes of native code that no ' +
      'phone can execute; they exist for emulators. Also drops armeabi-v7a ' +
      '(9,255,669 bytes, 28.1% of the 32,940,585-byte rebuild), as the owner decided on ' +
      '2026-09-22. The cost is known and accepted: a phone that can only run ' +
      '32-bit code cannot install this APK, and because sideloading has no Play ' +
      'filter it says a bare "App not installed" with no reason given.',
  },
  {
    key: 'expo.useLegacyPackaging',
    value: 'true',
    why:
      'Stores .so compressed instead of Stored. React Native 0.73 flipped this ' +
      'default to get faster loads by mmapping libraries straight out of the ' +
      'APK; the cost is that the APK carries them at full size. For a file that ' +
      'is downloaded by hand over a chat app, download size wins. The tradeoff ' +
      'is real and one-directional: install extracts the libraries, so the app ' +
      'takes more space on the device and starts marginally slower.',
  },
  {
    key: 'expo.gif.enabled',
    value: 'false',
    why:
      'Removes libgifimage.so (318,992 bytes per ABI). The input to this app is ' +
      'a screenshot, which Android writes as PNG; nothing here decodes a GIF.',
  },
  {
    // The Expo SDK 57 template reads THIS name (android/app/build.gradle:69).
    // `android.enableProguardInReleaseBuilds`, the name nearly every guide
    // gives, is from the bare React Native template and is not read here: it
    // would leave R8 off and look like it had been turned on.
    key: 'android.enableMinifyInReleaseBuilds',
    value: 'true',
    why:
      'Turns on R8 for the release build: dex was 7,810,455 bytes before it. ' +
      'R8 rewrites and strips bytecode, so unlike everything above it can ' +
      'change runtime behaviour -- the classic React Native symptom is a native ' +
      'module that resolves by reflection at startup and is no longer there. ' +
      'Every release built with it therefore gets launched on a phone first.',
  },
  {
    key: 'android.enableBundleCompression',
    value: 'true',
    why:
      'Compresses assets/index.android.bundle. React Native\'s Gradle plugin ' +
      'adds "bundle" to noCompress unless this is set (ReactPlugin.kt ' +
      'configureResources), so the 2,813,392-byte bundle ships Stored; gzip -9 ' +
      'of it is 1,109,444 bytes, about 1.70 MB saved. The tradeoff is real: ' +
      'Hermes can no longer mmap the bytecode straight out of the APK, it is ' +
      'inflated into memory at launch, so cold start may be slower. ' +
      'tools/coldstart.sh measures it before release.',
  },
  {
    key: 'android.enableShrinkResourcesInReleaseBuilds',
    value: 'true',
    why:
      'Turns on resource shrinking for the release build (it needs R8, which is ' +
      'already on). res/ is 829,698 bytes compressed and resources.arsc ' +
      '1,237,532 bytes, Stored, and has to stay Stored. The risk is the usual ' +
      'one: a resource reached only by name through getIdentifier is stripped ' +
      'and nothing fails until it is looked up. Two things to see on the phone ' +
      'before release: the expo-splash-screen splash and the adaptive icon.',
  },
  {
    key: 'expo.webp.enabled',
    value: 'false',
    why:
      'Removes Fresco\'s webpsupport, and with it ' +
      'lib/arm64-v8a/libstatic-webp.so (206,899 bytes compressed). Android ' +
      'decodes WebP natively anyway, and this app never draws a React Native ' +
      '<Image> (App.js and src/ import none from react-native; everything is ' +
      'drawn through Skia), so the Fresco decoder has no caller.',
  },
  {
    key: 'android.packagingOptions.excludes',
    value: '**/libnative-imagetranscoder.so',
    why:
      'Excludes Fresco\'s JPEG resize/rotate transcoder, ' +
      'lib/arm64-v8a/libnative-imagetranscoder.so (224,841 bytes compressed). ' +
      'It only runs when an <Image> resizes or rotates a JPEG, and Twitwa draws ' +
      'everything through Skia. The tradeoff: a missing .so fails at the ' +
      'moment of use, not at the build, so a path that did reach it would ' +
      'crash on first use. libimagepipeline (3 KB, which Fresco\'s memory pools ' +
      'can load) and libnative-filters are deliberately NOT excluded.',
  },
];

// English only, through `localeFilters`, which needs a block in app/build.gradle
// and so cannot be a gradle.properties line. The template ships every locale
// the AndroidX/Material/Expo libraries carry translations for: on 1.0.6, 74
// non-English locales' type chunks are 278,224 bytes of resources.arsc, and
// most of the 324,612-byte global string pool holds their translated strings.
// resources.arsc must stay Stored, so every byte removed there is a byte off
// the APK. The app's own words are English only (src/copy.js), so nothing it
// shows is lost. System UI such as the photo picker belongs to the OS and is
// not affected. AGP 8.9+ spells it `localeFilters`; resConfigs /
// resourceConfigurations are the deprecated names for the same thing.
const LOCALE_LINE = "localeFilters += ['en']";
const LOCALE_ANCHOR = /^([ \t]*)androidResources[ \t]*\{[ \t]*(\r?\n)/m;
const LOCALE_ANY = /^[ \t]*localeFilters\b.*$/gm;

function applyLocales(gradleText) {
  let out = gradleText;
  const present = out.split(/\r?\n/).some((l) => l.trim() === LOCALE_LINE);
  if (!present) {
    const m = LOCALE_ANCHOR.exec(out);
    if (!m) {
      throw new Error(
        'withAndroidSize found no `androidResources {` block in app/build.gradle ' +
          'to put localeFilters in, so the release APK would silently be built ' +
          'with every locale and at the wrong size.'
      );
    }
    const at = m.index + m[0].length;
    out = out.slice(0, at) + m[1] + '    ' + LOCALE_LINE + m[2] + out.slice(at);
  }
  const lines = out.match(LOCALE_ANY) || [];
  if (lines.length !== 1 || lines[0].trim() !== LOCALE_LINE) {
    throw new Error(
      'withAndroidSize could not set localeFilters as intended, so the release ' +
        'APK would silently be built at the wrong size: expected exactly one ' +
        `\`${LOCALE_LINE}\` line, read back ${JSON.stringify(lines.map((l) => l.trim()))}`
    );
  }
  return out;
}

function apply(items) {
  const out = items.slice();
  for (const { key, value } of PROPERTIES) {
    const at = out.findIndex((i) => i.type === 'property' && i.key === key);
    if (at === -1) out.push({ type: 'property', key, value });
    else out[at] = { ...out[at], value };
  }
  const wrong = [];
  for (const { key, value } of PROPERTIES) {
    const found = out.filter((i) => i.type === 'property' && i.key === key);
    if (found.length !== 1) wrong.push(`${key}: expected 1 entry, found ${found.length}`);
    else if (found[0].value !== value) wrong.push(`${key}: wrote '${value}', read back '${found[0].value}'`);
  }
  if (wrong.length) {
    throw new Error(
      'withAndroidSize could not set gradle.properties as intended, so the ' +
        'release APK would silently be built at the wrong size:\n  ' +
        wrong.join('\n  ')
    );
  }
  return out;
}

module.exports = function withAndroidSize(config) {
  const { withGradleProperties, withAppBuildGradle } = require('@expo/config-plugins');
  config = withGradleProperties(config, (cfg) => {
    cfg.modResults = apply(cfg.modResults);
    return cfg;
  });
  return withAppBuildGradle(config, (cfg) => {
    cfg.modResults.contents = applyLocales(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.apply = apply;
module.exports.applyLocales = applyLocales;
module.exports.LOCALE_LINE = LOCALE_LINE;
module.exports.PROPERTIES = PROPERTIES;
