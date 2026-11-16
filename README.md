# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/midx-crypto/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/midx-crypto/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

md-fast is a faster drop-in for marked 18.1.3: its `parse(markdown)` returns exactly the HTML that `marked.parse(markdown)` returns with marked's default options (GFM on), for less CPU. It subclasses marked's own Lexer and Tokenizer and replaces the hot paths with index-based scanning: a first-character dispatch inline loop, a hand-written text scanner, block pre-checks, and a cached closer index for emphasis and strikethrough. The vendored `marked.esm.js` under `vendor/marked/` is the reference library itself, byte for byte from npm, kept so the entry can subclass it.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json`, renders each one with `parse`, and writes the HTML strings to `/output/html.json`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=g5h40b4t&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
