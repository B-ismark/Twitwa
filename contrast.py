def lin(c):
    c = c/255
    return c/12.92 if c <= 0.03928 else ((c+0.055)/1.055)**2.4

def L(hexs):
    h = hexs.lstrip('#')
    r,g,b = (int(h[i:i+2],16) for i in (0,2,4))
    return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)

def ratio(a,b):
    la,lb = L(a),L(b)
    hi,lo = max(la,lb),min(la,lb)
    return (hi+0.05)/(lo+0.05)

PAPER='#F6F4EF'; INK='#15181D'
SURF_L='#FFFFFF'; SURF_D='#1E2228'
GRAPHITE='#4B5157'; SIGNAL='#3B5BA8'

pairs = [
 ('Graphite on Paper', GRAPHITE, PAPER),
 ('Graphite on Ink', GRAPHITE, INK),
 ('Graphite on Surface-dark', GRAPHITE, SURF_D),
 ('Signal on Paper', SIGNAL, PAPER),
 ('Signal on Ink', SIGNAL, INK),
 ('Signal on Surface-dark', SIGNAL, SURF_D),
 ('Ink text on Paper', INK, PAPER),
 ('Paper text on Ink', PAPER, INK),
 ('Surface-dark on Ink (island edge)', SURF_D, INK),
]
for name,a,b in pairs:
    r = ratio(a,b)
    aa   = 'PASS' if r>=4.5 else 'FAIL'
    aaa  = 'PASS' if r>=7.0 else 'FAIL'
    ui   = 'PASS' if r>=3.0 else 'FAIL'
    print(f'{name:36s} {r:5.2f}:1   text-AA {aa}  text-AAA {aaa}  ui-3:1 {ui}')

# candidate dark-mode Signal replacements
print()
for cand in ['#6E8FD6','#7C9AE0','#8FA8E8','#9DB4EC','#A8BDF0']:
    print(f'{cand} on Ink {ratio(cand,INK):5.2f}:1   on Surface-dark {ratio(cand,SURF_D):5.2f}:1')
print()
for cand in ['#8A9299','#949BA2','#9CA3AA','#A6ADB4','#B0B7BE']:
    print(f'Graphite-dark {cand} on Ink {ratio(cand,INK):5.2f}:1   on Surface-dark {ratio(cand,SURF_D):5.2f}:1')

# --- shipped token table: read out of the theme, not typed here again ------
#
# It parses spike/src/theme.js rather than carrying its own copy of the hex
# values. A second copy is the whole defect this section exists to catch: the
# numbers would agree on the day they were written and drift silently
# afterwards, and this file would keep printing PASS for a palette the app no
# longer uses. The spec says it in one line -- run the contrast gate against
# whatever ends up in the theme, not against what a document claims is in it.
#
# It REFUSES rather than passing if it cannot find every token it expects. A
# gate that reads nothing and exits 0 is worse than no gate, and a renamed key
# is exactly how that happens.
print('\n=== shipped tokens, read from spike/src/theme.js ===')
import re, sys, os

THEME = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'spike', 'src', 'theme.js')
try:
    src = open(THEME, encoding='utf-8').read()
except OSError as e:
    print(f'REFUSING: cannot read {THEME}: {e}')
    print('This gate has nothing to check, which is not the same as a pass.')
    raise SystemExit(1)


def block(name):
    """The body of one theme in the PALETTE literal."""
    m = re.search(name + r':\s*\{(.*?)\n  \}', src, re.S)
    return m.group(1) if m else None


def token(body, key):
    if body is None:
        return None
    m = re.search(key + r":\s*'(#[0-9A-Fa-f]{6})'", body)
    return m.group(1) if m else None


light_body, dark_body = block('light'), block('dark')
WANT = ['background', 'surface', 'text', 'graphite', 'signal', 'onSignal', 'stage',
        'onStage', 'onStageMuted']
tokens = {}
missing = []
for theme, body in (('light', light_body), ('dark', dark_body)):
    for key in WANT:
        v = token(body, key)
        if v is None:
            missing.append(f'{theme}.{key}')
        tokens[f'{theme}.{key}'] = v

if missing:
    print(f'REFUSING: these tokens were not found in theme.js: {", ".join(missing)}')
    print('Either a key was renamed or the literal changed shape. Read it, do not')
    print('loosen this pattern until it matches something.')
    raise SystemExit(1)

for k in sorted(tokens):
    print(f'  read  {k:20s} {tokens[k]}')

ship = [
    ('Graphite-L on Paper',  tokens['light.graphite'], tokens['light.background'], 4.5),
    ('Graphite-L on Surf-L', tokens['light.graphite'], tokens['light.surface'],    4.5),
    ('Signal-L on Paper',    tokens['light.signal'],   tokens['light.background'], 4.5),
    ('Signal-L on Surf-L',   tokens['light.signal'],   tokens['light.surface'],    4.5),
    ('Text-L on Paper',      tokens['light.text'],     tokens['light.background'], 4.5),
    ('Graphite-D on Ink',    tokens['dark.graphite'],  tokens['dark.background'],  4.5),
    ('Graphite-D on Surf-D', tokens['dark.graphite'],  tokens['dark.surface'],     4.5),
    ('Signal-D on Ink',      tokens['dark.signal'],    tokens['dark.background'],  4.5),
    ('Signal-D on Surf-D',   tokens['dark.signal'],    tokens['dark.surface'],     4.5),
    ('Text-D on Ink',        tokens['dark.text'],      tokens['dark.background'],  4.5),
]

# The label on the Signal-filled primary button. This pair is the reason
# onSignal is a token at all: with the button hardcoded to white, this check
# measured 2.78:1 on dark and failed the moment it was first run.
ship.append(('onSignal-L on Signal-L', tokens['light.onSignal'], tokens['light.signal'], 4.5))
ship.append(('onSignal-D on Signal-D', tokens['dark.onSignal'],  tokens['dark.signal'],  4.5))

# The stage: the ground the screenshot sits on. It is DARK IN BOTH THEMES, on
# purpose -- Paper tints the edges of a light screenshot enough to misjudge a
# crop -- and that is the trap. A component running light reaches for the light
# palette, and light Graphite on the stage measures 2.37:1: it fails AA and the
# 3:1 UI floor. That is not hypothetical. The empty-state message was drawn
# exactly that way and shipped in the Phase 4 commit; it was read off a
# screenshot, then measured here.
#
# So the rule is: anything drawn ON the stage takes the DARK palette's
# foreground, whatever scheme the app is running. These two pairs are what that
# rule permits. The light pair is deliberately absent rather than listed as an
# expected failure -- a table of things that are allowed to fail is a table
# nobody reads.
for theme in ('light', 'dark'):
    ship.append((f'onStage-{theme[0].upper()} on Stage',
                 tokens[f'{theme}.onStage'], tokens[f'{theme}.stage'], 4.5))
    ship.append((f'onStageMuted-{theme[0].upper()} on Stage',
                 tokens[f'{theme}.onStageMuted'], tokens[f'{theme}.stage'], 4.5))

fails = 0
for name, a, b, need in ship:
    r = ratio(a, b)
    ok = r >= need
    fails += (not ok)
    print(f'{name:24s} {r:5.2f}:1  need {need}  {"PASS" if ok else "FAIL"}')

# --- and the dark palette has to be REACHABLE -----------------------------
#
# Everything above proves the dark tokens pass. None of it proves anything
# ever selects them, and for the whole life of this project nothing did.
# `app.json` carried `"userInterfaceStyle": "light"` -- the create-expo-app
# default, never revisited -- and expo-dev-launcher reads that key out of the
# manifest Metro serves and overwrites React Native's AppearanceModule with
# it (DevLauncherExpoAppLoader.applyUserInterfaceStyle). So `useColorScheme()`
# returned 'light' on a phone sitting in night mode, the whole dark half of
# the table was measured and drawn by nobody, and the repo recorded the cause
# as "this phone locks night mode" -- which was the wrong diagnosis of a real
# observation. The owner found it by looking at the phone.
#
# Worse, that override lives in expo-dev-launcher's DEBUG source set only, and
# this app ships no expo-updates, so the RELEASE build never had it. The
# untested theme was the one other people were given.
#
# Hence this check, here rather than in a gate of its own: a contrast table
# for a palette nothing can select is decoration, which is the same fault this
# file's own header warns about one section up.
print('\n=== the dark palette is reachable ===')
import json

APP_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'spike', 'app.json')
try:
    with open(APP_JSON, encoding='utf-8') as fh:
        expo_cfg = json.load(fh)['expo']
except (OSError, KeyError, ValueError) as e:
    print(f'REFUSING: cannot read expo config from {APP_JSON}: {e}')
    print('This check has nothing to read, which is not the same as a pass.')
    raise SystemExit(1)

style = expo_cfg.get('userInterfaceStyle', 'light')
style_ok = style == 'automatic'
fails += (not style_ok)
print(f'{"userInterfaceStyle":24s} {style!r:>9}  need \'automatic\'  '
      f'{"PASS" if style_ok else "FAIL"}')
if not style_ok:
    print("  -> the dev client forces this scheme, so useColorScheme() never "
          "reports the device's. Every dark row above is then unreachable.")

print(f'-> {len(ship) + 1} pair(s)/config checked, {fails} failing')
raise SystemExit(1 if fails else 0)
