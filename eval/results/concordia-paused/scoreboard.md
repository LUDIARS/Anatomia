# Anatomia eval scoreboard — 2026-06-16

runs: 4 (ok: 4)

## claude-haiku-4-5

| arm | ②avoid(anat/out) | landing | exemplar | complete | correct | findings | verifyFires | ③wall(s) | overhead(s) | turns | cost$ | ①hit% | llm |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | 0.67 / 1 | 4 | 2 | 3 | 4 | 6 | 0 | 192.47 | 0 | 39 | 0.47 | 0 | 0 | (n=1/1) |
| supply | 1 / 1 | 5 | 5 | 5 | 4 | 1 | 0 | 427.06 | 0 | 72 | 0.74 | 0 | 0 | (n=1/1) |
| verify | 1 / 1 | 5 | 4 | 4 | 4 | 4 | 0 | 472.2 | 107.2 | 73 | 0.9 | 20 | 0 | (n=1/1) |
| both | 1 / 1 | 5 | 5 | 5 | 5 | 2 | 0 | 325.76 | 98.79 | 47 | 0.66 | 15 | 0 | (n=1/1) |

## 読み方
- ②avoid = footgun 回避率 (anatomia系/outcome系, 1.0=全回避)。 off→both で上がれば supply/verify が効いている。
- ③overhead = Anatomia フックの追加遅延 (秒)。wall(s) の off vs on 差と合わせて「介在コスト vs 手戻り(turns)削減」を読む。
- ①hit%/llm = run 中の Anatomia 蒸留キャッシュ命中率と LLM 呼び出し数 (記述用、主測定は cache-microbench)。