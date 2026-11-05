/**
 * DualFlow Translator — 后台调度管道模拟联调测试
 * 用最小化的 chrome API mock + fetch mock 驱动完整的批处理流水线：
 *   存储读取 -> 激活模型 -> 分块 -> HTTP 请求 -> JSON 解析 -> 结果回填
 */
import { buildDefaultSchema } from '../src/shared/storage/migration.js';

let failures = 0;
function ok(label) {
  console.log(`  [PASS] ${label}`);
}
function fail(label, detail) {
  failures += 1;
  console.log(`  [FAIL] ${label}${detail ? ` -> ${detail}` : ''}`);
}

/* ---------------- chrome API mock ---------------- */
const store = buildDefaultSchema();
store.providers[store.settings.active_model_id ? 'provider_deepseek_default' : ''].api_key = 'sk-test-key-123456';
const providerId = Object.keys(store.providers)[0];
const modelId = Object.keys(store.models)[0];
store.models[modelId].model_name = 'deepseek-chat';

const storageListeners = [];
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null || keys === undefined) return JSON.parse(JSON.stringify(store));
        const out = {};
        for (const key of [].concat(keys)) {
          if (key in store) out[key] = JSON.parse(JSON.stringify(store[key]));
        }
        return out;
      },
      async set(patch) {
        // 模拟 Chrome 的 storage.onChanged 语义：{key: {oldValue, newValue}}
        const changes = {};
        for (const [key, newValue] of Object.entries(patch || {})) {
          changes[key] = { oldValue: store[key], newValue };
        }
        Object.assign(store, JSON.parse(JSON.stringify(patch)));
        for (const listener of storageListeners) listener(changes, 'local');
      },
    },
    onChanged: {
      addListener(fn) {
        storageListeners.push(fn);
      },
    },
  },
  runtime: {
    onConnect: { addListener() {} },
    onMessage: { addListener() {} },
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    sendMessage: async () => ({ ok: true }),
  },
  commands: { onCommand: { addListener() {} } },
  tabs: { query: async () => [], sendMessage: async () => ({}) },
};

/* ---------------- fetch mock ---------------- */
const requests = [];
globalThis.fetch = async (url, options) => {
  requests.push({ url, options });
  const raw = (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)).replace(/\\"/g, '"');
  const ids = [...raw.matchAll(/"id"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  const content = JSON.stringify(ids.map((id) => ({ id, t: `译文-${id}` })));

  const makeJson = () => {
    if (url.includes('/messages')) {
      return { content: [{ type: 'text', text: content }], usage: { input_tokens: 8, output_tokens: 4 } };
    }
    if (url.includes(':generateContent')) {
      return { candidates: [{ content: { parts: [{ text: content }] } }] };
    }
    return { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  };

  return {
    ok: true,
    status: 200,
    async json() {
      return makeJson();
    },
  };
};

/* ---------------- 载入后台模块 ---------------- */
const background = await import('../src/background/index.js');
// 等待存储迁移完成，避免与后续测试写入的配置互相覆盖
await background.bootstrap();
const { splitIntoChunks } = await import('../src/background/pipeline/chunker.js');

console.log('\n[mock] 存储与模型上下文');
const { storageClient } = await import('../src/shared/storage/storage-client.js');
await storageClient.init();
const context = storageClient.getActiveModelContext();
if (context && context.model.model_name === 'deepseek-chat') ok('激活模型上下文解析正确');
else fail('激活模型上下文解析', JSON.stringify(context));

console.log('\n[mock] 批处理切片');
const chunked = splitIntoChunks(
  Array.from({ length: 10 }, (_, i) => ({ seqId: i + 1, text: 'x'.repeat(300) })),
  6,
  1800,
);
if (chunked.length >= 2) ok(`10 段被切分为 ${chunked.length} 块`);
else fail('批处理切片', `得到 ${chunked.length} 块`);

console.log('\n[mock] HTTP 请求装配（OpenAI 兼容协议）');
const { translateBatch } = await import('../src/background/client/llm-client.js');
const { rawContent } = await translateBatch(
  [{ seqId: 1, text: 'Hello world' }],
  context.provider,
  context.model,
);
const parsed = JSON.parse(rawContent);
if (parsed[0].t === '译文-1') ok('请求装配与响应提取正常');
else fail('请求装配', rawContent);

const lastRequest = requests[requests.length - 1];
if (lastRequest.url.endsWith('/chat/completions')) ok(`端点拼接正确：${lastRequest.url}`);
else fail('端点拼接', lastRequest.url);

if (lastRequest.options.headers.Authorization === 'Bearer sk-test-key-123456') ok('鉴权头正确');
else fail('鉴权头', JSON.stringify(lastRequest.options.headers));

if (lastRequest.options.signal) ok('请求携带 AbortSignal（可超时熔断）');
else fail('请求缺少 AbortSignal');

const systemPrompt = JSON.parse(lastRequest.options.body).messages[0].content;
if (systemPrompt.includes('简体中文') && systemPrompt.includes('JSON')) ok('系统提示词约束正确');
else fail('系统提示词', systemPrompt.slice(0, 60));

console.log('\n[mock] 多协议请求装配');
const protocolCases = [
  {
    protocol: 'anthropic',
    base_url: 'https://api.anthropic.com/v1',
    api_key: 'sk-ant-123456',
    expectUrl: 'https://api.anthropic.com/v1/messages',
    expectHeader: 'x-api-key',
  },
  {
    protocol: 'gemini',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    api_key: 'AIzaTestKey123456',
    expectUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=AIzaTestKey123456',
    expectHeader: null,
  },
];

for (const testCase of protocolCases) {
  const provider = {
    provider_id: 'p_test',
    name: 'test',
    base_url: testCase.base_url,
    api_key: testCase.api_key,
    protocol: testCase.protocol,
    custom_headers: {},
  };
  const model = {
    model_id: 'm_test',
    provider_ref: 'p_test',
    model_name: testCase.protocol === 'gemini' ? 'gemini-2.0-flash' : 'claude-3-5-haiku-latest',
    display_label: 'test',
    max_tokens: 1024,
    temperature: 0.3,
    concurrency: 1,
    is_enabled: true,
  };
  const before = requests.length;
  await translateBatch([{ seqId: 42, text: 'Hello world' }], provider, model);
  const req = requests[before];
  if (req.url === testCase.expectUrl) ok(`${testCase.protocol} 端点正确`);
  else fail(`${testCase.protocol} 端点`, req.url);

  if (testCase.expectHeader) {
    if (req.options.headers[testCase.expectHeader] === testCase.api_key) ok(`${testCase.protocol} 鉴权头正确`);
    else fail(`${testCase.protocol} 鉴权头`, JSON.stringify(req.options.headers));
  } else {
    if (req.url.includes('key=')) ok(`${testCase.protocol} 使用 key 查询参数传参`);
    else fail(`${testCase.protocol} key 参数缺失`, req.url);
  }
}

console.log('\n[mock] 端点拼接矩阵（排查第 2 步 · Base URL 拼接）');
const { buildEndpointUrl, describeEndpoint } = await import('../src/shared/providers.js');
const endpointCases = [
  {
    label: '只填域名 → 自动补 /v1',
    provider: { base_url: 'https://api.deepseek.com', protocol: 'openai' },
    model: { model_name: 'deepseek-chat' },
    expect: 'https://api.deepseek.com/v1/chat/completions',
  },
  {
    label: '已带 /v1 → 不重复追加',
    provider: { base_url: 'https://api.deepseek.com/v1', protocol: 'openai' },
    model: { model_name: 'deepseek-chat' },
    expect: 'https://api.deepseek.com/v1/chat/completions',
  },
  {
    label: '已带完整路径 → 绝不二次拼接',
    provider: { base_url: 'https://api.deepseek.com/v1/chat/completions', protocol: 'openai' },
    model: { model_name: 'deepseek-chat' },
    expect: 'https://api.deepseek.com/v1/chat/completions',
  },
  {
    label: '自定义网关路径原样保留',
    provider: { base_url: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai' },
    model: { model_name: 'glm-4-flash' },
    expect: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  },
  {
    label: '完整端点覆盖优先于自动拼接',
    provider: {
      base_url: 'https://gw.corp.com',
      endpoint_override: 'https://gw.corp.com/llm/v2/generate',
      protocol: 'openai',
    },
    model: { model_name: 'x' },
    expect: 'https://gw.corp.com/llm/v2/generate',
  },
  {
    label: 'Anthropic 原生协议',
    provider: { base_url: 'https://api.anthropic.com', protocol: 'anthropic' },
    model: { model_name: 'claude-3-5-haiku-latest' },
    expect: 'https://api.anthropic.com/v1/messages',
  },
  {
    label: 'Gemini 原生协议 + key 脱敏',
    provider: { base_url: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini', api_key: 'AIzaSecretKey' },
    model: { model_name: 'gemini-2.0-flash' },
    expect:
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=***',
    mask: true,
  },
];

for (const testCase of endpointCases) {
  const actual = testCase.mask
    ? describeEndpoint(testCase.provider, testCase.model)
    : buildEndpointUrl(testCase.provider, testCase.model);
  if (actual === testCase.expect) ok(testCase.label);
  else fail(testCase.label, `期望 ${testCase.expect}，实际 ${actual}`);
}

console.log('\n[mock] 端到端流水线（后台真实函数 + fetch mock）');
const { processBatchRequest } = background;
const pipelineResult = await processBatchRequest([{ seqId: 11, text: 'Hello world' }], 'trace_mock');
if (pipelineResult.results?.[0]?.translatedText === '译文-11') ok('批量翻译结果正确回填');
else fail('批量翻译结果', JSON.stringify(pipelineResult.results));

console.log('\n[mock] 存量安装升级（1.0.0 → 1.0.1）');
const { runStorageMigration } = await import('../src/shared/storage/migration.js');
const legacyStore = {
  schema_version: 1,
  providers: {
    p_legacy: {
      provider_id: 'p_legacy',
      name: '我的 DeepSeek',
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'sk-existing-user-key',
      protocol: 'openai',
      custom_headers: {},
      created_at: 1,
      updated_at: 1,
    },
  },
  models: {
    m_legacy: {
      model_id: 'm_legacy',
      provider_ref: 'p_legacy',
      model_name: 'deepseek-chat',
      display_label: 'DeepSeek-V3',
      max_tokens: 2048,
      temperature: 0.3,
      concurrency: 3,
      is_enabled: true,
    },
  },
  rules: {},
  settings: {
    active_model_id: 'm_legacy',
    cjk_threshold: 0.7,
    batch_size: 6,
    batch_token_budget: 1800,
    auto_translate: false,
    target_language: 'zh-CN',
    theme_mode: 'system',
    custom_css: '',
  },
};
for (const key of Object.keys(store)) delete store[key];
Object.assign(store, JSON.parse(JSON.stringify(legacyStore)));

await runStorageMigration();

if (store.settings.mock_mode === undefined) ok('已下线的 mock_mode 字段被清理干净');
else fail('mock_mode 清理', JSON.stringify(store.settings.mock_mode));

if (store.providers.p_legacy.endpoint_override === '') ok('新增供应商字段 endpoint_override 已补齐');
else fail('endpoint_override 迁移', JSON.stringify(store.providers.p_legacy.endpoint_override));

if (store.providers.p_legacy.api_key === 'sk-existing-user-key') ok('存量 API Key 未被覆盖');
else fail('API Key 丢失', JSON.stringify(store.providers.p_legacy.api_key));

if (store.settings.translate_mode === 'manual') ok('存量安装已补齐 translate_mode = manual（常驻模式默认手动）');
else fail('translate_mode 迁移', String(store.settings.translate_mode));

if (store.settings.active_model_id === 'm_legacy' && store.models.m_legacy) ok('模型与激活项保持不变');
else fail('模型配置丢失', JSON.stringify(store.settings.active_model_id));

console.log('\n[mock] 一键自检');
const { runSelfCheck } = background;
const selfCheck = await runSelfCheck();
const selfCheckNames = selfCheck.checks.map((c) => c.name);
if (selfCheckNames.includes('模型配置') && selfCheckNames.includes('端点拼接') && selfCheckNames.includes('连通性（Ping）')) {
  ok(`自检覆盖 ${selfCheck.checks.length} 项：${selfCheckNames.join(' / ')}`);
} else {
  fail('自检项目不完整', selfCheckNames.join(', '));
}
const pingCheck = selfCheck.checks.find((c) => c.name.startsWith('连通性'));
if (pingCheck?.ok) ok(`Ping 连通成功（${pingCheck.detail}）`);
else fail('Ping 连通失败', pingCheck?.detail);
const parseCheck = selfCheck.checks.find((c) => c.name === '结果解析');
if (parseCheck?.ok) ok('解析链路正常');
else fail('解析链路', parseCheck?.detail);

console.log('\n[mock] 截断输出 → 二分拆批自愈');
const originalFetch = globalThis.fetch;
let truncateMode = false;
globalThis.fetch = async (url, options) => {
  if (!truncateMode) return originalFetch(url, options);
  const raw = (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)).replace(/\\"/g, '"');
  const ids = [...raw.matchAll(/"id"\s*:\s*(\d+)/g)].map((m) => Number(m[1]));
  // 模拟：只返回第一条 + 被截断的 JSON（finish_reason=length）
  const payload = ids.length > 1
    ? `[{"id":${ids[0]},"t":"译文-${ids[0]}"}`
    : `[{"id":${ids[0]},"t":"译文-${ids[0]}"}]`;
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content: payload }, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    },
  };
};

truncateMode = true;
const truncatedResult = await processBatchRequest(
  [
    { seqId: 31, text: 'AAA' },
    { seqId: 32, text: 'BBB' },
    { seqId: 33, text: 'CCC' },
    { seqId: 34, text: 'DDD' },
  ],
  'trace_trunc',
);
truncateMode = false;
globalThis.fetch = originalFetch;

const translated = truncatedResult.results.filter((r) => r.translatedText);
if (translated.length === 4) ok('截断批次经二分重发后全部翻译成功');
else fail('二分重发自愈', `仅 ${translated.length}/4 条成功：${JSON.stringify(truncatedResult.results)}`);

console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);

