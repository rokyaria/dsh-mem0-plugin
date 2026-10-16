#!/usr/bin/env bash
# install.md §1 的探测步骤，脚本化 —— 让 Agent（或人）一眼看到"这台机器上有什么"，
# 从而决定复用还是安装。只读：不装东西、不改配置、不启容器。
#
#   bash scripts/probe.sh
#
# 退出码始终为 0：这是一份报告，不是断言。
set -uo pipefail

ES_URL=${MEM0_TEST_ES_URL:-http://localhost:9200}
ES_USER=${MEM0_TEST_ES_USER:-elastic}
ES_PASS=${MEM0_TEST_ES_PASS:-elastic}
LM_URL=${MEM0_TEST_LMSTUDIO_URL:-http://localhost:1234}
OLLAMA_URL=${MEM0_TEST_OLLAMA_URL:-http://localhost:11434}
ES_IMAGE=${MEM0_ES_IMAGE:-docker.elastic.co/elasticsearch/elasticsearch:8.14.3}

ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; }
info() { printf '  •  %s\n' "$1"; }

echo "== 1/5 Elasticsearch（向量库）=="
if curl -fsS --max-time 5 -u "$ES_USER:$ES_PASS" "$ES_URL" -o /tmp/probe-es.json 2>/dev/null; then
  ver=$(python3 -c "import json;print(json.load(open('/tmp/probe-es.json'))['version']['number'])" 2>/dev/null || echo '?')
  case "$ver" in
    8.*) ok "ES $ver 在 ${ES_URL}（8.x 可用）" ;;
    9.*) bad "ES $ver 在 $ES_URL —— 客户端锁 v8，ES9 不兼容（见 design-notes §2.4）" ;;
    *)   info "ES $ver 在 $ES_URL —— 只测过 8.14.3" ;;
  esac
else
  bad "没有 ES 应答 $ES_URL —— 见 install.md §2（${ES_IMAGE}）"
fi

echo "== 2/5 LM Studio（embedding 的一条路）=="
if curl -fsS --max-time 5 "$LM_URL/v1/models" -o /tmp/probe-lm.json 2>/dev/null; then
  n=$(python3 -c "
import json
d=json.load(open('/tmp/probe-lm.json'))
print(sum(1 for m in d.get('data',[]) if 'embed' in m.get('id','').lower()))" 2>/dev/null || echo 0)
  if [ "$n" -gt 0 ]; then ok "LM Studio 在 ${LM_URL}（$n 个 embedding 模型）"
  else bad "LM Studio 在 ${LM_URL}，但没有 embedding 模型 —— 见 install.md §3 选项 A"; fi
else
  bad "没有 LM Studio 应答 $LM_URL"
fi

echo "== 3/5 Ollama（embedding 的另一条路）=="
if curl -fsS --max-time 5 "$OLLAMA_URL/api/tags" -o /tmp/probe-ol.json 2>/dev/null; then
  n=$(python3 -c "
import json
d=json.load(open('/tmp/probe-ol.json'))
print(sum(1 for m in d.get('models',[]) if 'embed' in m.get('name','').lower()))" 2>/dev/null || echo 0)
  ok "Ollama 在 ${OLLAMA_URL}（$n 个名字里带 embed 的模型）"
else
  bad "没有 Ollama 应答 $OLLAMA_URL"
fi

echo "== 4/5 Docker（起 ES 用）=="
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    ok "docker 可用（$(docker --version | cut -d, -f1)）"
    if docker image inspect "$ES_IMAGE" >/dev/null 2>&1; then ok "镜像已在本地：$ES_IMAGE"
    else info "镜像不在本地（首次 up 会拉，约 1 GB）：$ES_IMAGE"; fi
  else
    bad "docker 装了但 daemon 没起（macOS：open -a Docker，约 16 s 就绪）"
  fi
else
  bad "没有 docker —— 见 install.md §2"
fi

echo "== 5/5 插件与配置 =="
if command -v node >/dev/null 2>&1; then
  ok "node $(node -v)（要求 ^22.19 || >=24）"
else
  bad "没有 node"
fi
home=${DSH_HOME:-$HOME/.dsh}
profile=${MEM0_PROFILE:-$home/profiles/desktop}
if [ -f "$profile/cordis.patch.yml" ]; then
  if grep -q 'dsh-mem0-plugin' "$profile/cordis.patch.yml"; then ok "配置行已在 $profile/cordis.patch.yml"
  else bad "配置里还没有 mem0 行 —— 见 install.md §5/§6"; fi
else
  bad "没有找到 profile 的 cordis.patch.yml（${profile}）"
fi

echo
echo "报告结束。选哪条 embedding 路：LM Studio 有 embedding 模型就选它（install.md §3 选项 A），"
echo "否则用 Ollama（选项 B）。两条都通了之后，用 export MEM0_TEST_EMBEDDER=lmstudio|ollama 跑测试。"
exit 0
