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

const PROPERTIES = [
  {
    key: 'reactNativeArchitectures',
    value: 'arm64-v8a,armeabi-v7a',
    why:
      'Drops lib/x86 and lib/x86_64 -- 61,374,008 bytes of native code that no ' +
      'phone can execute. They exist for emulators. armeabi-v7a is kept so a ' +
      '32-bit device still installs: sideloading has no Play filter, so the ' +
      'failure mode there is a bare "App not installed" with no reason given.',
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
];

// Deliberately NOT in the list above, and the reason is worth keeping:
// `android.enableMinifyInReleaseBuilds`. R8 rewrites and strips bytecode, so
// unlike everything above it can change runtime behaviour -- the classic React
// Native symptom is a native module that resolves by reflection at startup and
// is no longer there. It is a separate change with a separate device test.
const NOT_SET_YET = ['android.enableMinifyInReleaseBuilds'];

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
  const { withGradleProperties } = require('@expo/config-plugins');
  return withGradleProperties(config, (cfg) => {
    cfg.modResults = apply(cfg.modResults);
    return cfg;
  });
};

module.exports.apply = apply;
module.exports.PROPERTIES = PROPERTIES;
module.exports.NOT_SET_YET = NOT_SET_YET;
