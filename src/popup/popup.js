import { storageClient, matchDomainPattern } from '../shared/storage/storage-client.js';
import { describeEndpoint } from '../shared/providers.js';
import { TranslateMode, TRANSLATE_MODE_META } from '../shared/constants.js';

const els = {
  toggle: document.getElementById('toggle-translate'),
  modeGroup: document.getElementById('mode-group'),
  modeHint: document.getElementById('mode-hint'),
  modelSelect: document.getElementById('model-select'),
  modelHint: document.getElementById('model-hint'),
  endpointHint: document.getElementById('endpoint-hint'),
  statQueued: document.getElementById('stat-queued'),
  statRendered: document.getElementById('stat-rendered'),
  statSkipped: document.getElementById('stat-skipped'),
  badge: document.getElementById('status-badge'),
  statusText: document.getElementById('status-text'),
  optionsBtn: document.getElementById('btn-open-options'),
  siteBypass: document.getElementById('site-bypass'),
  siteLabel: document.getElementById('site-label'),
  errorBox: document.getElementById('error-box'),
  errorText: document.getElementById('error-text'),
  reloadBtn: document.getElementById('btn-reload-translate'),
};

let currentTab = null;
let currentHostname = '';
let pollTimer = null;

/** 渲染模型下拉列表 */
function renderModels(models, activeModelId) {
  els.modelSelect.innerHTML = '';
  if (models.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '尚未配置任何模型';
    els.modelSelect.appendChild(option);
    els.modelSelect.disabled = true;
    return;
  }
  els.modelSelect.disabled = false;
  for (const model of models) {
    const option = document.createElement('option');
    option.value = model.model_id;
    option.textContent = `${model.display_label} · ${model.provider_name}`;
    if (model.model_id === activeModelId) option.selected = true;
    els.modelSelect.appendChild(option);
  }
}

/** 设置状态徽标 */
function setStatus(kind, text) {
  els.badge.className = `badge badge-${kind}`;
  els.statusText.textContent = text;
}

/** 当前生效的翻译模式（常驻开关；兼容旧版 auto_translate 布尔开关） */
function currentMode() {
  const settings = storageClient.getSnapshot().settings || {};
  if (settings.translate_mode === TranslateMode.ALWAYS_ON) return TranslateMode.ALWAYS_ON;
  if (settings.translate_mode === TranslateMode.ALWAYS_OFF) return TranslateMode.ALWAYS_OFF;
  return settings.auto_translate ? TranslateMode.ALWAYS_ON : TranslateMode.MANUAL;
}

/** 渲染翻译模式三态控件 */
function renderMode(mode) {
  const safe = TRANSLATE_MODE_META[mode] ? mode : TranslateMode.MANUAL;
  els.modeGroup.querySelectorAll('.seg-item').forEach((button) => {
    const active = button.dataset.mode === safe;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  els.modeHint.textContent = TRANSLATE_MODE_META[safe].hint;
}

/** 渲染模型信息 + 实际请求端点（排查 404 时用来核对拼接结果） */
function renderModelHint() {
  const context = storageClient.getActiveModelContext();
  if (!context) {
    els.modelHint.textContent = '尚未配置可用的 API 供应商与密钥，请前往设置页添加。';
    els.endpointHint.textContent = '';
    showError('未检测到可用的翻译模型，请先在设置页配置 API Key。');
    setStatus('error', '未配置');
    return;
  }

  els.modelHint.textContent = `模型：${context.model.display_label || context.model.model_name}`;
  els.endpointHint.textContent = `实际端点：${describeEndpoint(context.provider, context.model)}`;
}

function showError(message, options = {}) {
  if (!message) {
    els.errorBox.hidden = true;
    els.reloadBtn.hidden = true;
    return;
  }
  els.errorBox.hidden = false;
  els.errorText.textContent = message;
  els.reloadBtn.hidden = !options.reload;
}

/** 同步当前标签页状态与统计 */
async function syncTabStatus() {
  if (!currentTab?.id) return;
  let response = null;
  try {
    response = await chrome.tabs.sendMessage(currentTab.id, { action: 'REQ_TAB_STATS' });
  } catch (_) {
    response = null;
  }

  if (!response) {
    els.toggle.checked = false;
    els.toggle.disabled = true;
    els.statQueued.textContent = '-';
    els.statRendered.textContent = '-';
    els.statSkipped.textContent = '-';
    setStatus('idle', '未注入');
    showError(
      '当前标签页没有注入内容脚本：通常是「安装/刷新插件前就打开的旧页面」。点下方按钮刷新后即可翻译。',
      { reload: true },
    );
    return;
  }

  els.toggle.disabled = false;
  els.toggle.checked = !!response.isActive;
  els.statQueued.textContent = String(response.queuedCount ?? 0);
  els.statRendered.textContent = String(response.renderedCount ?? 0);
  els.statSkipped.textContent = String(response.skippedCount ?? 0);

  if (response.bypassed) {
    setStatus('idle', '站点豁免');
    showError('当前域名已被设为豁免站点，可在下方取消。');
  } else if (response.isActive) {
    setStatus('busy', response.queuedCount > 0 ? '翻译中' : '已开启');
    showError('');
  } else {
    setStatus('idle', '就绪');
    showError('');
  }
}

/** 站点豁免规则同步 */
function syncSiteBypass(rules) {
  const list = Object.values(rules || {});
  const matched = list.find(
    (rule) => rule.action === 'bypass' && matchDomainPattern(currentHostname, rule.domain_pattern),
  );
  els.siteBypass.checked = !!matched;
  els.siteLabel.textContent = currentHostname ? `在 ${currentHostname} 禁用翻译` : '在当前站点禁用翻译';
}

/** 切换当前站点豁免 */
async function toggleSiteBypass(checked) {
  const snapshot = storageClient.getSnapshot();
  const rules = { ...(snapshot.rules || {}) };
  const existingKey = Object.keys(rules).find(
    (key) => rules[key].action === 'bypass' && matchDomainPattern(currentHostname, rules[key].domain_pattern),
  );

  if (checked) {
    const ruleId = existingKey || `rule_${Date.now().toString(36)}`;
    rules[ruleId] = {
      rule_id: ruleId,
      domain_pattern: currentHostname,
      action: 'bypass',
      excluded_selectors: existingKey ? rules[ruleId].excluded_selectors : [],
    };
  } else if (existingKey) {
    delete rules[existingKey];
  }

  await chrome.storage.local.set({ rules });
}

/** 事件绑定 */
function bindEvents() {
  els.modelSelect.addEventListener('change', async () => {
    const modelId = els.modelSelect.value;
    if (!modelId) return;
    await storageClient.setActiveModel(modelId);
    chrome.runtime.sendMessage({
      action: 'EVENT_CONFIG_CHANGED',
      payload: { active_model_id: modelId },
    }).catch(() => {});
    renderModels(storageClient.listEnabledModels(), modelId);
    renderModelHint();
  });

  els.toggle.addEventListener('change', async () => {
    if (!currentTab?.id) return;
    const action = els.toggle.checked ? 'CMD_START_TRANSLATION' : 'CMD_SWEEP_TRANSLATION';
    try {
      await chrome.tabs.sendMessage(currentTab.id, { action });
    } catch (_) {
      els.toggle.checked = false;
      showError('无法与页面通信，请刷新页面后重试。');
      return;
    }
    setTimeout(syncTabStatus, 200);
  });

  /**
   * 常驻模式切换：一次设置，所有页面生效
   *   常开 → 当前页立即开译，且此后每个新页面自动翻译
   *   常关 → 当前页立即停译，且此后每个新页面都不自动翻译
   *   手动 → 仅影响后续新页面的默认行为，当前页保持现状
   */
  els.modeGroup.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('.seg-item');
    if (!button) return;
    const mode = button.dataset.mode;
    if (!TRANSLATE_MODE_META[mode]) return;

    await storageClient.patchSettings({
      translate_mode: mode,
      auto_translate: mode === TranslateMode.ALWAYS_ON,
    });
    renderMode(mode);

    if (currentTab?.id) {
      const action =
        mode === TranslateMode.ALWAYS_ON
          ? 'CMD_START_TRANSLATION'
          : mode === TranslateMode.ALWAYS_OFF
            ? 'CMD_SWEEP_TRANSLATION'
            : null;
      if (action) {
        try {
          await chrome.tabs.sendMessage(currentTab.id, { action });
        } catch (_) {
          /* 页面未注入内容脚本时忽略（下方会提示刷新） */
        }
      }
    }

    chrome.runtime
      .sendMessage({ action: 'EVENT_CONFIG_CHANGED', payload: { translate_mode: mode } })
      .catch(() => {});
    setTimeout(syncTabStatus, 250);
  });

  els.siteBypass.addEventListener('change', async () => {
    if (!currentHostname) {
      els.siteBypass.checked = false;
      return;
    }
    await toggleSiteBypass(els.siteBypass.checked);
    syncSiteBypass(storageClient.getSnapshot().rules);
    setTimeout(syncTabStatus, 200);
  });

  els.optionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // 刷新当前标签页并在其加载完成后自动开始翻译
  els.reloadBtn.addEventListener('click', () => {
    if (!currentTab?.id) return;
    const tabId = currentTab.id;
    els.reloadBtn.disabled = true;
    els.reloadBtn.textContent = '刷新中...';

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      setTimeout(() => {
        chrome.tabs
          .sendMessage(tabId, { action: 'CMD_START_TRANSLATION' })
          .then(() => {
            els.toggle.checked = true;
            setStatus('busy', '翻译中');
          })
          .catch(() => {
            setStatus('error', '仍未注入');
          })
          .finally(() => {
            els.reloadBtn.disabled = false;
            els.reloadBtn.textContent = '刷新页面并翻译';
            syncTabStatus();
          });
      }, 400);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.reload(tabId);
  });
}

/** 初始化 */
async function init() {
  await storageClient.init();
  const snapshot = storageClient.getSnapshot();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  currentHostname = currentTab?.url ? new URL(currentTab.url).hostname : '';

  renderModels(storageClient.listEnabledModels(), snapshot.settings.active_model_id);
  syncSiteBypass(snapshot.rules);
  renderMode(currentMode());
  bindEvents();
  await syncTabStatus();

  // 校验激活模型是否可用（缺少 API Key 时给出提示）
  renderModelHint();

  pollTimer = setInterval(syncTabStatus, 1200);
  window.addEventListener('unload', () => {
    if (pollTimer) clearInterval(pollTimer);
  });

  // 设置页改动配置后实时同步（模型、端点、翻译模式）
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!changes.settings && !changes.models && !changes.providers) return;
    const latest = storageClient.getSnapshot();
    renderModels(storageClient.listEnabledModels(), latest.settings.active_model_id);
    renderModelHint();
    if (changes.settings) renderMode(currentMode());
  });
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    console.error('[DualFlow] Popup 初始化失败', error);
  });
});
