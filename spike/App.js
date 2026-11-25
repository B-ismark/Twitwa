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
  ActivityIndicator,
  Alert,
  BackHandler,
  DevSettings,
  Linking,
  PixelRatio,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import { File, Paths } from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import Svg, { G, Line, Path, Rect as SvgRect } from 'react-native-svg';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  interpolateColor,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
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
  alreadySaved,
  cancelTool,
  canvasShows,
  doneTool,
  editorState,
  exportCurrent,
  openTool,
  padStops,
  resetTool,
  setBackground,
  setPadding,
  unsaved,
  BACKGROUNDS,
  BASIC_BACKGROUNDS,
  TONE_BACKGROUNDS,
  PAD_MAX,
  PAD_MIN,
} from './src/shell';
import { proposeFromImage } from './src/autocrop';
import { readRect, downscaleImage } from './src/skia';
import { stampSample, keepsLog, previewSize, cardSource } from './src/perf';
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
import { advancePlan, arrivalPlan, shareOutcome } from './src/sharein';
import { keepList, takeNext, waitingLabel } from './src/queue';
import { cropFits, readSession, serialiseSession } from './src/session';
import { DEFAULT_PREFS, parsePrefs, serialisePrefs, startingStyle } from './src/prefs';
import { formatFor } from './src/format';
import { noticeMs, viewUri } from './src/saved';
import { onShare, shareInAvailable, takeShare } from './src/sharein-io';
import { COPY, fill } from './src/copy';
import { RADIUS, SPACE, TOUCH, TYPE, paletteFor } from './src/theme';
import { ICONS, ICON_GAP, ICON_GRID, ICON_ONLY, ICON_SIZE, ICON_STROKE } from './src/icons';
import { BAR, CARD, CENTRE, LINE, coloursFor } from './src/mark';
import {
  CAPTION_LINE,
  CAPTION_LINES,
  bottomPad,
  captionHeight,
  cropGutter,
  liftForSheet,
  overlayTop,
  statusBarStyle,
  stepPadding,
  topPad,
} from './src/layout';
import DevPanel from './src/DevPanel';

const PAPER = '#F6F4EF';
const LOG = 'PHASE0';

/** The cross-fade between the composed card and the raw screenshot. */
const FADE_MS = 160;

/** The card's fade-in from the empty screen. Close to FADE_MS, not equal: it is a different move. */
const APPEAR_MS = 180;

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

// The editor's card, so a killed process comes back to it. See src/session.js.
// In the cache for the same reason as the flag above: it is a convenience, and
// losing it costs only the card coming back.
const SESSION_FILE = 'session.json';

function writeSessionFile(text) {
  try {
    const f = new File(Paths.cache, SESSION_FILE);
    f.create({ overwrite: true });
    f.write(text);
    return true;
  } catch (e) {
    return false;
  }
}

function clearSessionFile() {
  try {
    const f = new File(Paths.cache, SESSION_FILE);
    if (f.exists) f.delete();
  } catch (e) {
    // A file that cannot be deleted is read next launch and fails validation.
  }
}

// The remembered style (src/prefs.js). In the DOCUMENT directory, not the cache:
// the session file above is one unfinished card and goes when the card does,
// but this is a habit and must survive both an export and Android clearing the
// cache. Read with the async `text()` (see takeResumeFlag); expo-file-system
// has no async twin of `write`, and a ~100 byte write is not worth a thread hop.
const PREFS_FILE = 'prefs.json';

async function readPrefsFile() {
  try {
    const f = new File(Paths.document, PREFS_FILE);
    if (!f.exists) return { ...DEFAULT_PREFS };
    return parsePrefs(await f.text());
  } catch (e) {
    return { ...DEFAULT_PREFS };
  }
}

function writePrefsFile(text) {
  try {
    const f = new File(Paths.document, PREFS_FILE);
    f.create({ overwrite: true });
    f.write(text);
    return true;
  } catch (e) {
    return false;
  }
}

function fileExists(uri) {
  try {
    return new File(uri).exists;
  } catch (e) {
    return false;
  }
}

function removeFile(uri) {
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch (e) {
    // Cache space only.
  }
}

// The provider is the app's outermost layer so `useSafeAreaInsets` has an
// answer on the first render of the editor. The app draws edge to edge (Android
// 15+ forces it), so the insets are the only honest source for the status and
// navigation bars' heights.
export default function App() {
  return (
    <SafeAreaProvider>
      <Editor />
    </SafeAreaProvider>
  );
}

function Editor() {
  const insets = useSafeAreaInsets();
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
  // The one button a notice may carry, `{ label, run }`: "View" after a Save.
  // Beside `notice` rather than inside it so the many plain setNotice(text)
  // calls stay as they are. It is shown only while `notice` is, and set with it
  // by showNotice.
  const [noticeAction, setNoticeAction] = useState(null);
  const showNotice = useCallback((text, action = null) => {
    setNotice(text);
    setNoticeAction(action);
  }, []);
  // 'png' | 'jpeg', from the More menu's switch and remembered (prefs). Share
  // and Save follow it; Copy never does (src/format.js).
  const [format, setFormat] = useState(DEFAULT_PREFS.format);
  // The remembered style, and the read that fills it. openImage waits on the
  // read, so a share that starts the app cold still opens on the remembered
  // style instead of racing the file.
  const prefsRef = useRef({ ...DEFAULT_PREFS });
  const prefsLoad = useRef(null);
  const prefsText = useRef(null);
  const [menu, setMenu] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const devOpenRef = useRef(false);
  devOpenRef.current = devOpen;
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

  // A pick or a share is being copied and decoded. A COUNT behind the state
  // rather than a flag: a launch check, a share and a restore can overlap, and
  // a flag cleared by whichever finishes first would show the empty sentence
  // while another is still running. It starts at one for the launch check
  // (the effect on `receive` ends it), so a cold launch with a share waiting
  // never paints the empty screen: the native module has no synchronous "is
  // there a share" call, so every launch starts in this state and drops to
  // empty once it is answered.
  const importDepth = useRef(1);
  const [importing, setImporting] = useState(true);
  // The picker is open or about to be. A ref, set before the first await: two
  // taps inside one frame both read state as idle and both launched a picker.
  const pickingRef = useRef(false);
  // The pictures queued behind the card on screen: the rest of a multi-image
  // share, or a share kept over unsaved work (src/queue.js). State for the
  // chip, ref for the share handler, which is subscribed once and would read
  // the first render's [] (see edRef). In memory only: a restored session
  // (P1) does not bring the queue back, because those files may be gone, and
  // the first take() after a launch deletes any that are not on the keep list.
  const [queue, setQueueState] = useState([]);
  const queueRef = useRef([]);
  // The text last written to the session file, so an unchanged card is not
  // written again.
  const sessionText = useRef(null);
  // Which export Back is still waiting for, and since when `busy` began. See
  // backAction in src/shell.js.
  const exportGen = useRef(0);
  const busySince = useRef(0);

  // Free the downscaled copy when the picture changes or goes. Skia images
  // are native memory the garbage collector does not see, and a tall capture's
  // copy is several MB. Only a copy this component made: for a small picture
  // previewImg IS img, and img is not ours to free here.
  useEffect(() => {
    const p = src && src.previewImg !== src.img ? src.previewImg : null;
    return () => {
      if (p && typeof p.dispose === 'function') p.dispose();
    };
  }, [src]);

  const emit = useCallback((label, payload) => {
    const line = label + ' ' + JSON.stringify(payload);
    // Marker prefix so the whole run lifts off the device with:
    //   adb logcat -s ReactNativeJS:V | grep PHASE0
    console.log(LOG, line);
    // State only when somebody can see it: each setLog re-renders the whole
    // editor, and in release the panel is hidden. Opened in release it starts
    // empty, which is fine, because what came before is in logcat. The panel's
    // state is read through a ref so this callback's identity never changes
    // (it is a dependency of nearly everything).
    if (keepsLog({ dev: __DEV__, panelOpen: devOpenRef.current })) {
      setLog((prev) => [{ label, payload }, ...prev].slice(0, 12));
    }
  }, []);

  const beginImport = useCallback(() => {
    importDepth.current += 1;
    setImporting(true);
  }, []);
  const endImport = useCallback(() => {
    importDepth.current = Math.max(0, importDepth.current - 1);
    setImporting(importDepth.current > 0);
  }, []);
  const setQueue = useCallback((next) => {
    queueRef.current = next;
    setQueueState(next);
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

  // What each Background choice would paint, for its swatch. The same
  // `planOutput` answer as the card, per choice, so Match shows the colour that
  // was actually sampled (with its fallbacks) and Paper and Ink show what the
  // renderer uses rather than a second copy of those two hex values.
  const swatchFills = useMemo(() => {
    const out = {};
    for (const b of BACKGROUNDS) {
      try {
        out[b] = ed
          ? planOutput({ crop: ed.crop, padding: ed.padding, background: sampled, frame: b }).fill
          : null;
      } catch (e) {
        out[b] = null;
      }
    }
    return out;
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


  // The crop's working area: the stage less a gutter on each side, so a handle
  // can never be dragged within 24dp of the screen's edge, where Android's back
  // gesture takes the touch. Inset rather than the stage being narrowed, which
  // would resize it for the whole of every crop. See `cropGutter`.
  const gutter = cropGutter();
  const cropStage = useMemo(
    () => (stage ? { w: Math.max(0, stage.w - 2 * gutter), h: stage.h } : null),
    [stage, gutter],
  );

  /** The contain-fit projection used by the raw-screenshot layer and its tools. */
  const view = useMemo(() => {
    if (!src || !cropStage) return null;
    try {
      return fitView({ imageW: src.width, imageH: src.height, viewW: cropStage.w, viewH: cropStage.h });
    } catch (e) {
      return null;
    }
  }, [src, cropStage]);

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
  // The card's lift while the Style sheet is open: see liftForSheet. Two
  // shared values so the card glides, and the sheet's height is measured
  // rather than assumed, because it grows with the system font size.
  const [sheetH, setSheetH] = useState(0);
  const liftY = useSharedValue(0);
  const liftS = useSharedValue(1);
  const cardLayer = useAnimatedStyle(() => ({
    opacity: 1 - raw.value,
    transform: [{ translateY: liftY.value }, { scale: liftS.value }],
  }));

  // The card fades in when it first appears, instead of replacing the empty
  // screen in one frame. Not on a replacement: `hasSrc` stays true, so the
  // effect does not run and a new picture swaps in as it always did. Skipped
  // under the system's reduce-motion setting.
  const reduceMotion = useReducedMotion();
  const appear = useSharedValue(0);
  const hasSrc = Boolean(src);
  useEffect(() => {
    if (!hasSrc) {
      appear.value = 0;
      return;
    }
    appear.value = reduceMotion ? 1 : withTiming(1, { duration: APPEAR_MS });
  }, [hasSrc, reduceMotion, appear]);
  const appearStyle = useAnimatedStyle(() => ({ opacity: appear.value }));
  const rawLayer = useAnimatedStyle(() => ({ opacity: raw.value }));

  const styleOpen = Boolean(ed && ed.tool === 'style');
  useEffect(() => {
    const r = styleOpen && shot && stage
      ? liftForSheet({ stageH: stage.h, cardTop: shot.offY, cardH: shot.height, sheetH })
      : { scale: 1, ty: 0 };
    const t = (v) => (reduceMotion ? v : withTiming(v, { duration: LIFT_MS }));
    liftY.value = t(r.ty);
    liftS.value = t(r.scale);
  }, [styleOpen, shot, stage, sheetH, reduceMotion, liftY, liftS]);

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
  // The card last saved to Photos, and the picture it came from. Tapping Save
  // again on the same card used to write a second identical copy to the
  // gallery every time; now it asks first (owner's report, 2026-11-25).
  const savedTo = useRef(null);
  // One export at a time. `busy` is state, so two taps inside one frame both
  // read it as false and both ran: a double tap on Save saved twice. A ref is
  // set before the first await, so the second tap sees it.
  const working = useRef(false);
  // The editor as last rendered, for the share handler. It is subscribed once
  // (see the effect on `receive`), so a closure over `ed` would read the
  // first render's null for ever and never ask before replacing a card.
  const edRef = useRef(null);
  edRef.current = ed;

  // Read once at launch. Declared before the effects that open a shared or
  // restored picture, so the promise exists by the time openImage asks for it.
  useEffect(() => {
    prefsLoad.current = readPrefsFile().then((p) => {
      prefsRef.current = p;
      prefsText.current = JSON.stringify(serialisePrefs(p));
      setFormat(p.format);
      return p;
    });
  }, []);

  // A style choice was committed (chip, slider release, swatch, the format
  // switch): write it down. Not called for a slider's live preview, nor for
  // Style's Reset, which is "undo on this card" and not a new habit.
  const remember = useCallback((patch) => {
    prefsRef.current = { ...prefsRef.current, ...patch };
    const text = JSON.stringify(serialisePrefs(prefsRef.current));
    if (text === prefsText.current) return;
    if (writePrefsFile(text)) prefsText.current = text;
  }, []);

  /**
   * Decode `uri`, propose a crop, and open the editor on it. Both ways in end
   * here -- the picker and a share -- so they cannot drift into two imports
   * with two sets of rules. Returns whether the editor opened.
   *
   * `saved` is a validated session (src/session.js) when this is the launch
   * putting a card back: the proposal is still computed, because Reset
   * returns to it, but the card opens on the saved crop and style.
   */
  const openImage = useCallback(async (uri, via, saved) => {
    const gen = ++importGen.current;
    try {
      // A restored card keeps its own style, so it need not wait for prefs.
      if (!saved && prefsLoad.current) await prefsLoad.current;
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
      if (saved && !cropFits(saved.crop, decoded.width, decoded.height)) {
        throw new Error('saved crop lies outside the picture');
      }
      shownUri.current = uri;
      setSrc({ ...decoded, uri, previewImg: makePreview(decoded.img, decoded.width, decoded.height) });
      setOverride(null);
      const base = editorState(p.crop);
      const opened = saved
        ? { ...base, crop: saved.crop, padding: saved.padding, background: saved.background }
        : { ...base, ...startingStyle(prefsRef.current) };
      setEd(opened);
      // A restored card is treated as unsaved, so Back asks. Whether it had
      // been shared or saved before the process died is not in the file, and
      // asking once too often costs a tap where not asking costs the card.
      kept.current = saved ? null : cardOf(opened);
      setSampled(sampleAt(decoded.img, opened.crop));
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
      // A restore that fails is silent: the person did not ask for it, and the
      // empty screen is what they would have had without it.
      if (!superseded && via !== 'restore') setProblem(via === 'share' ? COPY.sharedFailed : COPY.pickFailed);
      return false;
    }
  }, [emit]);

  const pickFromLibrary = useCallback(async () => {
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
    // From here until the card is up or an error is shown: Choose is off and
    // the empty screen says what is happening.
    beginImport();
    try {
      await openImage(res.assets[0].uri, 'picker');
    } finally {
      endImport();
    }
    // staleLauncher and recoverPicker belong here. With `[emit]` alone this
    // callback kept the first render's `staleLauncher: false` for the life of
    // the component, so the proactive branch above could never fire and every
    // recreation went the long way round: launch, reject, report, recover.
  }, [emit, staleLauncher, recoverPicker, openImage, beginImport, endImport]);

  const pick = useCallback(async () => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    try {
      await pickFromLibrary();
    } finally {
      pickingRef.current = false;
    }
  }, [pickFromLibrary]);

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

  const clearEditor = useCallback(() => {
    // Back always ends here, and so do Discard and Close with nothing queued
    // (with something queued those two go through leaveCard and open the next
    // picture instead). A card that was thrown away must not come back at the next
    // launch. A New screenshot needs no
    // clear of its own: the card that replaces it overwrites the file.
    clearSessionFile();
    sessionText.current = null;
    setSrc(null);
    setEd(null);
    setSampled(null);
    setOverride(null);
    setProblem(null);
    setMenu(false);
  }, []);

  // What happens to the pictures of a share that are copied into our cache and
  // ready to show: open the first, or ask first when the card on screen has
  // unkept changes. `src/sharein.js` decides which, and what becomes of the
  // queue; this carries it out. Also the chip's route (advancePlan), so a
  // queued picture goes through the same ask as a fresh share.
  const offer = useCallback(async (plan, why, gen) => {
    // A share replaces whatever is on screen, open tool and menus included:
    // it is a deliberate act from another app.
    const apply = async (leaf) => {
      beginImport();
      try {
        setMenu(false);
        setDevOpen(false);
        setProblem(null);
        setNotice(null);
        const opened = await openImage(leaf.open, 'share');
        if (opened && leaf.notice) setNotice(leaf.notice);
      } finally {
        endImport();
      }
    };
    // Files to delete (what the queue's cap refused), and what the queue is
    // afterwards. Never the file on screen.
    const settle = (leaf) => {
      for (const f of leaf.drop) if (f !== shownUri.current) removeFile(f);
      setQueue(leaf.queue);
    };
    if (plan.act === 'none') return;
    if (plan.act === 'open') {
      settle(plan);
      await apply(plan);
      return;
    }
    // Over a card with unsaved changes it asks first, by the same rule Back
    // and New screenshot use. Keep editing QUEUES the pictures (the chip opens
    // them later); it used to delete them. Only for the take it answers: a
    // later take has already deleted these copies and has its own ask, so an
    // answer that arrives after it is ignored, as Replace always was.
    //
    // The ask does NOT hold the chain. It used to be awaited here, and a
    // dialog that never calls back (Android drops it when the activity is
    // recreated, say by a Display size change, and MainActivity restores no
    // state) left every later share queued behind it, silently, until the
    // app was killed. Found in review, 2026-09-23. Replace goes back on the
    // chain, so its import still never overlaps a take().
    const keep = () => {
      const stale = gen !== shareGen.current;
      emit('share.in.ask', { why, replace: false, stale });
      if (stale) return;
      settle(plan.keep);
      if (plan.keep.notice) setNotice(plan.keep.notice);
    };
    Alert.alert(
      COPY.replaceCardTitle,
      COPY.replaceCardBody,
      [
        { text: COPY.keepEditing, style: 'cancel', onPress: keep },
        {
          text: COPY.replace,
          style: 'destructive',
          onPress: () => {
            receiving.current = receiving.current.then(() => {
              const stale = gen !== shareGen.current;
              emit('share.in.ask', { why, replace: true, stale });
              if (stale) return undefined;
              settle(plan.replace);
              return apply(plan.replace);
            }).catch((e) => emit('share.error', { why, message: String(e && e.message ? e.message : e) }));
          },
        },
      ],
      { cancelable: true, onDismiss: keep },
    );
  }, [emit, openImage, beginImport, endImport, setQueue]);

  // Queued pictures whose files are gone, dropped. Resolves the live queue.
  const pruneQueue = useCallback(() => {
    const before = queueRef.current;
    const live = before.filter(fileExists);
    if (live.length !== before.length) setQueue(live);
    return live;
  }, [setQueue]);

  /** Resolves true when a share was there to deal with, even one that failed. */
  const receiveOnce = useCallback(async (why) => {
    let answer = null;
    const gen = ++shareGen.current;
    // From the moment a share is detected: the copy inside take() is part of
    // the wait, and the card is not up until the decode after it.
    beginImport();
    try {
      try {
        answer = await takeShare(keepList(shownUri.current, queueRef.current));
      } catch (e) {
        emit('share.error', { why, message: String(e && e.message ? e.message : e) });
        setProblem(COPY.sharedFailed);
        return true;
      }
      // take() keeps the picture on screen and the queue's files, so they
      // should all still be there; one that is not has nothing to open.
      pruneQueue();
      const o = shareOutcome(answer, shareInAvailable);
      emit('share.in', {
        why,
        action: o.action,
        reason: o.reason ?? null,
        count: answer && answer.count != null ? answer.count : null,
        skipped: answer && answer.skipped != null ? answer.skipped : null,
        bytes: answer && answer.bytes != null ? answer.bytes : null,
      });
      if (o.action === 'ignore') return false;
      if (o.action === 'problem') {
        setProblem(o.message);
        return true;
      }
      await offer(
        arrivalPlan({
          uris: o.uris,
          skipped: o.skipped,
          dirty: unsaved(edRef.current, kept.current),
          queue: queueRef.current,
        }),
        why,
        gen,
      );
      return true;
    } finally {
      endImport();
    }
  }, [emit, offer, pruneQueue, beginImport, endImport]);

  const receive = useCallback((why) => {
    // receiveOnce catches what it can throw, so the chain is not left
    // rejected; this catch is for whatever it did not see coming. The value
    // is receiveOnce's, so the launch can tell "there was a share" from not.
    receiving.current = receiving.current
      .then(() => receiveOnce(why))
      .catch((e) => emit('share.error', { why, message: String(e && e.message ? e.message : e) }));
    return receiving.current;
  }, [emit, receiveOnce]);

  // The chip's tap: the next queued picture through the same ask as a new
  // share. On the chain, so it cannot overlap a take() that would delete it.
  const openWaiting = useCallback(() => {
    receiving.current = receiving.current.then(() => {
      const had = queueRef.current.length;
      const live = pruneQueue();
      if (live.length === 0) {
        if (had > 0) setProblem(COPY.sharedFailed);
        return undefined;
      }
      return offer(
        advancePlan({ dirty: unsaved(edRef.current, kept.current), queue: live }),
        'waiting',
        shareGen.current,
      );
    }).catch((e) => emit('share.error', { why: 'waiting', message: String(e && e.message ? e.message : e) }));
  }, [emit, offer, pruneQueue]);

  // A card was finished with (Close, Back, Discard): the next queued picture
  // opens in its place instead of the empty screen. No ask here: the caller
  // has already asked, or the card had nothing to lose. On the chain, like
  // every take(), because the file it opens is one a take would keep only
  // while it is still queued. A picture that will not open leaves the empty
  // screen with the rest still queued behind the chip, rather than the card
  // that was just closed.
  const advanceQueue = useCallback(() => {
    receiving.current = receiving.current.then(async () => {
      const { next, rest } = takeNext(pruneQueue());
      if (next === null) {
        clearEditor();
        return;
      }
      const before = shownUri.current;
      setQueue(rest);
      beginImport();
      try {
        setMenu(false);
        setDevOpen(false);
        setProblem(null);
        setNotice(null);
        const opened = await openImage(next, 'share');
        emit('queue.advance', { opened, left: rest.length });
        if (!opened && shownUri.current === before) {
          clearEditor();
          setProblem(COPY.sharedFailed);
        }
      } finally {
        endImport();
      }
    }).catch((e) => emit('share.error', { why: 'advance', message: String(e && e.message ? e.message : e) }));
  }, [emit, openImage, pruneQueue, clearEditor, setQueue, beginImport, endImport]);

  // Put back the card a killed process left, when no share is waiting. Quiet
  // on every failure: delete the file and show the empty screen. The queue is
  // not restored (it is not in the session file): its files may be gone.
  const restoreSession = useCallback(async () => {
    try {
      const f = new File(Paths.cache, SESSION_FILE);
      if (!f.exists) return;
      // `text()` is the async one; see the note on takeResumeFlag.
      const saved = readSession(await f.text());
      // A card already on screen came from something the person did while
      // this was reading, and wins.
      if (shownUri.current) return;
      if (!saved || !fileExists(saved.uri)) {
        emit('session.restore', { ok: false, reason: saved ? 'picture gone' : 'unreadable' });
        clearSessionFile();
        return;
      }
      beginImport();
      try {
        const opened = await openImage(saved.uri, 'restore', saved);
        emit('session.restore', { ok: opened });
        if (opened) setNotice(COPY.restored);
        else clearSessionFile();
      } finally {
        endImport();
      }
    } catch (e) {
      emit('session.restore', { ok: false, message: String(e && e.message ? e.message : e) });
      clearSessionFile();
    }
  }, [emit, openImage, beginImport, endImport]);

  // Once at launch, for a share that started the app, and then on every
  // share that arrives while it is running. The native module also catches a
  // share that recreates a destroyed activity; see its header for all three.
  //
  // The launch also ends the wait `importDepth` starts with, and, when there
  // was no share, brings back the last card. The picker's own resume (below)
  // wins over it: a pick in progress is what the person just asked for.
  useEffect(() => {
    (async () => {
      try {
        const consumed = await receive('launch');
        if (!consumed && !pickingRef.current) await restoreSession();
      } finally {
        endImport();
      }
    })();
    return onShare(() => receive('event'));
  }, [receive, restoreSession, endImport]);

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
      if (s.tool === 'crop' && src) setSampled(sampleAt(src.img, s.crop));
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
      if (s.tool === 'crop' && src) setSampled(sampleAt(src.img, next.crop));
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
  const build = useCallback(async (outputName, fmt) => {
    if (!src || !ed) return null;
    // The picture the editor already decoded and the colour it already sampled,
    // not a second decode and a second sample of the same file. src.img is
    // decodeFromUri's MakeImageFromEncoded, the same call renderCard's own uri
    // path makes, so it is the same pixels; `sampled` is only used by the
    // renderer when it was taken from exactly the crop being exported.
    const out = await renderCard({
      image: src.img,
      background: sampled,
      uri: src.uri,
      crop: ed.crop,
      padding: ed.padding,
      frame: ed.background,
      trim: 'never',
      format: fmt,
      outputName,
    });
    return out;
  }, [src, ed, sampled]);

  useEffect(() => {
    if (!notice) {
      setNoticeAction(null);
      return undefined;
    }
    const t = setTimeout(() => setNotice(null), noticeMs(Boolean(noticeAction)));
    return () => clearTimeout(t);
  }, [notice, noticeAction]);

  // The card went somewhere (Share, Save, Copy). A finished card is not worth
  // bringing back at the next launch, so its session file goes, but only when
  // the file holds this exact card: one edited since is still unfinished work.
  // The next edit writes the file again through the session effect.
  const markKept = useCallback((card) => {
    kept.current = card;
    const j = src ? serialiseSession(card, src.uri) : null;
    if (j && JSON.stringify(j) === sessionText.current) {
      clearSessionFile();
      sessionText.current = null;
    }
  }, [src]);

  /**
   * Render the card for one of the ways out of the app, and report it.
   *
   * Share, Save and Copy all come through here, so for one editor state they
   * hand over one composition. Three copies of this would be three chances for
   * one of them to export a card the preview never showed, and the P4 check
   * below is what would notice.
   */
  const exportCard = useCallback(async (outputName, fmt) => {
    const started = exportGen.current;
    const out = await build(outputName, fmt);
    // Back gave up on this one while it ran; see abandonExport. Nothing it
    // found is news any more, and its caller treats null as "stop".
    if (!exportCurrent(started, exportGen.current)) return null;
    if (!out || out.error) {
      emit('P1.render.error', { error: out && out.error });
      setProblem(COPY.renderFailed);
      return null;
    }
    emit('P1.render', {
      out: out.width + 'x' + out.height,
      kiB: +(out.bytes / 1024).toFixed(1),
      frame: out.frame,
      format: out.format,
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
    if (!src || !ed || working.current) return;
    working.current = true;
    const started = exportGen.current;
    const card = cardOf(ed);
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
      const spec = formatFor('share', format);
      const out = await exportCard(`card.${spec.ext}`, spec.format);
      if (!out) return;
      await Sharing.shareAsync(out.path, { mimeType: spec.mime, UTI: spec.uti });
      if (!exportCurrent(started, exportGen.current)) return;
      markKept(card);
      emit('P1.share', { ok: true, path: out.path });
    } catch (e) {
      if (!exportCurrent(started, exportGen.current)) return;
      emit('P1.share', { ok: false, message: String(e && e.message ? e.message : e) });
      setProblem(COPY.shareFailed);
    } finally {
      // Only the export Back is still waiting for may clear the wait: an
      // abandoned one landing late would otherwise un-busy the next.
      if (exportCurrent(started, exportGen.current)) {
        working.current = false;
        setBusy(false);
      }
    }
  }, [src, ed, format, exportCard, emit, markKept]);

  // The notice's View button. Linking.openURL rejects when no app handles the
  // URI; that is a short notice, not an exception on a tap handler.
  const viewSavedCard = useCallback(async (uri) => {
    setNotice(null);
    try {
      await Linking.openURL(uri);
      emit('P6.view', { ok: true });
    } catch (e) {
      emit('P6.view', { ok: false, message: String(e && e.message ? e.message : e) });
      showNotice(COPY.viewFailed);
    }
  }, [emit, showNotice]);

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
  const save = useCallback(async (again) => {
    if (!src || !ed || working.current) return;
    const card = cardOf(ed);
    const prev = savedTo.current;
    // `again === true`, not truthiness: as a button's onPress this receives
    // the press event.
    if (again !== true && alreadySaved(ed, prev, shownUri.current, format)) {
      emit('P5.save', { ok: false, reason: 'already saved' });
      Alert.alert(COPY.alreadySavedTitle, COPY.alreadySavedBody, [
        { text: COPY.alreadySavedOk, style: 'cancel' },
        { text: COPY.saveAgain, onPress: () => save(true) },
      ]);
      return;
    }
    working.current = true;
    const started = exportGen.current;
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
        const spec = formatFor('save', format);
        const out = await exportCard(savedName(new Date(), spec.format), spec.format);
        if (!out) return;
        const asset = await Asset.create(out.path);
        if (!exportCurrent(started, exportGen.current)) return;
        // MediaStore holds its own copy now. The one in the cache has a name
        // per save, so unlike Share's card.png nothing ever overwrites it, and
        // without this every save left one behind. A failure here costs cache
        // space only, never the save, so it is not reported as one.
        try {
          new File(out.path).delete();
        } catch {
          // Deliberately empty; see above.
        }
        markKept(card);
        savedTo.current = { uri: shownUri.current, card, format: spec.format };
        emit('P5.save', { ok: true, api: Platform.Version, id: asset.id });
        // View opens the row we just wrote. A null URI (an id we cannot
        // read) gives a plain notice, with no button to fail.
        const uri = viewUri(asset.id);
        showNotice(COPY.saved, uri ? { label: COPY.viewSaved, run: () => viewSavedCard(uri) } : null);
      }
    } catch (e) {
      if (!exportCurrent(started, exportGen.current)) return;
      emit('P5.save', { ok: false, api: Platform.Version, message: String(e && e.message ? e.message : e) });
      setProblem(COPY.saveFailed);
    } finally {
      if (exportCurrent(started, exportGen.current)) {
        working.current = false;
        setBusy(false);
      }
    }
    if (fallback) await share();
  }, [src, ed, format, exportCard, share, emit, markKept, showNotice, viewSavedCard]);

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
    if (!src || !ed || working.current) return;
    working.current = true;
    const started = exportGen.current;
    const card = cardOf(ed);
    setProblem(null);
    setNotice(null);
    setMenu(false);
    setBusy(true);
    try {
      // Always PNG, whatever the switch says (src/format.js).
      const spec = formatFor('copy');
      const out = await exportCard(`card.${spec.ext}`, spec.format);
      if (!out) return;
      const png = new File(out.path);
      const b64 = await png.base64();
      await Clipboard.setImageAsync(b64);
      if (!exportCurrent(started, exportGen.current)) return;
      markKept(card);
      emit('P5.copy', { ok: true, api: Platform.Version, kiB: +(out.bytes / 1024).toFixed(1) });
      if (Platform.Version < 33) setNotice(COPY.copied);
    } catch (e) {
      if (!exportCurrent(started, exportGen.current)) return;
      emit('P5.copy', { ok: false, api: Platform.Version, message: String(e && e.message ? e.message : e) });
      setProblem(COPY.copyFailed);
    } finally {
      if (exportCurrent(started, exportGen.current)) {
        working.current = false;
        setBusy(false);
      }
    }
  }, [src, ed, exportCard, emit, markKept]);

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
  // round. Replaces Start over, whose other job Back now does. The queue is
  // not touched: the picked picture takes this card's place and the queued
  // ones stay behind it.
  const newShot = useCallback(() => {
    setMenu(false);
    if (unsaved(ed, kept.current)) confirmDiscard(COPY.discardCardTitle, COPY.discardCardBody, pick);
    else pick();
  }, [ed, confirmDiscard, pick]);

  // Back gave up on an export that never came back. Bumping the generation is
  // what makes the late result harmless (see exportCurrent), and the caption
  // says the card was not made, which is true as far as the person can tell.
  const abandonExport = useCallback(() => {
    exportGen.current += 1;
    working.current = false;
    setBusy(false);
    setNotice(null);
    setProblem(COPY.renderFailed);
  }, []);

  // When `busy` began, for Back's fifteen seconds. An effect rather than a
  // write at each of the places that set it: there are four.
  useEffect(() => {
    busySince.current = busy ? Date.now() : 0;
  }, [busy]);

  // Android's Back, one layer at a time, and the Close control on the card
  // view, which is the same act: one rule, so the two cannot disagree about
  // whether to ask. Before this there was no handler, so Back closed the
  // activity and the card went with it, unasked. The order and the reasons are
  // backAction's, in src/shell.js; this only carries them out. Returning false
  // is the one case Android should handle itself.
  // What Back does with an open takeover tool, once backAction has said which:
  // cancel at once, or ask first because the tool was changed. It is also the
  // Cancel button's, so Back and Cancel cannot disagree about when to ask.
  const leaveTool = useCallback(
    (a) => {
      if (a === 'cancel-tool') cancel();
      else if (a === 'ask-tool') confirmDiscard(COPY.discardCropTitle, COPY.discardCropBody, cancel);
    },
    [cancel, confirmDiscard],
  );
  const cancelCrop = useCallback(() => leaveTool(backAction(ed)), [ed, leaveTool]);

  // Close, Back and Discard all finish a card here, so they cannot disagree:
  // with pictures queued the next one opens, otherwise the empty screen. The
  // ask before discarding is the caller's, and comes first.
  const leaveCard = useCallback(() => {
    if (queueRef.current.length === 0) clearEditor();
    else advanceQueue();
  }, [clearEditor, advanceQueue]);

  const goBack = useCallback(() => {
    const busyMs = busy && busySince.current ? Date.now() - busySince.current : 0;
    const a = backAction(ed, { menu, dev: devOpen, busy, busyMs, kept: kept.current });
    emit('back', { action: a });
    if (a === 'exit') return false;
    if (a === 'close-dev') setDevOpen(false);
    else if (a === 'close-menu') setMenu(false);
    else if (a === 'abandon') abandonExport();
    else if (a === 'cancel-tool' || a === 'ask-tool') leaveTool(a);
    else if (a === 'close-tool') setEd((s) => (s ? doneTool(s) : s));
    // Back always lands on the start screen, queue or not (owner's call,
    // 2026-11-25). Back is how a person leaves; advancing on it meant one
    // press per waiting picture to get out of the app. The queue survives:
    // the start screen shows the same "N waiting" chip, and Close is the
    // route that moves on to the next card.
    else if (a === 'ask') confirmDiscard(COPY.discardCardTitle, COPY.discardCardBody, clearEditor);
    else if (a === 'leave') clearEditor();
    return true;
  }, [ed, menu, devOpen, busy, abandonExport, leaveTool, clearEditor, confirmDiscard, emit]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', goBack);
    return () => sub.remove();
  }, [goBack]);

  // The card, written down after it settles. One effect on the editor rather
  // than a write at each commit (crop proposed, Done, a Style change, an
  // export): the session is the card, and the card only changes through `ed`.
  // Debounced because the padding slider changes it on every move. A takeover
  // tool's uncommitted edit is not in it (serialiseSession).
  useEffect(() => {
    if (!ed || !src) return undefined;
    const j = serialiseSession(ed, src.uri);
    const text = j ? JSON.stringify(j) : null;
    if (!text || text === sessionText.current) return undefined;
    const t = setTimeout(() => {
      if (writeSessionFile(text)) sessionText.current = text;
    }, SESSION_MS);
    return () => clearTimeout(t);
  }, [ed, src]);

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
  // The bars' bottom padding, from the navigation bar's real height.
  const barPad = { paddingBottom: bottomPad(insets.bottom) };
  const frameLabel = {
    match: COPY.matchFrame,
    paper: COPY.paperFrame,
    ink: COPY.inkFrame,
    sky: COPY.skyFrame,
    mint: COPY.mintFrame,
    sand: COPY.sandFrame,
    plum: COPY.plumFrame,
    slate: COPY.slateFrame,
    midnight: COPY.midnightFrame,
  };

  return (
    <GestureHandlerRootView
      style={[styles.root, { backgroundColor: palette.background, paddingTop: topPad(insets.top) }]}
    >
      <StatusBar style={statusBarStyle(scheme)} />
      {/* The stage paints a ground only once there is an image on it, and
          which ground depends on what is being shown — see `stageGround`.
          Empty, the dark one was a full-height black slab with one line of
          grey text at the top, which reads as a broken viewport rather than
          as an empty app. It was also unreadable: the stage colour is dark in
          BOTH themes, so in light mode that line was light-Graphite on Ink at
          2.37:1. */}
      <View style={styles.stageArea}>
      <Animated.View
        style={[styles.stage, src ? stageGround : null]}
        onLayout={onStageLayout}
      >
        {!src ? (
          <View style={styles.empty}>
            {/* ONE way to choose, and it is the bar's filled button: in the
                thumb's reach, and in the place Share takes once a card is open.
                A second "Choose a screenshot" button in the middle read as two
                different actions. This panel is the welcome instead: the mark,
                the name and the other way in (sharing), with a dashed edge that
                echoes the mark's cut line. A tap on it still picks, because a
                big target that does nothing is a trap, but it is not a TalkBack
                stop of its own: the bar is that route, and two buttons with one
                name are noise. The panel stays up while a picture opens, with
                the spinner in the hint's place, so a cold share does not swap
                the whole screen. The mark gives way first on a short stage. */}
            <Pressable
              onPress={pick}
              disabled={importing}
              accessible={false}
              importantForAccessibility="no"
              style={[styles.panel, { borderColor: palette.hairline }]}
            >
              <View style={styles.markBox} accessible={false} importantForAccessibility="no-hide-descendants">
                <Mark mode={scheme === 'light' ? 'light' : 'dark'} />
              </View>
              <Text style={[styles.wordmark, { color: palette.text }]} accessibilityRole="header">
                {COPY.wordmark}
              </Text>
              {importing ? (
                <View style={styles.importingRow}>
                  <ActivityIndicator color={palette.graphite} />
                  <Text
                    style={[styles.emptyText, styles.importingText, { color: palette.graphite }]}
                    accessibilityLiveRegion="polite"
                  >
                    {COPY.importing}
                  </Text>
                </View>
              ) : (
                <Text style={[styles.emptyText, styles.emptyHint, { color: palette.graphite }]}>
                  {COPY.emptyShareHint}
                </Text>
              )}
            </Pressable>
          </View>
        ) : null}

        {/* Everything drawn from the picture, under one fade: see `appear`. */}
        <Animated.View style={[StyleSheet.absoluteFill, appearStyle]}>

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
                    image={
                      cardSource({
                        cropW: ed.crop.w,
                        srcW: src.width,
                        previewW: src.previewImg.width(),
                        destW: shot.dest.w,
                        pixelRatio: PixelRatio.get(),
                      }) === 'preview'
                        ? src.previewImg
                        : src.img
                    }
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
            style={[styles.rawLayer, { left: gutter, right: gutter }, rawLayer]}
            pointerEvents={takeover ? 'auto' : 'none'}
          >
            <Canvas style={{ width: cropStage.w, height: cropStage.h }}>
              {/* The downscaled copy drawn into the rect the full picture
                  would fill (fitView's), not contain-fitted: a rounded
                  copy's aspect is a hair off a tall capture's, and that hair
                  is a pixel or two at the bottom. */}
              <SkiaImage
                image={src.previewImg}
                x={view.offsetX}
                y={view.offsetY}
                width={src.width * view.scale}
                height={src.height * view.scale}
                fit="fill"
              />
            </Canvas>
            {ed && ed.tool === 'crop' ? (
              <GestureDetector gesture={cropGesture}>
                <View style={StyleSheet.absoluteFill}>
                  {/* The shared value, not `ed.crop`. Passing the rect would
                      put the projection back in the render and undo the whole
                      change: React would have to re-render to move the frame. */}
                  <Scrim crop={liveCrop} view={view} stage={cropStage} />
                  <CropBands crop={liveCrop} view={view} bounds={imageBounds} on={gridOn} />
                  <CropGrid crop={liveCrop} view={view} on={gridOn} />
                  <CropFrame crop={liveCrop} view={view} stage={cropStage} />
                  <CropLoupe
                    crop={liveCrop}
                    view={view}
                    stage={cropStage}
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
      </Animated.View>

      {/* OVERLAYS. Everything below up to the closing of this area floats over
          the stage and takes no height from it: see src/layout.js. */}
      {update ? (
        <View style={[styles.update, { top: overlayTop(Boolean(src) && !takeover) }, { backgroundColor: palette.surface, borderColor: palette.signal }]}>
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

      {/* Close, floating over the stage's top-left, on the card view. It took
          a row of its own, which made the stage 52dp shorter than it needed to
          be; over the card it takes none. A surface fill so it reads over any
          card, and it goes while a takeover tool is open because Crop has its
          own Cancel and the corner is a crop handle's. */}
      {src && !takeover ? (
        <View style={styles.closeFloat} pointerEvents="box-none">
          <Action label={COPY.close} icon="close" iconOnly palette={palette} fit onPress={goBack} />
        </View>
      ) : null}
      {ed && ed.tool === 'style' ? (
        <StyleStrip
          ed={ed}
          setEd={setEd}
          onRemember={remember}
          palette={palette}
          stops={stops}
          stopLabel={stopLabel}
          frameLabel={frameLabel}
          swatchFills={swatchFills}
          onSheetLayout={(h) => setSheetH(h + SPACE.sm)}
          canReset={canReset(ed)}
          onReset={resetT}
          onDone={done}
        />
      ) : null}

      {menu ? (
        <>
        {/* A tap on the card beside the sheet closes it, as a tap outside any
            sheet does. Not a TalkBack stop: Back closes it too, and an
            unlabelled full-screen button would be one. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => setMenu(false)}
          accessible={false}
          importantForAccessibility="no"
        />
        <View style={[styles.menu, { backgroundColor: palette.surface, borderColor: palette.hairline }]}>
          {/* Save is on the bar and no longer here. Developer tools is not
              here either: it is for us, not for the people Twitwa is handed
              to, and the long press on the caption is its way in. */}
          {src && ed && !busy ? (
            <MenuItem label={COPY.copyImage} icon="copy" palette={palette} onPress={copyImage} />
          ) : null}
          {/* A switch, not a button: it stays open to show its new state. */}
          <MenuItem
            label={COPY.saveAsJpeg}
            palette={palette}
            role="switch"
            checked={format === 'jpeg'}
            stateLabel={format === 'jpeg' ? COPY.switchOn : COPY.switchOff}
            onPress={() => {
              const next = format === 'jpeg' ? 'png' : 'jpeg';
              setFormat(next);
              remember({ format: next });
            }}
          />
          <MenuItem label={COPY.newShot} palette={palette} onPress={newShot} />
        </View>
        </>
      ) : null}

      </View>

      {/* The way in to the measurement harness, and the only thing on this
          screen that is not for a person using the app. A long press rather
          than a control, because a visible button would be the first thing to
          make this look like a tool again. Documented in the README. */}
      {/* Not a TalkBack stop while it says nothing: at rest the caption is
          empty, and an empty stop reads as a control with no name. The long
          press still works for a sighted developer either way. */}
      <View style={[styles.captionRow, { height: captionHeight(fontScale) }]}>
        <Pressable
          onLongPress={() => setDevOpen(true)}
          delayLongPress={800}
          style={[styles.captionWrap, styles.captionGrow]}
          accessible={caption !== ''}
        >
          {/* A live region, so TalkBack reads "Saved to Photos" and every problem
              aloud. On Android 13 and later that caption is Save's only
              confirmation, and before this nothing announced it. Only for those
              two: the crop hint also lives here, and a live region would read it
              out every time Crop opens. */}
          <Text
            style={[styles.caption, { color: problem ? palette.text : palette.graphite }]}
            numberOfLines={CAPTION_LINES}
            accessibilityLiveRegion={problem || notice ? 'polite' : 'none'}
          >
            {caption}
          </Text>
        </Pressable>
        {/* Pictures queued behind this card (the rest of a multi-image share, or a
            share kept over unsaved work). Tapping asks the same question a new
            share would. */}
        {/* The notice's one button sits in the caption row's own chip slot, so
            it moves nothing (P2: the stage never changes size). It takes the
            waiting chip's place while it is up: both at once would squeeze the
            caption, and the waiting chip is back in 6s. */}
        {notice && noticeAction && !problem && !busy ? (
          <Chip label={noticeAction.label} palette={palette} on={false} toggle={false} onPress={noticeAction.run} />
        ) : queue.length > 0 ? (
          <Chip label={waitingLabel(queue)} palette={palette} on={false} toggle={false} onPress={openWaiting} />
        ) : null}
      </View>

      {/* Kept under the panel rather than removed. The panel is the big target,
          but the bar is where every other screen of the app keeps its one
          primary, so the thumb finds Choose in the same place; and taking
          the bar out would hand the stage ~60dp the moment a picture opens, so
          the empty screen would grow and then shrink. Its slot is the one
          size the stage already has here. */}
      {!src ? (
        <View style={[styles.bar, barPad]}>
          <Action label={COPY.choose} palette={palette} primary wide disabled={importing} onPress={pick} />
        </View>
      ) : takeover ? (
        // Two rows, like the editor's tools row and bar, so opening Crop does
        // not hand the stage the tools row's height: the picture would grow
        // and jump in the same moment it cross-fades to the raw screenshot.
        // Cancel and Reset take the tools row; Done is the bar's one primary.
        <>
          <View style={styles.tools}>
            <Action label={COPY.cancel} palette={palette} onPress={cancelCrop} />
            <Action label={COPY.reset} palette={palette} disabled={!canReset(ed)} onPress={resetT} />
          </View>
          <View style={[styles.bar, barPad]}>
            <Action label={COPY.done} palette={palette} primary wide onPress={done} />
          </View>
        </>
      ) : (
        <>
          <View style={styles.tools}>
            {TOOLS.map((t) => (
              <Action
                key={t}
                label={toolLabel[t]}
                icon={t}
                palette={palette}
                selected={ed.tool === t}
                onPress={() => (TOOL[t].takeover ? open(t) : toggle(t))}
              />
            ))}
          </View>
          <View style={[styles.bar, barPad]}>
            <Action label={COPY.share} icon="share" palette={palette} primary wide disabled={busy} onPress={share} />
            {/* Save beside Share, and only here. The owner asked for it on
                the share sheet itself; Android lets an app add its own action
                there only from 14 on, and expo-sharing cannot, so it is here. */}
            <Action label={COPY.saveShort} icon="save" palette={palette} disabled={busy} onPress={save} />
            {/* Disabled while busy, as Share is. Open during an export, the menu
                lacked Copy with no reason given, and leaving the card from it
                let "Saved to Photos" land on the empty screen. */}
            <Action label={COPY.more} icon="more" iconOnly palette={palette} selected={menu} disabled={busy} onPress={() => setMenu((v) => !v)} />
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
// How long the card must sit still before it is written to the session file.
const SESSION_MS = 400;
// The card's glide out from under the Style sheet, and back.
const LIFT_MS = 220;

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
/**
 * The on-screen copy of a picture: the picture itself unless its longest side
 * is past perf.js's ceiling, then a downscaled one made once per opened image.
 * A failure to make it is not a failure to open, so it falls back to the
 * original. Export, sampling, autocrop and the loupe keep using `src.img`.
 */
function makePreview(img, width, height) {
  const size = previewSize({ width, height });
  if (!size.down) return img;
  try {
    return downscaleImage(img, size.width, size.height) || img;
  } catch (e) {
    return img;
  }
}

/**
 * The crop's edge colour, stamped with the crop it was read from, so the export
 * can tell the sample the preview used from one taken of a crop since moved.
 */
function sampleAt(img, crop) {
  return stampSample(sampleCropBackground(img, crop), crop);
}

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
 * Padding and background, as a sheet over the stage. No apply: every control
 * here is already its own preview, which is what `TOOL.style.takeover ===
 * false` means.
 *
 * Done is a plain text button, not a filled chip: Share is the one primary
 * control on the screen, and a second filled thing in the sheet competed with
 * it for "the thing to press".
 */
function StyleStrip({ ed, setEd, onRemember, palette, stops, stopLabel, frameLabel, swatchFills, onSheetLayout, canReset: resettable, onReset, onDone }) {
  const swatch = (b) => (
    <Swatch
      key={b}
      label={frameLabel[b]}
      colour={swatchFills[b]}
      palette={palette}
      on={ed.background === b}
      onPress={() => {
        setEd((s) => ({ ...s, background: setBackground(b) }));
        onRemember({ background: b });
      }}
    />
  );
  return (
    <View
      style={[styles.strip, { backgroundColor: palette.surface, borderColor: palette.hairline }]}
      onLayout={(e) => onSheetLayout(e.nativeEvent.layout.height)}
    >
      {/* Reset to a new card's style, and a way out that is not "tap Style
          again". They share the Padding label's row: a row of their own makes
          the sheet 48dp taller, and it floats over the card it is editing. */}
      <View style={styles.stripHead}>
        <Text style={[styles.stripLabel, styles.stripHeadLabel, { color: palette.graphite }]}>{COPY.padding}</Text>
        <Chip label={COPY.reset} palette={palette} on={false} toggle={false} disabled={!resettable} onPress={onReset} />
        <Pressable
          onPress={onDone}
          accessibilityRole="button"
          accessibilityLabel={COPY.done}
          style={styles.textButton}
        >
          <Text style={[styles.chipText, { color: palette.signal }]}>{COPY.done}</Text>
        </Pressable>
      </View>
      <View style={styles.chips}>
        {stops.map((s) => (
          <Chip
            key={s.key}
            label={stopLabel[s.key]}
            palette={palette}
            on={ed.padding === s.value}
            onPress={() => {
              const padding = setPadding(s.value, ed.crop.w).padding;
              setEd((v) => ({ ...v, padding }));
              onRemember({ padding });
            }}
          />
        ))}
      </View>
      <Slider
        value={ed.padding}
        min={PAD_MIN}
        max={PAD_MAX}
        palette={palette}
        label={COPY.padding}
        onCommit={(v) => {
          const padding = setPadding(v, ed.crop.w).padding;
          setEd((s) => ({ ...s, padding }));
          onRemember({ padding });
        }}
        onPreview={(v) => setEd((s) => {
          const padding = setPadding(v, s.crop.w).padding;
          return padding === s.padding ? s : { ...s, padding };
        })}
        onStep={(dir) => {
          const padding = stepPadding(ed.padding, dir, ed.crop.w);
          setEd((s) => ({ ...s, padding }));
          onRemember({ padding });
        }}
      />

      <Text style={[styles.stripLabel, { color: palette.graphite }]}>{COPY.background}</Text>
      {/* Match, Paper, Ink, then the six tones on a row of their own. The
          tones wrap rather than shrink: at a large font scale a name like
          Midnight outgrows its share, and a swatch under 48dp is not a target. */}
      <View style={styles.swatches}>
        {BASIC_BACKGROUNDS.map(swatch)}
      </View>
      <View style={styles.swatchesTones}>
        {TONE_BACKGROUNDS.map(swatch)}
      </View>
    </View>
  );
}

/**
 * A background choice as the colour it paints, with its name under it.
 *
 * Selected is a ring AND the accessibility state, not the ring alone. The ring
 * is Signal-coloured and a gap wide, so it reads against a swatch of any
 * colour, including one that matches the sheet. The disc itself has a hairline
 * because Paper on a white sheet, and Ink on a dark one, have no edge
 * otherwise.
 */
function Swatch({ label, colour, on, onPress, palette }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      style={styles.swatch}
    >
      <View style={[styles.swatchRing, { borderColor: on ? palette.signal : 'transparent' }]}>
        <View style={[styles.swatchDisc, { backgroundColor: colour || palette.surface, borderColor: palette.hairline }]} />
      </View>
      <Text style={[styles.swatchText, { color: on ? palette.text : palette.graphite }]}>{label}</Text>
    </Pressable>
  );
}

/**
 * A continuous control, written here because nothing in the dependency list is
 * one and a slider is forty lines.
 *
 * THE THUMB IS A SHARED VALUE and the padding is committed to React once, on
 * release, the way the crop commits its frame. It used to call `onChange` on
 * every move, so every frame of a drag was a thread hop, a re-render of the
 * whole app and a recompose of the card behind the sheet. Now the drag is the
 * UI thread's alone, and the card is told only when the value has moved a
 * hundredth of the range (and re-renders only when that changes the snapped
 * padding), so it still previews WHILE it is dragged. The release commits the
 * exact value.
 *
 * The whole track is the touch target, not the thumb: a 20pt thumb is under
 * the platform's touch floor and a track that only responds where the thumb
 * already is makes a long drag start with a miss.
 */
function Slider({ value, min, max, onCommit, onPreview, onStep, palette, label }) {
  const at = max > min ? (value - min) / (max - min) : 0;
  // 0..1 along the track, written by the drag and, at rest, by `value`.
  const pos = useSharedValue(at);
  const width = useSharedValue(0);
  const dragging = useSharedValue(false);
  const sent = useSharedValue(at);
  useEffect(() => {
    // Not while a finger is down: a commit from the previous release landing
    // mid-drag would snatch the thumb back to where the finger WAS.
    if (!dragging.value) pos.value = at;
  }, [at, pos, dragging]);

  const move = useMemo(
    () =>
      Gesture.Pan()
        .onBegin((e) => {
          'worklet';
          if (width.value <= 0) return;
          dragging.value = true;
          pos.value = clamp01(e.x / width.value);
          sent.value = pos.value;
          runOnJS(onPreview)(min + (max - min) * pos.value);
        })
        .onChange((e) => {
          'worklet';
          if (width.value <= 0) return;
          pos.value = clamp01(e.x / width.value);
          // The card previews the padding as the finger moves, which is what a
          // slider is for. Only when the value has moved a hundredth of the
          // range: the thumb itself stays on the UI thread at frame rate, and
          // the preview's setEd returns the same state (no render) when the
          // snapped padding has not changed.
          if (Math.abs(pos.value - sent.value) >= 0.01) {
            sent.value = pos.value;
            runOnJS(onPreview)(min + (max - min) * pos.value);
          }
        })
        // onFinalize, as the crop's is: a drag cancelled by the system still
        // has to put the thumb's value into the card.
        .onFinalize(() => {
          'worklet';
          if (!dragging.value) return;
          dragging.value = false;
          runOnJS(onCommit)(min + (max - min) * pos.value);
        }),
    [width, pos, dragging, sent, min, max, onCommit, onPreview],
  );
  const fillStyle = useAnimatedStyle(() => ({ width: pos.value * width.value }));
  const thumbStyle = useAnimatedStyle(() => ({ left: pos.value * width.value - 11 }));
  return (
    <GestureDetector gesture={move}>
      <View
        style={styles.sliderHit}
        onLayout={(e) => { width.value = Math.round(e.nativeEvent.layout.width); }}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(at * 100) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'increment') onStep(1);
          else if (e.nativeEvent.actionName === 'decrement') onStep(-1);
        }}
      >
        <View style={[styles.track, { backgroundColor: palette.hairline }]} />
        <Animated.View style={[styles.trackFill, { backgroundColor: palette.signal }, fillStyle]} />
        <Animated.View
          style={[styles.thumb, { backgroundColor: palette.signal, borderColor: palette.surface }, thumbStyle]}
        />
      </View>
    </GestureDetector>
  );
}

const clamp01 = (v) => {
  'worklet';
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

/** A small selectable label. On state is shown by fill AND border, not colour alone. */
// `toggle` false is for a chip that is an action, not a choice, such as the
// Style sheet's Reset: TalkBack must not read it as "selected".
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
function MenuItem({ label, icon, onPress, palette, role = 'button', checked, stateLabel }) {
  const isSwitch = role === 'switch';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityState={isSwitch ? { checked: Boolean(checked) } : undefined}
      style={styles.menuItem}
    >
      {icon ? <Icon name={icon} color={palette.text} /> : null}
      <Text style={[styles.menuText, styles.menuGrow, { color: palette.text }]}>{label}</Text>
      {/* The state in words as well as to TalkBack: a switch with no visible
          state is a button nobody can read. */}
      {isSwitch ? (
        <Text style={[styles.menuText, { color: checked ? palette.signal : palette.graphite }]}>{stateLabel}</Text>
      ) : null}
    </Pressable>
  );
}

/**
 * A glyph from src/icons.js. Decorative by design: whatever it sits in carries
 * the accessibility label, so TalkBack never meets a second, unnamed node.
 */
function Icon({ name, color, size = ICON_SIZE }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`0 0 ${ICON_GRID} ${ICON_GRID}`}
      fill="none"
      stroke={color}
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {ICONS[name].map((d, i) => (
        <Path key={i} d={d} />
      ))}
    </Svg>
  );
}

/** The mark from src/mark.js, the same shapes the launcher icon is drawn from. */
function Mark({ mode }) {
  const c = coloursFor(mode);
  const rect = (r, i) => (
    <SvgRect key={i} x={r.x} y={r.y} width={r.width} height={r.height} rx={r.rx} fill={c[r.fill]} />
  );
  const { deg, cx, cy } = BAR.rotate;
  return (
    // Framed on the middle 72 units (the launcher's visible area), not the 108
    // canvas: the launcher needs that margin for its masks, a screen does not,
    // and with it the mark filled barely half of its box. Not the 66-unit safe
    // circle: drawn at full size here (no LAUNCHER_SCALE), the mark reaches
    // ~35 units from the centre, and 66 would clip the bar's corners.
    <Svg width="100%" height="100%" viewBox={`${CENTRE - 36} ${CENTRE - 36} 72 72`}>
      <G transform={`rotate(${deg} ${cx} ${cy})`}>{BAR.rects.map(rect)}</G>
      <Line
        x1={LINE.x1}
        y1={LINE.y1}
        x2={LINE.x2}
        y2={LINE.y2}
        stroke={c[LINE.fill]}
        strokeWidth={LINE.strokeWidth}
        strokeLinecap="round"
        strokeDasharray={LINE.dash}
      />
      {CARD.map(rect)}
    </Svg>
  );
}

/**
 * One control. `primary` is the Signal-filled island; everything else is a
 * surface pill with a hairline. `selected` is shown by the border rather than
 * by colour alone.
 */
// `iconOnly` drops the visible label and keeps the name for TalkBack. It is a
// fixed square (see ICON_ONLY): with no word to give it width, a flex child
// would collapse to the glyph and fall under the touch floor.
function Action({ label, icon, iconOnly, onPress, disabled, primary, selected, wide, fit, palette }) {
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
        fit && styles.actionFit,
        icon && styles.actionIcon,
        icon && iconOnly && {
          flex: 0,
          width: fit ? ICON_ONLY.fit : ICON_ONLY.bar,
          height: fit ? ICON_ONLY.fit : ICON_ONLY.bar,
          paddingHorizontal: 0,
        },
        {
          backgroundColor: bg,
          borderColor: selected ? palette.signal : palette.hairline,
          borderWidth: selected ? 2 : StyleSheet.hairlineWidth,
        },
        disabled && styles.actionOff,
      ]}
    >
      {icon ? <Icon name={icon} color={fg} /> : null}
      {icon && iconOnly ? null : <Text style={[styles.actionText, { color: fg }]}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // No fixed top padding: the status bar's height comes from the insets, in the
  // view (`topPad`).
  root: { flex: 1 },
  // The stage and everything that floats over it. `flex: 1` is the one thing
  // that sizes the stage, and nothing in here is in the flow but the stage.
  stageArea: { flex: 1 },
  // The raw screenshot's layer, inset left and right by `cropGutter` (inline).
  rawLayer: { position: 'absolute', top: 0, bottom: 0 },
  // The Close control, over the stage's top-left: the stage's own margin plus a
  // gap, so it sits inside the card's corner rather than on the screen's edge.
  closeFloat: { position: 'absolute', top: SPACE.sm, left: SPACE.md + SPACE.sm, minWidth: TOUCH },
  // `top` is inline (`overlayTop`): it clears Close when Close is there.
  update: {
    position: 'absolute',
    left: SPACE.md,
    right: SPACE.md,
    borderWidth: 1,
    borderRadius: RADIUS.md,
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
  importingText: { marginTop: SPACE.md },
  // 96dp, and the first thing to give when the stage is short: flexShrink with
  // a floor, so the panel and the hint (which a person reads) keep their size.
  markBox: { width: 96, height: 96, flexShrink: 1, minHeight: 40 },
  wordmark: { ...TYPE.wordmark, marginTop: SPACE.md },
  // The welcome panel: a dashed edge, no fill, so it reads as a place rather
  // than a second button (see the empty state). No fixed height: a larger font
  // only makes it taller.
  panel: {
    alignSelf: 'stretch',
    maxWidth: 360,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACE.xl,
    paddingHorizontal: SPACE.lg,
    borderRadius: RADIUS.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
  },
  importingRow: { alignItems: 'center', marginTop: SPACE.md },
  emptyHint: { marginTop: SPACE.md },

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

  // A FIXED slot (height inline: `captionHeight`), so a problem that runs to a
  // second line, or none at all, never moves the stage above it.
  captionRow: { flexDirection: 'row', alignItems: 'center', paddingRight: SPACE.md },
  captionGrow: { flex: 1 },
  captionWrap: { flex: 1, justifyContent: 'center', paddingHorizontal: SPACE.lg },
  caption: { ...TYPE.caption, lineHeight: CAPTION_LINE, textAlign: 'center' },

  // The Style sheet: anchored to the bottom of the stage area, which is the top
  // of the caption and the bars, so it sits just above them and floats over the
  // card instead of squeezing it.
  strip: {
    position: 'absolute',
    left: SPACE.md,
    right: SPACE.md,
    bottom: SPACE.sm,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
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

  // A text button: no fill, no border, only the touch target around the word.
  textButton: { minHeight: TOUCH, minWidth: TOUCH, justifyContent: 'center', alignItems: 'center', paddingHorizontal: SPACE.sm },
  swatches: { flexDirection: 'row', gap: SPACE.lg, marginTop: SPACE.xs },
  swatchesTones: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: SPACE.xs, marginTop: SPACE.xs },
  swatch: { minHeight: TOUCH, minWidth: TOUCH + SPACE.md, alignItems: 'center' },
  swatchRing: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatchDisc: { width: 34, height: 34, borderRadius: 17, borderWidth: 1 },
  swatchText: { ...TYPE.caption, marginTop: SPACE.xs },

  sliderHit: { height: TOUCH, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2 },
  trackFill: { position: 'absolute', height: 4, borderRadius: 2 },
  thumb: { position: 'absolute', width: 22, height: 22, borderRadius: 11, borderWidth: 2 },

  menu: {
    position: 'absolute',
    left: SPACE.md,
    right: SPACE.md,
    bottom: SPACE.sm,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  menuItem: {
    minHeight: TOUCH + 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ICON_GAP + SPACE.xs,
    paddingHorizontal: SPACE.lg,
  },
  menuText: { ...TYPE.body },
  menuGrow: { flex: 1 },

  tools: { flexDirection: 'row', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingBottom: SPACE.sm },
  // paddingBottom is inline (`bottomPad`): the navigation bar's height.
  bar: { flexDirection: 'row', gap: SPACE.sm, paddingHorizontal: SPACE.md },
  action: {
    flex: 1,
    minHeight: TOUCH + 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACE.lg,
  },
  actionWide: { flex: 3 },
  // A control that is its own width, such as Close, rather than a share of a bar.
  actionFit: { flex: 0, minHeight: TOUCH },
  // Icon left of the label: a row, with the gap between them.
  actionIcon: { flexDirection: 'row', gap: ICON_GAP },
  actionOff: { opacity: 0.4 },
  actionText: { ...TYPE.label },
});
