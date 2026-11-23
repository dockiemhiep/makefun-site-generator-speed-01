# makefun-site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/dockiemhiep/makefun-site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/dockiemhiep/makefun-site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A clean-room re-implementation of the makefun-site 1.0.0 static site generator. It reproduces the reference output tree byte-for-byte on every case — front matter, Markdown rendering, template evaluation, collections and pagination — while cutting raw CPU time to roughly 1/2.3 of the baseline (paired-geomean ≈ 2.2–2.3× on the kit practice set). Zero dependencies: `solve.js` is a single ES module exporting `run(input)`; `main.ts` is the harness entry point and only tunes V8 flags before delegating.

## Run it

```sh
# reads $MAKEFUN_INPUT_DIR/cases.json, writes $MAKEFUN_OUTPUT_DIR/answers.json
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=r027wqk6&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
