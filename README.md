[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

[![rank](https://make.fun/badge/markdown-render-speed-02/midx-crypto/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

[![reward](https://make.fun/badge/markdown-render-speed-02/midx-crypto/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

# markdown-render-speed-02

A faster drop-in for marked 18.1.3. `parse(markdown)` in `parse.js`
returns exactly the HTML `marked.parse(markdown)` returns with
marked's default options, but renders the practice set noticeably
faster than marked itself.

How it works: instead of reimplementing the parser, the entry
subclasses marked's own `Tokenizer` and `Lexer` (vendored unchanged
under `vendor/marked`) and speeds up the hot paths while keeping
every decision identical:

- the inline loop dispatches on the first character, so at each
  position only the tokenizers that could match are tried;
- plain text runs are scanned with a hand-written scanner that
  stops at exactly the same places marked's text regex would;
- the emphasis / strikethrough masking and the scan for the last
  possible closer are computed lazily, once per inline source,
  instead of eagerly for every inline token list;
- block tokenizing skips the table and setext-heading patterns
  unless the next lines can possibly hold one.

`main.ts` is the harness driver: it reads `/input/cases.json`,
renders each case on its own with `parse`, and writes
`/output/html.json`. No input is recognised, nothing is cached
between cases, and `parse` keeps no state from an earlier call.
