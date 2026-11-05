/**
 * DualFlow Translator — 本地存储数据契约
 * 对应技术方案文档「2.1 chrome.storage.local 存储表契约」
 */

/**
 * @typedef {Object} ProviderConfig
 * @property {string} provider_id  唯一主键
 * @property {string} name         展示名称
 * @property {string} base_url     API 端点
 * @property {string} api_key      Bearer Token（明文存储于本地沙箱）
 * @property {string} protocol     'openai' | 'anthropic' | 'gemini'
 * @property {string} endpoint_override 完整端点覆盖（留空则按协议自动拼接）
 * @property {Object} custom_headers 扩展请求头
 * @property {number} created_at
 * @property {number} updated_at
 */

/**
 * @typedef {Object} ModelRegistry
 * @property {string} model_id
 * @property {string} provider_ref
 * @property {string} model_name
 * @property {string} display_label
 * @property {number} max_tokens
 * @property {number} temperature
 * @property {number} concurrency
 * @property {boolean} is_enabled
 */

/**
 * @typedef {Object} DomainRule
 * @property {string} rule_id
 * @property {string} domain_pattern
 * @property {'translate'|'bypass'} action
 * @property {string[]} excluded_selectors
 */

/**
 * @typedef {Object} AppSettings
 * @property {string} active_model_id
 * @property {number} cjk_threshold
 * @property {number} batch_size
 * @property {number} batch_token_budget
 * @property {boolean} auto_translate
 * @property {'manual'|'always_on'|'always_off'} translate_mode 常驻翻译模式
 * @property {string} target_language
 * @property {'system'|'light'|'dark'} theme_mode
 * @property {string} custom_css
 */

/**
 * @typedef {Object} StorageSchema
 * @property {number} schema_version
 * @property {Record<string, ProviderConfig>} providers
 * @property {Record<string, ModelRegistry>} models
 * @property {Record<string, DomainRule>} rules
 * @property {AppSettings} settings
 */
