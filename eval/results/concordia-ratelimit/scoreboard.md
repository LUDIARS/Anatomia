# Anatomia eval scoreboard — concordia-ratelimit — 2026-06-16

runs: 4 (ok: 4)

## claude-opus-4-8

| arm | ②avoid(anat/out) | landing | exemplar | complete | correct | findings | verifyFires | ③wall(s) | overhead(s) | turns | cost$ | ①hit% | llm |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | 1 / 1 | 5 | 4 | 5 | 4 | 5 | 0 | 714.76 | 0 | 73 | 6.69 | 0 | 0 | (n=1/1) |
| supply | 1 / 1 | 5 | 4 | 5 | 4 | 2 | 0 | 688.56 | 0 | 61 | 6.22 | 0 | 0 | (n=1/1) |
| verify | 1 / 1 | 5 | 5 | 5 | 4 | 3 | 0 | 799.29 | 135.33 | 43 | 5 | 29 | 0 | (n=1/1) |
| both | 1 / 1 | 5 | 5 | 5 | 5 | 0 | 0 | 728.35 | 7.02 | 49 | 4.84 | 0 | 0 | (n=1/1) |

## 読み方
- ②avoid = footgun 回避率 (anatomia系/outcome系, 1.0=全回避)。 off→both で上がれば supply/verify が効いている。
- ③overhead = Anatomia フックの追加遅延 (秒)。wall(s) の off vs on 差と合わせて「介在コスト vs 手戻り(turns)削減」を読む。
- ①hit%/llm = run 中の Anatomia 蒸留キャッシュ命中率と LLM 呼び出し数 (記述用、主測定は cache-microbench)。