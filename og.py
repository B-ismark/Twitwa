"""Extract Open Graph / twitter: meta tags from a saved post page.

Usage:  python og.py <saved.html> [more.html ...]

Exits 1 if any page is missing og:title, og:description or og:image, so it
doubles as a gate. Two things this gets right that a line-based `grep -o` does
not, and both of them silently produced wrong answers first time round:

  * re.S, because og:description contains literal newlines
  * no length cap, because Meta's signed og:image URLs run 480-580 chars
"""
import re, sys, html, io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8',
                              errors='backslashreplace')

KEYS = ('og:title', 'og:description', 'og:image', 'og:image:width',
        'og:image:height', 'og:image:alt', 'og:url', 'twitter:card',
        'twitter:creator', 'twitter:description')
ESSENTIAL = ('og:title', 'og:description', 'og:image')

ATTR_FIRST = re.compile(
    rb'<meta[^>]*?(?:property|name)="((?:og|twitter):[a-z:]+)"[^>]*?content="([^"]*)"',
    re.I | re.S)
CONTENT_FIRST = re.compile(
    rb'<meta[^>]*?content="([^"]*)"[^>]*?(?:property|name)="((?:og|twitter):[a-z:]+)"',
    re.I | re.S)


def extract(raw):
    found = {}
    for m in ATTR_FIRST.finditer(raw):
        found.setdefault(m.group(1).decode(), m.group(2).decode('utf-8', 'replace'))
    for m in CONTENT_FIRST.finditer(raw):
        found.setdefault(m.group(2).decode(), m.group(1).decode('utf-8', 'replace'))
    return {k: html.unescape(v) for k, v in found.items()}


def main(paths):
    failures = 0
    for path in paths:
        raw = open(path, 'rb').read()
        found = extract(raw)
        print(f'--- {path} ({len(raw)} bytes) ---')
        for k in KEYS:
            if k in found:
                v = found[k].replace('\n', '\\n')
                print(f'  {k:22s} len={len(v):5d}  {v[:140]}')
        missing = [k for k in ESSENTIAL if not found.get(k, '').strip()]
        if missing:
            failures += 1
            print(f'  MISSING/EMPTY essentials: {missing}')
        else:
            print('  all three essentials present')
        print()
    print(f'-> {failures} page(s) missing essentials')
    return 1 if failures else 0


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1:]))
