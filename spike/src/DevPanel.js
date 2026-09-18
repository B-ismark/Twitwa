// The Phase 0 and Phase 1 measurement harness, which used to be the whole app.
//
// It is kept, and kept reachable, because every measured number in this
// repository came out of these buttons. A measurement nobody can repeat is a
// measurement everyone has to take on trust, and the device is the only place
// several of them can be taken at all: Skia signatures, the Display P3 chunk,
// the composed-surface ceiling, and whether a card comes back byte-identical.
//
// It is hidden behind a long press because it is not part of the app. Two
// things follow from that split and are worth stating:
//
//   - The words in here are for whoever is holding a cable, not for a person
//     using Twitwa. That is why this file is NOT in `check-copy.mjs`'s list of
//     views: "Q1+Q3" is exactly the sort of label that gate exists to stop, and
//     exactly the right label here.
//   - Buttons here take `name`, not `label`. The gate looks for `label=` with a
//     literal string, so the two props keep the boundary visible in the source
//     rather than only in a comment.
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ColorSpace } from '@shopify/react-native-skia';

import { RADIUS, SPACE, TOUCH, TYPE } from './theme.js';

function DevBtn({ name, onPress, disabled, palette }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.btn,
        { backgroundColor: palette.surface, borderColor: palette.hairline },
        disabled && styles.off,
      ]}
    >
      <Text style={[styles.btnText, { color: palette.text }]}>{name}</Text>
    </Pressable>
  );
}

export default function DevPanel({
  palette,
  log,
  src,
  covered,
  showingResult,
  onMeasureCheap,
  onStress,
  onCompose,
  onRender,
  onBackToSource,
  onClose,
  title,
  hint,
  closeLabel,
}) {
  const hasSrc = Boolean(src);
  const live = hasSrc && !showingResult;
  return (
    <View style={[styles.sheet, { backgroundColor: palette.background }]}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: palette.text }]}>{title}</Text>
        <Pressable onPress={onClose} style={styles.close} hitSlop={SPACE.md}>
          <Text style={[styles.closeText, { color: palette.signal }]}>{closeLabel}</Text>
        </Pressable>
      </View>
      <Text style={[styles.hint, { color: palette.graphite }]}>{hint}</Text>

      <View style={styles.row}>
        <DevBtn name="Q1+Q3" onPress={onMeasureCheap} disabled={!live} palette={palette} />
        <DevBtn name="Q5 stress" onPress={onStress} disabled={!hasSrc} palette={palette} />
      </View>
      <View style={styles.row}>
        <DevBtn name="Cover on" onPress={() => onCompose(undefined, true)} disabled={!live} palette={palette} />
        <DevBtn name="Cover off" onPress={() => onCompose(undefined, false)} disabled={!live} palette={palette} />
        <DevBtn name="P3" onPress={() => onCompose(ColorSpace.DisplayP3, true)} disabled={!live} palette={palette} />
      </View>
      <View style={styles.row}>
        <DevBtn name="Render" onPress={() => onRender(false)} disabled={!live} palette={palette} />
        <DevBtn name="Render + cover" onPress={() => onRender(true)} disabled={!live} palette={palette} />
      </View>
      <View style={styles.row}>
        {/* Q4 through the real pipeline. The "P3" button above drives Phase 0's
            composeAndEncode, which is a different encoder call; the default
            render writes no iCCP at all, so this is the only way to find out
            whether renderCard tags a P3 card. */}
        <DevBtn
          name="Render P3"
          onPress={() => onRender(false, ColorSpace.DisplayP3)}
          disabled={!live}
          palette={palette}
        />
        {/* The only way out of result mode, and the only thing that puts the box
            back. Without it the box stayed live over a rendered card and the next
            render covered a region other than the one selected. */}
        <DevBtn
          name="Back to source"
          onPress={onBackToSource}
          disabled={!hasSrc || !showingResult}
          palette={palette}
        />
      </View>

      <Text style={[styles.state, { color: palette.graphite }]}>
        {src
          ? `${src.width}x${src.height}  ${src.megapixels}MP  ${src.rgbaMiB}MiB RGBA  ${showingResult ? 'result' : 'source'}  ${covered ? 'covered' : 'uncovered'}`
          : 'no image'}
      </Text>

      <ScrollView style={[styles.logWrap, { backgroundColor: palette.stage }]}>
        {log.map((entry, i) => (
          <Text
            key={i}
            selectable
            style={[styles.logLine, { color: palette.graphite, borderBottomColor: palette.hairline }]}
          >
            {entry.label + '  ' + JSON.stringify(entry.payload, null, 1)}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { ...StyleSheet.absoluteFillObject, paddingTop: SPACE.xxl + SPACE.lg, paddingHorizontal: SPACE.md },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { ...TYPE.title },
  close: { minHeight: TOUCH, justifyContent: 'center', paddingHorizontal: SPACE.sm },
  closeText: { ...TYPE.label },
  hint: { ...TYPE.caption, marginBottom: SPACE.md },
  row: { flexDirection: 'row', gap: SPACE.sm, marginBottom: SPACE.sm },
  btn: {
    flex: 1,
    minHeight: TOUCH,
    justifyContent: 'center',
    borderRadius: RADIUS.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  off: { opacity: 0.4 },
  btnText: { ...TYPE.caption, textAlign: 'center' },
  state: { ...TYPE.caption, marginTop: SPACE.xs, marginBottom: SPACE.sm },
  logWrap: { flex: 1, borderRadius: RADIUS.sm, marginBottom: SPACE.lg },
  logLine: { ...TYPE.mono, padding: SPACE.xs + 2, borderBottomWidth: StyleSheet.hairlineWidth },
});
