# Test links

Posts supplied by the user for measuring endpoint behaviour. The measurements in
`measured-endpoints.md` are only reproducible against the same inputs — a finding
whose input is gone is a claim, not a measurement — so the set is recorded, but
by shape rather than by link.

**The links themselves are held back**, under the same rule as
`spike/fixtures/screenshots/`: they are posts by identifiable people who did not
agree to appear in a public repository, and one of them carries an Instagram
`stkn=` share token, which is part of how that post is reachable. They live in
`test-links.local.md`, which is gitignored.

## The set

| Placeholder | Platform | What it exercises |
| --- | --- | --- |
| `X-1` | X | plain text post; X's overloaded `og:image`; oEmbed `author_name` + `html` |
| `IG-1` | Instagram | OG-only path — oEmbed returns almost nothing; signed CDN `og:image` 480-580 chars, expiring in ~5 days |
| `TH-1` | Threads | `/share/` short form, which oEmbed **rejects** although it is the primary entry path; `og:title` carries an emoji, which is why the pipeline must be UTF-8 clean |
| `X-2` | X | **quote post** — the nested fetch chain |
| `X-3` | X | **reply** — the parent-ancestor DOM walk; returns 1 ancestor where an original post returns 0 |

`X-2` and `X-3` were supplied in round 3 and, until now, existed only in the
conversation transcript. `measured-endpoints.md` records what was measured from
them without recording which posts they were, so the quote-chain and
reply-parent findings were not reproducible. They are now, for anyone holding
`test-links.local.md`.

## What these are for, and what they are not for

They exercise the **v2 link-input path** in the spec's appendix, and they are the
live inputs for `og.py`. The saved HTML is already archived in
`fixtures/og-pages.tar.gz`, so the gate runs offline; these links are for
re-measuring when something is suspected to have changed upstream.

They cannot answer anything in Phase 0. Phase 0 is about screenshots — a crop,
a sampled fill, and whether the seam shows. An OG image is the post's photo, not
a capture of the post's interface, so it has none of the chrome the Cover tool
exists to hide.

**Phase 0 needs screenshots**: a phone capture of an Instagram post showing the
like-count row between image and caption, a dark-mode X post, and one with a
gradient header. Then:

```
cd spike && node tools/probe.mjs <shot>.png
```

## Caveats on re-measuring

- Instagram and Threads `og:image` URLs are signed and expire in roughly five
  days (`oe` is a hex epoch). A stale URL is not a broken parser.
- `t.co` no longer redirects. It returns 200 with a meta-refresh interstitial, so
  a `HEAD` request fails *silently* rather than erroring.
- HTTP 400 alone does not mean deleted or private. Inspect the error `code` and
  normalise the URL first.

## The history is already public

These links were in this file and in `measured-endpoints.md` from commit
`dfa6dbc`, and that commit is pushed. Taking them out of the working tree does
not take them out of the published history — `git show dfa6dbc:test-links.md`
still returns them to anyone with the repository. Removing them properly means
rewriting and force-pushing history, which breaks every existing clone and is
not a call to make quietly. Recorded here so the decision is visible rather than
assumed.
