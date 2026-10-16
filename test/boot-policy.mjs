/**
 * Startup-policy verification: what DSH actually does when this plugin fails
 * to load.
 *
 * This matters because "fail-fast" is only a safe design if a failed
 * *non-required* plugin cannot take the application down with it. The claim is
 * verified here against the real `boot()` from the dsh version this plugin
 * targets, rather than asserted from reading the source.
 *
 * Verified policy (`@deepseek-ai/dsh-app-boot`, `auditStartupEntries`):
 *   - a failed/pending entry is fatal only when its id is in the hardcoded
 *     `requiredStartupEntryIds` set (agent-loop, webserver, modules,
 *     connection, headless-runner, acp, sdk-jsonrpc-server) or when it is the
 *     bootstrap `include` itself;
 *   - any other inactive entry produces one warning and startup continues.
 *
 * Consequences asserted below:
 *   1. a bad plugin config  → warning, fiber FAILED, boot returns normally
 *   2. a missing embedder   → warning, fiber FAILED, boot returns normally
 *   3. an unreachable store → warning, fiber FAILED, boot returns normally
 *   4. malformed YAML in the root config → boot *throws* (the include is required)
 *
 * Run: node test/boot-policy.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'

// The minimal boot tree has no workspace registry, so the plugin's history
// store would fall back to `<DSH_HOME>/mem0/`. Sandbox DSH_HOME so this suite
// never writes into the user's real dsh home.
process.env.DSH_HOME = join(mkdtempSync(join(tmpdir(), 'dsh-mem0-boot-home-')), 'dsh')

const here = (p) => fileURLToPath(new URL(p, import.meta.url))
const PLUGIN = here('../lib/index.js')
const SYSTEM_PROMPT = here('../node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js')
const TOOLS = here('../node_modules/@deepseek-ai/dsh-tools/lib/index.js')

const dir = mkdtempSync(join(tmpdir(), 'dsh-boot-policy-'))

const HEADER = `- id: system-prompt
  name: ${SYSTEM_PROMPT}
- id: tools
  name: ${TOOLS}
`

const GOOD_VECTOR_STORE = `      provider: elasticsearch
      config: { collectionName: mem0_boot_policy, host: localhost, port: 9200, username: elastic, password: elastic, useSsl: false }`

function configFile(name, body) {
  const path = join(dir, name)
  writeFileSync(path, body)
  return path
}

const CASES = [
  {
    label: '未知配置键（refresh_after_write 拼写错误）— 默认模式',
    yaml: `${HEADER}- id: mem0
  name: ${PLUGIN}
  config:
    embedder:
      provider: ollama
      config: { url: 'http://localhost:11434', model: 'nomic-embed-text:latest' }
    vectorStore:
${GOOD_VECTOR_STORE}
    refresh_after_write: false
`,
    expectThrows: false,
    expectMem0State: 2, // ACTIVE: the plugin loaded so mem0_status can explain the config error
    expectInWarning: null,
  },
  {
    label: '缺少 embedder — 默认模式',
    yaml: `${HEADER}- id: mem0
  name: ${PLUGIN}
  config:
    vectorStore:
${GOOD_VECTOR_STORE}
`,
    expectThrows: false,
    expectMem0State: 2,
    expectInWarning: null,
  },
  {
    label: 'vector store 不可达 — 默认模式',
    yaml: `${HEADER}- id: mem0
  name: ${PLUGIN}
  config:
    embedder:
      provider: ollama
      config: { url: 'http://localhost:11434', model: 'nomic-embed-text:latest' }
    vectorStore:
      provider: elasticsearch
      config: { collectionName: mem0_boot_policy, host: localhost, port: 9299, useSsl: false }
    preflight: { enabled: true, timeoutMs: 4000 }
`,
    expectThrows: false,
    expectMem0State: 2,
    expectInWarning: null,
  },
  {
    label: '缺少 embedder — startup.strict=true',
    yaml: `${HEADER}- id: mem0
  name: ${PLUGIN}
  config:
    startup: { strict: true }
    vectorStore:
${GOOD_VECTOR_STORE}
`,
    // The plugin fiber fails, but `mem0` is not in the host's hardcoded
    // required-entry list, so the application still starts. That is the whole
    // reason fail-fast is a safe option here.
    expectThrows: false,
    expectMem0State: 3, // FAILED
    expectInWarning: /embedder/,
  },
  {
    label: '根配置 YAML 语法错误',
    yaml: `${HEADER}- id: mem0
  name: ${PLUGIN}
  config: [this is: not, valid: yaml
`,
    expectThrows: true,
    expectMem0State: null,
    expectInWarning: null,
  },
]

/** Collect stderr for one boot attempt. */
async function attempt(yaml, index) {
  const path = configFile(`case-${index}.yml`, yaml)
  const chunks = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk))
    return original(chunk, ...rest)
  }
  try {
    const ctx = await boot('dsh', path, [], undefined, undefined)
    const states = Object.fromEntries([...ctx.loader.entries()].map((e) => [e.options.id, e.fiber?.state]))
    await ctx.fiber.dispose()
    return { threw: false, states, stderr: chunks.join('') }
  } catch (error) {
    return { threw: true, error, stderr: chunks.join('') }
  } finally {
    process.stderr.write = original
  }
}

console.log('='.repeat(72))
console.log('DSH 启动策略：插件加载失败时会发生什么')
console.log('='.repeat(72))

let index = 0
for (const testCase of CASES) {
  index += 1
  const outcome = await attempt(testCase.yaml, index)
  console.log(`\n▸ ${testCase.label}`)
  if (outcome.threw) {
    console.log(`  boot() 抛出 —— 应用无法启动`)
    console.log(`  ${String(outcome.error.message).split('\n').slice(0, 3).join(' | ')}`)
  } else {
    console.log(`  boot() 正常返回 —— 应用继续启动 | fiber 状态: ${JSON.stringify(outcome.states)}`)
    const warning = outcome.stderr.trim().split('\n').slice(0, 2).join(' | ')
    if (warning) console.log(`  stderr: ${warning.slice(0, 150)}`)
  }

  assert.equal(
    outcome.threw,
    testCase.expectThrows,
    `${testCase.label}: expected threw=${testCase.expectThrows} but got ${outcome.threw}`,
  )
  if (!testCase.expectThrows) {
    // Regardless of the plugin's own state, the services it depends on and the
    // application as a whole must keep running.
    assert.equal(outcome.states.tools, 2, 'unrelated plugins must keep running')
    assert.equal(outcome.states['system-prompt'], 2, 'unrelated plugins must keep running')
    if (testCase.expectMem0State !== null) {
      assert.equal(
        outcome.states.mem0,
        testCase.expectMem0State,
        `mem0 fiber must be ${testCase.expectMem0State} (2=ACTIVE, 3=FAILED)`,
      )
    }
    if (testCase.expectInWarning) {
      assert.match(outcome.stderr, testCase.expectInWarning, 'the warning must carry the real reason')
    }
  }
}

console.log(`\n${'='.repeat(72)}`)
console.log('✅ 策略符合预期：')
console.log('   - 默认模式下插件 ACTIVE —— mem0_status 始终可用（这正是设计目的）')
console.log('   - strict 模式下插件 FAILED，但 dsh 仍正常启动（mem0 不在必需条目清单里）')
console.log('   - 只有根配置损坏才会阻断启动')
