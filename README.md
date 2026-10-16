# dsh-mem0-plugin

给 DeepSeek Harness（dsh）加上**长期记忆**的插件。

它让 agent 能跨会话记住事情：你说过一遍的偏好、项目约定、之前的决定，
下次开新会话它还记得，不用你重复。

> 一句话：**基于 [mem0](https://github.com/mem0ai/mem0) 的记忆层，作为 dsh 插件运行。**

---

## 它是什么

把 mem0 接进 agent 通常要另起一套 Python 服务（用 FastAPI 之类的框架把 mem0 包成
HTTP 接口），agent 再通过 HTTP 调它。

本插件把这个中间层去掉：直接跑 mem0 官方的 **TypeScript SDK**（`mem0ai/oss`），
成为 dsh 的一个插件。结果是：

| | 独立 mem0 服务 | 本插件 |
|---|---|---|
| 额外进程 | 要（Python 容器） | **不要** |
| agent 调用方式 | HTTP 请求 | 原生工具调用 |
| 配置位置 | 服务端 `config.json` | dsh profile 的 `cordis.patch.yml` |
| 启动依赖 | 服务先起来 | 插件随 dsh 起来（后端不通也能自查） |

---

## 实现了哪些功能

八个工具，覆盖记忆的完整生命周期：

| 工具 | 做什么 | 什么时候用 |
|---|---|---|
| `mem0_add` | 存入记忆 | 用户说「记住这个」，或陈述了值得长期保留的偏好、决定、约定 |
| `mem0_search` | 语义检索记忆 | 回答涉及过往决策、偏好、历史工作的问题之前 |
| `mem0_get` | 按 id 读取某条记忆的完整内容 | 已经从检索结果拿到 id，需要它的确切原文 |
| `mem0_update` | 改写某条记忆 | 之前记的内容过时了或写错了 |
| `mem0_delete` | 删除记忆 | 按 id 删一条，或按 `user_id` / `agent_id` / `run_id` 清空一个范围 |
| `mem0_get_all` | 列出记忆，支持**时间范围扫描** | 盘点记住了什么；找出过期记忆准备淘汰 |
| `mem0_history` | 查看某条记忆的变更轨迹 | 想知道某条记忆被改过几次、原来是什么 |
| `mem0_status` | 安装与健康自检 | 记忆相关的工具报错时；刚装完想确认是否正常 |

`mem0_get_all` 的时间范围扫描是插件自己实现的（mem0 原生 API 表达不了），
支持 `created_after` / `created_before` / `updated_after` / `updated_before` +
排序 + 分页，返回真实总数——就是为了「找出 N 天前的记忆」这类淘汰任务准备的。

`mem0_status` 是插件的自检入口：**它永远可用**，即使记忆后端完全连不上。
初始化失败时它会给出关键报错和针对性排查建议，而不是让你去猜。

---

## 从 mem0 继承了什么

**记忆本身的语义全部由 mem0 提供**，插件不重新发明：

- **事实抽取**：配置了 `llm` 之后，`mem0_add` 由 mem0 用 LLM 从对话里提炼值得记住的事实，
  而不是照抄原文；没配 `llm` 时按原文存储（见 [三项核心配置](#三项核心配置)）
- **去重与合并**：走上面这条抽取路径时，由 mem0 判断新内容和已有记忆是新增、合并还是替换
- **向量检索**：embedding + kNN 排序、相似度阈值、可选 rerank
- **provider 生态**：embedding 模型和向量库都用 mem0 支持的 provider。
  仓库里的参考部署用 **Elasticsearch 8** 存向量、**Ollama** 提供 embedding；
  [`install.md`](./install.md) 推荐的是 **LM Studio + `bge-m3`**，两者都能用
- **记忆结构**：索引布局、`metadata.user_id/agent_id/run_id` 作用域、
  `expiration_date` 过期语义，都沿用 mem0 的约定

**插件自己实现、mem0 不提供的部分：**

- `mem0_get_all` 的时间范围扫描（mem0 原生只支持精确匹配，没有范围查询、排序和分页）
- 按范围删除：独立实现，保证真的清空
- `mem0_history` 的持久化存储
- **给模型的「什么时候该用记忆」引导**（见下）
- `mem0_status` 自检

> 为什么这几处要另起炉灶，以及哪些路径尚未经过端到端验证，
> 都记在 [development.md](./development.md) 里。

---

## 验证到哪一步了

**已端到端验证**（真依赖链）：

| 路径 | 状态 |
|---|---|
| Elasticsearch 8.14.3（单节点、明文 http） | ✅ e2e / scope-delete / config-failfast 全过 |
| embedding = **Ollama** `nomic-embed-text`（768 维） | ✅ 原始基线 |
| embedding = **LM Studio** `text-embedding-bge-m3`（1024 维） | ✅ 2026-10-16 补验（e2e 全过：写后即读、作用域隔离、分页、时间窗） |
| 装进**桌面版 profile** | ✅ 2026-10-16（软链进 profile 的 `node_modules` ＋ `cordis.patch.yml` 加一行） |
| `startup.strict` 的失败路径 | ✅ `boot-policy`（调真 `boot()`） |

**尚未端到端验证**：`infer: true` 的真实事实抽取（需要 LLM 凭据）、并发写入、ES9。
细节与证据见 [development.md](./development.md) §7.3 与 [docs/design-notes.md](./docs/design-notes.md) §3。

---

## 怎么安装

### 最省事：交给 Agent

把仓库交给 dsh，让它读 [`install.md`](./install.md)——那是写给 Agent 执行的安装手册：
先探测你机器上已有什么（ES、LM Studio、Ollama），**能复用就复用**，缺什么才装什么，
最后用 `mem0_status` 验收。

### 手动

需要两样东西：**一个 Elasticsearch 8** 和 **一个 embedding 模型**
（还有一个可选的 LLM，见下）。

```sh
# 1) Elasticsearch 8（8.14.3 实测可用）
docker run -d --name dsh-es8 -p 9200:9200 --cpus 1.0 -m 2g \
  -e discovery.type=single-node \
  -e xpack.security.enabled=true -e xpack.security.http.ssl.enabled=false \
  -e xpack.security.transport.ssl.enabled=false -e xpack.security.enrollment.enabled=false \
  -e ELASTIC_PASSWORD=elastic -e "ES_JAVA_OPTS=-Xms1024m -Xmx1024m" \
  docker.elastic.co/elasticsearch/elasticsearch:8.14.3

# 2) embedding：LM Studio 里加载 bge-m3，或用 Ollama
docker run -d --name dsh-ollama -p 11434:11434 ollama/ollama:0.20.7
docker exec dsh-ollama ollama pull nomic-embed-text

# 3) 构建并安装插件
node node_modules/typescript/bin/tsc -p tsconfig.build.json
dsh plugin --profile <profile> add /绝对路径/dsh-mem0-plugin
```

> **桌面版注意**：公开 CLI 不能管理 Desktop profile，要走 **设置 → 插件**。

装完调一次 `mem0_status`，第一行是 `OK` 就成了。

---

## 怎么配置

配置写在 dsh profile 的 `cordis.patch.yml`。最小可用配置：

```yaml
- insert:
    - id: mem0
      name: dsh-mem0-plugin
      config:
        embedder:
          provider: lmstudio          # 用 Ollama 就改成 ollama
          config:
            baseURL: http://localhost:1234/v1
            model: text-embedding-bge-m3
        vectorStore:
          provider: elasticsearch
          config:
            collectionName: mem0_vector_store
            host: localhost
            port: 9200
            username: elastic
            password: elastic
            useSsl: false             # ← 不写会默认走 HTTPS，本地明文 ES 连不上
```

### 三项核心配置

| 配置 | 必需 | 说明 |
|---|---|---|
| `embedder` | ✅ | 把文本变成向量。任意 mem0 支持的 provider |
| `vectorStore` | ✅ | 向量存哪。ES8 用 `provider: elasticsearch` |
| `llm` | 可选 | 只有 `mem0_add` 的**事实抽取**需要它 |

**关于 `llm`**：不配也能用，只是记忆按**原文**存储，不做事实提炼；
配了之后 `mem0_add` 默认开启抽取。任何 OpenAI 兼容端点都行
（DeepSeek、LM Studio 的 chat 模型、Ollama……）。

### ⚠️ LM Studio 会静默替换未知的 model id

实测（2026-10-16，走 LM Studio 的 `/v1/embeddings`）：请求 `model: "definitely-not-a-real-model"`，
返回 **HTTP 200**、**1024 维**，响应里的 `model` 字段是 `text-embedding-bge-m3` ——
**它不报错，而是拿当前加载的 embedding 模型顶上。**

后果：**embedding 模型名写错不会报错**，但向量空间可能不是你要的那个；一条索引里混进两种向量空间，
检索会**静默**变差。所以：**换 embedding 模型必须重建索引**，并且把 `mem0_status` 报出的维度和预期对一遍。
（Ollama 在未知模型上会直接报错。）

### 其它可选项

| 配置 | 默认 | 说明 |
|---|---|---|
| `identifiers.user_id` 等 | 无 | 单用户部署可以不每次传 `user_id` |
| `history.dbPath` | `<workspace>/mem0/history.db` | `mem0_history` 的存储位置 |
| `refreshAfterWrite` | `true` | 写完立刻刷新索引，保证「存完马上搜得到」 |
| `guidance.*` | 见下 | 给模型的使用引导 |
| `toolDescriptions.*` | 内置 | 覆盖单个工具给模型看的描述 |

> 完整配置项、取值语义与失败行为见 [development.md](./development.md)。

---

## 什么时候触发

工具**不会自己运行**——是模型在需要时调用它们。为了让模型知道「什么时候该想起来用」，
插件会往系统提示词里注入一段**使用引导**（默认开启，约 860 字符），大意是：

- 回答涉及用户过往决策、偏好、约定或历史工作的问题前，先 `mem0_search`，
  别假设当前对话里什么都有；
- 用户让你记住某事、或陈述了值得保留的偏好 / 决定 / 约定时，调 `mem0_add`；
- 保持 `user_id` 作用域稳定，`run_id` 用于只属于本次会话的笔记；
- 不要存密钥、凭据，或能直接从工作区推导出来的东西；
- 记忆工具报错时先看 `mem0_status`。

这段引导**可以整段替换、追加，或关掉**：

```yaml
guidance:
  enabled: true
  text: |            # 整段替换
    ## 记忆策略
    回答历史问题前先用 mem0_search 查一遍。
  append: |          # 在内置文本后追加
    约定：不要存客户姓名。
```

也可以让它**只对部分 agent 生效**（按 agent 分别注册，并用 preset 过滤）：

```yaml
guidance:
  scope: agent
  presets: [ptc, standard]
```

工具描述同样可以按工具覆盖：

```yaml
toolDescriptions:
  mem0_add: '把用户希望记住的持久事实或偏好存起来。'
```

---

## 怎么跑测试

```sh
bash scripts/probe.sh          # 先看这台机器上有什么（只读，不改任何东西）
pnpm install && pnpm build     # pnpm 12 见下
export MEM0_TEST_EMBEDDER=lmstudio   # 不设则默认 ollama
npm test
```

- **后端只在一处选**（`test/backends.mjs`）：`MEM0_TEST_EMBEDDER`、`MEM0_TEST_EMBEDDER_URL`、
  `MEM0_TEST_MODEL`、`MEM0_TEST_ES_HOST/_PORT/_USER/_PASS`；旧的 `BENCH_*` 名字仍然认。
- **缺后端 ≠ 失败**：需要活后端的套件会打一行 `⏭ SKIP` 然后**退出 0** —— 缺一个可选依赖不是代码缺陷，
  假失败只会训练人忽略测试。
- **`config-failfast` 里「vector store 不可达」那条需要活的 embedder**（preflight 先探 embedder，再探 store），
  没有 embedder 时会 SKIP 并说明原因。
- **「embedding 模型不存在要报错」只在 Ollama 上断言** —— LM Studio 不拒绝未知 model id（见上）。
- **pnpm 12**：`onlyBuiltDependencies` 已改名 `allowBuilds`，且未登记的构建脚本会让 `pnpm install`
  **退出非 0**（`ERR_PNPM_IGNORED_BUILDS`）；本仓库用 `allowBuilds: {better-sqlite3: false}` 明确拒绝它。
- 性能基线每跑一次写一份 `docs/evidence/benchmark-<日期>-<后端>.md`，同日后端不同**不会互相覆盖**。

---

## 出问题了怎么办

**第一步永远是调 `mem0_status`。** 它不受后端故障影响，会告诉你：

- 运行时是否就绪；不就绪时给出**关键报错**和针对性的排查建议；
- 配置摘要（embedder / vectorStore / 索引名 / 有没有配 LLM）；
- 启动探测结果（embedding 维度、ES 版本、索引状态）；
- 历史库实际路径、给模型的引导是否注入。

**修好依赖后不需要重启 dsh**——再调一次 `mem0_status` 就会重试（失败后每 5 秒自动重试）。

更深入的排查、设计取舍与实测证据，看 **[development.md](./development.md)**：
里面有完整配置参考、启动契约、排错对照表、性能基线与已知限制。
