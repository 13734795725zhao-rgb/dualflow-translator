/**
 * DualFlow Translator — 全局常量契约
 * 对应技术方案文档「0.3 术语表与全局常量定义」
 */

/** DOM 节点处理状态机枚举（data-df-status） */
export const NodeProcessStatus = {
  IDLE: 'idle',
  FILTERING: 'filtering',
  SKIPPED: 'skipped',
  QUEUED: 'queued',
  FETCHING: 'fetching',
  RENDERED: 'rendered',
  FAILED: 'failed',
};

/** 跨上下文消息动作契约 */
export const MessageAction = {
  REQ_BATCH_TRANSLATE: 'REQ_BATCH_TRANSLATE',
  RESP_BATCH_TRANSLATE: 'RESP_BATCH_TRANSLATE',
  EVENT_CONFIG_CHANGED: 'EVENT_CONFIG_CHANGED',
  REQ_TEST_CONNECTION: 'REQ_TEST_CONNECTION',
  REQ_SELF_CHECK: 'REQ_SELF_CHECK',
  CMD_START_TRANSLATION: 'CMD_START_TRANSLATION',
  CMD_SWEEP_TRANSLATION: 'CMD_SWEEP_TRANSLATION',
  REQ_TAB_STATS: 'REQ_TAB_STATS',
  RESP_TAB_STATS: 'RESP_TAB_STATS',
  EVENT_STAT_UPDATED: 'EVENT_STAT_UPDATED',
};

/** 翻译生效模式（常驻开关：一次设置，所有页面生效） */
export const TranslateMode = {
  /** 手动：每个页面都要点开关才翻译（默认，零意外消耗） */
  MANUAL: 'manual',
  /** 常开：所有页面打开即自动翻译（站点豁免规则优先） */
  ALWAYS_ON: 'always_on',
  /** 常关：所有页面都不自动翻译；当前页仍可手动点开关 */
  ALWAYS_OFF: 'always_off',
};

/** 模式的中文标签与说明（Popup / 设置页共用） */
export const TRANSLATE_MODE_META = {
  [TranslateMode.MANUAL]: { label: '手动', hint: '每个页面都要点开关才翻译（默认）。' },
  [TranslateMode.ALWAYS_ON]: { label: '常开', hint: '所有页面打开即自动翻译（豁免站点除外）。' },
  [TranslateMode.ALWAYS_OFF]: { label: '常关', hint: '所有页面都不自动翻译；当前页仍可手动开启。' },
};

/** 全局默认约束 */
export const SYS_DEFAULTS = {
  CJK_THRESHOLD: 0.7,
  BATCH_SIZE: 6,
  BATCH_TOKEN_BUDGET: 1800,
  API_TIMEOUT_MS: 15000,
  CONCURRENCY_LIMIT: 3,
  PING_TIMEOUT_MS: 8000,
  SCHEMA_VERSION: 3,
  MAX_RETRY: 3,
  BACKOFF_BASE_MS: 1000,
  BACKOFF_MAX_MS: 10000,
  TRANSLATE_MODE: TranslateMode.MANUAL,
};

/** 挂载容器的特征类名（用于一键无损还原与自注入拦截） */
export const CONTAINER_CLASS = 'flow-translate-container';
export const SUB_CLASS = 'flow-translate-sub';
export const SKELETON_CLASS = 'flow-translate-skeleton';
export const ERROR_CLASS = 'flow-translate-error';

/** 目标语义标签白名单 */
export const TARGET_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'BLOCKQUOTE',
  'FIGCAPTION',
  'DD',
  'DT',
  'TD',
  'TH',
]);

/** 严格跳过的黑名单标签 */
export const IGNORED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'PRE',
  'CODE',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'BUTTON',
  'SVG',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'NOSCRIPT',
  'KBD',
  'SAMP',
  'IFRAME',
  'OBJECT',
  'EMBED',
]);

/** 统一错误码表 */
export const ERROR_CODES = {
  ERR_NO_ACTIVE_MODEL: '未配置或未启用任何可用的翻译模型，请前往设置页添加 API 供应商与模型。',
  ERR_NETWORK_TIMEOUT: '大模型 API 请求超时（15s）。请调小「单批段落数 / 单批字符预算」或稍后重试。',
  ERR_RATE_LIMITED: '服务商触发限流（429），已自动退避重试。',
  ERR_JSON_MALFORMED: '大模型返回内容无法解析为结构化结果（已尝试剥离 Markdown 围栏与截断修复）。',
  ERR_TRUNCATED: '大模型输出被 max_tokens 截断，请调大该模型「最大生成长度」或调小「单批段落数 / 单批字符预算」。',
  ERR_UNAUTHORIZED: 'API Key 无效或已过期（401），请检查凭据配置。',
  ERR_FORBIDDEN: '密钥无该端点/模型的访问权限（403），请确认账号套餐与模型授权。',
  ERR_NOT_FOUND: '端点路径不存在（404），请检查 Base URL 是否缺少 /v1，或是否重复拼接了 /chat/completions。',
  ERR_BAD_REQUEST: '请求被服务端拒绝（400），请检查模型名是否正确。',
  ERR_NETWORK: '网络请求失败（请求发生在 Service Worker，不受页面 CSP 约束），请检查端点域名、协议与网络连通性。',
  ERR_UNKNOWN: '未知错误。',
};

/** 供内容脚本使用的纯常量镜像（内容脚本无法 import ES Module） */
export const CONTENT_CONSTANTS = {
  CONTAINER_CLASS,
  SUB_CLASS,
  SKELETON_CLASS,
  ERROR_CLASS,
  STATUS: NodeProcessStatus,
};
