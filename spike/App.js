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
// spec never described it, and it caused a real bug — the Cover box was drawn
// over one image and applied to another, because the same on-screen rectangle
// points at different content in the two.
//
// So the canvas IS the card, composed at screen resolution and recomposed on
// every change. The rules live in three modules and none of them are here:
//
//   src/compose.js   one composition, projected to the stage and to 1080. The
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
// NOT DONE HERE, deliberately: Save to Photos and Copy image, which the IA
// puts in the overflow. The first is MediaStore and scoped storage per API
// level and the second needs a clipboard dependency this app does not have;
// both are Phase 5. The overflow ships with what exists rather than with
// disabled rows explaining themselves.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DevSettings,
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
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  Canvas,
  Group,
  Image as SkiaImage,
  Rect,
  rect as skRect,
  rrect as skRRect,
} from '@shopify/react-native-skia';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';

import {
  decodeFromUri,
  measureRing,
  measureStatusBar,
  composeAndEncode,
  measureRoundTrip,
  stressFullRead,
} from './src/measure';
import { renderCard, decodeUri, sampleCropBackground } from './src/pipeline';
import { composition, project, MIN_PROJECT, MAX_RADIUS } from './src/compose';
import {
  TOOL,
  TOOLS,
  barMode,
  canReset,
  cancelTool,
  canvasShows,
  doneTool,
  editorState,
  openTool,
  padStops,
  resetTool,
  setBackground,
  setPadding,
  setRadius,
  BACKGROUNDS,
  PAD_MAX,
  PAD_MIN,
} from './src/shell';
import { proposeFromImage } from './src/autocrop';
import { readRect } from './src/skia';
import { maskToDestPixels, planOutput } from './src/plan';
import { dragCrop, fitView, pickHandle, toImageDelta, toViewportRect, MIN_CROP } from './src/crop';
import {
  canReloadRuntime,
  isStaleLauncherError,
  launcherWentStale,
  recoveryPlan,
  resumeDecision,
} from './src/recover';
import { check as checkForUpdate, openDownload, installedVersionCode } from './src/update-io';
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
  const [menu, setMenu] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  // Dev only, and not part of the editor. The Q2 and P1 buttons put a measured
  // image on the canvas in place of the card; this holds it. It is a separate
  // piece of state rather than a mode of `ed` precisely so it cannot leak into
  // the product's state machine the way `showingResult` did.
  const [override, setOverride] = useState(null);

  // A newer APK, if there is one. Twitwa is handed out as a file, so nothing
  // tells a person that a new version exists unless the app does. See
  // src/update.js for the whole design, including why this is the app's only
  // network call and what that costs in privacy.
  const [update, setUpdate] = useState(null);

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
  // size the stage can show. The export calls `project` again at up to 1080.
  // Neither computes a layout, which is the whole point of src/compose.js.
  const comp = useMemo(() => {
    if (!ed) return null;
    try {
      return composition({ w: ed.crop.w, h: ed.crop.h }, ed.padding, ed.radius);
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
    const asset = res.assets[0];
    try {
      const decoded = await decodeFromUri(asset.uri);
      // The editor opens on a proposal, not on the whole screenshot. This is
      // the line that makes step 2 of the user flow true.
      const t0 = Date.now();
      const p = proposeFromImage(decoded.img, readRect);
      const proposeMs = Date.now() - t0;

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
      setSrc({ ...decoded, uri: asset.uri });
      setOverride(null);
      setEd(editorState(p.crop));
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
    } catch (e) {
      emit('decode.error', { message: String(e && e.message ? e.message : e) });
      setProblem(COPY.pickFailed);
    }
    // staleLauncher and recoverPicker belong here. With `[emit]` alone this
    // callback kept the first render's `staleLauncher: false` for the life of
    // the component, so the proactive branch above could never fire and every
    // recreation went the long way round: launch, reject, report, recover.
  }, [emit, staleLauncher, recoverPicker]);

  // Ask once per mount whether a newer APK exists. Deliberately fire-and-forget:
  // nothing waits on it, nothing is blocked by it, and a failure is a log line.
  useEffect(() => {
    if (updateAsked.current) return;
    updateAsked.current = true;
    let live = true;
    (async () => {
      const r = await checkForUpdate();
      if (!live) return;
      emit('P0.updateCheck', { action: r.action, installed: installedVersionCode(), latest: r.latestVersionCode ?? null, reason: r.reason ?? null });
      if (r.action === 'update') setUpdate(r);
    })();
    return () => { live = false; };
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
  const build = useCallback(async () => {
    if (!src || !ed) return null;
    const out = await renderCard({
      uri: src.uri,
      crop: ed.crop,
      padding: ed.padding,
      radius: ed.radius,
      frame: ed.background,
      trim: 'never',
      masks: ed.masks,
      outputName: 'card.png',
    });
    return out;
  }, [src, ed]);

  // Hand the PNG to the system sheet. Not "Save to Photos": that is MediaStore
  // and scoped storage per API level, which is Phase 5. This is the path the
  // product exists for, and expo-sharing was already a dependency.
  const share = useCallback(async () => {
    if (!src || !ed) return;
    setProblem(null);
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
      const out = await build();
      if (!out || out.error) {
        emit('P1.render.error', { error: out && out.error });
        setProblem(COPY.renderFailed);
        return;
      }
      emit('P1.render', {
        out: out.width + 'x' + out.height,
        kiB: +(out.bytes / 1024).toFixed(1),
        frame: out.frame,
        fill: out.fill,
        fillSource: out.fillSource,
        radius: out.radius,
        radiusPx: out.radiusPx,
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
          preview: { w: shot.width, h: shot.height, pad: shot.pad, radius: shot.radius },
          exported: { w: out.width, h: out.height, pad: out.pad, radius: out.radiusPx },
          aspectOff: +Math.abs(out.height / out.width - shot.height / shot.width).toFixed(5),
          padFracOff: +Math.abs(out.pad / out.width - shot.pad / shot.width).toFixed(5),
        });
      }
      await Sharing.shareAsync(out.path, { mimeType: 'image/png', UTI: 'public.png' });
      emit('P1.share', { ok: true, path: out.path });
    } catch (e) {
      emit('P1.share', { ok: false, message: String(e && e.message ? e.message : e) });
      setProblem(COPY.shareFailed);
    } finally {
      setBusy(false);
    }
  }, [src, ed, shot, build, emit]);

  // --- gestures on the raw layer ------------------------------------------
  //
  // Both tools work in IMAGE pixels, so the rect that reaches `ed` is the rect
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
  //     reason — a new image, Reset, Start over, an auto-proposal.
  //   - Exactly one write flows the other way, in `onFinalize`, and after it
  //     the effect below writes the same value straight back.
  //
  // So the two can only disagree during a gesture, which is the interval in
  // which nothing reads `ed.crop`.
  const liveCrop = useSharedValue(null);
  const grabbed = useSharedValue(null);
  const dragFrom = useSharedValue(null);

  useEffect(() => {
    liveCrop.value = ed ? ed.crop : null;
  }, [ed, liveCrop]);

  const commitCrop = useCallback((next) => {
    setEd((s) => (s ? { ...s, crop: next } : s));
  }, []);

  const cropGesture = useMemo(() => {
    // Read off `src` here, in the render, rather than inside the worklet: a
    // worklet captures what it closes over by value at creation, and a Skia
    // image is not serialisable across the boundary. Plain numbers are.
    const bounds = src ? { x: 0, y: 0, w: src.width, h: src.height } : null;
    return (
      Gesture.Pan()
        .onBegin((e) => {
          'worklet';
          const start = liveCrop.value;
          if (!view || !bounds || !start) return;
          const h = pickHandle({ x: e.x, y: e.y }, start, view);
          grabbed.value = h;
          dragFrom.value = h ? start : null;
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
        })
    );
    // `ed` is deliberately NOT a dependency. It used to be, so every frame of
    // the old drag rebuilt the Gesture object it was in the middle of.
  }, [view, src, commitCrop, liveCrop, grabbed, dragFrom]);

  // Cover, still one box. Phase 3 makes it several objects with a selection and
  // a delete; this is the shipped behaviour moved onto the new state, not a new
  // design, and the survey says plainly that one box is the wrong shape.
  //
  // Left on the JS thread on purpose. Cover draws nothing while the finger is
  // down — it only appends the box on release — so there is no per-frame
  // render to move off, and Phase 3's OPEN QUESTION may delete the whole tool.
  // Its own ref rather than the crop's shared value: the two are different
  // quantities that happened to share a variable, and that sharing only ever
  // worked because a tool takes the whole screen.
  const startRect = useRef(null);

  const coverGesture = useMemo(
    () =>
      Gesture.Pan()
        .onBegin((e) => {
          if (!view || !ed) return;
          const p = { x: (e.x - view.offsetX) / view.scale, y: (e.y - view.offsetY) / view.scale };
          startRect.current = { x: Math.round(p.x), y: Math.round(p.y), w: 0, h: 0 };
        })
        .onChange((e) => {
          if (!view || !startRect.current) return;
          const d = toImageDelta(view, { dx: e.changeX, dy: e.changeY });
          const r = startRect.current;
          startRect.current = { ...r, w: Math.round(r.w + d.dx), h: Math.round(r.h + d.dy) };
        })
        .onEnd(() => {
          const r = startRect.current;
          startRect.current = null;
          if (!r) return;
          // Normalised here rather than during the drag: a box dragged up and
          // to the left has a negative size, and every consumer downstream
          // expects a positive one.
          const box = {
            x: Math.min(r.x, r.x + r.w),
            y: Math.min(r.y, r.y + r.h),
            w: Math.abs(r.w),
            h: Math.abs(r.h),
          };
          if (box.w < 8 || box.h < 8) return;
          setEd((s) => (s ? { ...s, masks: [...s.masks, box] } : s));
        })
        .runOnJS(true),
    [view, ed],
  );

  // --- the dev harness, unchanged in what it measures ----------------------
  const boxInImageSpace = useCallback(() => {
    if (!ed || !ed.masks.length) return null;
    return ed.masks[ed.masks.length - 1];
  }, [ed]);

  const measureCheap = useCallback(() => {
    if (!src) return;
    const box = boxInImageSpace();
    const r = measureRing(src.img, box);
    emit('Q1.ring', {
      box,
      fill: r.ring && r.ring.hex,
      spread: r.ring && r.ring.spread,
      coverage: r.ring && r.ring.coverage,
      meanFill: r.meanRing && r.meanRing.hex,
      meanSd: r.meanRing && Math.max(...r.meanRing.stddev),
      readMs: r.readMs,
      bgMs: r.bgMs,
      bytesRead: r.bytesRead,
    });
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
  }, [src, boxInImageSpace, emit]);

  const compose = useCallback(
    (colorSpace, withMask) => {
      if (!src) return;
      const box = boxInImageSpace();
      const r = measureRing(src.img, box);
      if (!r.ring) {
        emit('Q2.error', { reason: 'no ring background', r });
        return;
      }
      const crop = { x: 0, y: 0, w: src.width, h: src.height };
      const pad = Math.max(12, Math.round(crop.w * 0.06 / 2) * 2);
      // Background is Paper here on purpose: Q1 is about the MASK fill, and
      // edge-sampled backgrounds are Phase 1's job.
      const out = composeAndEncode(
        src.img,
        crop,
        pad,
        withMask ? box : null,
        // Modal colour, never the mean. See src/pixels.js ringBackground.
        { background: PAPER, mask: r.ring.hex },
        colorSpace,
      );
      if (out.error) {
        emit('Q2.error', out);
        return;
      }
      setOverride(out.snapshot);
      emit('Q2.compose', {
        space: colorSpace ? 'DisplayP3' : 'sRGB',
        withMask,
        out: out.outW + 'x' + out.outH,
        mp: out.outMegapixels,
        pad,
        fill: r.ring.hex,
        spread: r.ring.spread,
        coverage: r.ring.coverage,
        meanFillWouldHaveBeen: r.meanRing && r.meanRing.hex,
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
    [src, boxInImageSpace, emit],
  );

  const render = useCallback(
    async (withMask, space) => {
      if (!src || !ed) return;
      setProblem(null);
      setBusy(true);
      try {
        const t0 = Date.now();
        const out = await renderCard({
          uri: src.uri,
          crop: ed.crop,
          padding: ed.padding,
          radius: ed.radius,
          frame: ed.background,
          trim: 'never',
          masks: withMask ? ed.masks : [],
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
          radiusPx: out.radiusPx,
          crop: out.crop,
          dest: out.dest,
          pad: out.pad,
          trimmed: out.trimmed,
          masks: out.masks.map((m) => ({ fill: m.fill, coverage: m.coverage, clipped: m.clipped })),
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

  const startOver = useCallback(() => {
    setSrc(null);
    setEd(null);
    setSampled(null);
    setOverride(null);
    setProblem(null);
    setMenu(false);
  }, []);

  // --- what the caption says ----------------------------------------------
  let caption = '';
  if (problem) caption = problem;
  else if (busy) caption = COPY.working;
  else if (ed && ed.tool === 'crop') caption = COPY.cropHint;
  else if (ed && ed.tool === 'cover') caption = COPY.coverHint;
  else if (comp) caption = fill(COPY.cardSize, { width: comp.width, height: comp.height });

  const mode = ed ? barMode(ed) : 'main';
  const takeover = mode === 'takeover';
  const stops = padStops();
  // Labels keyed by the name the module uses, not a second list of tools in a
  // second order. The ORDER comes from src/shell.js's TOOLS; this only says
  // what each one is called, and naming each key here is also what lets
  // tools/check-copy.mjs see that the string is used.
  const toolLabel = { crop: COPY.crop, cover: COPY.cover, style: COPY.style };
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
          <View style={styles.updateRow}>
            <Action
              label={COPY.updateGet}
              palette={palette}
              primary
              onPress={async () => {
                const ok = await openDownload(update.url);
                emit('P0.update', { opened: ok, url: ok ? update.url : 'refused' });
              }}
            />
            <Action label={COPY.updateLater} palette={palette} onPress={() => setUpdate(null)} />
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
                {/* The image is clipped to the rounded destination and drawn
                    scaled so that the CROP lands on it. Skia's Image has no
                    source rect, so the placement does that job: the whole
                    picture is scaled and positioned, and the clip keeps the
                    part that belongs in the card. */}
                <Group clip={skRRect(skRect(shot.dest.x, shot.dest.y, shot.dest.w, shot.dest.h), shot.radius, shot.radius)}>
                  <SkiaImage
                    image={src.img}
                    fit="fill"
                    x={shot.dest.x - ed.crop.x * (shot.dest.w / ed.crop.w)}
                    y={shot.dest.y - ed.crop.y * (shot.dest.h / ed.crop.h)}
                    width={src.width * (shot.dest.w / ed.crop.w)}
                    height={src.height * (shot.dest.h / ed.crop.h)}
                  />
                  {ed.masks.map((m, i) => {
                    // maskToDestPixels, the renderer's own mapping, against a
                    // plan whose crop and dest are the projected ones. One
                    // implementation of "where does this box land", so a box
                    // cannot sit in one place on screen and another in the PNG.
                    const r = maskToDestPixels(m, { crop: ed.crop, dest: shot.dest });
                    if (!r) return null;
                    return (
                      <Rect
                        key={i}
                        x={r.x}
                        y={r.y}
                        width={r.w}
                        height={r.h}
                        color={fillColour}
                      />
                    );
                  })}
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
                  <CropFrame crop={liveCrop} view={view} />
                </View>
              </GestureDetector>
            ) : null}
            {ed && ed.tool === 'cover' ? (
              <GestureDetector gesture={coverGesture}>
                <View style={StyleSheet.absoluteFill}>
                  {ed.masks.map((m, i) => (
                    <View key={i} style={[styles.maskBox, boxStyle(toViewportRect(view, m))]} />
                  ))}
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
      <Pressable onLongPress={() => setDevOpen(true)} delayLongPress={800} style={styles.captionWrap}>
        <Text style={[styles.caption, { color: problem ? palette.text : palette.graphite }]}>
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
        />
      ) : null}

      {menu ? (
        <View style={[styles.menu, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
          <MenuItem label={COPY.startOver} palette={palette} onPress={startOver} />
          <MenuItem label={COPY.devTitle} palette={palette} onPress={() => { setMenu(false); setDevOpen(true); }} />
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
            <Action label={COPY.more} palette={palette} selected={menu} onPress={() => setMenu((v) => !v)} />
          </View>
        </>
      )}

      {devOpen ? (
        <DevPanel
          palette={palette}
          log={log}
          src={src}
          covered={Boolean(ed && ed.masks.length)}
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

/** Corner bracket: the arm's length, and the thickness of the two sides drawn. */
const BRACKET = 22;
const BRACKET_W = 3;

/** A viewport rect as absolute-position style. */
function boxStyle(r) {
  return { left: r.x, top: r.y, width: r.w, height: r.h };
}

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
 * The crop rectangle: a hairline and four corner brackets.
 *
 * Brackets rather than dots, because the survey is unambiguous about what the
 * two mean: brackets say "this is a frame and the picture is behind it", dots
 * say "this is an object you have selected". A crop is a frame. Phase 2 adds
 * the rest of the list, including the rule-of-thirds grid on touch and the
 * loupe at the dragged corner.
 */
function CropFrame({ crop, view }) {
  const len = BRACKET;
  // One hook per element, for the same reason as Scrim: these five must follow
  // the finger on the UI thread. Only position is animated — the border widths
  // that make a corner an L are static, and live in the style objects below,
  // so each worklet returns two numbers rather than a whole style.
  const edge = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    return { left: r.x, top: r.y, width: r.w, height: r.h };
  });
  const nw = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    return { left: r.x, top: r.y };
  });
  const ne = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    return { left: r.x + r.w - len, top: r.y };
  });
  const sw = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    return { left: r.x, top: r.y + r.h - len };
  });
  const se = useAnimatedStyle(() => {
    'worklet';
    const r = crop.value ? toViewportRect(view, crop.value) : ZERO_RECT;
    return { left: r.x + r.w - len, top: r.y + r.h - len };
  });
  const box = { width: len, height: len };
  return (
    <>
      <Animated.View style={[styles.cropEdge, edge]} />
      <Animated.View style={[styles.cropCorner, box, styles.cornerNW, nw]} />
      <Animated.View style={[styles.cropCorner, box, styles.cornerNE, ne]} />
      <Animated.View style={[styles.cropCorner, box, styles.cornerSW, sw]} />
      <Animated.View style={[styles.cropCorner, box, styles.cornerSE, se]} />
    </>
  );
}

/**
 * Padding, corners and background. No apply: every control here is already
 * its own preview, which is what `TOOL.style.takeover === false` means.
 */
function StyleStrip({ ed, setEd, palette, stops, stopLabel, frameLabel }) {
  return (
    <View style={[styles.strip, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
      <Text style={[styles.stripLabel, { color: palette.graphite }]}>{COPY.padding}</Text>
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

      <Text style={[styles.stripLabel, { color: palette.graphite }]}>{COPY.corners}</Text>
      <Slider
        value={ed.radius}
        min={0}
        max={MAX_RADIUS}
        palette={palette}
        onChange={(v) => setEd((s) => ({ ...s, radius: setRadius(v) }))}
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
function Chip({ label, on, onPress, palette }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      style={[
        styles.chip,
        {
          backgroundColor: on ? palette.signal : 'transparent',
          borderColor: on ? palette.signal : palette.hairline,
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
  cropCorner: {
    position: 'absolute',
    borderColor: '#FFFFFF',
    outlineWidth: 1,
    outlineColor: 'rgba(0,0,0,0.6)',
  },
  // Which two sides of each bracket are drawn. Static, so they stay out of the
  // animated styles that follow the finger — a worklet returning `left` and
  // `top` is two numbers a frame, one returning the whole style is nine.
  cornerNW: { borderLeftWidth: BRACKET_W, borderTopWidth: BRACKET_W },
  cornerNE: { borderRightWidth: BRACKET_W, borderTopWidth: BRACKET_W },
  cornerSW: { borderLeftWidth: BRACKET_W, borderBottomWidth: BRACKET_W },
  cornerSE: { borderRightWidth: BRACKET_W, borderBottomWidth: BRACKET_W },
  maskBox: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    backgroundColor: 'rgba(0,0,0,0.35)',
    outlineWidth: 1,
    outlineColor: 'rgba(0,0,0,0.6)',
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
