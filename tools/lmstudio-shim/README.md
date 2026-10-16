# tools/lmstudio-shim —— 让本机 LM Studio 能当 mem0 的 LLM

一个**只做适配、不做业务**的本地转发：`127.0.0.1:1235` → LM Studio `127.0.0.1:1234`。

## 为什么需要它

`mem0_add(infer: true)` 会让 mem0 调 LLM 去抽事实。把 `llm` 指向本机 LM Studio 时，会连撞三件事
（2026-10-16 实测）：

1. **`response_format: {"type":"json_object"}` 被拒**（HTTP 400：LM Studio 只接受 `json_schema` / `text`）。
   这个值来自 mem0ai 继承的 OpenAI 客户端，配置层改不了。
2. **空的 `tool_calls: []`**：LM Studio 总会带这个字段，而 mem0ai 写的是 `if (response.tool_calls)` ——
   JS 里空数组是 truthy，于是本该返回字符串的地方返回了对象，调用方 `.replace` 直接炸。
3. **推理模型的答案在 `reasoning_content` 里**，`content` 是空的；直接搬过去又会踩第二个坑：
   把请求改写成 `json_schema`（哪怕 schema 是「任意对象」）会让模型交出空壳（`{"memory": [{}]}`）。
   所以最终选的是 LM Studio 也接受的 **`text`**（=不加约束），让模型按 mem0 的提示词自己输出 JSON。

## 怎么用

```sh
# 起（先踢掉旧实例，避免 EADDRINUSE）
node tools/lmstudio-shim/server.mjs --port 1235 --upstream http://127.0.0.1:1234
# 可选：--temperature 0 钉住采样（默认就钉 0；传 -1 则不干预）
```

配置里 `llm.provider` 仍写 `lmstudio`（复用它的 OpenAI 兼容客户端，**不用额外装 `openai` 包**），
只把 `baseURL` 指向适配层：

```yaml
llm:
  provider: lmstudio
  config:
    baseURL: http://127.0.0.1:1235/v1
    model: <你 LM Studio 里的对话模型 id>
```

## 实测（2026-10-16）

- 一段自我介绍（`qwen3.6-35b-a3b-uncensored-heretic-mlx`）→ 抽出 1–2 条事实 ✓
- **同一段对话存第二遍、换个说法存第三遍，条数都不涨**（mem0 的去重生效）✓
- 每次 `mem0_add`（含抽取）3–15 s —— 本地推理，比云端慢，批量灌历史对话时要心里有数。

## 边界

- 它**不改 mem0 的语义**，只搬运形状；将来 mem0ai 修了这三处，这层就可以删掉。
- 它**不引依赖**（只用 node 内置 http/fetch）。
- 它**不含任何凭据**：上游是本机 1234，`apiKey` 用 LM Studio 的占位值即可。
