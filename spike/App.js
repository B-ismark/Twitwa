// Phase 0 spike. Throwaway by design: one screen, no nav, no theme.
// See PHASE0.md for what each button is meant to answer.
//
// Each question has its own button rather than one "Measure" that runs them
// all. Q5 is a deliberate out-of-memory probe, and a single button would lose
// the four cheap answers every time the expensive one died.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DevSettings,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { File, Paths } from 'expo-file-system';
import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { Canvas, Image as SkiaImage, ColorSpace } from '@shopify/react-native-skia';
import * as ImagePicker from 'expo-image-picker';

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
  isStaleLauncherError,
  launcherWentStale,
  recoveryPlan,
  resumeDecision,
} from './src/recover';

const PAPER = '#F6F4EF';
const INK = '#15181D';
const LOG = 'PHASE0';

// A dead picker launcher is repaired by replacing the JS runtime, which throws
// away everything in memory — including the fact that the owner had just asked
// to pick a picture. This file carries that one intention across the reload, so
// the recovery costs one tap instead of two.
//
// In the cache directory on purpose: it is a hint, not data. Android may delete
// it at any time and the only cost is the extra tap this exists to avoid.
// `src/recover.js` bounds its age, because there is no moment at which this can
// reliably be cleaned up — the runtime that writes it is about to be destroyed.
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

/** Read it and delete it in one go: a resume flag must never be usable twice. */
function takeResumeFlag() {
  try {
    const f = new File(Paths.cache, RESUME_FLAG);
    if (!f.exists) return null;
    // textSync, NOT text. text() returns a promise, so the delete below raced
    // the read: the file was gone before the read resolved, the rejection was
    // an unhandled promise rather than something this try/catch could see, and
    // the log showed ENOENT on a file that had just been written successfully.
    const text = f.textSync();
    // Deleted BEFORE it is parsed. A flag whose contents throw would otherwise
    // be re-read on every launch, and the failure it describes is the one that
    // ends in a reload.
    f.delete();
    return JSON.parse(text);
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
  const { width: screenW, fontScale, scale: pixelScale } = useWindowDimensions();
  const canvasW = screenW;
  const canvasH = 420;

  const [src, setSrc] = useState(null);      // { img, width, height, ... }
  const [shown, setShown] = useState(null);  // SkImage currently drawn
  const [covered, setCovered] = useState(false);
  // Which image is on the canvas: the source, or a result. The Cover box is only
  // meaningful over the source — `map` converts view coordinates to SOURCE
  // pixels, and a result is trimmed, padded and rescaled, so the same on-screen
  // rectangle points at different content. Showing a result with the box still
  // live meant the next Render covered a region other than the one selected.
  // Two previews, one box, and the box belongs to exactly one of them.
  const [showingResult, setShowingResult] = useState(false);
  const [log, setLog] = useState([]);

  // The picker launcher is dead until this runtime is replaced. See
  // src/recover.js for the measurement behind that claim.
  const [staleLauncher, setStaleLauncher] = useState(false);
  // Survives the reload through the flag file, not through this ref — a reload
  // creates a new runtime in which every ref is fresh, so a ref alone would
  // permit an endless reload loop. The mount effect below sets it when this
  // runtime IS the recovery.
  const recoveryUsed = useRef(false);
  const lastConfig = useRef(null);

  // Mask box in VIEW coordinates. Shared values so the drag stays on the UI thread.
  const bx = useSharedValue(40);
  const by = useSharedValue(120);
  const bw = useSharedValue(240);
  const bh = useSharedValue(52);

  const map = useMemo(
    () => (src ? fit(src.width, src.height, canvasW, canvasH) : null),
    [src, canvasW, canvasH],
  );

  const emit = useCallback((label, payload) => {
    const line = label + ' ' + JSON.stringify(payload);
    // Marker prefix so the whole run lifts off the device with:
    //   adb logcat -s ReactNativeJS:V | grep PHASE0
    console.log(LOG, line);
    setLog((prev) => [{ label, payload }, ...prev].slice(0, 12));
  }, []);

  // Replace the runtime, because nothing short of that re-registers the
  // launcher: backgrounding does not, and a second activity recreation does not
  // either. Both were measured on 2026-09-18 — see src/recover.js.
  const recoverPicker = useCallback(
    (why) => {
      const canReload = typeof DevSettings !== 'undefined' && typeof DevSettings.reload === 'function';
      const plan = recoveryPlan({ canReload, alreadyTried: recoveryUsed.current });
      emit('pick.recover', { why, action: plan.action, message: plan.message });
      if (plan.action !== 'reload') return;
      recoveryUsed.current = true;
      emit('pick.recover.reload', { resumeFlagWritten: writeResumeFlag() });
      DevSettings.reload();
    },
    [emit],
  );

  const pick = useCallback(async () => {
    // The launch is INSIDE the boundary, and reports under its own label.
    //
    // It used to sit above the try, so its rejection escaped as an unhandled
    // promise and the button simply stopped working with nothing on screen. The
    // failure is real and reproduced on device: after the activity is recreated
    // — a font-scale or density change does it, and rotation cannot, because
    // `configChanges` absorbs rotation — `launchImageLibraryAsync` rejects with
    // "Attempting to launch an unregistered ActivityResultLauncher".
    //
    // The app now repairs itself instead of reporting and stopping: see
    // `src/recover.js` for what was measured, and `recoverPicker` above for the
    // repair. Two ways in, on purpose. The detector below knows the launcher is
    // dead before it is used; the catch here covers every route to the same
    // fault that the detector does not watch for.
    //
    // A separate label from `decode.error` on purpose. One says the picker never
    // opened, the other says it returned something unreadable, and reporting
    // both as a decode failure is what made the first one look like a bad file.
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
      emit('decode', {
        w: decoded.width,
        h: decoded.height,
        mp: decoded.megapixels,
        rgbaMiB: decoded.rgbaMiB,
        decodeMs: decoded.decodeMs,
      });
    } catch (e) {
      emit('decode.error', { message: String(e && e.message ? e.message : e) });
    }
    // staleLauncher and recoverPicker belong here. With `[emit]` alone this
    // callback kept the first render's `staleLauncher: false` for the life of
    // the component, so the proactive branch above could never fire and every
    // recreation went the long way round: launch, reject, report, recover. The
    // reactive path caught it, which is exactly why the omission was invisible
    // on the device -- the repair still worked, one scary stack trace later.
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
        space: colorSpace === ColorSpace.DisplayP3 ? 'DisplayP3' : 'sRGB',
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
  // Unlike the Q2 buttons above, nothing here composes anything itself: the crop,
  // the trim, the padding, the frame colour and every Cover fill come from
  // renderCard. The card is then decoded back off disk and shown, which is both
  // the cheapest possible check that the written file is a real PNG and the only
  // way to answer Q1 by eye — the question no measurement can settle.
  const render = useCallback(
    async (withMask, space) => {
      if (!src) return;
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
          return;
        }
        // Read the file back rather than trusting the return value. A wrong
        // width here means the encode and the plan disagree; a throw means the
        // bytes on disk are not a PNG.
        const back = await decodeUri(out.path);
        setShown(back);
        setCovered(withMask);
        setShowingResult(true);
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
      }
    },
    [src, boxInImageSpace, emit],
  );

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

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={[styles.canvasWrap, { width: canvasW, height: canvasH }]}>
        {shown && map ? (
          <Canvas style={{ width: canvasW, height: canvasH }}>
            <SkiaImage
              image={shown}
              x={0}
              y={0}
              width={canvasW}
              height={canvasH}
              fit="contain"
            />
          </Canvas>
        ) : (
          <Text style={styles.hint}>Pick a screenshot</Text>
        )}

        {src && !showingResult ? (
          <GestureDetector gesture={move}>
            <Animated.View style={[styles.box, boxStyle]}>
              <GestureDetector gesture={resize}>
                <View style={styles.handle} />
              </GestureDetector>
            </Animated.View>
          </GestureDetector>
        ) : null}
      </View>

      <View style={styles.row}>
        <Btn label="Pick" onPress={pick} />
        <Btn label="Q1+Q3" onPress={measureCheap} disabled={!src || showingResult} />
        <Btn label="Q5 stress" onPress={stress} disabled={!src} />
      </View>
      <View style={styles.row}>
        <Btn label="Cover on" onPress={() => compose(undefined, true)} disabled={!src || showingResult} />
        <Btn label="Cover off" onPress={() => compose(undefined, false)} disabled={!src || showingResult} />
        <Btn label="P3" onPress={() => compose(ColorSpace.DisplayP3, true)} disabled={!src || showingResult} />
      </View>
      <View style={styles.row}>
        <Btn label="Render" onPress={() => render(false)} disabled={!src || showingResult} />
        <Btn label="Render + cover" onPress={() => render(true)} disabled={!src || showingResult} />
        {/* Q4 through the real pipeline. The "P3" button above drives Phase 0's
            composeAndEncode, which is a different encoder call; the default
            render writes no iCCP at all, so this is the only way to find out
            whether renderCard tags a P3 card. */}
        <Btn
          label="Render P3"
          onPress={() => render(false, ColorSpace.DisplayP3)}
          disabled={!src || showingResult}
        />
        {/* The only way out of result mode, and the only thing that puts the box
            back. Without it the box stayed live over a rendered card and the next
            render covered a region other than the one selected. */}
        <Btn label="Back to source" onPress={backToSource} disabled={!src || !showingResult} />
      </View>
      <Text style={styles.state}>
        {src
          ? src.width + 'x' + src.height + '  ' + src.megapixels + 'MP  ' +
            src.rgbaMiB + 'MiB RGBA  ' + (covered ? 'covered' : 'uncovered') +
            (showingResult ? '  — showing RESULT, box hidden' : '  — showing source')
          : 'no image'}
        {staleLauncher ? '  — picker stale, will recover on use' : ''}
      </Text>

      <ScrollView style={styles.logWrap}>
        {log.map((entry, i) => (
          <Text key={i} selectable style={styles.logLine}>
            {entry.label + '  ' + JSON.stringify(entry.payload, null, 1)}
          </Text>
        ))}
      </ScrollView>
    </GestureHandlerRootView>
  );
}

function Btn({ label, onPress, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.btn, disabled && styles.btnOff]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: INK, paddingTop: 44 },
  canvasWrap: { backgroundColor: '#000' },
  hint: { color: '#949BA2', textAlign: 'center', marginTop: 180 },
  // White core plus a dark outline, because a coloured handle over arbitrary
  // screenshot pixels can be invisible — the same reason the real app uses
  // brackets instead of a Signal-coloured rectangle.
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
  row: { flexDirection: 'row', gap: 8, padding: 8 },
  btn: { flex: 1, backgroundColor: '#1E2228', paddingVertical: 12, borderRadius: 8 },
  btnOff: { opacity: 0.4 },
  btnText: { color: '#F6F4EF', textAlign: 'center', fontSize: 13 },
  state: { color: '#949BA2', fontSize: 11, paddingHorizontal: 10 },
  logWrap: { flex: 1, margin: 8, backgroundColor: '#0E1013', borderRadius: 8 },
  logLine: {
    color: '#949BA2',
    fontFamily: 'monospace',
    fontSize: 10,
    padding: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.10)',
  },
});
