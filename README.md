# md-fast

A fast drop-in for marked 18.1.3: `parse(markdown)` returns exactly the HTML
that `marked.parse(markdown)` returns with marked's default options
(GFM on, breaks off, pedantic off, async off), for every string.

The parser is a fork of marked 18.1.3 (MIT, see `vendor/marked/LICENSE`),
tuned for speed: first-character dispatch in the inline loop, a hand-written
text scanner in place of the inline text regex, cheap pre-checks before the
block regexes, and a cursor-based list tokenizer. No dependency, no caching
across cases, no input recognition: every case is parsed from scratch.

Run: `node main.ts` reads `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`) and
writes `/output/html.json` (or `$MAKEFUN_OUTPUT_DIR`).
