/**
 * DualFlow Translator — API 供应商预设模板
 * 全部基于 OpenAI 兼容协议（/chat/completions），另含 Anthropic / Gemini 原生协议适配。
 * protocol: 'openai' | 'anthropic' | 'gemini'
 */

export const PROVIDER_PRESETS = [
  {
    key: 'deepseek',
    label: 'DeepSeek 官方',
    protocol: 'openai',
    base_url: 'https://api.deepseek.com/v1',
    models: [
      { model_name: 'deepseek-chat', display_label: 'DeepSeek-V3 (通用)' },
      { model_name: 'deepseek-reasoner', display_label: 'DeepSeek-R1 (推理)' },
    ],
  },
  {
    key: 'openai',
    label: 'OpenAI 官方',
    protocol: 'openai',
    base_url: 'https://api.openai.com/v1',
    models: [
      { model_name: 'gpt-4o-mini', display_label: 'GPT-4o mini' },
      { model_name: 'gpt-4o', display_label: 'GPT-4o' },
    ],
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    protocol: 'gemini',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    models: [
      { model_name: 'gemini-2.0-flash', display_label: 'Gemini 2.0 Flash' },
      { model_name: 'gemini-2.5-flash', display_label: 'Gemini 2.5 Flash' },
    ],
  },
  {
    key: 'claude',
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    base_url: 'https://api.anthropic.com/v1',
    models: [
      { model_name: 'claude-3-5-haiku-latest', display_label: 'Claude 3.5 Haiku' },
      { model_name: 'claude-3-7-sonnet-latest', display_label: 'Claude 3.7 Sonnet' },
    ],
  },
  {
    key: 'siliconflow',
    label: 'SiliconFlow 硅基流动',
    protocol: 'openai',
    base_url: 'https://api.siliconflow.cn/v1',
    models: [
      { model_name: 'Qwen/Qwen2.5-7B-Instruct', display_label: 'Qwen2.5-7B-Instruct' },
      { model_name: 'deepseek-ai/DeepSeek-V3', display_label: 'DeepSeek-V3' },
    ],
  },
  {
    key: 'moonshot',
    label: 'Moonshot / Kimi',
    protocol: 'openai',
    base_url: 'https://api.moonshot.cn/v1',
    models: [
      { model_name: 'moonshot-v1-8k', display_label: 'Moonshot v1 8K' },
      { model_name: 'kimi-k2-0711-preview', display_label: 'Kimi K2' },
    ],
  },
  {
    key: 'qwen',
    label: '阿里云百炼 / 通义千问',
    protocol: 'openai',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [{ model_name: 'qwen-plus', display_label: 'Qwen Plus' }],
  },
  {
    key: 'zhipu',
    label: '智谱 GLM',
    protocol: 'openai',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    models: [{ model_name: 'glm-4-flash', display_label: 'GLM-4-Flash' }],
  },
  {
    key: 'ollama',
    label: 'Ollama 本地模型',
    protocol: 'openai',
    base_url: 'http://127.0.0.1:11434/v1',
    models: [{ model_name: 'qwen2.5:7b', display_label: 'Qwen2.5 7B (本地)' }],
  },
  {
    key: 'lmstudio',
    label: 'LM Studio 本地服务',
    protocol: 'openai',
    base_url: 'http://127.0.0.1:1234/v1',
    models: [{ model_name: 'local-model', display_label: '本地模型' }],
  },
  {
    key: 'custom',
    label: '自定义兼容端点',
    protocol: 'openai',
    base_url: '',
    models: [{ model_name: '', display_label: '自定义模型' }],
  },
];

/** 生成短 id */
export function shortId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 掩码显示 API Key */
export function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 10) return `${key.slice(0, 2)}••••••`;
  return `${key.slice(0, 6)}••••••••${key.slice(-4)}`;
}

/** 归一化 Base URL：仅去除首尾空白与末尾斜杠（不吞掉完整端点路径，由 buildEndpointUrl 判定） */
export function normalizeBaseUrl(raw) {
  if (!raw) return '';
  let url = String(raw).trim();
  url = url.replace(/\/+$/, '');
  return url;
}

/** 取出 URL 的路径部分（无路径时返回空串） */
export function getUrlPath(raw) {
  try {
    const url = new URL(String(raw).trim());
    return url.pathname.replace(/\/+$/, '');
  } catch (_) {
    return '';
  }
}

/** 掩码 URL 中的敏感查询参数（key / token / access_token） */
export function maskUrlSecrets(raw) {
  if (!raw) return '';
  return String(raw).replace(/([?&](?:key|token|access_token|api_key)=)([^&]+)/gi, (match, prefix) => `${prefix}***`);
}

/**
 * 智能拼接「实际请求的完整 URL」
 *
 * 解决的经典翻车点：
 * 1. Base URL 只填了域名（https://api.deepseek.com）→ 自动补 /v1（OpenAI/Anthropic）或 /v1beta（Gemini）；
 * 2. Base URL 已经带了完整路径（.../v1/chat/completions）→ 原样使用，绝不重复拼接；
 * 3. 自建网关路径不规则 → 使用供应商配置里的「完整端点覆盖」字段强制指定。
 *
 * @param {Object} provider
 * @param {Object} model
 * @returns {string}
 */
export function buildEndpointUrl(provider, model) {
  const protocol = provider?.protocol || 'openai';
  const override = String(provider?.endpoint_override || '').trim();
  if (override) {
    return /^https?:\/\//i.test(override) ? override : `https://${override}`;
  }

  const base = normalizeBaseUrl(provider?.base_url);
  const path = getUrlPath(base);
  const lower = base.toLowerCase();

  if (protocol === 'gemini') {
    if (lower.includes(':generatecontent')) return base;
    const root = path ? base : `${base}/v1beta`;
    const modelName = model?.model_name || '';
    return `${root}/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(
      provider?.api_key || '',
    )}`;
  }

  if (protocol === 'anthropic') {
    if (lower.endsWith('/messages')) return base;
    const root = path ? base : `${base}/v1`;
    return `${root}/messages`;
  }

  // OpenAI 兼容协议
  if (lower.endsWith('/chat/completions') || lower.endsWith('/completions')) return base;
  const root = path ? base : `${base}/v1`;
  return `${root}/chat/completions`;
}

/** 供 UI 展示的脱敏端点 */
export function describeEndpoint(provider, model) {
  return maskUrlSecrets(buildEndpointUrl(provider, model));
}

/** Base URL 合法性校验 */
export function validateBaseUrl(raw) {
  const value = normalizeBaseUrl(raw);
  if (!value) return { valid: false, message: '请填写 API 端点' };
  if (!/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(value)) {
    return { valid: false, message: '端点格式非法，需形如 https://api.example.com/v1' };
  }
  return { valid: true, value };
}
