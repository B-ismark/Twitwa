// The app's one screen.
//
// It was the Phase 0 harness: eleven buttons, a JSON log, and a caption that
// read "1440x3120 2.3MP 16.5MiB RGBA — showing source". That was the right
// shape for answering measurement questions and the wrong shape for anything
// else, and it is now behind a long press. See src/DevPanel.js, which still
// holds every one of those buttons, because the numbers in this repository
// came out of them.
//
// What replaced it is three states and never more than three controls:
// nothing picked, a screenshot to work on, a finished card. Words come from
// src/copy.js and colours from src/theme.js; neither is written here, and
// tools/check-copy.mjs fails the build if a view starts writing its own.
//
// NOT DONE HERE, deliberately: saving to Photos. That needs MediaStore and
// scoped-storage handling per API level, which is Phase 5. Share hands the
// file to the system sheet, which is the path the product exists for, and it
// uses expo-sharing, which was already a dependency and previously unused.
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
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { Canvas, Image as SkiaImage } from '@shopify/react-native-skia';
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
import { renderCard, decodeUri } from './src/pipeline';
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

/** contain-fit an image into a box; returns the mapping both ways. */
function fit(imgW, imgH, boxW, boxH) {
  const scale = Math.min(boxW / imgW, boxH / imgH);
  const w = imgW * scale;
  const h = imgH * scale;
  return { scale, w, h, offX: (boxW - w) / 2, offY: (boxH - h) / 2 };
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

  const [src, setSrc] = useState(null);      // { img, width, height, ... }
  const [shown, setShown] = useState(null);  // SkImage currently drawn
  const [covered, setCovered] = useState(false);
  // Which image is on the canvas: the source, or a result. The Cover box is only
  // meaningful over the source. `map` converts view coordinates to SOURCE
  // pixels, and a result is trimmed, padded and rescaled, so the same on-screen
  // rectangle points at different content. Showing a result with the box still
  // live meant the next render covered a region other than the one selected.
  // Two previews, one box, and the box belongs to exactly one of them.
  const [showingResult, setShowingResult] = useState(false);
  const [log, setLog] = useState([]);

  // Whether the Cover box is in use. The box is hidden until it is, because a
  // rectangle sitting on someone's screenshot with no explanation is the single
  // most confusing thing the old screen did.
  const [useCover, setUseCover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [cardPath, setCardPath] = useState(null);
  const [cardSize, setCardSize] = useState(null);
  const [devOpen, setDevOpen] = useState(false);

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
  const lastStage = useRef(null);

  // Mask box in VIEW coordinates. Shared values so the drag stays on the UI thread.
  const bx = useSharedValue(40);
  const by = useSharedValue(120);
  const bw = useSharedValue(240);
  const bh = useSharedValue(52);

  const map = useMemo(
    () => (src && stage ? fit(src.width, src.height, stage.w, stage.h) : null),
    [src, stage],
  );

  const emit = useCallback((label, payload) => {
    const line = label + ' ' + JSON.stringify(payload);
    // Marker prefix so the whole run lifts off the device with:
    //   adb logcat -s ReactNativeJS:V | grep PHASE0
    console.log(LOG, line);
    setLog((prev) => [{ label, payload }, ...prev].slice(0, 12));
  }, []);

  // A box drawn in one viewport means something different in another, which is
  // the same rule the crop rect follows. The stage changes size on rotation and
  // on a display-zoom change, so rather than let the box quietly point at
  // different pixels, it goes back to a default inside the new stage and says
  // so. Skipped on the first layout, where there is no previous viewport.
  const onStageLayout = useCallback((e) => {
    const { width, height } = e.nativeEvent.layout;
    const next = { w: Math.round(width), h: Math.round(height) };
    const prev = lastStage.current;
    lastStage.current = next;
    setStage(next);
    if (!prev || (prev.w === next.w && prev.h === next.h)) return;
    bx.value = Math.round(next.w * 0.1);
    by.value = Math.round(next.h * 0.2);
    bw.value = Math.round(next.w * 0.6);
    bh.value = Math.round(next.h * 0.08);
    emit('cover.reset', { from: prev, to: next, note: 'the box was drawn in a viewport that no longer exists' });
  }, [bx, by, bw, bh, emit]);

  // Ask once per mount whether a newer APK exists. Deliberately fire-and-forget:
  // nothing waits on it, nothing is blocked by it, and a failure is a log line.
  // The once-a-day throttle lives in src/update.js, so a person who restarts
  // the app ten times does not produce ten requests.
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

  // Replace the runtime, because nothing short of that re-registers the
  // launcher: backgrounding does not, and a second activity recreation does not
  // either. Both were measured on 2026-09-18. See src/recover.js.
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
    // The launch is INSIDE the boundary, and reports under its own label.
    //
    // It used to sit above the try, so its rejection escaped as an unhandled
    // promise and the button simply stopped working with nothing on screen. The
    // failure is real and reproduced on device: after the activity is recreated
    // (a font-scale or density change does it, and rotation cannot, because
    // `configChanges` absorbs rotation) `launchImageLibraryAsync` rejects with
    // "Attempting to launch an unregistered ActivityResultLauncher".
    //
    // The app now repairs itself instead of reporting and stopping: see
    // `src/recover.js` for what was measured, and `recoverPicker` above for the
    // repair. Two ways in, on purpose. The detector below knows the launcher is
    // dead before it is used; the catch here covers every route to the same
    // fault that the detector does not watch for.
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
      // The URI is kept because renderCard takes one: a share arrives as a
      // content:// URI, so that is the real input, not the already-decoded image.
      setSrc({ ...decoded, uri: asset.uri });
      setShown(decoded.img);
      setCovered(false);
      setShowingResult(false);
      setCardPath(null);
      setCardSize(null);
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
    // recreation went the long way round: launch, reject, report, recover. The
    // reactive path caught it, which is exactly why the omission was invisible
    // on the device: the repair still worked, one scary stack trace later.
  }, [emit, staleLauncher, recoverPicker]);

  /** Mask box in image pixels, from the on-screen box. */
  const boxInImageSpace = useCallback(() => {
    if (!map) return null;
    return {
      x: Math.round((bx.value - map.offX) / map.scale),
      y: Math.round((by.value - map.offY) / map.scale),
      w: Math.round(bw.value / map.scale),
      h: Math.round(bh.value / map.scale),
    };
  }, [map, bx, by, bw, bh]);

  // --- Q1 + Q3: the cheap answers -----------------------------------------
  // fontScale and density are the two configuration values MainActivity's
  // configChanges does not absorb, so a change to either recreates the activity
  // and kills the launcher while this runtime carries on running. There is no
  // other signal: the runtime is not restarted and is not told.
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
    // Not repaired here. The repair destroys this runtime, and doing that the
    // instant someone changes their system font size would throw away a card
    // they were looking at. It waits until the picker is actually wanted.
    emit('pick.stale', { from: prev, to: next, note: 'activity recreated; the picker will recover on use' });
  }, [fontScale, pixelScale, emit]);

  // Finish the pick the previous runtime could not make.
  useEffect(() => {
    const flag = takeResumeFlag();
    const decision = resumeDecision(flag, Date.now());
    if (!flag) return;
    emit('pick.resume', { resume: decision.resume, reason: decision.reason });
    if (!decision.resume) return;
    // THIS runtime is the recovery. Marking it spent is what bounds the loop: if
    // the picker fails again now, recoveryPlan answers give-up instead of
    // reloading, and a self-reloading app that never comes back is worse than a
    // button that does not work.
    recoveryUsed.current = true;
    pick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // --- Q2 + Q4: compose, encode, round-trip -------------------------------
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
      setShown(out.snapshot);
      setCovered(withMask);
      setShowingResult(true);
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

  // --- Phase 1: the real pipeline, end to end -----------------------------
  //
  // Unlike the Q2 buttons, nothing here composes anything itself: the crop, the
  // trim, the padding, the frame colour and every Cover fill come from
  // renderCard. The card is then decoded back off disk and shown, which is both
  // the cheapest possible check that the written file is a real PNG and the only
  // way to answer Q1 by eye, the question no measurement can settle.
  const render = useCallback(
    async (withMask, space) => {
      if (!src) return;
      setProblem(null);
      setBusy(true);
      const masks = withMask ? [boxInImageSpace()] : [];
      try {
        const t0 = Date.now();
        const out = await renderCard({
          uri: src.uri,
          padding: 'standard',
          trim: 'auto',
          masks,
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
        setShown(back);
        setCovered(withMask);
        setShowingResult(true);
        setCardPath(out.path);
        setCardSize({ width: out.width, height: out.height });
        emit('P1.render', {
          path: out.path,
          space: space ? 'DisplayP3' : 'sRGB',
          out: out.width + 'x' + out.height,
          fileBack: back.width() + 'x' + back.height(),
          kiB: +(out.bytes / 1024).toFixed(1),
          fill: out.fill,
          fillSource: out.fillSource,
          fillLuma: out.fillLuma,
          bg: out.background && {
            hex: out.background.hex,
            source: out.background.source,
            reason: out.background.reason,
            coverage: out.background.coverage,
          },
          crop: out.crop,
          dest: out.dest,
          pad: out.pad,
          trimmed: out.trimmed,
          trimmedRows: out.trimmedRows,
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
    [src, boxInImageSpace, emit],
  );

  // Hand the PNG to the system sheet. Not "Save to Photos": that is MediaStore
  // and scoped storage per API level, which is Phase 5. This is the path the
  // product exists for, and expo-sharing was already a dependency.
  const share = useCallback(async () => {
    if (!cardPath) return;
    setProblem(null);
    try {
      // Asked, not assumed. A device with no sharing target throws from
      // shareAsync, and "nothing happened" is the worst possible answer.
      const can = await Sharing.isAvailableAsync();
      if (!can) {
        emit('P1.share', { ok: false, reason: 'no sharing target' });
        setProblem(COPY.shareFailed);
        return;
      }
      await Sharing.shareAsync(cardPath, {
        mimeType: 'image/png',
        UTI: 'public.png',
      });
      emit('P1.share', { ok: true, path: cardPath });
    } catch (e) {
      emit('P1.share', { ok: false, message: String(e && e.message ? e.message : e) });
      setProblem(COPY.shareFailed);
    }
  }, [cardPath, emit]);

  // --- Q5: the probe that is allowed to die -------------------------------
  const stress = useCallback(() => {
    if (!src) return;
    emit('Q5.fullread', stressFullRead(src.img));
  }, [src, emit]);

  /** Put the source back on the canvas, which is the only state the box means anything in. */
  const backToSource = useCallback(() => {
    if (!src) return;
    setShown(src.img);
    setShowingResult(false);
    setCovered(false);
    setCardPath(null);
    setCardSize(null);
    setProblem(null);
  }, [src]);

  // --- gestures -----------------------------------------------------------
  const move = Gesture.Pan()
    .onChange((e) => {
      bx.value += e.changeX;
      by.value += e.changeY;
    })
    .runOnJS(false);

  const resize = Gesture.Pan()
    .onChange((e) => {
      bw.value = Math.max(24, bw.value + e.changeX);
      bh.value = Math.max(16, bh.value + e.changeY);
    })
    .runOnJS(false);

  const boxStyle = useAnimatedStyle(() => ({
    left: bx.value,
    top: by.value,
    width: bw.value,
    height: bh.value,
  }));

  const showBox = Boolean(src) && !showingResult && useCover;

  let caption = '';
  if (problem) caption = problem;
  else if (busy) caption = COPY.working;
  else if (showingResult && cardSize) {
    caption = `${COPY.ready}. ${fill(COPY.cardSize, cardSize)}`;
  } else if (showingResult) caption = COPY.ready;
  else if (showBox) caption = COPY.coverHint;

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

      {/* The stage only paints its dark ground once there is an image on it.
          Empty, it was a full-height black slab with one line of grey text at
          the top, which reads as a broken viewport rather than as an empty
          app. It was also unreadable: the stage is dark in BOTH themes, so in
          light mode that line was light-Graphite on Ink at 2.37:1. contrast.py
          now checks the stage pairs, which is how that ratio was found. */}
      <View
        style={[styles.stage, shown ? { backgroundColor: palette.stage } : null]}
        onLayout={onStageLayout}
      >
        {shown && map && stage ? (
          <Canvas style={{ width: stage.w, height: stage.h }}>
            <SkiaImage image={shown} x={0} y={0} width={stage.w} height={stage.h} fit="contain" />
          </Canvas>
        ) : (
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: palette.graphite }]}>{COPY.emptyTitle}</Text>
          </View>
        )}

        {showBox ? (
          <GestureDetector gesture={move}>
            <Animated.View style={[styles.box, boxStyle]}>
              <GestureDetector gesture={resize}>
                <View style={styles.handle} />
              </GestureDetector>
            </Animated.View>
          </GestureDetector>
        ) : null}
      </View>

      {/* The way in to the measurement harness, and the only thing on this
          screen that is not for a person using the app. A long press rather
          than a control, because a visible button would be the twelfth thing
          this screen used to have and the first thing to make it look like a
          tool again. Documented in the README. */}
      <Pressable onLongPress={() => setDevOpen(true)} delayLongPress={800} style={styles.captionWrap}>
        <Text style={[styles.caption, { color: problem ? palette.text : palette.graphite }]}>
          {caption}
        </Text>
      </Pressable>

      <View style={styles.bar}>
        {!src ? (
          <Action label={COPY.choose} palette={palette} primary wide onPress={pick} />
        ) : showingResult ? (
          <>
            <Action label={COPY.startOver} palette={palette} onPress={backToSource} />
            <Action label={COPY.share} palette={palette} primary onPress={share} disabled={!cardPath} />
          </>
        ) : (
          <>
            <Action label={COPY.startOver} palette={palette} onPress={pick} />
            <Action
              label={COPY.cover}
              palette={palette}
              selected={useCover}
              onPress={() => setUseCover((v) => !v)}
            />
            <Action
              label={COPY.makeCard}
              palette={palette}
              primary
              disabled={busy}
              onPress={() => render(useCover)}
            />
          </>
        )}
      </View>

      {devOpen ? (
        <DevPanel
          palette={palette}
          log={log}
          src={src}
          covered={covered}
          showingResult={showingResult}
          scheme={scheme}
          onMeasureCheap={measureCheap}
          onStress={stress}
          onCompose={compose}
          onRender={render}
          onBackToSource={backToSource}
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
 * One control. `primary` is the Signal-filled island; everything else is a
 * surface pill with a hairline. `selected` is the Cover toggle's on state,
 * which is shown by the border rather than by colour alone.
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

  // White core plus a dark outline, because a coloured handle over arbitrary
  // screenshot pixels can be invisible. No pair of theme tokens can express
  // that requirement, which is why it is not one.
  box: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    outlineWidth: 1,
    outlineColor: 'rgba(0,0,0,0.6)',
  },
  handle: {
    position: 'absolute',
    right: -12,
    bottom: -12,
    width: 24,
    height: 24,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.6)',
  },

  captionWrap: { minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: SPACE.lg },
  caption: { ...TYPE.caption, textAlign: 'center' },

  bar: { flexDirection: 'row', gap: SPACE.sm, paddingHorizontal: SPACE.md, paddingBottom: SPACE.xl },
  action: {
    flex: 1,
    minHeight: TOUCH + 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACE.lg,
  },
  actionWide: { flex: 1 },
  actionOff: { opacity: 0.4 },
  actionText: { ...TYPE.label },
});
