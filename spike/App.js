// The app's one screen.
//
// It was the Phase 0 harness: eleven buttons, a JSON log, and a caption that
// read "1440x3120 2.3MP 16.5MiB RGBA — showing source". That was the right
// shape for answering measurement questions and the wrong shape for anything
// else, and it is now behind a long press. See src/DevPanel.js, which still
// holds every one of those buttons, because the numbers in this repository
// came out of them.
//
// PHASE 4.5 DELETED THE RENDER STEP. There used to be a "Make card" button and
// a `showingResult` flag: the canvas showed the screenshot, you pressed the
// button, and the canvas showed a card. Nothing surveyed works that way, the
// spec never described it, and it caused a real bug — a box was drawn over one
// image and applied to another, because the same on-screen rectangle points at
// different content in the two.
//
// So the canvas IS the card, composed at screen resolution and recomposed on
// every change. The rules live in three modules and none of them are here:
//
//   src/compose.js   one composition, projected to the stage and to the export. The
//                    preview and the export cannot be two layouts because
//                    there is only one `project()`.
//   src/shell.js     which tool is open, which image the canvas draws, and
//                    what Cancel, Reset and Done each put back.
//   src/autocrop.js  the crop the editor opens on, so there is a card to see
//                    before anything is touched.
//
// This file measures the stage, reads pixels, draws, and routes gestures. When
// a question here has a right answer that does not depend on React, it belongs
// in one of those three; that is what keeps them testable on a desktop.
//
// The three ways out -- Share, Save to Photos and Copy image -- all render
// through `exportCard`, so they hand over one composition. Save sits on the
// bar beside Share and Copy in the overflow (the owner's calls, 2026-09-23).
//
// The two ways in -- the picker and a share from another app -- both end in
// `openImage`, so a shared screenshot gets the same proposal, the same
// sampled frame and the same error handling as a picked one. The share is
// read by a native module of our own, modules/twitwa-share-in, because
// nothing else in the project exposes EXTRA_STREAM; src/sharein.js decides
// what its answer means.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  DevSettings,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import { File, Paths } from 'expo-file-system';
import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  Canvas,
  Group,
  Image as SkiaImage,
  Rect,
  rect as skRect,
} from '@shopify/react-native-skia';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import { Asset, requestPermissionsAsync } from 'expo-media-library';

import {
  decodeFromUri,
  measureStatusBar,
  composeAndEncode,
  measureRoundTrip,
  stressFullRead,
} from './src/measure';
import { renderCard, decodeUri, sampleCropBackground } from './src/pipeline';
import { composition, project, MIN_PROJECT } from './src/compose';
import {
  TOOL,
  TOOLS,
  backAction,
  barMode,
  canReset,
  cardOf,
  cancelTool,
  canvasShows,
  doneTool,
  editorState,
  openTool,
  padStops,
  resetTool,
  setBackground,
  setPadding,
  unsaved,
  BACKGROUNDS,
  PAD_MAX,
  PAD_MIN,
} from './src/shell';
import { proposeFromImage } from './src/autocrop';
import { readRect } from './src/skia';
import { planOutput, savedName } from './src/plan';
import {
  dragCrop,
  edgeBand,
  expandToEdge,
  fitView,
  handlePoint,
  loupeScale,
  pickBand,
  pickHandle,
  toImageDelta,
  toImagePoint,
  toViewportRect,
  MIN_CROP,
} from './src/crop';
import {
  canReloadRuntime,
  isStaleLauncherError,
  launcherWentStale,
  recoveryPlan,
  resumeDecision,
} from './src/recover';
import {
  check as checkForUpdate,
  openDownload,
  installedVersionCode,
  updaterAvailable,
  downloadUpdate,
  cancelUpdate,
  installUpdate,
  clearUpdate,
  laterRecord,
  rememberLater,
} from './src/update-io';
import { installRoute, downloadPercent, updateProblem, laterHides } from './src/update';
import { shareOutcome } from './src/sharein';
import { onShare, shareInAvailable, takeShare } from './src/sharein-io';
import { COPY, fill } from './src/copy';
import { RADIUS, SPACE, TOUCH, TYPE, paletteFor } from './src/theme';
import DevPanel from './src/DevPanel';

const PAPER = '#F6F4EF';
const LOG = 'PHASE0';

/** The cross-fade between the composed card and the raw screenshot. */
const FADE_MS = 160;

/**
 * Column subsampling for the auto-crop's profiles.
 *
 * The profile is a coverage ratio, so its denominator moves with the step and
 * the numbers stay comparable. 8 rather than 2 because this runs once per
 * import on the whole image, not on a 400-row band: a 1440x3120 capture is
 * 3120 rows of 180 samples instead of 3120 of 720.
 */

// A dead picker launcher is repaired by replacing the JS runtime, which throws
// away everything in memory, including the fact that the owner had just asked
// to pick a picture. This file carries that one intention across the reload, so
// the recovery costs one tap instead of two.
//
// In the cache directory on purpose: it is a hint, not data. Android may delete
// it at any time and the only cost is the extra tap this exists to avoid.
// `src/recover.js` bounds its age, because there is no moment at which this can
// reliably be cleaned up: the runtime that writes it is about to be destroyed.
const RESUME_FLAG = 'pick-resume.json';

function writeResumeFlag() {
  try {
    const f = new File(Paths.cache, RESUME_FLAG);
    f.create({ overwrite: true });
    f.write(JSON.stringify({ at: Date.now(), want: 'library' }));
    return true;
  } catch (e) {
    return false;
  }
}

function takeResumeFlag() {
  try {
    const f = new File(Paths.cache, RESUME_FLAG);
    if (!f.exists) return null;
    // textSync, not text. `text` is an AsyncFunction in expo-file-system's
    // native module, so it returns a promise and JSON.parse throws on it. The
    // catch below would then answer "no flag" every single time.
    const flag = JSON.parse(f.textSync());
    f.delete();
    return flag;
  } catch (e) {
    return null;
  }
}

export default function App() {
  const { fontScale, scale: pixelScale } = useWindowDimensions();
  const scheme = useColorScheme();
  const palette = paletteFor(scheme);

  // The stage measures itself rather than taking a fixed height, so the
  // screenshot gets the whole screen. Null until the first layout pass: every
  // colour and every coordinate below depends on it, and rendering a canvas
  // against a zero-sized box puts a one-frame black rectangle on screen.
  const [stage, setStage] = useState(null);

  const [src, setSrc] = useState(null);      // { img, width, height, uri, ... }
  // The crop's own edge colour, from the renderer's own sampler.
  //
  // Sampled when the crop is COMMITTED rather than on every frame of a drag:
  // it reads four edge strips, which is cheap but not free, and during a crop
  // the canvas is showing the raw screenshot, so the card's frame is not on
  // screen to be wrong. Committed means at import and on Done.
  const [sampled, setSampled] = useState(null);
  // The whole editor, in one object, from src/shell.js. Null with no
  // screenshot: "no editor" and "an editor with nothing in it" are different
  // states and only one of them can be drawn.
  const [ed, setEd] = useState(null);
  const [log, setLog] = useState([]);

  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  // An outcome to confirm, such as "Saved to Photos". Separate from `problem`
  // because it clears itself: a confirmation that stays up reads as the
  // caption being stuck, and one that has to be dismissed is a second action
  // for a thing that already happened.
  const [notice, setNotice] = useState(null);
  const [menu, setMenu] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  // Dev only, and not part of the editor. The Q2 and P1 buttons put a measured
  // image on the canvas in place of the card; this holds it. It is a separate
  // piece of state rather than a mode of `ed` precisely so it cannot leak into
  // the product's state machine the way `showingResult` did.
  const [override, setOverride] = useState(null);

  // A newer APK, if there is one. Twitwa is handed out as a file, so nothing
  // tells a person that a new version exists unless the app does. See
  // src/update.js for the whole design, including why the check is the app's
  // only unasked network call and what that costs in privacy.
  const [update, setUpdate] = useState(null);
  // What the banner says while Twitwa fetches the update itself: `{percent}`
  // while downloading (null until the size is known), `{problem}` after a
  // failure, null otherwise.
  const [updateStep, setUpdateStep] = useState(null);
  const updateBusy = useRef(false);
  // "Later" after Get it. While the file downloads the banner offers Cancel
  // instead, but Later is back for the moment the file is re-checked, and the
  // installer must not then appear over whatever the person went back to.
  const updateDismissed = useRef(false);
  // Cancel during a download. Checked after it returns as well as by the
  // native side, so a cancel that raced the download's start still keeps the
  // installer from opening.
  const updateCancelled = useRef(false);

  // The picker launcher is dead until this runtime is replaced. See
  // src/recover.js for the measurement behind that claim.
  const [staleLauncher, setStaleLauncher] = useState(false);
  // Survives the reload through the flag file, not through this ref: a reload
  // creates a new runtime in which every ref is fresh, so a ref alone would
  // permit an endless reload loop. The mount effect below sets it when this
  // runtime IS the recovery.
  const recoveryUsed = useRef(false);
  const lastConfig = useRef(null);
  const updateAsked = useRef(false);

  const emit = useCallback((label, payload) => {
    const line = label + ' ' + JSON.stringify(payload);
    // Marker prefix so the whole run lifts off the device with:
    //   adb logcat -s ReactNativeJS:V | grep PHASE0
    console.log(LOG, line);
    setLog((prev) => [{ label, payload }, ...prev].slice(0, 12));
  }, []);

  const onStageLayout = useCallback((e) => {
    const { width, height } = e.nativeEvent.layout;
    setStage({ w: Math.round(width), h: Math.round(height) });
  }, []);

  // --- the card, as ratios and then as pixels ------------------------------
  //
  // One composition. `comp` is what the card IS; `shot` is that card at the
  // size the stage can show. The export draws it at the crop's own size.
  // Neither computes a layout, which is the whole point of src/compose.js.
  const comp = useMemo(() => {
    if (!ed) return null;
    try {
      return composition({ w: ed.crop.w, h: ed.crop.h }, ed.padding);
    } catch (e) {
      return null;
    }
  }, [ed]);

  // The frame colour, taken from the renderer's own decision function rather
  // than from a rule written again here. planOutput is pure arithmetic over a
  // sample this component already has, so calling it costs nothing and buys
  // the only thing that matters: the preview's frame and the PNG's frame are
  // one answer, including the near-white and near-black fallbacks.
  const fillColour = useMemo(() => {
    if (!ed) return null;
    try {
      return planOutput({
        crop: ed.crop,
        padding: ed.padding,
        background: sampled,
        frame: ed.background,
      }).fill;
    } catch (e) {
      return null;
    }
  }, [ed, sampled]);

  const shot = useMemo(() => {
    if (!comp || !stage) return null;
    // Contain-fit the CARD in the stage, not the image: the padding is part of
    // what is being previewed, so fitting the image would show a card whose
    // margins are cropped by the viewport.
    const w = Math.min(stage.w, stage.h / comp.aspect);
    if (!(w >= MIN_PROJECT)) return null;
    try {
      const p = project(comp, w);
      return { ...p, offX: (stage.w - p.width) / 2, offY: (stage.h - p.height) / 2 };
    } catch (e) {
      // `project` refuses rather than rounding when the padding would close
      // over the image. A stage too small for the composition is a real
      // condition on a short landscape window, not an impossible one.
      return null;
    }
  }, [comp, stage]);

  /** The contain-fit projection used by the raw-screenshot layer and its tools. */
  const view = useMemo(() => {
    if (!src || !stage) return null;
    try {
      return fitView({ imageW: src.width, imageH: src.height, viewW: stage.w, viewH: stage.h });
    } catch (e) {
      return null;
    }
  }, [src, stage]);

  // --- the cross-fade ------------------------------------------------------
  //
  // The one piece of motion in the app. It exists because the two layers show
  // the same screenshot at different sizes and in different positions, and a
  // hard cut between them reads as the picture jumping.
  const raw = useSharedValue(0);
  const wants = ed ? canvasShows(ed) : 'card';
  useEffect(() => {
    raw.value = withTiming(wants === 'screenshot' ? 1 : 0, { duration: FADE_MS });
  }, [wants, raw]);
  const cardLayer = useAnimatedStyle(() => ({ opacity: 1 - raw.value }));
  const rawLayer = useAnimatedStyle(() => ({ opacity: raw.value }));

  // The stage's ground rides the same value as the two layers.
  //
  // `palette.stage` says what it is for in src/theme.js: "the ground behind
  // the image WHILE IT IS BEING CROPPED", dark on purpose so that Paper does
  // not tint the edges of a light screenshot and make the crop hard to judge.
  // It was painted under the finished card too, which is a different job and
  // the wrong answer for it: with Background = Paper the card came out light
  // on a full-width black slab, so the card looked like it had an enormous
  // black border. That was invisible for as long as anyone looked, because
  // the DEFAULT is Match and Match on this fixture samples near-black — the
  // slab and the card were the same colour. Found on a phone, on the first
  // run that changed the background away from the default.
  //
  // Interpolated rather than switched so it crosses with the fade instead of
  // snapping 160ms before or after it.
  const stageGround = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(raw.value, [0, 1], [palette.background, palette.stage]),
  }));

  // --- the picker ----------------------------------------------------------
  const recoverPicker = useCallback(
    (why) => {
      // __DEV__ is load-bearing, not decoration: DevSettings.reload exists in a
      // release build and is an empty function. See canReloadRuntime.
      const canReload = canReloadRuntime(DevSettings, __DEV__);
      const plan = recoveryPlan({ canReload, alreadyTried: recoveryUsed.current });
      emit('pick.recover', { why, action: plan.action, message: plan.message });
      if (plan.action !== 'reload') {
        // The release build lands here, and this is the branch that could never
        // be reached while the guard tested only for the method's existence.
        setProblem(COPY.pickerStale);
        return;
      }
      recoveryUsed.current = true;
      emit('pick.recover.reload', { resumeFlagWritten: writeResumeFlag() });
      DevSettings.reload();
    },
    [emit],
  );

  // Which import is the newest. Two can overlap -- a second share arriving
  // while the first is still decoding -- and without this the one that
  // FINISHES last wins, which is not the one that arrived last. The older one
  // is also the one whose file the native cleanup may already have deleted,
  // because it was not yet on screen to be kept. Found in review, 2026-09-22.
  const importGen = useRef(0);
  // The URI the editor is showing, for the native module's cache cleanup: it
  // deletes every earlier shared copy EXCEPT this one, because the export
  // reads the source file again and a card whose source was deleted cannot be
  // shared. Written in openImage, at the moment the editor commits to a file,
  // not in an effect after the render: an effect lags, and a take() in that
  // gap would be told to keep the previous file.
  const shownUri = useRef(null);
  // The card as it was last kept: at import, and after every Share, Save and
  // Copy. Back, New screenshot and a share-in ask before discarding only a card that differs
  // from it; see unsaved in src/shell.js for why Share counts as kept.
  const kept = useRef(null);
  // The editor as last rendered, for the share handler. It is subscribed once
  // (see the effect on `receive`), so a closure over `ed` would read the
  // first render's null for ever and never ask before replacing a card.
  const edRef = useRef(null);
  edRef.current = ed;

  /**
   * Decode `uri`, propose a crop, and open the editor on it. Both ways in end
   * here -- the picker and a share -- so they cannot drift into two imports
   * with two sets of rules. Returns whether the editor opened.
   */
  const openImage = useCallback(async (uri, via) => {
    const gen = ++importGen.current;
    try {
      const decoded = await decodeFromUri(uri);
      // The editor opens on a proposal, not on the whole screenshot. This is
      // the line that makes step 2 of the user flow true.
      const t0 = Date.now();
      const p = proposeFromImage(decoded.img, readRect);
      const proposeMs = Date.now() - t0;
      if (gen !== importGen.current) {
        emit('import.superseded', { via });
        return false;
      }

      // EVERYTHING ABOVE CAN THROW; EVERYTHING BELOW IS STATE. That order is
      // the fix for a real crash and not a tidy-up. `setSrc` used to run
      // first, so when the proposal threw the catch set `problem` and the
      // render still went on to read `ed.tool` with `ed` null — the bottom bar
      // keys off `src`, and `src` was now the only half of the pair that had
      // been committed. The app died with "Cannot read property 'tool' of
      // null", which names neither the throw nor the decode that caused it.
      //
      // Guarding the render with `ed &&` would have hidden that instead of
      // fixing it. The invariant worth having is that src and ed are set
      // together or not at all, so there is no state in which one exists
      // without the other for a guard to paper over.
      shownUri.current = uri;
      setSrc({ ...decoded, uri });
      setOverride(null);
      const opened = editorState(p.crop);
      setEd(opened);
      kept.current = cardOf(opened);
      setSampled(sampleCropBackground(decoded.img, p.crop));
      emit('crop.propose', {
        crop: p.crop,
        trimmed: p.trimmed,
        reasons: p.reasons,
        ms: proposeMs,
      });
      emit('decode', {
        w: decoded.width,
        h: decoded.height,
        mp: decoded.megapixels,
        rgbaMiB: decoded.rgbaMiB,
        decodeMs: decoded.decodeMs,
      });
      return true;
    } catch (e) {
      const superseded = gen !== importGen.current;
      emit('decode.error', { via, superseded, message: String(e && e.message ? e.message : e) });
      // A newer import has taken over, and this one's file may have been
      // deleted under it. Its failure is not news to anyone.
      if (!superseded) setProblem(via === 'share' ? COPY.sharedFailed : COPY.pickFailed);
      return false;
    }
  }, [emit]);

  const pick = useCallback(async () => {
    setProblem(null);
    setMenu(false);
    // The launch is INSIDE the boundary, and reports under its own label.
    //
    // It used to sit above the try, so its rejection escaped as an unhandled
    // promise and the button simply stopped working with nothing on screen. The
    // failure is real and reproduced on device: after the activity is recreated
    // (a font-scale or density change does it, and rotation cannot, because
    // `configChanges` absorbs rotation) `launchImageLibraryAsync` rejects with
    // "Attempting to launch an unregistered ActivityResultLauncher".
    //
    // Known dead: do not launch. The rejection is certain, and calling anyway
    // puts a scary stack trace in front of the owner on the way to the same
    // repair. The detector that sets this is the config-change effect below.
    if (staleLauncher) {
      recoverPicker('the activity was recreated, so the launcher is known to be unregistered');
      return;
    }

    let res;
    try {
      res = await ImagePicker.launchImageLibraryAsync({ quality: 1, exif: false });
    } catch (e) {
      const message = String(e && e.message ? e.message : e);
      // The detector above is not the only way in. It watches fontScale and
      // density because those are the recreations this build is known to suffer;
      // any other route to an unregistered launcher lands here instead, and gets
      // the same repair rather than an instruction to restart the app by hand.
      if (isStaleLauncherError(message)) {
        setStaleLauncher(true);
        emit('pick.error', { message, note: 'unregistered launcher; recovering' });
        recoverPicker('launchImageLibraryAsync rejected with an unregistered launcher');
        return;
      }
      emit('pick.error', { message, note: 'the picker did not open, and not because of the launcher' });
      setProblem(COPY.pickFailed);
      return;
    }
    if (res.canceled) return;
    await openImage(res.assets[0].uri, 'picker');
    // staleLauncher and recoverPicker belong here. With `[emit]` alone this
    // callback kept the first render's `staleLauncher: false` for the life of
    // the component, so the proactive branch above could never fire and every
    // recreation went the long way round: launch, reject, report, recover.
  }, [emit, staleLauncher, recoverPicker, openImage]);

  // --- receiving a share ---------------------------------------------------
  //
  // One receive at a time. Each take() deletes every shared copy but the one
  // on screen, so a second take() running while the first import is still
  // decoding would delete the file that import is about to show. Chaining them
  // means a take() only ever runs once the previous picture is on screen, or
  // has failed. Found in review, 2026-09-22.
  const receiving = useRef(Promise.resolve());

  // Counts take()s. A take deletes every shared copy but the one on screen, so
  // a Replace answered after a later take would open a file that is gone.
  const shareGen = useRef(0);

  const receiveOnce = useCallback(async (why) => {
    let answer = null;
    const gen = ++shareGen.current;
    try {
      answer = await takeShare(shownUri.current);
    } catch (e) {
      emit('share.error', { why, message: String(e && e.message ? e.message : e) });
      setProblem(COPY.sharedFailed);
      return;
    }
    const o = shareOutcome(answer, shareInAvailable);
    emit('share.in', {
      why,
      action: o.action,
      reason: o.reason ?? null,
      count: answer && answer.count != null ? answer.count : null,
      bytes: answer && answer.bytes != null ? answer.bytes : null,
    });
    if (o.action === 'ignore') return;
    if (o.action === 'problem') {
      setProblem(o.message);
      return;
    }
    // A share replaces whatever is on screen, open tool and menus included:
    // it is a deliberate act from another app, and there is nowhere to put it
    // aside until the person is done.
    const apply = async () => {
      setMenu(false);
      setDevOpen(false);
      setProblem(null);
      setNotice(null);
      const opened = await openImage(o.uri, 'share');
      if (opened && o.notice) setNotice(o.notice);
    };
    if (!unsaved(edRef.current, kept.current)) {
      await apply();
      return;
    }
    // Over a card with unsaved changes it asks first, by the same rule Back
    // and New screenshot use. Keep editing drops the share: its copy is not on
    // screen, so the next take cleans it up like any other.
    //
    // The ask does NOT hold the chain. It used to be awaited here, and a
    // dialog that never calls back (Android drops it when the activity is
    // recreated, say by a Display size change, and MainActivity restores no
    // state) left every later share queued behind it, silently, until the
    // app was killed. Found in review, 2026-09-23. Replace goes back on the
    // chain, so its import still never overlaps a take(); and it applies only
    // if no share has been taken since, because that take deleted this copy.
    Alert.alert(
      COPY.replaceCardTitle,
      COPY.replaceCardBody,
      [
        { text: COPY.keepEditing, style: 'cancel', onPress: () => emit('share.in.ask', { why, replace: false }) },
        {
          text: COPY.replace,
          style: 'destructive',
          onPress: () => {
            receiving.current = receiving.current.then(() => {
              const stale = gen !== shareGen.current;
              emit('share.in.ask', { why, replace: true, stale });
              return stale ? undefined : apply();
            }).catch((e) => emit('share.error', { why, message: String(e && e.message ? e.message : e) }));
          },
        },
      ],
      { cancelable: true, onDismiss: () => emit('share.in.ask', { why, replace: false }) },
    );
  }, [emit, openImage]);

  const receive = useCallback((why) => {
    // receiveOnce catches what it can throw, so the chain is not left
    // rejected; this catch is for whatever it did not see coming.
    receiving.current = receiving.current
      .then(() => receiveOnce(why))
      .catch((e) => emit('share.error', { why, message: String(e && e.message ? e.message : e) }));
    return receiving.current;
  }, [emit, receiveOnce]);

  // Once at launch, for a share that started the app, and then on every
  // share that arrives while it is running. The native module also catches a
  // share that recreates a destroyed activity; see its header for all three.
  useEffect(() => {
    receive('launch');
    return onShare(() => receive('event'));
  }, [receive]);

  // Ask once per mount whether a newer APK exists. Deliberately fire-and-forget:
  // nothing waits on it, nothing is blocked by it, and a failure is a log line.
  useEffect(() => {
    if (updateAsked.current) return;
    updateAsked.current = true;
    let live = true;
    // An APK downloaded by an earlier run is of no use to this one: it was
    // either installed, which is why this run exists, or abandoned. Clearing
    // it here is what stops 19 MB sitting in the cache for good.
    clearUpdate();
    (async () => {
      const r = await checkForUpdate();
      if (!live) return;
      emit('P0.updateCheck', { action: r.action, installed: installedVersionCode(), latest: r.latestVersionCode ?? null, reason: r.reason ?? null });
      // Put off with Later less than three days ago: the check still ran and
      // is still logged, the banner just stays down. See laterHides.
      if (r.action === 'update' && !laterHides(r, laterRecord(), Date.now())) setUpdate(r);
    })();
    return () => { live = false; };
  }, [emit]);

  // "Get it". In-app when this build has the updater and the manifest names a
  // sha256, otherwise the browser, as every release before 1.0.4 did; see
  // installRoute in src/update.js for why. Installing first is not a typo:
  // after the person backs out of Android's installer and taps again, the
  // checked APK is still in the cache, and a second 19 MB download would be
  // the only reason to wait.
  const getUpdate = useCallback(async (u) => {
    if (updateBusy.current) return;
    updateBusy.current = true;
    try {
      const route = installRoute(u, updaterAvailable);
      if (route !== 'app') {
        const ok = await openDownload(u.url);
        emit('P0.update', { route, opened: ok, url: ok ? u.url : 'refused' });
        return;
      }
      let installed = await installUpdate(u);
      if (installed.status !== 'ok' && (installed.reason === 'missing' || installed.reason === 'digest')) {
        updateCancelled.current = false;
        setUpdateStep({ percent: null });
        const got = await downloadUpdate(u, ({ bytes, total }) => {
          if (!updateCancelled.current) setUpdateStep({ percent: downloadPercent(bytes, total) });
        });
        emit('P0.update', { route, download: got.status, reason: got.reason ?? null });
        if (updateCancelled.current) {
          setUpdateStep(null);
          return;
        }
        if (got.status !== 'ok') {
          const problem = updateProblem(got.reason);
          setUpdateStep(problem ? { problem } : null);
          return;
        }
        if (updateDismissed.current) return;
        // Progress arrives every 256 KB, so the last one is usually short of
        // 100, and the caption would sit on "98%" while the file is re-checked.
        setUpdateStep({ percent: 100 });
        installed = await installUpdate(u);
      }
      emit('P0.updateInstall', { status: installed.status, reason: installed.reason ?? null });
      setUpdateStep(installed.status === 'ok' ? null : { problem: updateProblem(installed.reason) });
    } finally {
      updateBusy.current = false;
    }
  }, [emit]);

  // fontScale and density are the two configuration values MainActivity's
  // configChanges does not absorb, so a change to either recreates the activity
  // and kills the launcher while this runtime carries on running.
  //
  // Width and height are deliberately not watched. Rotation changes both and IS
  // absorbed, so watching them would report a dead launcher for the one
  // configuration change that cannot kill it.
  useEffect(() => {
    const next = { fontScale, scale: pixelScale };
    const prev = lastConfig.current;
    lastConfig.current = next;
    if (!launcherWentStale(prev, next)) return;
    setStaleLauncher(true);
    emit('pick.stale', { from: prev, to: next, note: 'activity recreated; the picker will recover on use' });
  }, [fontScale, pixelScale, emit]);

  // Finish the pick the previous runtime could not make.
  useEffect(() => {
    const flag = takeResumeFlag();
    const decision = resumeDecision(flag, Date.now());
    if (!flag) return;
    emit('pick.resume', { resume: decision.resume, reason: decision.reason });
    if (!decision.resume) return;
    // THIS runtime is the recovery. Marking it spent is what bounds the loop.
    recoveryUsed.current = true;
    pick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- the editor's own actions -------------------------------------------
  const open = useCallback((tool) => {
    setMenu(false);
    setProblem(null);
    setEd((s) => (s ? openTool(s, tool) : s));
  }, []);
  const toggle = useCallback((tool) => {
    setMenu(false);
    setEd((s) => (s ? (s.tool === tool ? doneTool(s) : openTool(s, tool)) : s));
  }, []);
  const done = useCallback(() => {
    setEd((s) => {
      if (!s) return s;
      // Resampled here rather than in an effect on `ed.crop`, which would fire
      // on every frame of the drag and read four strips sixty times a second.
      // Done is the moment the crop becomes the one the card is made from.
      if (s.tool === 'crop' && src) setSampled(sampleCropBackground(src.img, s.crop));
      return doneTool(s);
    });
  }, [src]);
  const cancel = useCallback(() => {
    setEd((s) => {
      if (!s) return s;
      const next = cancelTool(s);
      // Cancel restores a DIFFERENT crop from the one on screen a moment ago,
      // so the sample has to follow it. Forgetting this is a card framed in
      // the colour of a crop the user just threw away.
      if (s.tool === 'crop' && src) setSampled(sampleCropBackground(src.img, next.crop));
      return next;
    });
  }, [src]);
  const resetT = useCallback(() => setEd((s) => (s ? resetTool(s) : s)), []);

  /**
   * Build the card as a PNG at export resolution, and hand back the path.
   *
   * `trim: 'never'` on purpose. The status-bar trim now happens once, in the
   * proposal, where the user can see it and put it back with Reset. Leaving it
   * on here would let the export trim again under a crop the user chose, which
   * is the preview-disagrees-with-export failure this phase exists to remove.
   */
  const build = useCallback(async (outputName) => {
    if (!src || !ed) return null;
    const out = await renderCard({
      uri: src.uri,
      crop: ed.crop,
      padding: ed.padding,
      frame: ed.background,
      trim: 'never',
      outputName,
    });
    return out;
  }, [src, ed]);

  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  /**
   * Render the card for one of the ways out of the app, and report it.
   *
   * Share, Save and Copy all come through here, so for one editor state they
   * hand over one composition. Three copies of this would be three chances for
   * one of them to export a card the preview never showed, and the P4 check
   * below is what would notice.
   */
  const exportCard = useCallback(async (outputName) => {
    const out = await build(outputName);
    if (!out || out.error) {
      emit('P1.render.error', { error: out && out.error });
      setProblem(COPY.renderFailed);
      return null;
    }
    emit('P1.render', {
      out: out.width + 'x' + out.height,
      kiB: +(out.bytes / 1024).toFixed(1),
      frame: out.frame,
      fill: out.fill,
      fillSource: out.fillSource,
      sampling: out.sampling,
      surface: out.surface,
      crop: out.crop,
      dest: out.dest,
      pad: out.pad,
      warnings: out.warnings,
      timings: out.timings,
    });
    // The claim Phase 4.5 rests on, checked on the device rather than only
    // in src/compose.test.mjs: the card that was on screen and the card in
    // the file are one composition. Compared as ratios, because the two are
    // at different scales by design.
    if (shot) {
      emit('P4.sameComposition', {
        preview: { w: shot.width, h: shot.height, pad: shot.pad },
        exported: { w: out.width, h: out.height, pad: out.pad },
        aspectOff: +Math.abs(out.height / out.width - shot.height / shot.width).toFixed(5),
        padFracOff: +Math.abs(out.pad / out.width - shot.pad / shot.width).toFixed(5),
      });
    }
    return out;
  }, [build, shot, emit]);

  // Hand the PNG to the system sheet. The path the product exists for: this is
  // how a card reaches WhatsApp, and expo-sharing wraps the file in its own
  // FileProvider content URI, which is what ACTION_SEND needs.
  const share = useCallback(async () => {
    if (!src || !ed) return;
    setProblem(null);
    setNotice(null);
    setMenu(false);
    setBusy(true);
    try {
      // Asked, not assumed. A device with no sharing target throws from
      // shareAsync, and "nothing happened" is the worst possible answer.
      const can = await Sharing.isAvailableAsync();
      if (!can) {
        emit('P1.share', { ok: false, reason: 'no sharing target' });
        setProblem(COPY.shareFailed);
        return;
      }
      const out = await exportCard('card.png');
      if (!out) return;
      await Sharing.shareAsync(out.path, { mimeType: 'image/png', UTI: 'public.png' });
      kept.current = cardOf(ed);
      emit('P1.share', { ok: true, path: out.path });
    } catch (e) {
      emit('P1.share', { ok: false, message: String(e && e.message ? e.message : e) });
      setProblem(COPY.shareFailed);
    } finally {
      setBusy(false);
    }
  }, [src, ed, exportCard, emit]);

  /**
   * Save the card to Photos, which on Android means a MediaStore row in DCIM.
   *
   * WHY IT ASKS FOR NOTHING ON ANDROID 11 AND LATER. From API 30 an app may
   * insert its own image into MediaStore with no permission at all, and
   * expo-media-library's modern path does exactly that. A prompt for access
   * the app does not need is how a person learns to deny the one it does, so
   * the prompt exists only where the platform requires it.
   *
   * Android 10 and earlier need WRITE_EXTERNAL_STORAGE. If that is refused
   * the card goes to the share sheet instead, where the person can still save
   * it, rather than to a message telling them to go and change a setting.
   * That is Phase 5's "falls back to the share sheet silently".
   *
   * A file name per save, not `card.png`: MediaStore takes the display name
   * from the file, and a gallery of identically named cards can be told apart
   * by nothing but a thumbnail.
   */
  const save = useCallback(async () => {
    if (!src || !ed) return;
    setProblem(null);
    setNotice(null);
    setMenu(false);
    setBusy(true);
    let fallback = false;
    try {
      if (Platform.Version < 30) {
        const perm = await requestPermissionsAsync(true);
        // No `return` here. A return inside `try` runs `finally` and then
        // leaves the function, so the share fallback after the try/finally
        // never ran: the first version of this did exactly that, and logged
        // `fallback: 'share'` for a sheet that never opened. Found in review
        // on 2026-09-22; nothing had run it, since the test phone is API 37.
        if (!perm.granted) {
          emit('P5.save', { ok: false, reason: 'permission', api: Platform.Version, fallback: 'share' });
          fallback = true;
        }
      }
      if (!fallback) {
        const out = await exportCard(savedName(new Date()));
        if (!out) return;
        const asset = await Asset.create(out.path);
        // MediaStore holds its own copy now. The one in the cache has a name
        // per save, so unlike Share's card.png nothing ever overwrites it, and
        // without this every save left one behind. A failure here costs cache
        // space only, never the save, so it is not reported as one.
        try {
          new File(out.path).delete();
        } catch {
          // Deliberately empty; see above.
        }
        kept.current = cardOf(ed);
        emit('P5.save', { ok: true, api: Platform.Version, id: asset.id });
        setNotice(COPY.saved);
      }
    } catch (e) {
      emit('P5.save', { ok: false, api: Platform.Version, message: String(e && e.message ? e.message : e) });
      setProblem(COPY.saveFailed);
    } finally {
      setBusy(false);
    }
    if (fallback) await share();
  }, [src, ed, exportCard, share, emit]);

  /**
   * Put the card on the clipboard as an image.
   *
   * No "Copied" from the app on Android 13 and later, because the system shows
   * its own clipboard preview there and two confirmations of one copy read as
   * two copies. Below 13 nothing else says it happened, so the app does.
   *
   * `base64()` is the async one. expo-file-system has a sync twin, and calling
   * an AsyncFunction as if it were sync is a mistake this codebase has already
   * made once; tools/check-fs-sync.mjs is the gate for it.
   */
  const copyImage = useCallback(async () => {
    if (!src || !ed) return;
    setProblem(null);
    setNotice(null);
    setMenu(false);
    setBusy(true);
    try {
      const out = await exportCard('card.png');
      if (!out) return;
      const png = new File(out.path);
      const b64 = await png.base64();
      await Clipboard.setImageAsync(b64);
      kept.current = cardOf(ed);
      emit('P5.copy', { ok: true, api: Platform.Version, kiB: +(out.bytes / 1024).toFixed(1) });
      if (Platform.Version < 33) setNotice(COPY.copied);
    } catch (e) {
      emit('P5.copy', { ok: false, api: Platform.Version, message: String(e && e.message ? e.message : e) });
      setProblem(COPY.copyFailed);
    } finally {
      setBusy(false);
    }
  }, [src, ed, exportCard, emit]);

  // --- gestures on the raw layer ------------------------------------------
  //
  // The crop works in IMAGE pixels, so the rect that reaches `ed` is the rect
  // the renderer will use.
  //
  // THE CROP DRAG RUNS ON THE UI THREAD AND `ed` IS WRITTEN ONCE, ON RELEASE.
  // It used to run with `.runOnJS(true)` and call `setEd` on every frame. The
  // comment that stood here said a shared value "would be faster and would be
  // a second copy of the crop", and chose the copy-free version. The owner
  // then used the build and said the drag was not as smooth as expected, which
  // settles it: every finger movement was a thread hop, a re-render of the
  // whole app, a fresh `shot` plan, and a Skia recompose of the card canvas —
  // a canvas sitting at opacity 0, because a takeover tool is showing the raw
  // layer. The invisible layer was the expensive one.
  //
  // `liveCrop` is the second copy, and the rule that keeps it from drifting is
  // that it is a DRAG BUFFER, not a parallel source of truth:
  //
  //   - `ed.crop` is authoritative, and is the only thing the card, the export
  //     and every module downstream ever read.
  //   - `liveCrop` is what the overlay draws while a finger is down, and it is
  //     written from `ed.crop` whenever `ed.crop` changes for any other
  //     reason — a new image, Reset, a new screenshot, an auto-proposal.
  //   - Exactly one write flows the other way, in `onFinalize`, and after it
  //     the effect below writes the same value straight back.
  //
  // So the two can only disagree during a gesture, which is the interval in
  // which nothing reads `ed.crop`.
  const liveCrop = useSharedValue(null);
  const grabbed = useSharedValue(null);
  const dragFrom = useSharedValue(null);
  // 1 while a handle is held, 0 otherwise, and it is a SEPARATE value from
  // `grabbed` rather than derived from it: `grabbed` has to flip the instant
  // the finger lands or the first frame of the drag uses a stale handle, and
  // this one has to take 120ms to get there. One value cannot be both.
  const gridOn = useSharedValue(0);

  useEffect(() => {
    liveCrop.value = ed ? ed.crop : null;
  }, [ed, liveCrop]);

  const commitCrop = useCallback((next) => {
    setEd((s) => (s ? { ...s, crop: next } : s));
  }, []);

  // Read off `src` here, in the render, rather than inside a worklet: a
  // worklet captures what it closes over by value at creation, and a Skia
  // image is not serialisable across the boundary. Plain numbers are.
  //
  // ONE rect, not one per consumer. The gesture and the band overlay both
  // need the image's extent, and two `{ x: 0, y: 0, w: src.width, h:
  // src.height }` literals is the two-copies defect at its smallest and
  // easiest to miss -- they cannot disagree today and they can the moment one
  // of them learns about, say, a rotation.
  const imageBounds = useMemo(
    () => (src ? { x: 0, y: 0, w: src.width, h: src.height } : null),
    [src],
  );

  const cropGesture = useMemo(() => {
    const bounds = imageBounds;

    // A TAP, RACED AGAINST THE PAN, and the race is what makes both possible
    // from one detector. A tap needs the finger to go down and up without
    // travelling; the pan needs it to travel. Whichever condition is met
    // first wins and the other is cancelled, so reclaiming a band never
    // fires at the end of a drag and a drag never has to wait for a tap to
    // time out. `Gesture.Exclusive` would not do: it decides by the order
    // the two are written in, and the pan activates for a finger that
    // grabbed nothing.
    const reclaim = Gesture.Tap().onEnd((e) => {
      'worklet';
      const cur = liveCrop.value;
      if (!view || !bounds || !cur) return;
      // The frame's own 48pt grab zone comes first. A tap just outside the
      // top edge is a miss at the handle, not a request to undo the trim.
      if (pickHandle({ x: e.x, y: e.y }, cur, view)) return;
      const edge = pickBand(toImagePoint(view, { x: e.x, y: e.y }), bounds, cur);
      if (!edge) return;
      const next = expandToEdge(cur, edge, bounds);
      // Both, in this order. `liveCrop` so the overlay moves on this frame,
      // and `ed.crop` because that is what the card and the export read; the
      // effect above then writes the same value back and they agree.
      liveCrop.value = next;
      runOnJS(commitCrop)(next);
    });

    return Gesture.Race(
      reclaim,
      Gesture.Pan()
        .onBegin((e) => {
          'worklet';
          const start = liveCrop.value;
          if (!view || !bounds || !start) return;
          const h = pickHandle({ x: e.x, y: e.y }, start, view);
          grabbed.value = h;
          dragFrom.value = h ? start : null;
          // Only when something was actually grabbed. A finger landing outside
          // the frame is not a drag, and flashing the thirds at it would say
          // it was.
          if (h) gridOn.value = withTiming(1, { duration: GRID_MS });
        })
        // translationX, not changeX. crop.js's header says deltas are measured
        // from the gesture start and applied to the rect as it was then; the
        // old code passed per-frame changes and advanced its own start on each
        // one, which is the accumulating-rounding version that header warns
        // about. Total-from-start is idempotent, so a dropped frame costs
        // nothing — and it is the reason `dragFrom` is never reassigned here.
        .onChange((e) => {
          'worklet';
          if (!grabbed.value || !dragFrom.value || !bounds || !view) return;
          const d = toImageDelta(view, { dx: e.translationX, dy: e.translationY });
          liveCrop.value = dragCrop({
            start: dragFrom.value,
            handle: grabbed.value,
            dx: d.dx,
            dy: d.dy,
            bounds,
            min: MIN_CROP,
          });
        })
        // onFinalize, not onEnd: a gesture cancelled by a system takeover — a
        // notification shade, a call — still has to put the rect it left on
        // screen into `ed`, or the overlay and the card disagree until the
        // next drag.
        .onFinalize(() => {
          'worklet';
          if (grabbed.value && liveCrop.value) runOnJS(commitCrop)(liveCrop.value);
          grabbed.value = null;
          dragFrom.value = null;
          gridOn.value = withTiming(0, { duration: GRID_MS });
        }),
    );
    // `ed` is deliberately NOT a dependency. It used to be, so every frame of
    // the old drag rebuilt the Gesture object it was in the middle of.
  }, [view, imageBounds, commitCrop, liveCrop, grabbed, dragFrom, gridOn]);

  // --- the dev harness ----------------------------------------------------
  //
  // Q1, the ring around a drawn box, is not here: it measured the Cover tool,
  // which was cut on 2026-09-22 and was the only source of a box. Q2 through Q5
  // measure what they always did.
  const measureCheap = useCallback(() => {
    if (!src) return;
    const sb = measureStatusBar(src.img, 400);
    emit('Q3.statusbar', {
      detected: sb.detected,
      reason: sb.reason,
      cut: sb.cut,
      cutFraction: sb.cutFraction,
      zones: sb.zones,
      looksLikeStatusBar: sb.looksLikeStatusBar,
      shapeReasons: sb.shapeReasons,
      shouldTrim: sb.shouldTrim,
      readMs: sb.readMs,
      profileMs: sb.profileMs,
      head16: sb.profileHead ? sb.profileHead.slice(0, 16) : null,
    });
  }, [src, emit]);

  const compose = useCallback(
    (colorSpace) => {
      if (!src) return;
      const crop = { x: 0, y: 0, w: src.width, h: src.height };
      const pad = Math.max(12, Math.round(crop.w * 0.06 / 2) * 2);
      // Background is Paper here on purpose: this times the composite and the
      // encode, and edge-sampled backgrounds are Phase 1's job.
      const out = composeAndEncode(src.img, crop, pad, PAPER, colorSpace);
      if (out.error) {
        emit('Q2.error', out);
        return;
      }
      setOverride(out.snapshot);
      emit('Q2.compose', {
        space: colorSpace ? 'DisplayP3' : 'sRGB',
        out: out.outW + 'x' + out.outH,
        mp: out.outMegapixels,
        pad,
        pngKiB: +(out.pngBytes / 1024).toFixed(1),
        totalMs: out.totalMs,
        steps: out.steps,
      });
      const region = {
        x: Math.round(out.outW * 0.25),
        y: Math.round(out.outH * 0.25),
        w: Math.min(200, Math.round(out.outW * 0.4)),
        h: Math.min(200, Math.round(out.outH * 0.4)),
      };
      emit('Q4.roundtrip', measureRoundTrip(out.png, out.snapshot, region));
    },
    [src, emit],
  );

  const render = useCallback(
    async (space) => {
      if (!src || !ed) return;
      const gen = importGen.current;
      setProblem(null);
      setBusy(true);
      try {
        const t0 = Date.now();
        const out = await renderCard({
          uri: src.uri,
          crop: ed.crop,
          padding: ed.padding,
          frame: ed.background,
          trim: 'never',
          colorSpace: space,
          // Distinct names so the two cards coexist on disk: Q4 is a comparison
          // of their iCCP chunks, and one overwriting the other leaves nothing
          // to compare.
          outputName: space ? 'card-p3.png' : 'card.png',
        });
        const wallMs = Date.now() - t0;
        if (out.error) {
          emit('P1.render.error', { error: out.error, plan: out.plan && out.plan.width });
          setProblem(COPY.renderFailed);
          return;
        }
        // Read the file back rather than trusting the return value. A wrong
        // width here means the encode and the plan disagree; a throw means the
        // bytes on disk are not a PNG.
        const back = await decodeUri(out.path);
        // Dev only, and the same race as openImage's: an import that landed
        // during the await must not be covered by the previous image's card.
        if (gen !== importGen.current) return;
        setOverride(back);
        emit('P1.render', {
          path: out.path,
          space: space ? 'DisplayP3' : 'sRGB',
          out: out.width + 'x' + out.height,
          fileBack: back.width() + 'x' + back.height(),
          kiB: +(out.bytes / 1024).toFixed(1),
          fill: out.fill,
          fillSource: out.fillSource,
          frame: out.frame,
          crop: out.crop,
          dest: out.dest,
          pad: out.pad,
          trimmed: out.trimmed,
          warnings: out.warnings,
          timings: out.timings,
          wallMs,
        });
      } catch (e) {
        emit('P1.render.throw', { message: String(e && e.message ? e.message : e) });
        setProblem(COPY.renderFailed);
      } finally {
        setBusy(false);
      }
    },
    [src, ed, emit],
  );

  const stress = useCallback(() => {
    if (!src) return;
    emit('Q5.fullread', stressFullRead(src.img));
  }, [src, emit]);

  const clearEditor = useCallback(() => {
    setSrc(null);
    setEd(null);
    setSampled(null);
    setOverride(null);
    setProblem(null);
    setMenu(false);
  }, []);

  // Keep editing is the cancel button, so tapping outside the dialog or
  // pressing Back on it keeps the card too. Only the button that names the
  // loss can cause it.
  //
  // And only for the card it asked about. A share can arrive while this is
  // open and replace the card from its own dialog on top; Discard tapped on
  // this one afterwards would then wipe the card just shared (or, from New
  // screenshot, open the picker over it). Found in review, 2026-09-23.
  const confirmDiscard = useCallback((title, body, onDiscard) => {
    const asked = shownUri.current;
    Alert.alert(
      title,
      body,
      [
        { text: COPY.keepEditing, style: 'cancel' },
        {
          text: COPY.discard,
          style: 'destructive',
          onPress: () => {
            if (shownUri.current === asked) onDiscard();
            else emit('discard.stale', {});
          },
        },
      ],
      { cancelable: true },
    );
  }, [emit]);

  // Another screenshot, from the editor, in one tap. It asks before the
  // picker rather than after it: a picker cancelled after Discard leaves the
  // card where it was, because nothing replaced it, which is the safe way
  // round. Replaces Start over, whose other job Back now does.
  const newShot = useCallback(() => {
    setMenu(false);
    if (unsaved(ed, kept.current)) confirmDiscard(COPY.discardCardTitle, COPY.discardCardBody, pick);
    else pick();
  }, [ed, confirmDiscard, pick]);

  // Android's Back, one layer at a time. Before this there was no handler, so
  // Back closed the activity and the card went with it, unasked. The order
  // and the reasons are backAction's, in src/shell.js; this only carries
  // them out. Returning false is the one case Android should handle itself.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const a = backAction(ed, { menu, dev: devOpen, busy, kept: kept.current });
      emit('back', { action: a });
      if (a === 'exit') return false;
      if (a === 'close-dev') setDevOpen(false);
      else if (a === 'close-menu') setMenu(false);
      else if (a === 'cancel-tool') cancel();
      else if (a === 'ask-tool') confirmDiscard(COPY.discardCropTitle, COPY.discardCropBody, cancel);
      else if (a === 'close-tool') setEd((s) => (s ? doneTool(s) : s));
      else if (a === 'ask') confirmDiscard(COPY.discardCardTitle, COPY.discardCardBody, clearEditor);
      else if (a === 'leave') clearEditor();
      return true;
    });
    return () => sub.remove();
  }, [ed, menu, devOpen, busy, cancel, clearEditor, confirmDiscard, emit]);

  // --- what the caption says ----------------------------------------------
  let caption = '';
  if (problem) caption = problem;
  else if (busy) caption = COPY.working;
  else if (notice) caption = notice;
  else if (ed && ed.tool === 'crop') caption = COPY.cropHint;
  // Nothing at rest. It used to carry the export's size, "1080 by 2173",
  // which nobody holding the app acts on (the owner's call, 2026-09-23). The
  // strip keeps its height when empty, so the layout does not jump and the
  // long press into Developer tools still has somewhere to land.

  const mode = ed ? barMode(ed) : 'main';
  const takeover = mode === 'takeover';
  const stops = padStops();
  // Labels keyed by the name the module uses, not a second list of tools in a
  // second order. The ORDER comes from src/shell.js's TOOLS; this only says
  // what each one is called, and naming each key here is also what lets
  // tools/check-copy.mjs see that the string is used.
  const toolLabel = { crop: COPY.crop, style: COPY.style };
  const stopLabel = { snug: COPY.snug, standard: COPY.standard, roomy: COPY.roomy };
  const frameLabel = { match: COPY.matchFrame, paper: COPY.paperFrame, ink: COPY.inkFrame };

  return (
    <GestureHandlerRootView style={[styles.root, { backgroundColor: palette.background }]}>
      {update ? (
        <View style={[styles.update, { backgroundColor: palette.surface, borderColor: palette.signal }]}>
          <Text style={[styles.updateTitle, { color: palette.text }]}>
            {fill(COPY.updateTitle, { version: update.versionName })}
          </Text>
          {update.notes ? (
            <Text style={[styles.updateNotes, { color: palette.graphite }]}>{update.notes}</Text>
          ) : null}
          {updateStep ? (
            <Text
              style={[styles.updateNotes, { color: palette.text }]}
              accessibilityLiveRegion="polite"
            >
              {updateStep.problem
                ?? (updateStep.percent === null
                  ? COPY.updateStarting
                  : fill(COPY.updateDownloading, { percent: updateStep.percent }))}
            </Text>
          ) : null}
          <View style={styles.updateRow}>
            <Action
              label={COPY.updateGet}
              palette={palette}
              primary
              disabled={Boolean(updateStep && !updateStep.problem)}
              onPress={() => getUpdate(update)}
            />
            {/* While it downloads, the way out is Cancel, not Later. Before
                this there was no way to stop 19 MB once started: Later hid
                the banner and left the download running. */}
            {updateStep && !updateStep.problem && updateStep.percent !== 100 ? (
              <Action
                label={COPY.cancel}
                palette={palette}
                onPress={() => {
                  updateCancelled.current = true;
                  cancelUpdate();
                  setUpdateStep(null);
                }}
              />
            ) : (
              <Action
                label={COPY.updateLater}
                palette={palette}
                onPress={() => {
                  updateDismissed.current = true;
                  rememberLater(update);
                  setUpdate(null);
                }}
              />
            )}
          </View>
        </View>
      ) : null}

      {/* The stage paints a ground only once there is an image on it, and
          which ground depends on what is being shown — see `stageGround`.
          Empty, the dark one was a full-height black slab with one line of
          grey text at the top, which reads as a broken viewport rather than
          as an empty app. It was also unreadable: the stage colour is dark in
          BOTH themes, so in light mode that line was light-Graphite on Ink at
          2.37:1. */}
      <Animated.View
        style={[styles.stage, src ? stageGround : null]}
        onLayout={onStageLayout}
      >
        {!src ? (
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: palette.graphite }]}>{COPY.emptyTitle}</Text>
          </View>
        ) : null}

        {/* Layer one: the card, exactly as it will export. */}
        {src && stage && shot && fillColour && !override ? (
          <Animated.View style={[StyleSheet.absoluteFill, cardLayer]} pointerEvents="none">
            <Canvas style={{ width: stage.w, height: stage.h }}>
              <Group transform={[{ translateX: shot.offX }, { translateY: shot.offY }]}>
                <Rect x={0} y={0} width={shot.width} height={shot.height} color={fillColour} />
                {/* The image is clipped to the destination and drawn
                    scaled so that the CROP lands on it. Skia's Image has no
                    source rect, so the placement does that job: the whole
                    picture is scaled and positioned, and the clip keeps the
                    part that belongs in the card. */}
                <Group clip={skRect(shot.dest.x, shot.dest.y, shot.dest.w, shot.dest.h)}>
                  <SkiaImage
                    image={src.img}
                    fit="fill"
                    x={shot.dest.x - ed.crop.x * (shot.dest.w / ed.crop.w)}
                    y={shot.dest.y - ed.crop.y * (shot.dest.h / ed.crop.h)}
                    width={src.width * (shot.dest.w / ed.crop.w)}
                    height={src.height * (shot.dest.h / ed.crop.h)}
                  />
                </Group>
              </Group>
            </Canvas>
          </Animated.View>
        ) : null}

        {/* The dev harness's own image, when it has put one there. */}
        {src && stage && override ? (
          <Canvas style={{ width: stage.w, height: stage.h }}>
            <SkiaImage image={override} x={0} y={0} width={stage.w} height={stage.h} fit="contain" />
          </Canvas>
        ) : null}

        {/* Layer two: the raw screenshot, which is what a takeover tool edits. */}
        {src && stage && view && !override ? (
          <Animated.View
            style={[StyleSheet.absoluteFill, rawLayer]}
            pointerEvents={takeover ? 'auto' : 'none'}
          >
            <Canvas style={{ width: stage.w, height: stage.h }}>
              <SkiaImage image={src.img} x={0} y={0} width={stage.w} height={stage.h} fit="contain" />
            </Canvas>
            {ed && ed.tool === 'crop' ? (
              <GestureDetector gesture={cropGesture}>
                <View style={StyleSheet.absoluteFill}>
                  {/* The shared value, not `ed.crop`. Passing the rect would
                      put the projection back in the render and undo the whole
                      change: React would have to re-render to move the frame. */}
                  <Scrim crop={liveCrop} view={view} stage={stage} />
                  <CropBands crop={liveCrop} view={view} bounds={imageBounds} on={gridOn} />
                  <CropGrid crop={liveCrop} view={view} on={gridOn} />
                  <CropFrame crop={liveCrop} view={view} stage={stage} />
                  <CropLoupe
                    crop={liveCrop}
                    view={view}
                    stage={stage}
                    image={src.img}
                    handle={grabbed}
                    on={gridOn}
                  />
                </View>
              </GestureDetector>
            ) : null}
          </Animated.View>
        ) : null}
      </Animated.View>

      {/* The way in to the measurement harness, and the only thing on this
          screen that is not for a person using the app. A long press rather
          than a control, because a visible button would be the first thing to
          make this look like a tool again. Documented in the README. */}
      {/* Not a TalkBack stop while it says nothing: at rest the caption is
          empty, and an empty stop reads as a control with no name. The long
          press still works for a sighted developer either way. */}
      <Pressable
        onLongPress={() => setDevOpen(true)}
        delayLongPress={800}
        style={styles.captionWrap}
        accessible={caption !== ''}
      >
        {/* A live region, so TalkBack reads "Saved to Photos" and every problem
            aloud. On Android 13 and later that caption is Save's only
            confirmation, and before this nothing announced it. Only for those
            two: the crop hint also lives here, and a live region would read it
            out every time Crop opens. */}
        <Text
          style={[styles.caption, { color: problem ? palette.text : palette.graphite }]}
          accessibilityLiveRegion={problem || notice ? 'polite' : 'none'}
        >
          {caption}
        </Text>
      </Pressable>

      {ed && ed.tool === 'style' ? (
        <StyleStrip
          ed={ed}
          setEd={setEd}
          palette={palette}
          stops={stops}
          stopLabel={stopLabel}
          frameLabel={frameLabel}
          canReset={canReset(ed)}
          onReset={resetT}
          onDone={done}
        />
      ) : null}

      {menu ? (
        <View style={[styles.menu, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
          {/* Save is on the bar and no longer here. Developer tools is not
              here either: it is for us, not for the people Twitwa is handed
              to, and the long press on the caption is its way in. */}
          {src && ed && !busy ? (
            <MenuItem label={COPY.copyImage} palette={palette} onPress={copyImage} />
          ) : null}
          <MenuItem label={COPY.newShot} palette={palette} onPress={newShot} />
        </View>
      ) : null}

      {!src ? (
        <View style={styles.bar}>
          <Action label={COPY.choose} palette={palette} primary wide onPress={pick} />
        </View>
      ) : takeover ? (
        <View style={styles.bar}>
          <Action label={COPY.cancel} palette={palette} onPress={cancel} />
          <Action label={COPY.reset} palette={palette} disabled={!canReset(ed)} onPress={resetT} />
          <Action label={COPY.done} palette={palette} primary onPress={done} />
        </View>
      ) : (
        <>
          <View style={styles.tools}>
            {TOOLS.map((t) => (
              <Action
                key={t}
                label={toolLabel[t]}
                palette={palette}
                selected={ed.tool === t}
                onPress={() => (TOOL[t].takeover ? open(t) : toggle(t))}
              />
            ))}
          </View>
          <View style={styles.bar}>
            <Action label={COPY.share} palette={palette} primary wide disabled={busy} onPress={share} />
            {/* Save beside Share, and only here. The owner asked for it on
                the share sheet itself; Android lets an app add its own action
                there only from 14 on, and expo-sharing cannot, so it is here. */}
            <Action label={COPY.saveShort} palette={palette} disabled={busy} onPress={save} />
            {/* Disabled while busy, as Share is. Open during an export, the menu
                lacked Copy with no reason given, and leaving the card from it
                let "Saved to Photos" land on the empty screen. */}
            <Action label={COPY.more} palette={palette} selected={menu} disabled={busy} onPress={() => setMenu((v) => !v)} />
          </View>
        </>
      )}

      {devOpen ? (
        <DevPanel
          palette={palette}
          log={log}
          src={src}
          override={Boolean(override)}
          scheme={scheme}
          onMeasureCheap={measureCheap}
          onStress={stress}
          onCompose={compose}
          onRender={render}
          onBackToSource={() => setOverride(null)}
          onClose={() => setDevOpen(false)}
          title={COPY.devTitle}
          hint={COPY.devHint}
          closeLabel={COPY.close}
        />
      ) : null}
    </GestureHandlerRootView>
  );
}

/**
 * What the crop overlay draws before a crop exists.
 *
 * Never seen — the overlay only mounts under `ed.tool === 'crop'`, and there
 * is no editor without a crop — but the two overlay components read a shared
 * value that is null between images, and a worklet that throws takes the UI
 * thread with it.
 */
const ZERO_RECT = { x: 0, y: 0, w: 0, h: 0 };

/**
 * How long the rule-of-thirds grid takes to appear and go again.
 *
 * SHORTER THAN `FADE_MS` ON PURPOSE, and this is the app's second piece of
 * motion after the canvas cross-fade, which the aesthetic notes call "the one
 * piece of motion". The exception is argued rather than taken: the cross-fade
 * is the app moving by itself between two views, and 160ms is a transition a
 * person watches. This is a finger going down. It is bound to the touch, it
 * has to be over before the drag is, and a hard cut at finger-up reads as a
 * flicker rather than as an end. 120 is under the cross-fade so the two cannot
 * be mistaken for the same gesture.
 *
 * NOT YET SEEN ON A DEVICE. Whether 120 is right is a judgement about motion,
 * and nothing in this repo can make it.
 */
const GRID_MS = 120;
// How long an outcome such as "Saved to Photos" stays in the caption. Long
// enough to read a three-word sentence twice, short enough that the card's
// size is back before the next thing anyone does.
const NOTICE_MS = 2500;

/**
 * The loupe's size, its inset from the stage's corner, and how many POINTS
 * one image pixel is magnified to.
 *
 * `LOUPE_ZOOM` is not a magnification. `loupeScale` turns it into one using
 * the projection, so this number stays meaningful across screenshot widths:
 * 2 says "one image pixel is two points across", which is the smallest thing
 * a thumb can be aligned against. 112 is four of those pixels either side of
 * the crosshair at a 1080-wide capture in this stage -- enough context to see
 * an edge, small enough not to be the screen.
 */
const LOUPE = 112;
const LOUPE_GAP = 12;
const LOUPE_ZOOM = 2;

/**
 * The drag handles' diameters. Corners are bigger than edge midpoints because
 * a corner moves two edges and is the handle most people reach for; both sit
 * inside the TOUCH-sized hit target pickHandle uses, so the dot is what the
 * handle looks like, not how big it is to a thumb.
 */
const CORNER_DOT = 18;
const EDGE_DOT = 12;

/**
 * The four bands of darkness outside the crop.
 *
 * Four Views rather than one with a hole in it, because there is no hole: a
 * border cannot be transparent inside and a shadow cannot be a cut-out. Every
 * crop surface surveyed dims the outside this way, and the alternative — a
 * bright frame on undimmed pixels — leaves the user reading the whole
 * screenshot rather than the part they chose.
 */
function Scrim({ crop, view, stage }) {
  // Four hooks, unconditionally, one per band. Reanimated updates these on the
  // UI thread from `crop`, so a drag never reaches React at all — which is the
  // whole point of the change and the reason the bands cannot be a `.map`.
  const top = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    return { left: 0, top: 0, width: stage.w, height: Math.max(0, r.y) };
  });
  const bottom = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    const b = r.y + r.h;
    return { left: 0, top: b, width: stage.w, height: Math.max(0, stage.h - b) };
  });
  const left = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    return { left: 0, top: r.y, width: Math.max(0, r.x), height: Math.max(0, r.h) };
  });
  const right = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    const x = r.x + r.w;
    return { left: x, top: r.y, width: Math.max(0, stage.w - x), height: Math.max(0, r.h) };
  });
  return (
    <>
      <Animated.View style={[styles.scrim, top]} />
      <Animated.View style={[styles.scrim, bottom]} />
      <Animated.View style={[styles.scrim, left]} />
      <Animated.View style={[styles.scrim, right]} />
    </>
  );
}

/**
 * The crop rectangle: a hairline, a dot on each corner and one on each edge.
 *
 * Dots, and at all eight handles, at the owner's request (2026-09-23): the
 * corner brackets read as boxy, and gave no sign that the edge midpoints can
 * be dragged at all. BUILD-PLAN.md recorded the survey's case for brackets
 * (a frame, not a selected object); the owner weighed it and chose the dots.
 */
function CropFrame({ crop, view, stage }) {
  // Only position follows the finger, as in Scrim; each dot is its own
  // component so each has exactly one hook.
  const edge = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    return { left: r.x, top: r.y, width: r.w, height: r.h };
  });
  return (
    <>
      <Animated.View style={[styles.cropEdge, edge]} />
      {HANDLE_DOTS.map(([fx, fy]) => (
        <CropDot key={`${fx},${fy}`} crop={crop} view={view} stage={stage} fx={fx} fy={fy} />
      ))}
    </>
  );
}

/**
 * Where each dot sits, as a fraction of the crop's width and height. Corners
 * are the pairs of 0 and 1; a 0.5 is an edge midpoint. Eight, one per
 * resizing handle in src/crop.js's HANDLES (`move` has no dot: it is the
 * whole inside).
 */
const HANDLE_DOTS = [
  [0, 0], [0.5, 0], [1, 0],
  [1, 0.5], [1, 1], [0.5, 1],
  [0, 1], [0, 0.5],
];

function CropDot({ crop, view, stage, fx, fy }) {
  const size = fx === 0.5 || fy === 0.5 ? EDGE_DOT : CORNER_DOT;
  const maxX = stage.w - size;
  const maxY = stage.h - size;
  const at = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    // Centred on the handle, but never past the stage: the stage clips (it
    // has rounded corners), and a screenshot that fills it puts a crop at
    // the image edge on the stage edge, where a centred dot is cut in half.
    // Found in review, 2026-09-23. The brackets never had this, because they
    // were drawn inside the frame.
    const x = Math.min(Math.max(r.x + r.w * fx - size / 2, 0), maxX);
    const y = Math.min(Math.max(r.y + r.h * fy - size / 2, 0), maxY);
    return { left: x, top: y };
  });
  return (
    <Animated.View
      style={[styles.cropDot, { width: size, height: size, borderRadius: size / 2 }, at]}
    />
  );
}

/**
 * Rule of thirds, while a finger is down and not at rest.
 *
 * Every surveyed crop surface that has a grid shows it this way (X, Binance),
 * and the ones that do not show a grid show only the frame when idle -- which
 * is what this already does. A grid drawn at rest turns the frame into a
 * viewfinder and competes with the screenshot underneath it, which is the
 * thing being judged.
 *
 * `on` is a shared value, so the grid appears and goes without a React render,
 * the same reason `crop` is one. Four hooks rather than a loop because hooks
 * cannot be called in one.
 *
 * The lines carry the handle dots' treatment -- white with a dark outline
 * -- for the reason written on `cropDot`: a single-colour hairline over
 * arbitrary screenshot pixels is invisible against some of them, and a grid
 * that vanishes on a pale screenshot is worse than no grid, because the user
 * cannot tell it from a grid that never appeared.
 */
function CropGrid({ crop, view, on }) {
  const v1 = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    return { left: r.x + r.w / 3, top: r.y, height: r.h, opacity: on.value };
  });
  const v2 = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    return { left: r.x + (r.w * 2) / 3, top: r.y, height: r.h, opacity: on.value };
  });
  const h1 = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    return { left: r.x, top: r.y + r.h / 3, width: r.w, opacity: on.value };
  });
  const h2 = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    return { left: r.x, top: r.y + (r.h * 2) / 3, width: r.w, opacity: on.value };
  });
  return (
    <>
      <Animated.View style={[styles.gridV, v1]} />
      <Animated.View style={[styles.gridV, v2]} />
      <Animated.View style={[styles.gridH, h1]} />
      <Animated.View style={[styles.gridH, h2]} />
    </>
  );
}

/**
 * One band's position, or nothing. Shared by the four hooks below so the
 * arithmetic exists once; a hook cannot be called in a loop, but the worklet
 * inside it can.
 */
function bandStyle(edge, crop, bounds, view, on) {
  'worklet';
  const b = crop && bounds ? edgeBand(edge, bounds, crop) : null;
  if (!b) return { opacity: 0, left: 0, top: 0, width: 0, height: 0 };
  const r = toViewportRect(view, b);
  return { left: r.x, top: r.y, width: r.w, height: r.h, opacity: 1 - on };
}

/**
 * The strips the auto-proposed crop is leaving out, and the way to take one back.
 *
 * WHAT THE USER SEES. The editor opens on a proposal, so on almost every
 * screenshot there is already a band above the frame holding the status bar
 * and whatever flat space was above the post. Until now the only evidence of
 * that was that the frame did not start at the top, and the only way back was
 * Reset, which throws away the whole proposal including the parts that were
 * right.
 *
 * WHY NOT A BUTTON. Every surveyed app auto-proposes and every one of them
 * puts the undo where the thing was removed, because a chip in a bar cannot
 * say WHICH edge it means and this can. It is also the answer to Phase 2's
 * "status bar shown as an excluded band that can be dragged back in": the
 * status bar is the visible case of a general rule, not a special case with
 * its own state.
 *
 * TAP, NOT DRAG, and that is a change to the phrase in the plan rather than
 * an omission. A band is reclaimed whole or not at all -- half a status bar
 * is not a thing anyone wants -- so a drag would be a gesture whose only
 * meaningful outcomes are its two ends. Dragging the edge back by hand is
 * still there: it is the `n` handle, and it already works.
 *
 * SOLID AT LOW ALPHA RATHER THAN DASHED. A dashed 1px border is the obvious
 * vocabulary for "removed", and on Android RN it renders as a solid line at
 * hairline widths often enough that it would read as a bug on some devices
 * and not others. The fill lifts the band out of the scrim; the border gives
 * it an edge against a pale screenshot, the same problem `CropGrid`'s outline
 * solves.
 *
 * Hidden while a finger is down, off the SAME shared value the grid appears
 * on. One value, opposite senses: the two are the same statement about
 * whether a drag is in progress, and a second timer could drift from the
 * first.
 */
function CropBands({ crop, view, bounds, on }) {
  // One hook per edge, written out, for the reason CropGrid is: hooks are
  // positional, and the `EDGES.map(...)` that would read better here becomes
  // a conditional hook the first time an edge has no band.
  const n = useAnimatedStyle(() => {
    'worklet';
    return bandStyle('n', crop.value, bounds, view, on.value);
  });
  const e = useAnimatedStyle(() => {
    'worklet';
    return bandStyle('e', crop.value, bounds, view, on.value);
  });
  const s = useAnimatedStyle(() => {
    'worklet';
    return bandStyle('s', crop.value, bounds, view, on.value);
  });
  const w = useAnimatedStyle(() => {
    'worklet';
    return bandStyle('w', crop.value, bounds, view, on.value);
  });
  return (
    <>
      <Animated.View style={[styles.band, n]} />
      <Animated.View style={[styles.band, e]} />
      <Animated.View style={[styles.band, s]} />
      <Animated.View style={[styles.band, w]} />
    </>
  );
}

/**
 * A magnifier at the handle being dragged.
 *
 * WHY IT EXISTS, from the survey and from arithmetic rather than from taste.
 * `fitView` contains the screenshot in the stage, so on a 1080-wide capture
 * in a ~400pt stage one screen point is about six image pixels. Trimming a
 * status bar to the row is therefore not something a person can do with a
 * finger, and the finger is on top of the row in any case. `loupeScale`
 * derives the magnification from that projection rather than picking a
 * factor, so it is right on a 720-wide capture and on a 1440-wide one.
 *
 * IT DRAWS THE SAME IMAGE THE STAGE DRAWS, at the same contain-fit size, and
 * then transforms it so the handle's pixel lands in the middle. That is the
 * point: a loupe rendered from a second projection would magnify a slightly
 * different picture from the one underneath it, and the user would align the
 * crop to the wrong one. The transform is Skia's, applied to the child, so it
 * reads point -> scale -> translate.
 *
 * NO LOUPE FOR `move`. `handlePoint` returns null for it, because a
 * translation has no pixel to align -- and a magnifier over the middle of a
 * rect being slid around shows the picture at 2x with nothing to line it up
 * against, which looks like a feature and is noise.
 *
 * IT SWAPS SIDES rather than following the finger. Pinned to the top of the
 * stage, and to the far side of whichever half the handle is in, so it is
 * never under the hand. Following the finger is the other convention and it
 * costs a second moving thing on a screen whose aesthetic notes allow one.
 *
 * A SQUARE, not the circle the convention suggests. A round loupe needs a
 * clip path in Skia and a matching outline in RN, two shapes to keep in
 * step; the crosshair is what says which pixel, and it is legible either way.
 */
function CropLoupe({ crop, view, stage, image, handle, on }) {
  const transform = useDerivedValue(() => {
    'worklet';
    const c = crop.value;
    const h = handle.value;
    const p = c && h ? handlePoint(h, c) : null;
    if (!p) return [{ translateX: 0 }, { translateY: 0 }, { scale: 1 }];
    const k = loupeScale(view, LOUPE_ZOOM);
    const vx = view.offsetX + p.x * view.scale;
    const vy = view.offsetY + p.y * view.scale;
    return [
      { translateX: LOUPE / 2 - vx * k },
      { translateY: LOUPE / 2 - vy * k },
      { scale: k },
    ];
  });

  const box = useAnimatedStyle(() => {
    'worklet';
    const c = crop.value;
    const h = handle.value;
    const p = c && h ? handlePoint(h, c) : null;
    if (!p) return { opacity: 0, left: LOUPE_GAP, top: LOUPE_GAP };
    const vx = view.offsetX + p.x * view.scale;
    return {
      opacity: on.value,
      top: LOUPE_GAP,
      left: vx < stage.w / 2 ? stage.w - LOUPE - LOUPE_GAP : LOUPE_GAP,
    };
  });

  return (
    <Animated.View style={[styles.loupe, box]} pointerEvents="none">
      <Canvas style={{ width: LOUPE, height: LOUPE }}>
        <Group transform={transform}>
          <SkiaImage image={image} x={0} y={0} width={stage.w} height={stage.h} fit="contain" />
        </Group>
      </Canvas>
      <View style={styles.loupeCrossV} />
      <View style={styles.loupeCrossH} />
    </Animated.View>
  );
}

/**
 * Padding and background. No apply: every control here is already
 * its own preview, which is what `TOOL.style.takeover === false` means.
 */
function StyleStrip({ ed, setEd, palette, stops, stopLabel, frameLabel, canReset: resettable, onReset, onDone }) {
  return (
    <View style={[styles.strip, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
      {/* Reset to a new card's style, and a way out that is not "tap Style
          again". Before these the strip had neither. They share the Padding
          label's row rather than taking one of their own: a whole row cost
          the stage 48dp more, which a 640dp-tall phone cannot spare. */}
      <View style={styles.stripHead}>
        <Text style={[styles.stripLabel, styles.stripHeadLabel, { color: palette.graphite }]}>{COPY.padding}</Text>
        <Chip label={COPY.reset} palette={palette} on={false} toggle={false} disabled={!resettable} onPress={onReset} />
        <Chip label={COPY.done} palette={palette} on toggle={false} onPress={onDone} />
      </View>
      <View style={styles.chips}>
        {stops.map((s) => (
          <Chip
            key={s.key}
            label={stopLabel[s.key]}
            palette={palette}
            on={ed.padding === s.value}
            onPress={() => setEd((v) => ({ ...v, padding: setPadding(s.value, v.crop.w).padding }))}
          />
        ))}
      </View>
      <Slider
        value={ed.padding}
        min={PAD_MIN}
        max={PAD_MAX}
        palette={palette}
        onChange={(v) => setEd((s) => ({ ...s, padding: setPadding(v, s.crop.w).padding }))}
      />

      <Text style={[styles.stripLabel, { color: palette.graphite }]}>{COPY.background}</Text>
      <View style={styles.chips}>
        {BACKGROUNDS.map((b) => (
          <Chip
            key={b}
            label={frameLabel[b]}
            palette={palette}
            on={ed.background === b}
            onPress={() => setEd((s) => ({ ...s, background: setBackground(b) }))}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * A continuous control, written here because nothing in the dependency list is
 * one and a slider is forty lines.
 *
 * The whole track is the touch target, not the thumb: a 20pt thumb is under
 * the platform's 44pt floor and a track that only responds where the thumb
 * already is makes a long drag start with a miss.
 */
function Slider({ value, min, max, onChange, palette }) {
  const [w, setW] = useState(0);
  const at = max > min ? (value - min) / (max - min) : 0;
  const move = useMemo(
    () =>
      Gesture.Pan()
        .onBegin((e) => { if (w > 0) onChange(min + (max - min) * clamp01(e.x / w)); })
        .onChange((e) => { if (w > 0) onChange(min + (max - min) * clamp01(e.x / w)); })
        .runOnJS(true),
    [w, min, max, onChange],
  );
  return (
    <GestureDetector gesture={move}>
      <View
        style={styles.sliderHit}
        onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width))}
        accessibilityRole="adjustable"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(at * 100) }}
      >
        <View style={[styles.track, { backgroundColor: palette.hairline }]} />
        <View style={[styles.trackFill, { backgroundColor: palette.signal, width: Math.max(0, at * w) }]} />
        <View
          style={[
            styles.thumb,
            { backgroundColor: palette.signal, borderColor: palette.surface, left: Math.max(0, at * w - 11) },
          ]}
        />
      </View>
    </GestureDetector>
  );
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A small selectable label. On state is shown by fill AND border, not colour alone. */
// `toggle` false is for a chip that is an action, not a choice, such as the
// Style strip's Done: filled to mark it as the way out, but TalkBack must
// not read it as "selected".
function Chip({ label, on, onPress, palette, disabled = false, toggle = true }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={toggle ? { selected: on, disabled } : { disabled }}
      style={[
        styles.chip,
        {
          backgroundColor: on ? palette.signal : 'transparent',
          borderColor: on ? palette.signal : palette.hairline,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Text style={[styles.chipText, { color: on ? palette.onSignal : palette.text }]}>{label}</Text>
    </Pressable>
  );
}

/** One row of the overflow. */
function MenuItem({ label, onPress, palette }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={styles.menuItem}>
      <Text style={[styles.menuText, { color: palette.text }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * One control. `primary` is the Signal-filled island; everything else is a
 * surface pill with a hairline. `selected` is shown by the border rather than
 * by colour alone.
 */
function Action({ label, onPress, disabled, primary, selected, wide, palette }) {
  const bg = primary ? palette.signal : palette.surface;
  const fg = primary ? palette.onSignal : palette.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled), selected: Boolean(selected) }}
      style={[
        styles.action,
        wide && styles.actionWide,
        {
          backgroundColor: bg,
          borderColor: selected ? palette.signal : palette.hairline,
          borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
        },
        disabled && styles.actionOff,
      ]}
    >
      <Text style={[styles.actionText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: SPACE.xxl + SPACE.md },
  update: {
    borderWidth: 1,
    borderRadius: RADIUS.md,
    marginHorizontal: SPACE.md,
    marginBottom: SPACE.sm,
    padding: SPACE.md,
  },
  updateTitle: { ...TYPE.label },
  updateNotes: { ...TYPE.caption, marginTop: SPACE.xs },
  updateRow: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.md },

  stage: { flex: 1, marginHorizontal: SPACE.md, borderRadius: RADIUS.md, overflow: 'hidden' },
  // flex, not an absolute fill. It was `...StyleSheet.absoluteFillObject`,
  // which is not a member of React Native 0.86's StyleSheet -- the export is
  // `absoluteFill` -- so the spread contributed nothing and this text sat at
  // the top of the stage rather than in the middle of it.
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl },
  emptyText: { ...TYPE.body, textAlign: 'center' },

  scrim: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' },
  // White plus a dark outline, because a coloured frame over arbitrary
  // screenshot pixels can be invisible. No pair of theme tokens can express
  // that requirement, which is why it is not one.
  cropEdge: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.9)',
  },
  // White with a dark ring, legible over a white screenshot and a black one;
  // a single colour over arbitrary pixels is invisible against some of them.
  cropDot: {
    position: 'absolute',
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: 'rgba(0,0,0,0.6)',
  },
  // One device pixel of line with a dark outline around it, so the grid is
  // legible over a white screenshot and a black one. Thinner than cropEdge
  // because the frame is the statement and the thirds are a guide.
  // The reclaimable band: a fill that lifts it out of the scrim, and a
  // hairline so it still has an edge over a pale screenshot. No dashed
  // border -- see CropBands for why.
  band: {
    position: 'absolute',
    backgroundColor: 'rgba(255,255,255,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.45)',
  },
  loupe: {
    position: 'absolute',
    width: LOUPE,
    height: LOUPE,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
    backgroundColor: '#000',
  },
  // The crosshair, in the frame's white-over-dark treatment: the loupe shows
  // arbitrary screenshot pixels and a single-colour hairline disappears into
  // some of them.
  loupeCrossV: {
    position: 'absolute',
    left: LOUPE / 2,
    top: 0,
    width: 1,
    height: LOUPE,
    backgroundColor: 'rgba(255,255,255,0.85)',
    outlineWidth: 1,
    outlineColor: 'rgba(0,0,0,0.35)',
  },
  loupeCrossH: {
    position: 'absolute',
    left: 0,
    top: LOUPE / 2,
    width: LOUPE,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.85)',
    outlineWidth: 1,
    outlineColor: 'rgba(0,0,0,0.35)',
  },
  gridV: {
    position: 'absolute',
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.85)',
    outlineWidth: 1,
    outlineColor: 'rgba(0,0,0,0.35)',
  },
  gridH: {
    position: 'absolute',
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.85)',
    outlineWidth: 1,
    outlineColor: 'rgba(0,0,0,0.35)',
  },

  captionWrap: { minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: SPACE.lg },
  caption: { ...TYPE.caption, textAlign: 'center' },

  strip: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    marginHorizontal: SPACE.md,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: SPACE.sm,
  },
  stripLabel: { ...TYPE.caption, marginTop: SPACE.xs },
  stripHead: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  stripHeadLabel: { flex: 1, marginTop: 0 },
  chips: { flexDirection: 'row', gap: SPACE.sm, marginTop: SPACE.xs },
  chip: {
    minHeight: TOUCH,
    justifyContent: 'center',
    paddingHorizontal: SPACE.lg,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
  },
  chipText: { ...TYPE.label },

  sliderHit: { height: TOUCH, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2 },
  trackFill: { position: 'absolute', height: 4, borderRadius: 2 },
  thumb: { position: 'absolute', width: 22, height: 22, borderRadius: 11, borderWidth: 2 },

  menu: {
    marginHorizontal: SPACE.md,
    marginBottom: SPACE.sm,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  menuItem: { minHeight: TOUCH + 4, justifyContent: 'center', paddingHorizontal: SPACE.lg },
  menuText: { ...TYPE.body },

  tools: { flexDirection: 'row', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingBottom: SPACE.sm },
  bar: { flexDirection: 'row', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingBottom: SPACE.xl },
  action: {
    flex: 1,
    minHeight: TOUCH + 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACE.lg,
  },
  actionWide: { flex: 3 },
  actionOff: { opacity: 0.4 },
  actionText: { ...TYPE.label },
});
