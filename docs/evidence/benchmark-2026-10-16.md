# dsh-mem0-plugin 性能基线

| 项 | 值 |
|---|---|
| Embedding | `ollama` / `nomic-embed-text:latest` → 768 dims |
| Vector store | Elasticsearch 8.14.3 reachable; index `mem0_dsh_benchmark` present (768 dims) |
| Node | 24.21.0 |
| 规模 | 写入 100 条 · 检索 30 次 (top_k=5) · 预热 5 次 |

延迟均为**端到端**工具调用耗时（含 embedding 往返、ES 写入/检索、索引刷新），不含模型侧推理。
测试前做了 5 次预热，所以下面的数字不含 embedding 模型冷启动。
单线程顺序调用，**未测并发**。

## 结论

- **写入** `mem0_add` p50 **35.3 ms**、p95 346.7 ms（100 条样本）。
- **检索** `mem0_search` p50 **47.2 ms**、p95 337.5 ms（top_k=5）。
- **全量扫描** `mem0_get_all` 读 100 条 **7.2 ms** —— 淘汰过期记忆该走这条路径。
- **召回** recall@1 = **100.0%**，MRR = 1.0000（30 个唯一可判定查询）。

p95 是 p50 的 9.8 倍，说明**尾部**而非中位数决定了体验。
尾部大概率来自 embedding 服务的调度（本地 Ollama），而不是 ES —— 全量扫描 100 条只要 7.2 ms，可见 ES 侧很轻。

## 读取 / 扫描延迟

| 路径 | mean | p50 | p95 | max |
|---|---|---|---|---|
| `mem0_search`（写后刷新开） | 75.2 | 47.2 | 337.5 | 432.2 |
| `mem0_search`（写后刷新关） | 98.3 | 51.3 | 395 | 763.8 |
| `mem0_get_all` 全量扫描 100 条 | 7.2 | — | — | — |

## 写入延迟 — `mem0_add`

### `refreshAfterWrite: true`（默认）

| mean | p50 | p95 | max | n |
|---|---|---|---|---|
| 75.4 | 35.3 | 346.7 | 781.2 | 100 |

### `refreshAfterWrite: false`

| mean | p50 | p95 | max | n |
|---|---|---|---|---|
| 63 | 28.8 | 303.2 | 713 | 100 |

**这项默认值的代价**：
- p50 写入 35.3 → 28.8 ms（**-6.5 ms**）
- p95 写入 346.7 → 303.2 ms（**-43.5 ms**）
- 检索 p50 +4.1 ms，p95 +57.5 ms

⚠️ 本次运行里两列写入延迟的差距（p50 -6.5 / p95 -43.5 ms）**都落在自身波动范围内**，无法与噪声区分。也就是说：在这个规模（100 条、单线程）下，写后刷新的成本可以忽略。要断言它在更大规模下的影响，请多跑几轮或加大 COUNT，不要拿这一行当定论。
默认开启换来的是「写完立刻能搜到」——对一个记忆工具来说，这个语义本身就值得。

> 本次运行中，关掉刷新后的检索延迟并没有变差（p95 395 vs 337.5 ms），
> 所以「不刷新会让后续检索变慢」这个说法**没有得到本次数据支持**，不写进结论。

## 召回正确率

| 指标 | refreshAfterWrite=true | refreshAfterWrite=false |
|---|---|---|
| recall@1 | 100.0% | 100.0% |
| recall@5 | 100.0% | 100.0% |
| MRR | 1.0000 | 1.0000 |
| 未命中 | 0 / 30 | 0 / 30 |

排名分布（true / false）:
- rank1: 30 / 30
- rank2: 0 / 0
- rank3: 0 / 0
- rank4: 0 / 0
- rank5: 0 / 0
- miss: 0 / 0

查询用的都是**唯一可判定**的问题（每个项目名在全库只出现一次），所以 recall@1 就是
「embedding + kNN 排序是否把正确答案排在第一」的直接度量，不含歧义样本。
换 embedding 模型、维度或 top_k 后，这组数字必须重测。

## 复现

```sh
node test/benchmark.mjs
COUNT=300 QUERIES=50 node test/benchmark.mjs
BENCH_EMBEDDER=lmstudio BENCH_MODEL=text-embedding-bge-m3 node test/benchmark.mjs
```
