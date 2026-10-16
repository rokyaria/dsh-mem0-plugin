# dsh-mem0-plugin — 开发与排错手册

> **这份是给维护者看的。** 想了解插件是什么、怎么装、怎么配，先读
> [`README.md`](./README.md)；让 Agent 自动安装则读 [`install.md`](./install.md)。
>
> 本文包含实现细节、设计取舍、实测证据与踩坑记录——排查线上问题时也看这里：
> 每个「为什么这么写」都能在文中找到对应章节，`docs/design-notes.md` 则记录了
> 结论是怎么得出来的。

---

## 1. 它提供什么

| 工具 | 对应 mem0 REST API 端点 | 说明 |
|---|---|---|
| `mem0_add` | `POST /memories` | 写入记忆；`infer` 决定「抽取事实」还是「原文存储」 |
| `mem0_search` | `POST /search` | 自然语言语义检索 |
| `mem0_get` | `GET /memories/{id}` | 按 id 精确读取单条记忆 |
| `mem0_update` | `PUT /memories/{id}` | 改写单条记忆的正文 / 合并 metadata |
| `mem0_delete` | `DELETE /memories[/{id}]` | 按 id 删单条，或按标识符批量删 |
| `mem0_get_all` | `GET /memories` | **时间范围扫描 + 排序 + 分页**，淘汰过期记忆用 |
| `mem0_history` | `GET /memories/{id}/history` | 单条记忆的变更轨迹（ADD/UPDATE/DELETE） |
| `mem0_status` | —（本插件新增） | **安装自检**：插件是否正常，不正常时给出关键报错与排查建议 |

标识符沿用 REST 版的 `user_id` / `agent_id` / `run_id`，并要求**至少给出一个**。

### 1.1 为什么 `mem0_get_all` 值得单独存在

mem0 自己的 `getAll` 做不到时间范围查询：它委派给 `vectorStore.list()`，
而 Elasticsearch 那个实现只构造 `term` 精确匹配（`validateFilter` 只接受
string/number/boolean），**没有 range、没有 sort、没有 offset**，且最多返回 `topK` 条。

所以本插件在 ES 上**直接下推原生查询**：`metadata.createdAt` 在 ES 里映射为 `date`，
可以原生做范围过滤、排序、分页，并用 `track_total_hits` 拿到真实总数。
非 ES 的向量库退化为 `getAll` + 内存过滤，并在结果里带一条 `caveat` 说明它不精确。

淘汰过期记忆应该走这条路径（`created_before` + 分页），而不是 `mem0_search` 之后再过滤。

### 1.2 `mem0_history` 的历史存在哪

存在插件自己维护的 SQLite 文件里（Node 内置的 `node:sqlite`），
默认路径 **`<workspace>/mem0/history.db`**。

`<workspace>` 通过 dsh 的 `workspaceRegistry` 解析，因为「工作区」在 dsh 里是**一个注册表**
而不是某个环境值：

| 情况 | 选择 |
|---|---|
| 只注册了一个工作区 | 用它 |
| 注册了多个 | 用 dsh 的**默认工作区**（`defaultWorkspaceId`） |
| 无法确定 / profile 没有工作区注册表 | 回退 `<DSH_HOME>/mem0/history.db` |

> 注意 **不能用 `process.cwd()`**：桌面宿主的 cwd 是 profile 目录
> （`~/.dsh/profiles/<name>`），不是用户的工作区。
>
> 解析在每次运行时就绪检查时重做，所以插件若在注册表就绪前加载，
> 会先落到 `<DSH_HOME>/mem0/`，之后**自动迁移**到工作区；一旦落到工作区就不再变动。
>
> 以上选择**都可以被 `history.dbPath` 覆盖**，实际生效路径与来源由 `mem0_status` 报告
> （`configured` / `workspace` / `dsh-home`）。

> **为什么不用 mem0 自带的 history store**：它只提供 `sqlite`（需要原生
> `better-sqlite3` 绑定）、`supabase` 和进程内 `memory`。而 dsh 桌面宿主跑的是
> **Electron 的 Node**（`ELECTRON_RUN_AS_NODE`），模块 ABI 与本机 Node 不同
> （Electron 44 → ABI 149，Node 24 → ABI 137），为 Node 编译的原生模块在宿主里
> **根本加载不了**；要适配就得把插件绑死在某个 dsh/Electron 版本上。
> `node:sqlite` 随 Node 自带（已在 Electron 宿主内实测可用），零编译、跨平台。
> 表结构沿用 mem0 的 `memory_history` 形状，读起来是同一套东西。

### 1.3 模型被告知了什么（以及怎么改）

有两层，作用不同，**都可以在配置里改**：

| 层 | 内容 | 回答的问题 | 默认值 |
|---|---|---|---|
| **工具描述** | 每个工具的 `description` | 这个工具**做什么** | 内置在 `src/tools.ts` |
| **引导段** | 系统提示词里的一节 | **什么时候**该用它 | 内置在 `src/guidance.ts` |

工具描述是 `defineTool` 的必填字段，也是 `ToolSchema`（模型可见白名单）的一部分——
`{ deferLoading?, name, description, parameters }`——所以它就是模型看到的那段文字。

引导段通过 dsh 的 `systemPrompt` 服务注册。**默认就会注入**，内容是
「先 `mem0_search` 再回答关于过往决策的问题」「用户让你记住时调 `mem0_add`」
「保持 `user_id` 作用域稳定」「不要存密钥」这类使用策略（约 860 字符）。

```yaml
guidance:
  enabled: true          # 关掉就完全不注入
  text: |                # 整段替换内置措辞
    ## 记忆策略
    回答涉及历史工作的问题前，先用 mem0_search 查一遍。
  append: |              # 在内置（或替换后）文本后面追加
    约定：不要存客户姓名。
  order: 3150            # 在提示词中的排序位置

toolDescriptions:        # 单个工具描述覆盖（每个值替换整段描述）
  mem0_add: '把用户希望记住的持久事实或偏好存起来。'
```

排序位置 `3150` 是刻意的：dsh 内置的工具段落从 `TOOL_BASH`（1000）排到
`TOOL_COMPUTER_USE`（3000），接着是 `MCP_SERVERS`（3100）与 `TOOLS_SDK`（5000），
3150 正好落在内置工具引导之后、SDK 段之前。

#### 只对部分 agent 生效

默认是**一段全局**。要让引导按 agent 分别注册（并可选地按 preset 过滤）：

```yaml
guidance:
  scope: agent            # 每个 agent 一段，注册进它自己的提示词层
  presets: [ptc, standard]  # 可选；不给就是所有 agent
```

`scope: agent` 的效果：

- 段落落在**该 agent 自己的提示词层**，会遮蔽同名的全局段；
- agent 结束时间段落一起销毁；
- 插件卸载时**存活 agent 的段落也会被回收**——否则热重载后下一次
  `agent/created` 会因同名重复注册而失败（这条有回归测试）。

preset 的判定走 **`sessionProjections` 的 `agentPreset` 投影**，而不是会话头——
dsh 自己的注释写得很明确：「Reconstruction reads the `agentPreset` Session
projection, never the header」。读不到 preset 时按**不匹配**处理（`presets` 是显式白名单）。

> `presets` 只能和 `scope: agent` 一起用。写成 `scope: global` + `presets` 会**直接报错**，
> 因为全局段无法事后收窄——静默忽略会让人以为过滤生效了。

**另一种（也是 dsh 原生的）做法**：把插件行放进 preset 的 `plugins` 列表。
preset 会把行挂进 agent 作用域，于是**工具和引导一起**变成该 preset 专属，
不需要任何 `guidance.scope` 配置。两种方式可以并存，选哪种取决于你是想
「只让引导按 preset 走」还是「整个插件都按 preset 走」。

> 两个实现要点（都踩过）：
> - 引导段注册时带 `interpolate: false`，否则自定义文本里的 `{...}`
>   会被当成提示词变量去求值。**你说的字面文本就是模型看到的文本。**
> - `systemPrompt.section()` 内部把 effect 挂在**服务自己的上下文**上，不是调用者的——
>   所以它**不会**随插件卸载自动清理。插件把它包进自己的 `ctx.effect`，
>   否则每次热重载都会在提示词里堆一份旧引导。这一段有回归测试
>   （`test/guidance.mjs` 的「卸载清理」用例）。

`mem0_status` 会报告引导段状态（是否注入、来源、排序、字符数），
在排查「模型为什么不用记忆」时先看这一行。

---

## 2. 前置条件

| 组件 | 要求 | 备注 |
|---|---|---|
| Elasticsearch | **8.x** | 实测 8.14.3 全链路可用；ES9 服务端会被启动期显式拒绝（见 [§6.1](#61-为什么锁-elasticsearch-客户端-v8)） |
| Embedding | 任意 mem0ai 支持的 provider | 参考部署用 LM Studio `bge-m3`（1024 维）或 Ollama `nomic-embed-text`（768 维） |
| Node | `^22.19.0 \|\| >=24.0.0` | 与 dsh 一致，`node:sqlite` 需要 ≥22.5 |

这两个依赖的起法见 [`install.md`](./install.md) §2 与 §3。

> `elasticsearch:8.19.16` 镜像在 Docker Desktop 的 linuxkit 内核上**无法启动**
> （`seccomp unavailable: CONFIG_SECCOMP not compiled into kernel`）——
> 这是容器内核的问题，与 mem0 和本插件无关；用 8.14.3 即可。

---

## 3. 安装

插件以 **bundle**（组合包）形式分发：npm 包 + 一个 patch 层
（[打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)）。

**推荐走 [`install.md`](./install.md)**，它包含依赖探测、Docker 起 ES8、
LM Studio/Ollama 装 embedding、配置写入与验收的完整流程。手工步骤如下：

```sh
# 在插件目录里先构建（分发预构建产物，用户无需工具链）
node node_modules/typescript/bin/tsc -p tsconfig.build.json

# 安装进某个 profile
dsh plugin --profile <name> add /绝对路径/out/dsh-mem0-plugin

# 先只验证配置层，再启动
dsh --profile <name> --dump-config     # 应出现 "# == dsh-mem0-plugin" 层
dsh --profile <name>
```

> **桌面版（Desktop profile）注意**：架构文档明确写了「公开 CLI 不能管理 Desktop profile」。
> 桌面版要走 **设置 → 插件**（或宿主内置的 pnpm 插件事务），而不是上面的 `dsh plugin` 命令。
> 桌面版不会把 `dsh` 放进 `PATH`，所以命令行方式对它不可用。

---

## 4. 配置

配置写在 profile 的 `cordis.patch.yml`，或由 bundle 自带的
[`cordis.patch.yml`](./cordis.patch.yml) 提供。**所有字段都是启动期校验的**。

```yaml
- insert:
    - id: mem0
      name: dsh-mem0-plugin
      config:
        embedder:                      # 就绪所必需
          provider: ollama
          config:
            url: http://localhost:11434
            model: nomic-embed-text:latest
        vectorStore:                   # 就绪所必需
          provider: elasticsearch
          config:
            collectionName: mem0_vector_store
            host: localhost
            port: 9200
            username: elastic
            password: elastic
            useSsl: false              # ← 不写会默认走 HTTPS
        llm:                           # 可选
          provider: openai
          config: { baseURL: '...', apiKey: '...', model: '...' }
        history:
          enabled: true
          # dbPath: /abs/path/history.db   # 覆盖默认的 <workspace>/mem0/
        preflight: { enabled: true, timeoutMs: 8000 }
        refreshAfterWrite: true
        startup: { strict: false }
        guidance: { enabled: true }
        identifiers: { user_id: default-user }
```

| 字段 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `embedder` | object | 无 | `provider` + `config`。缺省时**运行时不就绪**（插件仍加载，见 §5） |
| `vectorStore` | object | 无 | `provider` + `config`。缺省时**运行时不就绪** |
| `llm` | object，可选 | 无 | 只有 `mem0_add` 的 `infer: true` 需要它 |
| `history.enabled` | boolean | `true` | 是否记录/提供 `mem0_history` |
| `history.dbPath` | string | `<workspace>/mem0/history.db` | 历史库文件；覆盖工作区解析，不可写时 `mem0_status` 报错 |
| `preflight.enabled` | boolean | `true` | 就绪前真实探测两个后端 |
| `preflight.timeoutMs` | number | `8000` | 单次探测超时 |
| `refreshAfterWrite` | boolean | `true` | 每次写后刷新 ES 索引，保证「写完立刻能搜到」 |
| `startup.strict` | boolean | `false` | `true` 时后端不通即**加载失败**（见 §5） |
| `guidance.enabled` | boolean | `true` | 是否向系统提示词注入「何时使用记忆」引导段 |
| `guidance.text` | string | 内置文本 | 整段替换引导措辞 |
| `guidance.append` | string | 无 | 在内置（或替换后）文本后追加 |
| `guidance.order` | number | `3150` | 引导段在提示词中的排序 |
| `guidance.scope` | `global` \| `agent` | `global` | `agent` = 每个 agent 一段，注册进它自己的层 |
| `guidance.presets` | string[] | `[]`（全部） | 仅 `scope: agent` 时有效；按 preset 过滤 |
| `toolDescriptions.<工具名>` | string | 内置描述 | 覆盖单个工具给模型看的描述 |
| `identifiers.user_id` / `.agent_id` / `.run_id` | string | 无 | 工具调用省略标识符时的兜底 |

> ⚠️ **v0.1.0 的 `historyStore` 已被 `history` 取代。** mem0 自带的 history store
> 不再使用（原因见 §1.2）。写旧键会得到 `Unknown configuration key: historyStore`，
> 报错里会提示迁移。

### 4.1 向量库键名兼容

`vectorStore.config` 同时接受 TS SDK 的 camelCase 与 Python `config.json` 的 snake_case，
便于把现有配置直接搬过来：

| Python `config.json` | 本插件 / TS SDK |
|---|---|
| `collection_name` | `collectionName` |
| `embedding_model_dims` | `embeddingModelDims`（通常不必写，启动探测会自动填入） |
| `user` | `username` |

### 4.2 工具参数

| 工具 | 参数 |
|---|---|
| `mem0_add` | `messages`（必填，`{role, content}` 数组）、`user_id`、`agent_id`、`run_id`、`metadata`、`infer`、`expiration_date` |
| `mem0_search` | `query`（必填）、`user_id`、`agent_id`、`run_id`、`filters`、`top_k`（默认 5）、`threshold`、`rerank` |
| `mem0_update` | `memory_id`（必填）、`text`（必填）、`metadata` |
| `mem0_delete` | `memory_id`，**或** `user_id` / `agent_id` / `run_id`（两种形式互斥） |
| `mem0_get` | `memory_id`（必填）。未知或格式非法的 id 返回 `found: false`，**不报错** |
| `mem0_get_all` | `user_id` / `agent_id` / `run_id`（至少一个）、`created_after`、`created_before`、`updated_after`、`updated_before`、`limit`（默认 50，上限 500）、`offset`、`order`（`asc`/`desc`，默认 `desc`） |
| `mem0_history` | `memory_id`（必填） |
| `mem0_status` | 无 |

---

## 5. 启动契约：**永远加载，永远可诊断**

`apply` 注册完全部 8 个工具就返回，**初始化在后台跑**。后端不通不会让插件失败，
只会让运行时报 `NOT READY`——这样 `mem0_status` 才存在，才能告诉你哪里错了。

> 这是 v0.2.0 的**行为变更**。v0.1.0 的契约是「配置不满足就不启动」，
> 但那与「初始化失败时用 `mem0_status` 报错」无法共存：插件一旦不加载，
> 用来诊断的工具就一起没了。新契约保留了原意图（不健康就不提供服务），
> 同时让失败**可观测**。需要旧行为就设 `startup.strict: true`。

初始化失败时：

- `mem0_status` → 第一行 `NOT READY`，并给出**关键报错 + 针对性排查建议**；
- 其他 7 个工具 → 返回同一个错误，并提示去看 `mem0_status`；
- **失败后每 5 秒自动重试**，所以把 ES 起起来后直接再调一次即可，**不用重启 dsh**。

### 5.0 就绪前的四道校验

1. **`validateConfig()`**：provider 级语义检查（ES 缺 `collectionName`、
   缺 `useSsl`、顶层键拼错等）。
2. **preflight**：真的去调一次 embedding、ping 一次 ES，并核对**已有索引的向量维度**
   与 embedding 维度是否一致——这是 mem0 + ES 最常见的坑，否则要等到第一次写入才暴露。
3. **`Memory.fromConfig()`**：mem0 自己再校验一遍。
4. **`startup.strict`**（可选）：为 `true` 时上面任一步失败都会让插件加载失败。

实测的 8 个失败场景（`test/config-failfast.mjs`）在**默认模式下**全部满足
「插件加载 + 8 个工具注册 + `mem0_status` 报出真实原因」：

```
▸ 缺少 embedder                    NOT READY: `embedder` is not configured, so nothing can be embedded.
▸ 缺少 vectorStore                 NOT READY: `vectorStore` is not configured, so memories have nowhere to live.
▸ elasticsearch 缺少 collectionName NOT READY: vectorStore.config.collectionName is required ...
▸ elasticsearch 未设置 useSsl        NOT READY: ... mem0ai then defaults to HTTPS; set `useSsl: false` ...
▸ vector store 不可达               NOT READY: Elasticsearch at http://localhost:9299 failed its probe ...
▸ embedding 端点不可达              NOT READY: Embedding provider `ollama` failed its probe: fetch failed
▸ embedding 模型不存在              NOT READY: ... model "definitely-not-a-real-model" not found ...
▸ 未知配置键                        NOT READY: Unknown configuration key: refresh_after_write. Valid top-level
                                              keys are: embedder, vectorStore, llm, history, preflight,
                                              refreshAfterWrite, startup, identifiers ...
```

同一批场景加 `startup: { strict: true }` 时，插件**加载失败且不注册任何工具**——两条路径都有测试覆盖。

> 最后一条值得单独说明：Schemastery **会静默忽略未知键**，所以
> `refresh_after_write: false` 这种拼写错误本来会无声地保留默认值。
> 插件因此显式校验顶层键名。（`embedder.config` / `vectorStore.config` / `llm.config`
> 内部仍是自由透传，因为键名由各 provider 决定。）

### 5.1 不配 `llm` 会怎样

mem0 的 TS 运行时**强制要求** `llm` 块才能构造 `Memory`（即使调用路径用不到它）。
本插件因此总是塞一个「惰性占位」LLM，并把语义收敛成两条明确规则：

- 没配 `llm` → `mem0_add` 的 `infer` **默认 false**（原文存储），工具描述里写明；
- 没配 `llm` 却显式传 `infer: true` → 报错，而不是静默降级。

`mem0_search` / `mem0_update` / `mem0_delete` 完全不碰 LLM。

### 5.2 dsh 会不会因为插件起不来？实测：不会

这是运维上最需要先搞清楚的一条，所以单独实测过
（`test/boot-policy.mjs`，直接调用目标 dsh 版本的 `boot()`）。

dsh 的启动审计逻辑是：
**只有写死的「必需条目」失败才会让启动失败**，其余条目失败只打印一条警告。

必需条目是一份硬编码清单（`@deepseek-ai/dsh-app-boot` 的 `requiredStartupEntryIds`）：

```
agent-loop · webserver · modules · connection · headless-runner · acp · sdk-jsonrpc-server
```

本插件的行 id 是 `mem0`，**不在其中**。实测结果：

| 场景 | `boot()` | mem0 fiber | 其它插件 | 结果 |
|---|---|---|---|---|
| 配置有未知键（默认模式） | 正常返回 | `ACTIVE` | 全部 `ACTIVE` | **dsh 正常启动，可用 `mem0_status` 诊断** |
| 缺少 `embedder`（默认模式） | 正常返回 | `ACTIVE` | 全部 `ACTIVE` | 同上 |
| ES 连不上（默认模式） | 正常返回 | `ACTIVE` | 全部 `ACTIVE` | 同上 |
| 缺少 `embedder`（`strict: true`） | 正常返回 | `FAILED` | 全部 `ACTIVE` | dsh 仍正常启动，只是没有 mem0 工具 |
| **根配置 YAML 语法错误** | **抛出 `StartupError`** | — | — | **dsh 起不来（exit 1）** |

实际输出形如：

```
dsh: warning: 1 entry did not activate
mem0 (dsh-mem0-plugin): Mem0ConfigError: `embedder` is not configured, so nothing can be embedded.
  Add an `embedder` block.
```
（这条警告只在 `startup.strict: true` 时出现——默认模式下插件是 ACTIVE，
失败信息通过 `mem0_status` 暴露。）

**所以：**

- ❌ **不会**因为你把插件配置写错而让 dsh 崩溃或起不来——插件照常加载，
  8 个工具都在，`mem0_status` 会告诉你哪儿不对；
- ⚠️ `startup.strict: true` 时插件会 `FAILED`、**7 个记忆工具静默消失**，
  但 dsh 依然正常启动（`mem0` 不在必需清单里）——这也是 fail-fast 在这里安全的原因；
- 🔴 **唯一会真的让 dsh 起不来的**，是把 `cordis.patch.yml` 本身写成非法 YAML
  （根 Include 无法挂载 → 审计判定必需条目失败）。
  **改这个文件时务必保持 YAML 合法**，尤其是取消注释 `llm:` 那一段时别破坏缩进。

**失败了去哪儿看：**

1. **设置 → 插件** —— 插件清单按行暴露 `fiberPhase`，失败的行是 `failed`；
2. 启动时的 stderr 警告行（桌面版从 Finder 启动时未必可见，所以**优先看第 1 条**）；
3. 修好配置后**不需要重启**——配置变更会触发该行的热重载（`cordis.patch.yml` 改动
   → 卸载旧实例 → 加载新实例），因为注册都是 effect，旧实例的注册会被自动撤销。

> 为什么不改成「插件照常加载、调用时再报错」：那会让模型看到一个存在但永远失败的记忆工具，
> 它会反复重试并烧掉轮次。启动期失败 + 工具不存在，是更干净的失败方式。
> 代价就是本条所述——**必须知道去哪里确认插件到底有没有起来**。

---

## 6. 设计取舍

### 6.1 为什么锁 Elasticsearch 客户端 v8

`mem0ai@3.3.1` 把 `@elastic/elasticsearch@^9` 声明为 optional peer，但客户端是
**动态 import** 的，实际版本由插件决定。实测：

| 组合 | 结果 |
|---|---|
| v9 客户端 → ES 8.14.3 服务端 | ❌ `Accept version must be either version 8 or 7, but found 9` |
| v8 客户端 → ES 8.14.3 服务端 | ✅ 全链路可用 |

所以插件把 `@elastic/elasticsearch` **钉在 `^8.19.0`** 并放进 `dependencies`，
同时在 preflight 里对 ES9 服务端直接报错——避免出现「版本对不上但没人知道为什么」的状态。

### 6.2 为什么历史库自己实现（而不是用 mem0 的 history store）

一句话：**mem0 的 history store 用不了**。它只提供 `sqlite`（需要原生
`better-sqlite3`）、`supabase` 和进程内 `memory`；而 dsh 桌面宿主跑的是
**Electron 的 Node**，模块 ABI 与本机 Node 不同（实测 Electron 44 → ABI **149**，
Node 24 → ABI **137**），为 Node 编译的原生模块在宿主里根本加载不了。

于是插件改用 Node 自带的 `node:sqlite`（已在 Electron 宿主内实测可读写），
零编译、跨平台、路径完全可控。详见 [§1.2](#12-mem0_history-的历史存在哪)。

### 6.3 为什么不直接用 mem0 的 `deleteAll`（**这是个坑**）

按作用域删除（`mem0_delete` 传 `user_id` 等）**不能**调用 `mem0.deleteAll`。
它的实现是：

```js
const DELETE_ALL_BATCH_SIZE = 1                     // ← 每轮只删一条
while (true) {
  const [batch] = await this.vectorStore.list(filters, DELETE_ALL_BATCH_SIZE)
  if (!batch.length) break
  const batchKey = batch.map(m => m.id).sort().join(',')
  if (seenBatches.has(batchKey)) { logger.warn('Stopping deleteAll after a repeated memory batch'); break }
  seenBatches.add(batchKey)
  for (const m of batch) await this.deleteMemory(m.id)
}
```

它靠「批次重复」终止循环，而 `list` 走的是**依赖 refresh 的 search**。
索引自上次删除以来没刷新时，第二轮 `list` 返回的正是刚删掉的那条 → 守卫触发 → 退出。
后果是：

- **一次调用只删掉 1 条，却返回 `"Memories deleted successfully!"`** —— 静默残留；
- 时序稍变则抛 `Memory with ID ... not found`。

两种都在 ES8 上直接复现过（25 条的作用域：一次调用后仍有 24 条，
或直接抛 not found）。所以插件自己实现：**先 refresh，分页取 id，按 id 逐条删**
（按 id 删不依赖列表新鲜度），删完再复核一次，并把 `deleted` / `remaining`
如实返回——剩了就报剩了多少，不谎报成功。

回归测试见 `test/scope-delete.mjs`，两种 `refreshAfterWrite` 设置下都要求真正清空。

### 6.4 为什么写后要 refresh

mem0 建索引时写死 `refresh_interval: "1s"`。默认配置下会出现
**「刚 add 完，search 却搜不到」**——对一个记忆工具来说这是最难排查的失败模式。
插件在每次成功写入后对索引显式 `refresh`，让 `mem0_add` → `mem0_search` 立即一致；
可用 `refreshAfterWrite: false` 换回吞吐。

### 6.5 为什么结果要过一遍 `toJsonValue`

mem0 返回的对象带**显式 `undefined` 成员**（如未设置的 `updatedAt`）。
`JSON.stringify` 会丢掉它们，但 dsh 工具运行时按无损 JSON 做结构校验，
会直接判 `value is not lossless JSON`。`src/json.ts` 负责把结果投影成严格无损 JSON。

---

## 7. 验证

### 7.1 起测试依赖

```sh
docker run -d --name dsh-es8 -p 9200:9200 --cpus 1.0 -m 2g \
  -e discovery.type=single-node \
  -e xpack.security.enabled=true -e xpack.security.http.ssl.enabled=false \
  -e xpack.security.transport.ssl.enabled=false -e xpack.security.enrollment.enabled=false \
  -e ELASTIC_PASSWORD=elastic -e "ES_JAVA_OPTS=-Xms1024m -Xmx1024m" \
  docker.elastic.co/elasticsearch/elasticsearch:8.14.3

docker run -d --name dsh-ollama -p 11434:11434 ollama/ollama:0.20.7
docker exec dsh-ollama ollama pull nomic-embed-text
```

> ⚠️ `elasticsearch:8.19.16` 镜像在 Docker Desktop 的 linuxkit 内核上起不来
> （`seccomp unavailable: CONFIG_SECCOMP not compiled into kernel`）。
> 8.14.3 正常——这也是 `resources/.../vector/README` 推荐它的原因。

### 7.2 跑测试

```sh
npm run typecheck && npm run build && npm test
```

`npm test` 串起七个套件；`boot-policy` / `history-workspace` / `guidance` 不需要后端在线：

| 套件 | 覆盖 | 需要服务 |
|---|---|---|
| `test/boot-policy.mjs` | 用真实 `boot()` 验证：默认模式插件 ACTIVE、strict 模式 FAILED 但 dsh 仍启动、根配置损坏才致命 | 否 |
| `test/history-workspace.mjs` | 历史库位置决策表 7 个场景：唯一工作区 / 默认工作区 / 首个注册 / 显式配置 / 无注册表 / 自愈迁移 | 否（后端故意不可达） |
| `test/guidance.mjs` | 引导段 12 个场景：注入 / 替换 / 追加 / 关闭 / 排序 / 工具描述覆盖 / 拼写校验 / 卸载清理 / **per-agent 注册 / preset 过滤 / 组合校验** | 否（后端故意不可达） |
| `test/bundle-config.mjs` | `cordis.patch.yml` 的默认配置能过 schema 并真实启动插件 | 是 |
| `test/config-failfast.mjs` | 8 个失败场景在默认模式下「插件加载 + 8 工具 + `mem0_status` 报因」，strict 模式下加载失败 | 是 |
| `test/scope-delete.mjs` | 作用域删除真正清空（两种 `refreshAfterWrite` 设置），锁住 §6.3 的修复 | 是 |
| `test/e2e.mjs` | 真 Cordis `Context` + 真 `ToolRuntime` + 真 ES8，11 组断言 | 是 |
| `test/benchmark.mjs` | 性能基线（不参与 `npm test`，单独跑 `npm run test:bench`） | 是 |

`e2e` 的实际断言（写入路径**全程不 sleep**，写后立即读）：

1. 恰好注册 8 个工具；`mem0_status` 返回 `ok: true` 且暴露维度与历史库路径
2. `mem0_add` 写入并返回 memory id
3. `mem0_search` **立刻**能搜到 → 验证 `refreshAfterWrite`
4. 另一个 `user_id` 搜不到 → 作用域隔离
5. `mem0_update` 后立刻可见新正文
6. `mem0_get_all`：全量、`created_before` / `created_after` 时间窗、`limit`/`offset` 分页、
   非法时间参数被拒
7. `mem0_history`：ADD → UPDATE（保留旧值）→ DELETE 的完整轨迹
8. `mem0_get`：存在的 id 返回当前正文；未知 / 非法 id 返回 `found:false` 而不报错
9. `mem0_delete` 后该 id 立即消失，且删除动作进入历史
10. 批量删除清空作用域；`memory_id` + 标识符同时给出 → 拒绝；
    无标识符 → 拒绝；`infer: true` 但无 `llm` → 拒绝
11. `identifiers` 默认值可替代调用方传参；**dispose fiber 后 8 个工具全部注销**

### 7.2.1 性能基线

```sh
npm run test:bench                      # 100 条 / 30 次检索
COUNT=300 QUERIES=50 npm run test:bench
BENCH_EMBEDDER=lmstudio BENCH_MODEL=text-embedding-bge-m3 npm run test:bench
```

报告写入 `docs/evidence/benchmark-<date>.md`。基线（本地 Ollama `nomic-embed-text` 768 维 +
ES 8.14.3，单机、无并发）：

| 指标 | 值 |
|---|---|
| `mem0_add` p50 / p95 | ~35 ms / ~350 ms |
| `mem0_search` p50 / p95 | ~47 ms / ~340 ms |
| `mem0_get_all`（100 条全扫） | ~7 ms |
| recall@1 / recall@5 / MRR | 100% / 100% / 1.0000 |

读数要点：

- **尾部而非中位数决定体验**（p95 约是 p50 的 10 倍）。尾部的来源大概率是 embedding 服务的
  调度（本地 Ollama），因为同样规模的全量扫描只要 7 ms —— ES 侧很轻。
- **召回是唯一确定的**：100 个唯一项目名、唯一可判定查询，recall@1 = 100%。
  这度量的是「embedding + kNN 是否把正确答案排第一」，换模型/维度后必须重测。
- **`refreshAfterWrite` 的代价在本次规模下测不出来**（差值落在波动内）。
  报告不会把它写成结论——见 `docs/evidence/benchmark-*.md` 里的说明。

### 7.3 已知未验证项

诚实起见，以下路径**没有**实测，文档中也没有把它们写成已验证：

- **`infer: true` 的真实抽取链路**：本机没有可用的 LLM 凭据，
  因此只验证了「无 `llm` 时明确报错」这条分支。配上 `llm` 后走的是 mem0 官方代码路径。
- **安装进桌面版 profile**：本会话的审批被禁用，未改动正在运行的 profile。
- **LM Studio 作为 embedder**：`lmstudio` provider 的配置字段是从 SDK 源码读出来的
  （`baseURL` / `apiKey` / `model`），但本机没有 LM Studio，未端到端跑过。
  Ollama 路径是实测的。
- **ES9 服务端**：按设计直接拒绝，未做兼容性尝试。
- **并发**：所有性能数字都是单线程顺序调用，没有测并发写入/检索。

---

## 8. 与 REST 版的差异

| 维度 | 独立 mem0 REST 服务 | 本插件 |
|---|---|---|
| 进程 | 独立 Python 容器 | 进程内，无 sidecar |
| 协议 | HTTP + `X-API-Key` | dsh 工具调用 |
| 配置 | `config.json` + `MEM_CONF_FILE` 环境变量 | Cordis Config，运行时就绪校验 |
| 配置错误 | 启动时 `SystemExit` | 插件仍加载，`mem0_status` 报出原因（`startup.strict` 可改回失败加载） |
| 写后读 | 有 1s 索引刷新延迟 | 默认显式 refresh，写完即读 |
| 按作用域删除 | `DELETE /memories` | 自己实现（mem0 的 `deleteAll` 会静默漏删，见 §6.3） |
| 时间范围查询 | 无（只有 page/page_size） | `mem0_get_all` 原生 date range + sort + 分页 + 真实 total |
| 历史库 | mem0 的 sqlite（`history_db_path`） | 插件自己的 `node:sqlite`，默认 `<workspace>/mem0/`（`history.dbPath` 可覆盖） |
| 事实抽取 | `llm` 必需 | `llm` 可选，缺失时 `infer` 默认 false |
| 自检 | 无 | `mem0_status` |

**仍未实现的端点**：`/configure`（Cordis 用配置层 + 热重载替代）、`/reset`、
`GET /memories/{id}`。mem0 TS SDK 的对应能力（`reset` / `get`）都在，
需要时按 `src/tools.ts` 里现有工具的写法加即可。
