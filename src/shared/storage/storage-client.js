import { SYS_DEFAULTS } from '../constants.js';

/**
 * 统一的存储访问代理器：内存快照 + chrome.storage.onChanged 热更新。
 * 对应技术方案文档「2.3 存储访问代理器与内存快照缓存」
 */
class StorageClient {
  constructor() {
    /** @type {any} */
    this.cacheSnapshot = null;
    this.isInitialized = false;
    this.listenToExternalChanges();
  }

  async init() {
    if (this.isInitialized) return;
    const data = await chrome.storage.local.get(null);
    this.cacheSnapshot = data && Object.keys(data).length ? data : null;
    if (!this.cacheSnapshot) {
      const { buildDefaultSchema } = await import('./migration.js');
      this.cacheSnapshot = buildDefaultSchema();
      await chrome.storage.local.set(this.cacheSnapshot);
    }
    this.isInitialized = true;
  }

  listenToExternalChanges() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !this.cacheSnapshot) return;
      for (const [key, change] of Object.entries(changes)) {
        if (key in this.cacheSnapshot) {
          this.cacheSnapshot[key] = change.newValue;
        }
      }
    });
  }

  getSnapshot() {
    if (!this.cacheSnapshot) {
      throw new Error('[StorageClient] Storage not initialized. Call init() first.');
    }
    return this.cacheSnapshot;
  }

  /** O(1) 提取当前激活模型及其所属供应商 */
  getActiveModelContext() {
    const snapshot = this.getSnapshot();
    const activeModelId = snapshot.settings?.active_model_id;
    if (!activeModelId) return null;
    const model = snapshot.models?.[activeModelId];
    if (!model || !model.is_enabled) return null;
    const provider = snapshot.providers?.[model.provider_ref];
    if (!provider) return null;
    if (!provider.api_key) return null;
    return { model, provider };
  }

  /** 获取全部可用模型（Popup 下拉） */
  listEnabledModels() {
    const snapshot = this.getSnapshot();
    return Object.values(snapshot.models || {})
      .filter((m) => m.is_enabled)
      .map((m) => ({
        ...m,
        provider_name: snapshot.providers?.[m.provider_ref]?.name || '未知供应商',
      }));
  }

  async patchSettings(patch) {
    const current = this.getSnapshot();
    const updatedSettings = { ...current.settings, ...patch };
    this.cacheSnapshot.settings = updatedSettings;
    await chrome.storage.local.set({ settings: updatedSettings });
    return updatedSettings;
  }

  async upsertProvider(provider) {
    const current = this.getSnapshot();
    current.providers[provider.provider_id] = { ...provider, updated_at: Date.now() };
    await chrome.storage.local.set({ providers: current.providers });
  }

  async removeProviderCascade(providerId) {
    const current = this.getSnapshot();
    delete current.providers[providerId];
    for (const [modelId, model] of Object.entries(current.models || {})) {
      if (model.provider_ref === providerId) {
        delete current.models[modelId];
        if (current.settings.active_model_id === modelId) {
          current.settings.active_model_id = '';
        }
      }
    }
    await chrome.storage.local.set({
      providers: current.providers,
      models: current.models,
      settings: current.settings,
    });
  }

  async upsertModel(model) {
    const current = this.getSnapshot();
    current.models[model.model_id] = { ...model };
    await chrome.storage.local.set({ models: current.models });
  }

  async removeModelCascade(modelId) {
    const current = this.getSnapshot();
    delete current.models[modelId];
    if (current.settings.active_model_id === modelId) {
      current.settings.active_model_id = '';
    }
    await chrome.storage.local.set({ models: current.models, settings: current.settings });
  }

  async setActiveModel(modelId) {
    return this.patchSettings({ active_model_id: modelId });
  }

  async upsertRule(rule) {
    const current = this.getSnapshot();
    current.rules[rule.rule_id] = { ...rule };
    await chrome.storage.local.set({ rules: current.rules });
  }

  async removeRule(ruleId) {
    const current = this.getSnapshot();
    delete current.rules[ruleId];
    await chrome.storage.local.set({ rules: current.rules });
  }
}

/**
 * 域名通配符匹配：支持 *.github.com / github.com / 精确主机名
 */
export function matchDomainPattern(hostname, pattern) {
  if (!hostname || !pattern) return false;
  const host = String(hostname).toLowerCase();
  const pat = String(pattern).trim().toLowerCase();
  if (!pat) return false;
  if (pat === '*') return true;
  if (pat.startsWith('*.')) {
    const suffix = pat.slice(1); // ".github.com"
    return host.endsWith(suffix) || host === pat.slice(2);
  }
  return host === pat;
}

/**
 * 解析当前域名命中的站点规则（bypass 优先）
 */
export function resolveDomainRules(hostname, rules) {
  const list = Object.values(rules || {});
  let bypass = null;
  let excludedSelectors = [];
  for (const rule of list) {
    if (!matchDomainPattern(hostname, rule.domain_pattern)) continue;
    if (rule.action === 'bypass' && !bypass) bypass = rule;
    excludedSelectors = excludedSelectors.concat(rule.excluded_selectors || []);
  }
  return { bypass, excludedSelectors: [...new Set(excludedSelectors)] };
}

export const storageClient = new StorageClient();

export const STORAGE_LIMITS = {
  CJK_THRESHOLD_MIN: 0.5,
  CJK_THRESHOLD_MAX: 0.9,
  BATCH_SIZE_MIN: 1,
  BATCH_SIZE_MAX: 15,
  BATCH_BUDGET_MIN: 200,
  BATCH_BUDGET_MAX: 6000,
  CONCURRENCY_MIN: 1,
  CONCURRENCY_MAX: 10,
  MAX_TOKENS_MIN: 512,
  MAX_TOKENS_MAX: 8192,
  TEMPERATURE_MIN: 0,
  TEMPERATURE_MAX: 1,
  DEFAULTS: SYS_DEFAULTS,
};
