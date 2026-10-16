# 设计记录：dsh-mem0-plugin

这份文档记录**结论是怎么来的**，以及哪些地方还没验证。
（README 讲「怎么用」，这里讲「为什么这么定」以及「证据在哪」。）

---

## 1. 起点：要做成什么形态

需求是「提供一套 mem0 REST 服务里的 `add/update/delete/search`，
且必须给定 Embedding Model 与 vector store（偏好 ES8）才能启动」。

那套服务是 FastAPI 包着 `mem0.Memory`：

```python
MEMORY_INSTANCE = Memory.from_config(DEFAULT_CONFIG)
```

于是有两条路：

| 方案 | 说明 | 判断 |
|---|---|---|
| A. 插件当 HTTP 客户端，连现有 mem0 REST 服务 | 改动最小，复用已部署的容器 | 但没解决「少一跳」，且要求用户另起服务 |
| B. 插件进程内直接用 mem0 的 **TypeScript OSS SDK** | 无 sidecar、无 HTTP、配置走 Cordis | **采用** |

选 B 的决定性证据：`mem0ai@3.3.1` 的 `package.json` 里有

```json
"exports": { ".": {...}, "./oss": { "types": "./dist/oss/index.d.ts", ... } }
```

即 TS SDK **确实有 OSS 入口**，`dist/oss/index.d.ts` 里导出了
`Memory`、`EmbedderFactory`、`VectorStoreFactory` 等，与 Python 版同源。

> 社区已有实现（`github:orangeshinee/dsh-mem0`、npm `@roswellcity/dsh-memory-mem0`）
> 走的是方案 A——它们包的是 **mem0 REST 服务**。所以本插件与它们不是重复实现。

---

## 2. 逐个撞上的坑

### 2.1 `Memory.fromConfig` 要 camelCase，不是 Python 的 snake_case

第一次冒烟直接抄 `config.json` 的 `vector_store` / `embedder`，得到：

```
ZodError: [ { "path": ["vectorStore"], "message": "Required" },
            { "path": ["llm"],        "message": "Required" } ]
```

`MemoryConfigSchema`（`dist/oss/index.js:108`）的顶层键是
`embedder` / `vectorStore` / `llm`，全 camelCase。
插件的 `normalizeVectorStoreConfig()` 因此同时接受两种拼写。

### 2.2 `llm` 是**必填**的，哪怕用不到

同上，schema 里 `llm` 没有 `.optional()`。
`search` / `update` / `delete` 都不碰 LLM，但**构造 `Memory` 就需要它**。

处理方式见 README §5.1：总是塞惰性占位，把「有没有 LLM」收敛成 `mem0_add` 的
`infer` 默认值 + 显式报错，而不是让整个插件起不来。

### 2.3 `better-sqlite3`：ESM 静态 import，绕不开但不用编译

`dist/oss/index.js`（CJS）里是顶层 `require("better-sqlite3")`；
`dist/oss/index.mjs`（ESM）里是顶层静态 import。两者都会在**加载模块时**解析该包。

第一次实测（`/tmp/mem0smoke`）装上了但没编译，报
`Could not locate the bindings file` —— 说明「能解析」和「能实例化」是两件事。

于是查 history 后端：

```js
// HistoryManagerFactory.create
case "sqlite":   return new SQLiteManager(...)
case "supabase": return new SupabaseHistoryManager(...)
case "memory":   return new MemoryHistoryManager()
```

只要 provider 是 `memory`，`SQLiteManager` 永不构造 → 原生绑定永不加载。
**这消掉了整个插件安装流程里最重的一环**（不需要编译器、不需要拉 prebuild）。

注意 `better-sqlite3` 在 mem0ai 里是**必需 peer**（不是 optional），
所以插件必须把它列进 `dependencies` 让它「可解析」，
同时用 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies: []` 禁止构建。

### 2.4 ES 客户端 v9 与 ES8 服务端**不兼容**

mem0ai 声明 `@elastic/elasticsearch: ^9.0.0` 为 optional peer，但代码里是
`await import("@elastic/elasticsearch")` —— 版本由**谁装了它**决定。

实测 v9.5.1 客户端 → ES 8.14.3：

```
ResponseError: media_type_header_exception
  status_exception: Accept version must be either version 8 or 7, but found 9.
  Accept=application/vnd.elasticsearch+json; compatible-with=9
```

服务端直接 400。换 `@elastic/elasticsearch@8.19.2` 后全链路通过。

结论：**「偏好 ES8」就意味着必须把客户端钉在 v8**，并在 preflight 里把 ES9 服务端
显式挡掉，否则用户只会看到一个 400 而不知道为什么。

### 2.5 `useSsl` 不写会静默变成 HTTPS

`ElasticsearchDB.ensureClient()` 里：

```js
params.node = `${config.useSsl !== false ? "https" : "http"}://${host}:${port}`
```

`useSsl` 为 `undefined` 时 `undefined !== false` 为真 → **走 https**。
本地明文 ES8 会因此连不上，且错误信息不指向这个原因。
插件在 `validateConfig()` 里把这个缺省直接判为配置错误。

### 2.6 写后立刻读会读到旧文档

mem0 建索引用 `refresh_interval: "1s"`。
第一次 e2e 里 `add` 完马上 `search` 返回 0 条——不是 bug，是 ES 的预期行为，
但对「记忆工具」来说这是最容易被误判成「插件坏了」的现象。

插件因此默认在写后 `indices.refresh()`（`refreshAfterWrite`），
e2e 也改成**全程不 sleep** 来锁住这个性质。

### 2.7 工具返回值必须是无损 JSON

e2e 第一次跑通写读之后，`mem0_search` 被判：

```
Error: tool "mem0_search" returned invalid output: value is not lossless JSON
```

原因：mem0 返回的 item 带**显式 `undefined`** 成员（未设置的 `updatedAt`）。
`JSON.stringify` 会丢弃它们（所以手工冒烟看不出来），
但 dsh 工具运行时是**结构化**校验的。`src/json.ts` 负责投影。

### 2.8 Schemastery 里「可选 object 块」的写法

`llm` 想做成可选，但 Schemastery 会把缺省的 object 实例化成 `{}`
**再**校验内部 `required()` 字段，于是「不写 `llm`」直接报
`$.llm.provider missing required value`。

实测三种写法：

| 写法 | 缺省时的值 |
|---|---|
| `Schema.object({provider: Schema.string()})`（内部不 required） | `{config:{}}` ← 恒真，无法判断「有没有配」 |
| `Schema.object({provider: Schema.string().required()}).default(undefined)` | `undefined` ✅ |
| `Schema.union([..., Schema.const(undefined)])` | `undefined` ✅ |

采用第二种（`.default(undefined as never)`，`.default()` 的类型签名不收 `undefined`，故加 cast）。

### 2.9 Schemastery 会**静默忽略**未知键

实测 `plugin.Config({ ...合法配置, typoKey: 1 })` 直接通过，不报错。
已知键的类型和枚举**会**校验（`$.preflight.enabled expected boolean`、
`$.historyStore.provider expected "memory" | "sqlite"`），但不认识的键被丢掉。

后果：用户在 patch 里写 `refresh_after_write: false`，插件无声地用默认值 `true`，
而文档写的又是 `refreshAfterWrite`——这种不一致没有任何信号。

因此 `validateConfig()` 增加了一道顶层键白名单校验，
错误信息直接列出全部合法键名。（`embedder.config` / `vectorStore.config` / `llm.config`
内部保持自由透传，因为键名由各 provider 决定，插件无从枚举。）

---

### 2.10 `deleteAll` 会**静默漏删**（v0.2.0 最重要的发现）

需求里的「按作用域删除」差点直接用 `memory.deleteAll()` 实现。它在基准测试里
炸了两次，追下去才发现是个设计缺陷：

```js
const DELETE_ALL_BATCH_SIZE = 1          // ← 每轮只删一条
while (true) {
  const [batch] = await this.vectorStore.list(filters, DELETE_ALL_BATCH_SIZE)
  if (!batch.length) break
  const batchKey = batch.map(m => m.id).sort().join(',')
  if (seenBatches.has(batchKey)) { logger.warn('Stopping deleteAll after a repeated memory batch'); break }
  seenBatches.add(batchKey)
  for (const m of batch) await this.deleteMemory(m.id)
}
```

它靠「批次 id 重复」终止循环，而 `list` 走的是**依赖 refresh 的 search**。
索引自上次删除以来没刷新时：

| 轮次 | `list` 返回 | 动作 |
|---|---|---|
| 1 | `[A]` | 删 A |
| 2 | `[A]`（未刷新，仍可见） | 批次重复 → **break** |

→ **一次调用只删掉 1 条，却返回 `{"message":"Memories deleted successfully!"}`。**

在 ES 8.14.3 上直接复现（25 条作用域）：

- `refreshAfterWrite: false`：调用后仍剩 24 条（静默）；
- 换个时序：直接抛 `Memory with ID ... not found`。

**这是静默失败**，返回值是成功消息 —— 所以测试必须数实际剩余条数，
断言返回值没有任何意义。

### 2.11 修法：自己实现，并复核

```js
for (let pass = 1; pass <= MAX_PASSES; pass++) {
  await refresh()                                  // 先让视图准确
  const page = await scan(scope, { limit: PAGE })   // 自己分页取 id
  if (page.total === 0) return { remaining: 0 }
  for (const item of page.items) {
    await memory.delete(item.id)                   // 按 id 删，不依赖列表新鲜度
  }
}
```

关键点：**按 id 删除不受那个守卫影响**。删完再复核一次，把
`deleted` / `remaining` 如实返回；没删干净就报「还剩多少」，不谎报成功。

同时把 `refresh()` 从「`refreshAfterWrite` 的附带能力」提升为**始终可用**的能力 ——
作用域删除依赖它来保证正确性，而不只是写后读的便利。

回归测试 `test/scope-delete.mjs` 在两种 `refreshAfterWrite` 设置下都要求真正清空。

### 2.12 `getAll` 表达不了时间范围

`Memory.getAll` → `vectorStore.list(filters, topK)`，而 ES 的实现只构造 `term`
（`validateFilter` 只接受 string/number/boolean），没有 range、没有 sort、没有 offset。

要在 ES 上做「找出 N 天前的记忆」，只能下推原生查询 —— 好消息是
`metadata.createdAt` 在 ES 里被映射为 **`date`**，range / sort / `from`+`size` /
`track_total_hits` 全都能用。见 `src/scan.ts`。

非 ES 的向量库只能退化成 `getAll` + 内存过滤，结果**不精确**（受 topK 限制），
所以 `ScanResult.caveat` 会显式告诉调用方这件事。

### 2.13 dsh 宿主是 **Electron ABI**，原生模块加载不了

原本打算用 mem0 自带的 sqlite history store（`better-sqlite3`）。
查 dsh 桌面版怎么起宿主进程时发现：

```js
command: process.execPath,                 // Electron 二进制
env: { ELECTRON_RUN_AS_NODE: '1', ... }
```

实测两者 ABI 不同：

| 运行时 | Node | `process.versions.modules` |
|---|---|---|
| Electron 44（dsh 宿主） | 24.18.1 | **149** |
| 本机 Node 24 | 24.21.0 | **137** |

为 Node 编译的原生模块在宿主里**加载不了**，适配就得 `@electron/rebuild`
并绑死 dsh/Electron 版本。于是改用 Node 内置的 `node:sqlite`
（实测在 Electron 宿主内可读写），零编译、跨平台、路径可控。

**教训：给 dsh 插件选原生依赖之前，先确认 ABI。**

### 2.14 历史库放哪：dsh 的「工作区」是一个注册表

需求把默认路径从 `/mem0/`（容器路径）改成 `<WORKSPACE>/mem0/`。
「WORKSPACE」看着像个环境值，实际不是：

| 想法 | 实测 |
|---|---|
| `process.cwd()` 就是工作区 | ❌ 桌面宿主 cwd = `~/.dsh/profiles/desktop` |
| 有个 `workspace` 服务 | ❌ 服务键是 `workspaceRegistry` |
| 只有一个工作区 | ❌ 本机注册了 2 个 |

`workspaceRegistry` 的公开面是 `list()` / `get(id)` / `create()` / `initializeDefault()`；
**`defaultWorkspaceId` 没有公开访问器**（内部 state）。用得上的是这一条：
`initializeDefault(resolveDirectory)` 在默认工作区已设置时**立即返回该实体**，
不进入初始化分支。所以传一个**会抛错的 resolver** 就能安全地「读默认」——
万一真进了初始化分支，宁可失败，也不要在插件自己编的路径上创建一个工作区
（那会出现在用户的 UI 里）。

`workspaceRegistry` **不能写进 `inject`**：它由 web-app bundle 提供，
`headless` / `sdk` profile 没有，写进 inject 会让插件永远停在 PENDING，
与 §9 的「永远加载、永远可诊断」直接冲突。所以用 `ctx.get()` 做可选获取。

解析在**每次运行时就绪检查**时重做，因此插件若先于注册表加载，会先落到
`<DSH_HOME>/mem0/`，之后自动迁移到工作区，迁移到位后不再变动。

> 附带一个容易写错的判定：`isUsable(path)` 不能只看**直接父目录**。
> `<workspace>/mem0/` 在首次运行时不存在，只看父目录会误判为不可写、
> 错误回退到 DSH home。正确做法是向上找**最深的已存在祖先**再判可写。

决策表（`test/history-workspace.mjs`，7 个场景，全部通过）：
唯一工作区 → 用它；多个 → dsh 默认；没有默认 → 首个注册；
显式 `history.dbPath` → 覆盖一切；无注册表 → `$DSH_HOME`；注册表迟到 → 自愈迁移。

## 3. 验证证据

环境：

- Elasticsearch **8.14.3**（容器 `dsh-es8`，`docker.elastic.co/elasticsearch/elasticsearch:8.14.3`）
- Ollama **0.20.7**（容器 `dsh-ollama`），模型 `nomic-embed-text:latest`（768 维）
- Node **v24.21.0**，dsh 桌面版 **0.2.0-rc.2**

六个套件（`npm test`）的实测结果，全部退出码 0 —— 完整输出见
`docs/evidence/verification.log`：

| 套件 | 结果 |
|---|---|
| `boot-policy.mjs` | 用真实 `boot()` 验证：默认模式 mem0 fiber = ACTIVE；strict 模式 = FAILED 但 dsh 仍启动；根 YAML 损坏才抛 `StartupError` |
| `history-workspace.mjs` | 历史库位置决策表 7 个场景（唯一/默认/首个工作区、显式配置、无注册表、自愈迁移） |
| `bundle-config.mjs` | `cordis.patch.yml` 默认配置过 schema，真实 preflight 启动成功，注册 7 工具 |
| `config-failfast.mjs` | 8/8 场景「插件加载 + 7 工具 + `mem0_status` 报出真实原因」；strict 模式下 2/2 加载失败且 0 工具 |
| `scope-delete.mjs` | 两种 `refreshAfterWrite` 设置下 25 条作用域都真正清空（`remaining=0`，`deleted=25`） |
| `e2e.mjs` | 11 组断言通过（7 工具 / 写后即读 / 时间窗扫描 / 分页 / 历史轨迹 / 作用域隔离 / 参数护栏 / 卸载撤销） |

性能基线见 `docs/evidence/benchmark-2026-10-16.md`：
写入 p50 ~35 ms、检索 p50 ~47 ms、100 条全扫 ~7 ms、recall@1 = 100%（30 个唯一可判定查询）。

`e2e.mjs` / `scope-delete.mjs` 用的是**真**依赖链：
`new Context()` + `@deepseek-ai/dsh-system-prompt` + `@deepseek-ai/dsh-tools` 的
`ToolRuntime` + 构建产物 `lib/index.js`，工具调用走 `ctx.tools.execute()`
（即真实的参数校验、输出 schema 校验、内容渲染路径），而不是直接调 `execute`。
这一层是真的值钱：`value is not lossless JSON` 那个 bug 就是它抓出来的。

`boot-policy.mjs` 更进一步，直接调用 `@deepseek-ai/dsh-app-boot` 的 `boot()`，
所以「插件失败不会拖垮 dsh」这句话是被**目标版本的真实启动路径**验证的，
不是从源码推断的。

> 为什么要多装 `dsh-system-prompt`：`ToolRuntime` 有
> `static inject = ["systemPrompt"]`，不满足时 `ctx.tools` 根本不存在（fiber 停在 PENDING）。
> 这一点不在工具 DSL 文档里，是靠运行时诊断出来的。

---

## 4. 未做的事（以及为什么）

| 项 | 状态 | 原因 |
|---|---|---|
| `infer: true` 的真实抽取 | 未验证 | 本机没有可用 LLM 凭据；只验证了「缺 `llm` 明确报错」分支 |
| 装进桌面版 profile | 未执行 | 本会话审批被禁用，不去改动正在运行的 profile |
| LM Studio 作为 embedder | 未端到端验证 | provider 字段是从 SDK 源码读的；本机没有 LM Studio，Ollama 路径是实测的 |
| ES9 服务端 | 主动拒绝 | 见 §2.4 |
| 并发 | 未测 | 所有性能数字都是单线程顺序调用 |
| `GET /memories/{id}`、`/reset`、`/configure` | 未实现 | 不在要求范围内；SDK 能力都在，按 `src/tools.ts` 现有写法扩即可 |

---

## 5. 如果要做下一步

1. **补 LLM 后跑一遍 `infer: true`**，确认「抽取事实」路径与 Python 版语义一致
   （这是唯一还没走通的官方代码路径）。
2. **桌面版安装链路**：把 bundle 装进 `~/.dsh/profiles/desktop` 走一遍
   （设置 → 插件），确认 `cordis.patch.yml` 的层真的被叠加。
3. **并发基准**：目前只测了单线程。多个 agent 同时写记忆时的表现未知，
   而 `refreshAfterWrite` 在并发下可能成为争用点。
4. **过期记忆淘汰**：`mem0_get_all` 已经能按时间窗扫描，但还没有「扫描 + 删除」的
   一条龙工具（`expiration_date` 只在写入时生效）。真要做淘汰任务，这是下一步。
5. **ES 版本探测前移**：目前 ES9 在 preflight 才发现；
   如果要支持 ES9，`createElasticsearchClient()` 是唯一需要分支的地方。
