# install.md — 给 Agent 的安装与排错手册

> **读者是 Agent，不是人。** 每一节都给出可直接执行的命令和判定条件。
> 目标是：把 `dsh-mem0-plugin` 装起来并让 `mem0_status` 返回 OK。
>
> 核心原则：**先探测、能复用就复用、缺什么才装什么。**
> 不要无条件 `docker run` —— 用户很可能已经有 ES8 或 embedding 服务。

---

## 0. 心智模型（先读这 30 秒）

插件需要三样东西，缺一样就跑不起来：

| 角色 | 作用 | 参考实现 |
|---|---|---|
| **Embedding 模型** | 把文本变成向量 | LM Studio 里的 `bge-m3`，或 Ollama `nomic-embed-text` |
| **向量库** | 存向量并做相似度检索 | Elasticsearch **8.x**（插件钉死 v8 客户端，ES9 会被拒绝） |
| **LLM**（可选） | 从对话里抽取事实 | 用户自己的 LLM；不配也能用，只是 `mem0_add` 默认 `infer:false` |

**最关键的一条**：插件**永远会加载**，即使上面三样全都没配。
所以任何时候都可以用 `mem0_status()` 问它「你好了吗、哪里没对」。
配置错误不会让 dsh 起不来。

---

## 1. 探测现状（不要跳过）

```sh
# Elasticsearch 在不在？版本对不对？
curl -s -u elastic:elastic --max-time 5 http://localhost:9200 \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('ES', d['version']['number'])" 2>/dev/null \
  || echo "ES: 未在 localhost:9200 提供服务"

# LM Studio 在不在？
curl -s --max-time 5 http://localhost:1234/v1/models \
  | python3 -c "import sys,json;print('LM Studio models:', [m['id'] for m in json.load(sys.stdin).get('data',[])])" 2>/dev/null \
  || echo "LM Studio: 未在 localhost:1234 提供服务"

# Ollama 在不在？
curl -s --max-time 5 http://localhost:11434/api/tags \
  | python3 -c "import sys,json;print('Ollama models:', [m['name'] for m in json.load(sys.stdin).get('models',[])])" 2>/dev/null \
  || echo "Ollama: 未在 localhost:11434 提供服务"

# docker 可用吗？
docker version --format '{{.Server.Version}}' 2>/dev/null || echo "docker: 不可用"
```

判定：

- **ES 已就绪**（版本 8.x）→ 记下 host/port/账号，跳到 §2
- **ES 版本 ≥ 9** → 必须换 8.x，见 §2 的说明
- **embedding 已就绪**（LM Studio 里有 embedding 模型，或 Ollama 有 `nomic-embed-text`/`bge-m3`）→ 跳到 §3
- 都没有 → §2 和 §3 各装一个

---

## 2. 装 Elasticsearch 8（已有则复用）

```sh
docker run -d --name dsh-es8 \
  -p 9200:9200 --cpus 1.0 -m 2g \
  -e discovery.type=single-node \
  -e xpack.security.enabled=true \
  -e xpack.security.http.ssl.enabled=false \
  -e xpack.security.transport.ssl.enabled=false \
  -e xpack.security.enrollment.enabled=false \
  -e ELASTIC_PASSWORD=elastic \
  -e "ES_JAVA_OPTS=-Xms1024m -Xmx1024m" \
  docker.elastic.co/elasticsearch/elasticsearch:8.14.3

# 等到真的应答（首次启动约 20-40 秒）
for i in $(seq 1 60); do
  curl -s -u elastic:elastic --max-time 3 http://localhost:9200 >/dev/null 2>&1 && { echo "ES ready"; break; }
  sleep 2
done
curl -s -u elastic:elastic http://localhost:9200 | head -c 200
```

**为什么是 8.14.3 而不是最新：**

- 插件把 `@elastic/elasticsearch` 钉在 **v8**。mem0ai 声明的是 `^9`，但 v9 客户端会给 ES8 服务端发
  `compatible-with=9` 的 media type，服务端直接 **400**。
- `elasticsearch:8.19.16` 在 Docker Desktop 的 linuxkit 内核上**起不来**
  （`seccomp unavailable: CONFIG_SECCOMP not compiled into kernel`），与 mem0 无关。
- 所以：**8.14.3 是实测可用的版本。**

---

## 3. 装 Embedding 模型（已有则复用）

### 选项 A：LM Studio + bge-m3（用户已有 LM Studio 时首选）

LM Studio 是 GUI 应用，**Agent 无法完全自动安装**。分两步：

1. **用户手动**：打开 LM Studio → 搜索 `bge-m3` → 下载 → 在 **Developer / Local Server** 页
   启动服务器（默认端口 `1234`）→ 在模型列表里加载 embedding 模型。
2. **Agent 验证**：

```sh
curl -s http://localhost:1234/v1/models | python3 -m json.tool | head -30
# 期望看到形如 text-embedding-bge-m3 的条目
# 实际嵌入测试：
curl -s http://localhost:1234/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"text-embedding-bge-m3","input":"probe"}' \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('dims =', len(d['data'][0]['embedding']))"
```

> ⚠️ LM Studio 的模型 id 必须和上面 `-d` 里的 `model` **完全一致**（含 `text-embedding-` 前缀）。
> 配置时把 `embedder.config.model` 写成同一个字符串。

### 选项 B：Ollama（Agent 可全自动）

```sh
docker run -d --name dsh-ollama -p 11434:11434 ollama/ollama:0.20.7
sleep 5
docker exec dsh-ollama ollama pull nomic-embed-text      # 768 维
curl -s http://localhost:11434/api/tags
```

Ollama 也可以跑 `bge-m3`（1024 维）：`docker exec dsh-ollama ollama pull bge-m3`。

> **维度是不可逆的**：ES 索引一旦建好，`dense_vector` 的 dims 就固定了。
> 换 embedding 模型必须换 `collectionName`，否则插件会在启动探测时直接报维度不匹配。

---

## 4. LLM（可选，默认用用户自己的）

`mem0_add` 的 `infer:true` 会用 LLM 从对话里抽取事实。**不配也能用**（默认 `infer:false`，原文存储）。

优先复用用户已有的 LLM。任一 OpenAI 兼容端点都行：

| 用户已有的东西 | `llm.provider` | 关键配置 |
|---|---|---|
| DeepSeek API key | `deepseek` | `apiKey`，可选 `model`（默认 `deepseek-chat`）、`baseURL` |
| 任意 OpenAI 兼容网关（含 LM Studio 的 chat 模型） | `openai` | `baseURL` / `apiKey` / `model` |
| Ollama 的 chat 模型 | `ollama` | `url`（默认 `http://localhost:11434`）、`model` |

**问用户要，不要猜。** 需要 key 时明确询问；不要把 key 写进日志或回复里。

---

## 5. 写入配置

配置文件是当前 profile 的 `cordis.patch.yml`：

- Desktop 版：`$DSH_HOME/profiles/desktop/cordis.patch.yml`
- 其他 profile：`$DSH_HOME/profiles/<name>/cordis.patch.yml`

（`$DSH_HOME` 默认 `~/.dsh`。）

在数组里**追加**一条（不要覆盖已有条目）：

```yaml
- insert:
    - id: mem0
      name: dsh-mem0-plugin
      config:
        embedder:
          provider: lmstudio            # 用 Ollama 就改成 ollama
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
            useSsl: false               # ← 不写会默认走 HTTPS，本地明文 ES 会连不上
        # llm:                              # 可选；不配则 mem0_add 默认 infer:false
        #   provider: deepseek
        #   config:
        #     apiKey: <用户的 key>
        #     model: deepseek-chat
        history:
          enabled: true                     # 默认落 <workspace>/mem0/history.db
          # dbPath: /abs/path/history.db    # 想固定位置就写死它
        preflight:
          enabled: true
          timeoutMs: 8000
```

> 🔴 **改这个文件时务必保持 YAML 合法。**
> 这是唯一一条会让 dsh **完全起不来**的路径：根配置读不出来 → 启动审计判定必需条目失败 → 进程退出。
> 插件配置写错只会让插件不生效（可以用 `mem0_status` 查），但 YAML 语法错误会锁死启动。
> **改完先校验**：

```sh
python3 -c "
import yaml,sys
p='$DSH_HOME/profiles/desktop/cordis.patch.yml'
yaml.safe_load(open(p))
print('YAML OK')
" || echo '🔴 YAML 非法，不要重启 dsh，先修好'
```

---

## 6. 安装插件本体

```sh
# 源码目录（Agent 自己 clone / 构建的情况）
cd <plugin-dir> && npm run build

# 方式一：CLI（非 Desktop profile）
dsh plugin --profile <name> add <plugin-dir 绝对路径>

# 方式二：Desktop 版 —— 公开 CLI 不能管理 Desktop profile
#   用 GUI 的「设置 → 插件」，或宿主内置的 pnpm 插件事务。
#   也可以直接把 row 写进 cordis.patch.yml 并让插件目录可被解析。
```

---

## 7. 验证：`mem0_status()`

**这是唯一的验收标准。** 调用它（通过 dsh 的工具调用机制），看第一行：

- `OK — dsh-mem0-plugin: 记忆运行时已就绪` → **装好了**
- `NOT READY — dsh-mem0-plugin (phase=failed)` → 看下面的 `关键报错`

`mem0_status` 会一并给出：配置摘要、启动探测结果（embedding 维度、ES 版本与索引）、
历史库实际路径、以及针对该错误的排查建议。

```
OK — dsh-mem0-plugin: 记忆运行时已就绪（mem0_status + 7 个记忆工具可用）
version: 0.2.0

配置:
  embedder    : lmstudio
  vectorStore : elasticsearch (index: mem0_vector_store)
  llm         : 未配置 (mem0_add 默认 infer:false，不做事实抽取)
  identifiers : (无默认值)

工作区:
  /Users/<you>/Documents/deepseek-harness/default-workspace  [default-workspace, 共 2 个]

历史库:
  path  : /Users/<you>/Documents/deepseek-harness/default-workspace/mem0/history.db  [workspace]
  rows  : 0

启动探测:
  embedder    : lmstudio / text-embedding-bge-m3 -> 1024 dims
  vectorStore : Elasticsearch 8.14.3 reachable; index `mem0_vector_store` present (1024 dims)
```

**修好依赖后不需要重启 dsh** —— 再调一次 `mem0_status` 就会触发重试（失败后每 5 秒自动重试一次）。

---

## 8. 排错对照表

| `mem0_status` 的报错 | 根因 | 修法 |
|---|---|---|
| `` `embedder` is not configured `` | 配置里没有 `embedder` 块 | 按 §5 补上 |
| `` `vectorStore` is not configured `` | 配置里没有 `vectorStore` 块 | 按 §5 补上 |
| `Embedding provider \`X\` failed its probe: fetch failed` | embedding 端点连不上 | §1 探测；确认端口与 `baseURL` |
| `... model "Y" not found, try pulling it first` | 模型名不对或未下载 | 用端点返回的**准确** model id |
| `Elasticsearch at http://... did not respond within Nms` / `ConnectionError, no response` | ES 没起或端口不对 | `docker ps`；`curl -u elastic:elastic http://localhost:9200` |
| `Elasticsearch reported version 9.x ...` | 用了 ES9，与 v8 客户端不兼容 | 换 8.14.3（§2） |
| `Index \`X\` stores N-dimensional vectors but ... produces M` | 索引维度与 embedding 不匹配 | 换 `collectionName` 建新索引，或换回原 embedding |
| `vectorStore.config.useSsl is not set` | 没写 `useSsl`，mem0 默认走 HTTPS | 明文 ES 写 `useSsl: false` |
| `vectorStore.config.collectionName is required` | 缺索引名 | 补 `collectionName` |
| `Unknown configuration key: ...` | 配置键拼错 | 报错里会列出全部合法键 |
| dsh **完全起不来** | `cordis.patch.yml` YAML 非法 | 见 §5 的校验命令；修好再启动 |
| 历史库位置不是预期的工作区 | 你注册了多个工作区，插件选了 dsh 的默认工作区 | 用 `history.dbPath` 写死位置；`mem0_status` 的「工作区」一节会说明选了哪个、为什么 |

排查时**先调 `mem0_status`**，再动手改配置 —— 它给的就是上表里的那一条。

---

## 9. 验收清单

- [ ] `mem0_status()` 第一行是 `OK`
- [ ] `mem0_add` 写入一条测试记忆并返回 id
- [ ] `mem0_search` 能立刻搜到刚写入的内容（插件默认写后刷新索引）
- [ ] `mem0_get` 能用 id 取回刚写入的记忆
- [ ] `mem0_get_all` 能列出它，且 `created_before` 时间窗生效
- [ ] `mem0_history(memory_id)` 能看到 `ADD` 记录
- [ ] `mem0_status` 的「工作区」一节选中的是你期望的工作区（不对就用 `history.dbPath` 写死）
- [ ] `mem0_delete` 清掉测试数据

测试数据请用独立的 `user_id`（例如 `agent-install-check`），不要污染用户真实记忆。
