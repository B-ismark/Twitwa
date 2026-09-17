# Measured endpoint behaviour — 2026-09-16

All requests unauthenticated, plain `Mozilla/5.0 (compatible; test)` UA.

## X

`GET https://publish.x.com/oembed?url=https://x.com/jack/status/20` -> 200
Fields: url, author_name, author_url, html, width, height(null), type,
cache_age ("3153600000"), provider_name, provider_url, version.
- text lives in `<p lang="en" dir="ltr">` inside `blockquote.twitter-tweet`
  -> `dir` gives RTL direction for free
- handle in `&mdash; jack (@jack)`, date in the trailing `<a>`
- MEDIA POST (TheEllenShow/440322224407314432): html carries only
  `<a href="http://t.co/C9U5NOtGap">pic.twitter.com/C9U5NOtGap</a>`
  -> NO media URL from oEmbed. Confirmed.
- no avatar URL in any response

`GET https://x.com/jack/status/20` -> 200, 181KB, OG tags served to plain UA
(NO login wall):
- og:title      "jack (@jack) on X"
- og:description "just setting up my twttr"     <- post text
- og:image      pbs.twimg.com/profile_images/...  <- AVATAR (text-only post)
- og:image:alt  "jack profile picture"          <- discriminator
- twitter:card  "summary"
- twitter:creator "@jack"

Media post (TheEllenShow) -> 200:
- og:image      pbs.twimg.com/media/BhxWutnCEAAtEQ6?format=webp&name=large
- twitter:card  "summary_large_image"           <- discriminator
- og:image:alt  absent

Deleted post (x.com/NASA/status/1) -> **404**
- og:description "The post you're looking for could not be found or may have
  been deleted."
- og:image      abs.twimg.com/rweb/ssr/default/v2/og/image.png (placeholder)
-> clean deleted-post detection: 404 + placeholder image host

CONSEQUENCE: og:image is EITHER avatar (text post) OR media (media post),
never both. Avatar for a media post needs a third fetch of
`https://x.com/{handle}` -> og:image. Cacheable per author.

## Threads

`GET https://graph.threads.com/oembed?url=<real post>` -> 200, NO token.
Fields: type, version, html, provider_name, provider_url, width.
- NO author_name, NO thumbnail_url, NO text
- `html` is a CONTENT-FREE PLACEHOLDER: a Threads logo SVG plus the words
  "View on Threads". Real content is injected client-side by
  `https://www.threads.com/embed.js`.
-> UNUSABLE for rendering.

Garbage shortcode -> **400 + error**. So oEmbed IS a valid existence check
(200 = exists, 400 = gone/private).

`GET https://www.threads.com/@zuck/post/C2QBoRaRmR1` -> 200, 568KB, OG tags
served to plain UA:
- og:title       "Mark Zuckerberg (@zuck) on Threads"
- og:description "Some updates on our AI efforts"   <- post text
- og:image:width 720 / og:image:height 1280        <- media dims pre-fetch
-> OG is the only usable source for Threads.

## Instagram

`GET https://graph.facebook.com/v25.0/instagram_oembed?url=<fake>` -> 400
`{"error":{"code":24,"error_subcode":2207045,
  "error_user_title":"Media Not Found"}}`
-> a RESOURCE error, not an OAuth/token error. Tokenless access confirmed:
the request reached resource lookup without credentials.
Field set with a real post: NOT YET MEASURED. Meta's published sample response
is version, provider_name, provider_url, type, width, html only — and the
Nov 3 2025 change dropped thumbnail_url/_width/_height/author_name.

# Round 2 — real posts supplied by the user, 2026-09-16

Links tested: `X-1`, `IG-1`, `TH-1`. The links themselves are held back — see
`test-links.md` for why, and `test-links.local.md` (gitignored) for the mapping.

## CORRECTION to round 1

Round 1 concluded "Instagram serves only og:type and og:url" and "Threads has no
og:image". Both were WRONG and both were artifacts of the measuring instrument:
`grep -o` is line-based, and og:description / og:image contents contain literal
newlines and exceed the char cap the pattern used. A regex with re.S over the raw
bytes finds all three essentials on all three platforms. og.py is the fixed
instrument.

## All three serve full OG to a PLAIN UA (no crawler spoofing needed)

X   (X-1):   og:title is "<display name> (@<handle>) on X"
             og:description 66 chars, CONTAINS REAL NEWLINES — the post's own
             text, two paragraphs separated by a blank line. Held back; the
             finding is the embedded newline, not the sentence.
             og:image = avatar (pbs.twimg.com/profile_images/...), twitter:card=summary
             og:image:alt "dax profile picture"
Threads:     og:title is "<emoji> <post opening> | <display name> (@<handle>) on Threads"
             og:description 440 chars   <- twitter:description only 201 (TRUNCATED)
             og:image 574 chars, og:image:width 1872 / height 1190
Instagram:   og:title 1083 chars: 'ScienceAlert on Instagram: "In the darkest..."'
             og:description 1117 chars, PREFIXED WITH ENGAGEMENT COUNTS:
               '71 likes, 1 comments - sciencealert on September 16, 2026: "..."'
             og:image 498 chars, fetched OK: http 200, 53635 bytes, image/jpeg

## oEmbed is a content-free placeholder on BOTH Meta platforms

instagram_oembed (real post) -> 200, keys EXACTLY:
  ['version','provider_name','provider_url','type','width','html']
  html = grey #F4F4F4 skeleton boxes + Instagram logo + "View this post on Instagram"
graph.threads.com/oembed (2 real posts) -> 200, keys:
  ['type','version','html','provider_name','provider_url','width']
  html = Threads logo + "View on Threads", 3094 chars, no post text

## Threads share links MUST be resolved before any API call

TH-1, in its `threads.com/share/<id>/` form
  -> 301 -> https://www.threads.com/@<handle>/post/<id>?xmt=...
oEmbed on the UNRESOLVED share form -> 400
  {"code":100,"error_subcode":2207047,"error_user_title":"Invalid URL"}
The share sheet emits this form, so it is the primary entry path.

## Meta media URLs are signed and EXPIRE; X's do not

X         pbs.twimg.com              0 query params        no expiry
Threads   instagram.*.fna.fbcdn.net  16 params, oe=6AB0AAC4 -> 2026-09-21 03:55 UTC
Instagram scontent.cdninstagram.com  13 params, oe=6AB0D2FB -> 2026-09-21 06:47 UTC
`oe` is a hex epoch (~5 days out). `oh` signs the rest, so stp cannot be edited to
request a bigger crop. => cache image BYTES, never the URL.

## Instagram media is a 640x640 crop
stp=c216.0.648.648a_dst-jpg_e35_s640x640_tt6 -> 53KB JPEG.
Threads served 1872x1190 by comparison. Hard resolution ceiling on IG cards.

## Emoji are routine in display names
Threads og:title begins with U+1F6A8. A cp1252 stdout throws on it; the pipeline
must be UTF-8 clean end to end.


# Round 3 — what a 400 actually means, 2026-09-16

Prompted by a peer review noting that round 2 treated a bare 400 as "deleted".
Correct: it does not mean that. Seven variants measured.

## Threads  graph.threads.com/oembed
real post (canonical)        200  OK
unresolved /share/ link      400  code 100 / 2207047 / "Invalid URL"
well-formed, fake shortcode  400  code 24  / 4279056 / "Media Not Found"
well-formed, FAKE USER       200  OK          <-- username segment IGNORED
not a threads URL            400  code 100 / 2207047 / "Invalid URL"

## Instagram  graph.facebook.com/v25.0/instagram_oembed
real post                    200  OK
well-formed, fake shortcode  400  code 24  / 2207045 / "Media Not Found"
not an instagram URL         400  code 100 / 2207047 / "Invalid URL"

## Discriminator
code 100 = OUR url is wrong -> normalize and retry, never show "deleted"
code 24  = post gone/private -> show unavailable
Branch on `code`, NOT error_subcode: "Media Not Found" is 4279056 on Threads and
2207045 on Instagram, while code 24 is common to both.

## oEmbed 200 does not validate the handle
https://www.threads.com/@zzzznotarealacct/post/<TH-1 shortcode> -> 200
returned permalink: https://www.threads.com/t/<TH-1 shortcode>
The username segment is discarded. So a fabricated handle in the input URL yields
a successful probe for a real post. Attribution must come from the SCRAPED
og:url, never the input URL.

That same fake-username page URL returns 301 with an empty body, so the page
scrape must follow redirects (-L) generally, not only for /share/ links. og.py on
the unfollowed body correctly reports all three essentials missing -- which is
indistinguishable from a parse failure, hence: follow redirects.


# Round 4 — t.co expansion, 2026-09-16

## t.co NO LONGER REDIRECTS
https://t.co/C9U5NOtGap  -> 200, NO Location header, 0 redirects, 357 bytes
http://t.co/C9U5NOtGap   -> 520 (scheme matters; use https)

Body is a meta-refresh interstitial carrying the target three times:
  <META http-equiv="refresh" content="0;URL=https://twitter.com/TheEllenShow/status/440322224407314432/photo/1">
  <title>https://twitter.com/TheEllenShow/status/440322224407314432/photo/1</title>
  location.replace("https:\/\/twitter.com\/TheEllenShow\/status\/440322224407314432\/photo\/1")

=> Expand with GET + parse meta refresh. A HEAD or -L expansion silently fails:
   it returns 200 and you conclude the link is already canonical.
   This corrects the round-2 spec rule which said "expand t.co with a HEAD request".

## X oEmbed does NOT expose a reply parent
X-1's blockquote contains exactly one href: its own permalink.
No data-conversation attribute. (That post is not itself a reply, so this is
evidence about the response shape, not about reply handling — still unmeasured.)

## STILL UNMEASURED, blocks the quote-post feature
- whether a QUOTE post's blockquote carries a t.co link to the quoted status
- whether a REPLY's page exposes its parent post
Both need one real URL each.

