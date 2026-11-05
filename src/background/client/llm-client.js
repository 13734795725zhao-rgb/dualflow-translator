import { SYS_DEFAULTS } from '../../shared/constants.js';
import { buildEndpointUrl, maskUrlSecrets } from '../../shared/providers.js';

/**
 * 翻译引擎系统提示词（强约束结构化输出）
 */
export const SYSTEM_PROMPT = `你是一个专业的高质量网页双语对照翻译引擎。
你的目标是将用户提供的外文文本准确、流畅地翻译为【简体中文】。

必须严格遵守以下规则：
1. 无论原文包含何种语言（英文、日文、俄文、韩文、法文、德文、西班牙文、阿拉伯文等），统统翻译为【简体中文】。
2. 保持专业术语、代码块、专有名词准确；专有名词可保留英文原文。
3. 原文中的 HTML 实体、变量占位符、Markdown 链接必须原样保留。
4. 如果某一条目本身已是中文，请在该条目的 "t" 字段中返回空字符串 "" 或 "[SKIP]"，严禁复述或无意义改写。
5. 必须严格以标准 JSON 数组输出： [{"id": 序列号, "t": "翻译后的中文"}]，不要输出任何额外说明。
6. 严禁输出 Markdown 代码块标记（不要写 \`\`\`json）。`;

/**
 * 构造 OpenAI 兼容协议请求体
 */
function buildOpenAIBody(items, model) {
  const inputPayload = items.map((i) => ({ id: i.seqId, s: i.text }));
  return {
    model: model.model_name,
    temperature: model.temperature ?? 0.3,
    max_tokens: model.max_tokens ?? 2048,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(inputPayload) },
    ],
  };
}

/**
 * 生成请求所需的 URL / Headers / Body
 * 统一走 buildEndpointUrl，避免出现 /v1 缺失或 /chat/completions 重复拼接
 */
function buildRequest(provider, model, items, { probe = false } = {}) {
  const protocol = provider.protocol || 'openai';
  const endpoint = buildEndpointUrl(provider, model);
  const customHeaders = provider.custom_headers || {};

  if (protocol === 'anthropic') {
    const inputPayload = items.map((i) => ({ id: i.seqId, s: i.text }));
    const body = {
      model: model.model_name,
      max_tokens: probe ? 8 : model.max_tokens ?? 2048,
      temperature: model.temperature ?? 0.3,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: probe ? 'ping' : JSON.stringify(inputPayload),
        },
      ],
    };
    return {
      url: endpoint,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': provider.api_key,
        'anthropic-version': '2023-06-01',
        ...customHeaders,
      },
      body,
    };
  }

  if (protocol === 'gemini') {
    const inputPayload = items.map((i) => ({ id: i.seqId, s: i.text }));
    const userText = probe
      ? 'ping'
      : `${SYSTEM_PROMPT}\n\n待翻译内容：\n${JSON.stringify(inputPayload)}`;
    const body = {
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        temperature: model.temperature ?? 0.3,
        maxOutputTokens: probe ? 8 : model.max_tokens ?? 2048,
      },
    };
    return {
      url: endpoint,
      headers: { 'Content-Type': 'application/json', ...customHeaders },
      body,
    };
  }

  // 默认：OpenAI 兼容协议
  const body = probe
    ? { model: model.model_name, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5 }
    : buildOpenAIBody(items, model);

  return {
    url: endpoint,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.api_key}`,
      ...customHeaders,
    },
    body,
  };
}

/**
 * HTTP 状态码 → 可执行的中文排查提示
 * 排查指引见 README「排障速查表」
 */
export function describeHttpError(status, body) {
  const snippet = String(body || '')
    .slice(0, 200)
    .replace(/\s+/g, ' ')
    .trim();
  const hints = {
    400: '请求被拒绝（400），请检查模型名是否正确、max_tokens 是否超出上限',
    401: 'API Key 无效或未授权（401），请检查密钥是否填错/过期',
    403: '密钥无该模型权限或被风控拦截（403），请确认账号套餐与模型授权',
    404: '端点路径不存在（404），请检查 Base URL 是否缺少 /v1，或是否重复拼接了 /chat/completions',
    408: '请求超时',
    413: '请求体过大（413），请调小「单批段落数 / 单批字符预算」',
    429: '触发限流（429），系统会自动退避重试',
    500: '服务商内部错误（500），稍后重试',
    502: '网关错误（502），服务商暂时不可用',
    503: '服务繁忙（503），系统会自动退避重试',
  };
  const hint = hints[status] || '请求失败';
  return `HTTP ${status}：${hint}${snippet ? `｜响应：${snippet}` : ''}`;
}

/**
 * 从各协议响应体中提取模型文本
 */
function extractContent(protocol, json) {
  if (protocol === 'anthropic') {
    if (Array.isArray(json?.content)) {
      return json.content
        .filter((part) => part?.type === 'text' || typeof part?.text === 'string')
        .map((part) => part.text || '')
        .join('');
    }
    return '';
  }
  if (protocol === 'gemini') {
    const parts = json?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) return parts.map((p) => p?.text || '').join('');
    return '';
  }
  const choice = json?.choices?.[0];
  if (!choice) return '';
  if (typeof choice.message?.content === 'string' && choice.message.content.trim()) {
    return choice.message.content;
  }
  // 部分中转站返回 content 数组
  if (Array.isArray(choice.message?.content)) {
    const joined = choice.message.content.map((p) => p?.text || '').join('');
    if (joined.trim()) return joined;
  }
  // 推理型模型（deepseek-reasoner 等）可能把正文放进 reasoning_content
  if (typeof choice.message?.reasoning_content === 'string' && choice.message.reasoning_content.trim()) {
    return choice.message.reasoning_content;
  }
  if (typeof choice.text === 'string') return choice.text;
  return '';
}

/** 提取 finish_reason（判断是否被 max_tokens 截断） */
export function extractFinishReason(protocol, json) {
  if (protocol === 'anthropic') return json?.stop_reason || '';
  if (protocol === 'gemini') return json?.candidates?.[0]?.finishReason || '';
  return json?.choices?.[0]?.finish_reason || '';
}

/**
 * 修复被截断的 JSON 数组：补齐未闭合的字符串与括号
 */
export function repairTruncatedArray(fragment) {
  let repaired = fragment.replace(/,\s*$/, '').trimEnd();

  // 统计未转义引号数量，若为奇数说明字符串未闭合
  let quoteCount = 0;
  for (let i = 0; i < repaired.length; i += 1) {
    if (repaired[i] === '"' && repaired[i - 1] !== '\\') quoteCount += 1;
  }
  if (quoteCount % 2 === 1) repaired += '"';

  // 统计未闭合的括号，按栈序补齐 '}' 与 ']'
  const stack = [];
  let inString = false;
  for (let i = 0; i < repaired.length; i += 1) {
    const ch = repaired[i];
    if (inString) {
      if (ch === '"' && repaired[i - 1] !== '\\') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }

  let suffix = '';
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    suffix += stack[i] === '{' ? '}' : ']';
  }

  repaired = repaired.replace(/,\s*$/, '') + suffix;
  return repaired;
}

/**
 * 容错解析大模型返回的 JSON 数组：
 * 1. 剥离 Markdown 围栏
 * 2. 提取最外层 [ ... ]
 * 3. JSON.parse 失败时尝试闭合修复
 * 4. 仍失败则用正则逐条兜底抽取
 */
export function parseAndSanitizeJSON(raw) {
  const resultMap = new Map();
  if (!raw || typeof raw !== 'string') return resultMap;

  let text = raw.trim();
  text = text.replace(/^```(?:json|JSON)?\s*/, '').replace(/\s*```$/, '');
  text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  const candidates = [];

  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1));
  } else if (start >= 0) {
    // 数组被截断（无闭合括号）
    candidates.push(repairTruncatedArray(text.slice(start)));
  } else {
    // 退化为对象包裹数组的情况：{"results":[...]}
    const objStart = text.indexOf('{');
    const objEnd = text.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
      candidates.push(text.slice(objStart, objEnd + 1));
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.results)
          ? parsed.results
          : Array.isArray(parsed?.translations)
            ? parsed.translations
            : null;
      if (!list) continue;
      for (const item of list) {
        const id = Number(item?.id);
        const value =
          typeof item?.t === 'string'
            ? item.t
            : typeof item?.text === 'string'
              ? item.text
              : typeof item?.translation === 'string'
                ? item.translation
                : '';
        if (!Number.isNaN(id) && value) resultMap.set(id, value);
      }
      if (resultMap.size > 0) return resultMap;
    } catch (_) {
      /* 继续尝试下一个候选 */
    }
  }

  // 最终兜底：正则逐条抽取 {"id": n, "t": "..."}
  const pairRegex = /\{\s*"id"\s*:\s*(\d+)\s*,\s*"(?:t|text|translation)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = pairRegex.exec(text)) !== null) {
    const id = Number(match[1]);
    let value = match[2];
    try {
      value = JSON.parse(`"${value}"`);
    } catch (_) {
      /* 保留原始内容 */
    }
    if (!Number.isNaN(id) && value) resultMap.set(id, value);
  }

  return resultMap;
}

/**
 * 执行一次大模型调用
 */
async function requestCompletion(provider, model, items, { probe = false, timeoutMs } = {}) {
  const protocol = provider.protocol || 'openai';
  const { url, headers, body } = buildRequest(provider, model, items, { probe });
  const limit = timeoutMs || SYS_DEFAULTS.API_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);

  // 排查第 2 步：打印实际请求的完整 URL（凭据已脱敏）
  console.log(
    `[DualFlow] 实际请求的完整 URL: ${maskUrlSecrets(url)}`,
    `| 协议=${protocol} | 模型=${model?.model_name || '-'}${probe ? ' | Ping 探针' : ''}`,
  );

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const error = new Error(describeHttpError(response.status, errorText));
      error.status = response.status;
      error.rawBody = errorText.slice(0, 300);
      error.endpoint = maskUrlSecrets(url);
      throw error;
    }

    const json = await response.json();
    const rawContent = extractContent(protocol, json) || '';
    const finishReason = extractFinishReason(protocol, json);

    // 响应摘要日志：真实批量请求失败时，用它一眼看出是空响应、截断还是格式问题
    console.log(
      `[DualFlow] 响应摘要: finish_reason=${finishReason || 'n/a'} | contentLen=${rawContent.length}` +
        ` | tokens=${json?.usage?.total_tokens ?? 'n/a'} | 首段=${JSON.stringify(rawContent.slice(0, 120))}`,
    );

    return { rawContent, usage: json?.usage || null, finishReason, contentLength: rawContent.length };
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`API 请求超时 (${limit}ms)｜端点：${maskUrlSecrets(url)}`);
      timeoutError.name = 'TimeoutError';
      timeoutError.status = 408;
      timeoutError.endpoint = maskUrlSecrets(url);
      throw timeoutError;
    }
    // 网络层失败（CORS / DNS / 证书 / 断网）——在 Service Worker 中发生，多为端点域名或权限问题
    if (!error?.status) {
      error.message = `网络请求失败：${error?.message || 'unknown'}｜端点：${maskUrlSecrets(url)}`;
      error.endpoint = maskUrlSecrets(url);
    }
    console.error('[DualFlow] 请求失败：', error.message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 批量翻译主入口
 * @returns {Promise<{rawContent:string, usage:object|null}>}
 */
export async function translateBatch(items, provider, model) {
  return requestCompletion(provider, model, items, { probe: false });
}

/**
 * 连通性探测
 */
export async function pingModelEndpoint(provider, model) {
  const startTime = Date.now();
  try {
    const { rawContent } = await requestCompletion(provider, model, [{ seqId: 1, text: 'ping' }], {
      probe: true,
      timeoutMs: SYS_DEFAULTS.PING_TIMEOUT_MS,
    });
    return {
      success: true,
      latencyMs: Date.now() - startTime,
      sample: rawContent.slice(0, 40),
    };
  } catch (error) {
    return {
      success: false,
      latencyMs: Date.now() - startTime,
      errorMessage: sanitizeErrorMessage(error?.message || '连接失败'),
    };
  }
}

/**
 * 错误信息脱敏（剥离 Bearer / sk- 形式密钥）
 */
export function sanitizeErrorMessage(message) {
  if (!message) return '未知错误';
  return String(message)
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ••••••••')
    .replace(/sk-[A-Za-z0-9._\-]{8,}/g, 'sk-••••••••')
    .replace(/key=[A-Za-z0-9._\-]+/gi, 'key=••••••••')
    .slice(0, 300);
}
