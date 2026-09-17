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

# --- shipped token table: every pair must pass at its claimed level ---
print('\n=== shipped tokens ===')
GRAPHITE_D='#949BA2'; SIGNAL_D='#7C9AE0'
import os
GRAPHITE_D = os.environ.get('BREAK_GRAPHITE_D', GRAPHITE_D)
ship = [
 ('Graphite-L on Paper',   GRAPHITE,   PAPER,  4.5),
 ('Graphite-D on Ink',     GRAPHITE_D, INK,    4.5),
 ('Graphite-D on Surf-D',  GRAPHITE_D, SURF_D, 4.5),
 ('Signal-L on Paper',     SIGNAL,     PAPER,  4.5),
 ('Signal-D on Ink',       SIGNAL_D,   INK,    4.5),
 ('Signal-D on Surf-D',    SIGNAL_D,   SURF_D, 4.5),
]
fails = 0
for name,a,b,need in ship:
    r = ratio(a,b)
    ok = r >= need
    fails += (not ok)
    print(f'{name:24s} {r:5.2f}:1  need {need}  {"PASS" if ok else "FAIL"}')
print(f'-> {fails} failing pair(s)')
raise SystemExit(1 if fails else 0)
