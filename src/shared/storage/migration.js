import { SYS_DEFAULTS } from '../constants.js';
import { shortId } from '../providers.js';

/**
 * 出厂预设：首次安装时写入一套可直接填 Key 使用的 DeepSeek 配置。
 */
export function buildDefaultSchema() {
  const providerId = 'provider_deepseek_default';
  const modelId = 'model_deepseek_chat_default';
  const now = Date.now();

  const defaultProvider = {
    provider_id: providerId,
    name: 'DeepSeek (Official)',
    base_url: 'https://api.deepseek.com/v1',
    api_key: '',
    protocol: 'openai',
    endpoint_override: '',
    custom_headers: {},
    created_at: now,
    updated_at: now,
  };

  const defaultModel = {
    model_id: modelId,
    provider_ref: providerId,
    model_name: 'deepseek-chat',
    display_label: 'DeepSeek-V3',
    max_tokens: 2048,
    temperature: 0.3,
    concurrency: SYS_DEFAULTS.CONCURRENCY_LIMIT,
    is_enabled: true,
  };

  return {
    schema_version: SYS_DEFAULTS.SCHEMA_VERSION,
    providers: { [providerId]: defaultProvider },
    models: { [modelId]: defaultModel },
    rules: {},
    settings: {
      active_model_id: modelId,
      cjk_threshold: SYS_DEFAULTS.CJK_THRESHOLD,
      batch_size: SYS_DEFAULTS.BATCH_SIZE,
      batch_token_budget: SYS_DEFAULTS.BATCH_TOKEN_BUDGET,
      // 常驻翻译模式：manual（手动）/ always_on（所有页面自动译）/ always_off（都不自动译）
      translate_mode: SYS_DEFAULTS.TRANSLATE_MODE,
      // 旧版布尔开关，保留兼容：translate_mode 缺失时按它判断
      auto_translate: false,
      target_language: 'zh-CN',
      theme_mode: 'system',
      custom_css: '',
    },
  };
}

/**
 * 版本迁移核验与缺字段补丁。
 */
export async function runStorageMigration() {
  const rawData = await chrome.storage.local.get(null);
  if (!rawData || Object.keys(rawData).length === 0 || !rawData.schema_version) {
    await chrome.storage.local.set(buildDefaultSchema());
    return;
  }

  const current = rawData;
  let mutated = false;

  if (!current.providers) {
    current.providers = {};
    mutated = true;
  }
  if (!current.models) {
    current.models = {};
    mutated = true;
  }
  if (!current.rules) {
    current.rules = {};
    mutated = true;
  }

  // 供应商字段补丁：新增 endpoint_override（完整端点覆盖）
  for (const provider of Object.values(current.providers || {})) {
    if (provider && provider.endpoint_override === undefined) {
      provider.endpoint_override = '';
      mutated = true;
    }
  }

  const defaultSettings = buildDefaultSchema().settings;
  if (!current.settings) {
    current.settings = defaultSettings;
    mutated = true;
  } else {
    for (const key of Object.keys(defaultSettings)) {
      if (current.settings[key] === undefined) {
        current.settings[key] = defaultSettings[key];
        mutated = true;
      }
    }
    // 清理已下线的调试字段（Mock 调试模式），避免残留脏数据
    if (current.settings.mock_mode !== undefined) {
      delete current.settings.mock_mode;
      mutated = true;
    }
  }

  if (current.schema_version < SYS_DEFAULTS.SCHEMA_VERSION) {
    current.schema_version = SYS_DEFAULTS.SCHEMA_VERSION;
    mutated = true;
  }

  if (mutated) {
    await chrome.storage.local.set(current);
  }
}

export { shortId };
