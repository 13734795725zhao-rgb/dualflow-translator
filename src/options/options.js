import { storageClient, STORAGE_LIMITS } from '../shared/storage/storage-client.js';
import {
  PROVIDER_PRESETS,
  shortId,
  maskApiKey,
  normalizeBaseUrl,
  validateBaseUrl,
  buildEndpointUrl,
  describeEndpoint,
} from '../shared/providers.js';
import { MessageAction, TranslateMode, TRANSLATE_MODE_META } from '../shared/constants.js';

const state = {
  editingProviderId: null,
  editingModelId: null,
};

const els = {
  nav: document.getElementById('nav'),
  providerList: document.getElementById('provider-list'),
  ruleList: document.getElementById('rule-list'),
  preferencesPanel: document.getElementById('preferences-panel'),
  appearancePanel: document.getElementById('appearance-panel'),
  drawer: document.getElementById('provider-drawer'),
  drawerTitle: document.getElementById('drawer-title'),
  providerForm: document.getElementById('provider-form'),
  btnAddProvider: document.getElementById('btn-add-provider'),
  btnAddRule: document.getElementById('btn-add-rule'),
  btnSaveProvider: document.getElementById('btn-save-provider'),
  toast: document.getElementById('toast'),
};

let toastTimer = null;

/** 轻提示 */
function toast(message, type = 'info') {
  els.toast.textContent = message;
  els.toast.className = `toast${type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : ''}`;
  els.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2600);
}

/** 创建元素的小工具 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** 标签页切换 */
function switchTab(name) {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.classList.toggle('is-active', item.dataset.tab === name);
  });
  document.querySelectorAll('.panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.dataset.panel === name);
  });
}

/** 广播配置变更 */
function broadcastConfig(payload) {
  chrome.runtime.sendMessage({
    action: MessageAction.EVENT_CONFIG_CHANGED,
    payload: payload || {},
  }).catch(() => {});
}

/** 渲染模型仓库 */
function renderProviders() {
  const snapshot = storageClient.getSnapshot();
  const providers = Object.values(snapshot.providers || {});
  els.providerList.innerHTML = '';

  els.providerList.appendChild(buildSelfCheckCard());

  if (providers.length === 0) {
    els.providerList.appendChild(el('div', 'empty', '模型仓库为空，点击「+ 添加供应商」接入你的第一个大模型 API。'));
    return;
  }

  for (const provider of providers) {
    const models = Object.values(snapshot.models || {}).filter((m) => m.provider_ref === provider.provider_id);
    els.providerList.appendChild(buildProviderCard(provider, models, snapshot.settings.active_model_id));
  }
}

/**
 * 一键自检卡片：逐项体检配置 / 端点 / 连通性 / 解析
 */
function buildSelfCheckCard() {
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  const text = el('div');
  text.appendChild(el('div', 'card-title', '一键自检'));
  text.appendChild(el('div', 'panel-desc', '依次检查：模型配置 → 端点拼接 → 真实连通性 → 结果解析。'));
  head.appendChild(text);

  const runBtn = el('button', 'btn btn-primary btn-sm', '开始自检');
  runBtn.type = 'button';
  head.appendChild(runBtn);
  card.appendChild(head);

  const resultBox = el('div', 'selfcheck-result');
  resultBox.hidden = true;
  card.appendChild(resultBox);

  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true;
    runBtn.textContent = '自检中...';
    resultBox.hidden = false;
    resultBox.innerHTML = '';
    resultBox.appendChild(el('div', 'model-sub', '正在执行，请稍候…'));

    let response = null;
    try {
      response = await chrome.runtime.sendMessage({ action: MessageAction.REQ_SELF_CHECK });
    } catch (error) {
      response = { success: false, errorMessage: error?.message || '无法连接 Service Worker' };
    }

    resultBox.innerHTML = '';
    if (!response?.success) {
      resultBox.appendChild(
        el('div', 'model-sub', `自检失败：${response?.errorMessage || '未知错误'}`),
      );
      toast('自检未完成，请检查 Service Worker 控制台', 'error');
      runBtn.disabled = false;
      runBtn.textContent = '开始自检';
      return;
    }

    for (const check of response.report.checks) {
      const line = el('div', 'selfcheck-line');
      line.appendChild(el('span', `selfcheck-dot ${check.ok ? 'is-ok' : 'is-bad'}`, check.ok ? '✓' : '✕'));
      const body = el('div');
      body.appendChild(el('div', 'selfcheck-name', check.name));
      body.appendChild(el('div', 'model-sub', check.detail));
      if (check.fix) body.appendChild(el('div', 'selfcheck-fix', `→ ${check.fix}`));
      line.appendChild(body);
      resultBox.appendChild(line);
    }

    const failed = response.report.checks.filter((c) => !c.ok).length;
    toast(failed === 0 ? '自检全部通过 ✅' : `自检发现 ${failed} 项异常`, failed === 0 ? 'success' : 'error');
    runBtn.disabled = false;
    runBtn.textContent = '开始自检';
  });

  return card;
}

/** 构建供应商卡片 */
function buildProviderCard(provider, models, activeModelId) {
  const card = el('div', 'card');

  const head = el('div', 'card-head');
  const titleWrap = el('div');
  const title = el('div', 'card-title');
  title.appendChild(el('span', null, provider.name));
  const protocolLabel = { openai: 'OpenAI 兼容', anthropic: 'Anthropic 原生', gemini: 'Gemini 原生' };
  title.appendChild(el('span', 'chip chip-muted', protocolLabel[provider.protocol] || 'OpenAI 兼容'));
  titleWrap.appendChild(title);

  const meta = el('div', 'meta');
  meta.appendChild(el('div', 'mono', `Base URL：${provider.base_url || '未填写'}`));
  meta.appendChild(el('div', 'mono', `密钥：${provider.api_key ? maskApiKey(provider.api_key) : '未配置'}`));
  // 实际请求 URL（排查 404 时与 Network 面板对照）
  const sampleModel = models[0] || { model_name: 'MODEL_NAME' };
  meta.appendChild(
    el('div', 'mono', `实际请求 URL：${describeEndpoint(provider, sampleModel)}`),
  );
  titleWrap.appendChild(meta);
  head.appendChild(titleWrap);

  const actions = el('div', 'btn-row');
  const editBtn = el('button', 'btn btn-sm', '编辑');
  editBtn.type = 'button';
  editBtn.addEventListener('click', () => openProviderDrawer(provider.provider_id));
  const delBtn = el('button', 'btn btn-sm btn-danger', '删除');
  delBtn.type = 'button';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`确定删除供应商「${provider.name}」及其全部模型？`)) return;
    await storageClient.removeProviderCascade(provider.provider_id);
    toast('供应商已删除', 'success');
    renderAll();
  });
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  head.appendChild(actions);
  card.appendChild(head);

  const modelList = el('div', 'model-list');
  if (models.length === 0) {
    modelList.appendChild(el('div', 'model-sub', '该供应商下暂无模型。'));
  }
  for (const model of models) {
    modelList.appendChild(buildModelRow(provider, model, model.model_id === activeModelId));
  }
  const addModelBtn = el('button', 'btn btn-sm', '+ 添加模型');
  addModelBtn.type = 'button';
  addModelBtn.addEventListener('click', () => {
    state.editingModelId = null;
    openModelForm(provider.provider_id, null, modelList);
  });
  modelList.appendChild(addModelBtn);
  card.appendChild(modelList);

  return card;
}

/** 构建模型行 */
function buildModelRow(provider, model, isActive) {
  const row = el('div', 'model-row');

  const info = el('div', 'model-info');
  const nameLine = el('div', 'model-name');
  nameLine.appendChild(document.createTextNode(model.display_label || model.model_name));
  if (isActive) nameLine.appendChild(el('span', 'chip', '当前激活'));
  if (!model.is_enabled) nameLine.appendChild(el('span', 'chip chip-muted', '已停用'));
  info.appendChild(nameLine);
  info.appendChild(
    el(
      'div',
      'model-sub mono',
      `${model.model_name} · 并发 ${model.concurrency} · temp ${model.temperature} · 输出上限 ${model.max_tokens}`,
    ),
  );
  row.appendChild(info);

  const actions = el('div', 'btn-row');

  const pingBtn = el('button', 'btn btn-sm', 'Ping 测速');
  pingBtn.type = 'button';
  pingBtn.addEventListener('click', async () => {
    pingBtn.disabled = true;
    pingBtn.textContent = '探测中...';
    const result = await chrome.runtime.sendMessage({
      action: MessageAction.REQ_TEST_CONNECTION,
      payload: { provider, model },
    });
    pingBtn.disabled = false;
    if (result?.success) {
      pingBtn.textContent = `${result.latencyMs}ms`;
      pingBtn.classList.add('btn-success');
      toast(`连通成功 · ${result.latencyMs}ms`, 'success');
    } else {
      pingBtn.textContent = 'Ping 测速';
      toast(`连通失败：${result?.errorMessage || '未知错误'}`, 'error');
    }
  });
  actions.appendChild(pingBtn);

  if (!isActive) {
    const setBtn = el('button', 'btn btn-sm', '设为默认');
    setBtn.type = 'button';
    setBtn.addEventListener('click', async () => {
      await storageClient.setActiveModel(model.model_id);
      broadcastConfig({ active_model_id: model.model_id });
      toast('已切换激活模型', 'success');
      renderAll();
    });
    actions.appendChild(setBtn);
  }

  const editBtn = el('button', 'btn btn-sm', '编辑');
  editBtn.type = 'button';
  editBtn.addEventListener('click', () => {
    const list = editBtn.closest('.model-list');
    openModelForm(provider.provider_id, model.model_id, list);
  });
  actions.appendChild(editBtn);

  const delBtn = el('button', 'btn btn-sm btn-danger', '删除');
  delBtn.type = 'button';
  delBtn.addEventListener('click', async () => {
    if (!confirm(`确定删除模型「${model.display_label || model.model_name}」？`)) return;
    await storageClient.removeModelCascade(model.model_id);
    toast('模型已删除', 'success');
    renderAll();
  });
  actions.appendChild(delBtn);

  row.appendChild(actions);
  return row;
}

/** 打开模型编辑表单（内联） */
function openModelForm(providerId, modelId, container) {
  const snapshot = storageClient.getSnapshot();
  const model = modelId ? snapshot.models[modelId] : null;

  const form = el('div', 'form-grid');
  form.style.marginTop = '8px';

  const nameInput = el('input', 'input');
  nameInput.placeholder = 'deepseek-chat';
  nameInput.value = model?.model_name || '';

  const labelInput = el('input', 'input');
  labelInput.placeholder = 'DeepSeek-V3';
  labelInput.value = model?.display_label || '';

  const tokensInput = el('input', 'input');
  tokensInput.type = 'number';
  tokensInput.min = String(STORAGE_LIMITS.MAX_TOKENS_MIN);
  tokensInput.max = String(STORAGE_LIMITS.MAX_TOKENS_MAX);
  tokensInput.value = String(model?.max_tokens ?? 2048);

  const tempInput = el('input', 'input');
  tempInput.type = 'number';
  tempInput.step = '0.1';
  tempInput.min = '0';
  tempInput.max = '1';
  tempInput.value = String(model?.temperature ?? 0.3);

  const concurrencyInput = el('input', 'input');
  concurrencyInput.type = 'number';
  concurrencyInput.min = String(STORAGE_LIMITS.CONCURRENCY_MIN);
  concurrencyInput.max = String(STORAGE_LIMITS.CONCURRENCY_MAX);
  concurrencyInput.value = String(model?.concurrency ?? STORAGE_LIMITS.DEFAULTS.CONCURRENCY_LIMIT);

  const enabledInput = el('input');
  enabledInput.type = 'checkbox';
  enabledInput.checked = model ? model.is_enabled : true;

  form.appendChild(field('模型标识 (model_name)', nameInput));
  form.appendChild(field('展示别名 (display_label)', labelInput));
  const grid = el('div', 'grid-2');
  grid.appendChild(field('最大生成长度', tokensInput));
  grid.appendChild(field('温度 (0~1)', tempInput));
  grid.appendChild(field('并发上限 (1~10)', concurrencyInput));
  const enabledField = el('div', 'field');
  const enabledLabel = el('label', 'field-label');
  enabledLabel.appendChild(enabledInput);
  enabledLabel.appendChild(document.createTextNode(' 在快捷切换列表中启用'));
  enabledField.appendChild(enabledLabel);
  grid.appendChild(enabledField);
  form.appendChild(grid);

  const buttons = el('div', 'btn-row');
  const saveBtn = el('button', 'btn btn-primary btn-sm', '保存模型');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', async () => {
    const modelName = nameInput.value.trim();
    if (!modelName) {
      toast('请填写模型标识', 'error');
      return;
    }
    const payload = {
      model_id: modelId || shortId('model'),
      provider_ref: providerId,
      model_name: modelName,
      display_label: labelInput.value.trim() || modelName,
      max_tokens: clamp(Number(tokensInput.value) || 2048, STORAGE_LIMITS.MAX_TOKENS_MIN, STORAGE_LIMITS.MAX_TOKENS_MAX),
      temperature: clamp(Number(tempInput.value) || 0, STORAGE_LIMITS.TEMPERATURE_MIN, STORAGE_LIMITS.TEMPERATURE_MAX),
      concurrency: clamp(Number(concurrencyInput.value) || 3, STORAGE_LIMITS.CONCURRENCY_MIN, STORAGE_LIMITS.CONCURRENCY_MAX),
      is_enabled: enabledInput.checked,
    };
    await storageClient.upsertModel(payload);
    if (!modelId) {
      const snap = storageClient.getSnapshot();
      if (!snap.settings.active_model_id) {
        await storageClient.setActiveModel(payload.model_id);
      }
    }
    toast('模型已保存', 'success');
    renderAll();
  });

  const cancelBtn = el('button', 'btn btn-sm', '取消');
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => renderAll());

  buttons.appendChild(saveBtn);
  buttons.appendChild(cancelBtn);
  form.appendChild(buttons);

  const existing = container.querySelector('.form-grid');
  if (existing) existing.remove();
  container.appendChild(form);
}

/** 数值裁剪 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 表单字段 */
function field(label, control, hint) {
  const wrap = el('div', 'field');
  wrap.appendChild(el('label', 'field-label', label));
  wrap.appendChild(control);
  if (hint) wrap.appendChild(el('div', 'field-hint', hint));
  return wrap;
}

/** 打开供应商抽屉 */
function openProviderDrawer(providerId) {
  state.editingProviderId = providerId;
  const snapshot = storageClient.getSnapshot();
  const provider = providerId ? snapshot.providers[providerId] : null;
  els.drawerTitle.textContent = provider ? '编辑供应商' : '添加供应商';
  els.providerForm.innerHTML = '';
  els.providerForm.appendChild(buildProviderForm(provider));
  els.drawer.hidden = false;
}

/** 构建供应商表单 */
function buildProviderForm(provider) {
  const form = el('div', 'form-grid');

  const presetSelect = el('select', 'select');
  const presetPlaceholder = el('option', null, '— 选择预设模板（可选）—');
  presetPlaceholder.value = '';
  presetSelect.appendChild(presetPlaceholder);
  for (const preset of PROVIDER_PRESETS) {
    const option = el('option', null, preset.label);
    option.value = preset.key;
    presetSelect.appendChild(option);
  }
  presetSelect.addEventListener('change', () => {
    const preset = PROVIDER_PRESETS.find((p) => p.key === presetSelect.value);
    if (!preset) return;
    nameInput.value = preset.label;
    baseUrlInput.value = preset.base_url;
    overrideInput.value = '';
    protocolSelect.value = preset.protocol;
    keyHint.textContent =
      preset.key === 'gemini'
        ? 'Gemini 原生协议使用 ?key= 传参，无需 Bearer 头。'
        : '协议头：Authorization: Bearer <API Key>';
  });

  const nameInput = el('input', 'input');
  nameInput.placeholder = 'DeepSeek 官方';
  nameInput.value = provider?.name || '';

  const baseUrlInput = el('input', 'input');
  baseUrlInput.placeholder = 'https://api.deepseek.com/v1';
  baseUrlInput.value = provider?.base_url || '';

  const overrideInput = el('input', 'input');
  overrideInput.placeholder = '留空自动拼接；自建网关可填完整路径';
  overrideInput.value = provider?.endpoint_override || '';

  const protocolSelect = el('select', 'select');
  for (const [value, label] of [
    ['openai', 'OpenAI 兼容 (/chat/completions)'],
    ['anthropic', 'Anthropic 原生 (/messages)'],
    ['gemini', 'Gemini 原生 (:generateContent)'],
  ]) {
    const option = el('option', null, label);
    option.value = value;
    protocolSelect.appendChild(option);
  }
  protocolSelect.value = provider?.protocol || 'openai';

  const keyInput = el('input', 'input input-key');
  keyInput.type = 'password';
  keyInput.placeholder = 'sk-...';
  keyInput.value = provider?.api_key || '';
  const toggleBtn = el('button', 'btn', '显示');
  toggleBtn.type = 'button';
  toggleBtn.addEventListener('click', () => {
    const isPassword = keyInput.type === 'password';
    keyInput.type = isPassword ? 'text' : 'password';
    toggleBtn.textContent = isPassword ? '隐藏' : '显示';
  });
  const keyRow = el('div', 'key-row');
  keyRow.appendChild(keyInput);
  keyRow.appendChild(toggleBtn);

  const keyHint = el('div', 'field-hint', '仅保存在本机 chrome.storage.local，不会发送到任何第三方服务器。');

  const headersInput = el('textarea', 'textarea');
  headersInput.placeholder = '{"X-Custom-Header": "value"}';
  headersInput.value = provider?.custom_headers ? JSON.stringify(provider.custom_headers, null, 2) : '';

  form.appendChild(field('预设模板', presetSelect));
  form.appendChild(field('供应商名称', nameInput, '1~32 字符'));
  form.appendChild(field('API 端点 (Base URL)', baseUrlInput, '形如 https://api.deepseek.com/v1（可省略 /chat/completions）'));
  form.appendChild(field('完整端点覆盖（可选）', overrideInput, '仅当自动拼接不符合你的网关规则时填写，例如 https://gw.corp.com/v1/chat/completions'));

  const preview = el('div', 'preview mono');
  preview.style.fontSize = '11px';
  const updatePreview = () => {
    const probe = {
      base_url: baseUrlInput.value,
      endpoint_override: overrideInput.value,
      protocol: protocolSelect.value,
      api_key: 'sk-***',
    };
    preview.textContent = `实际请求 URL：${buildEndpointUrl(probe, { model_name: 'MODEL_NAME' })}`;
  };
  baseUrlInput.addEventListener('input', updatePreview);
  overrideInput.addEventListener('input', updatePreview);
  protocolSelect.addEventListener('change', updatePreview);
  form.appendChild(preview);
  updatePreview();

  form.appendChild(field('API 密钥', keyRow, ''));
  form.lastChild.appendChild(keyHint);
  form.appendChild(field('协议类型', protocolSelect));
  form.appendChild(field('自定义请求头（JSON，可选）', headersInput));

  return form;
}

/** 保存供应商 */
async function saveProvider() {
  const form = els.providerForm;
  const nameInput = form.querySelector('input[placeholder="DeepSeek 官方"]');
  const baseUrlInput = form.querySelector('input[placeholder="https://api.deepseek.com/v1"]');
  const overrideInput = form.querySelector('input[placeholder="留空自动拼接；自建网关可填完整路径"]');
  const keyInput = form.querySelector('input.input-key');
  const protocolSelect = form.querySelectorAll('select')[1];
  const headersInput = form.querySelector('textarea');

  const name = (nameInput?.value || '').trim();
  if (!name) {
    toast('请填写供应商名称', 'error');
    return;
  }

  const urlCheck = validateBaseUrl(baseUrlInput?.value || '');
  if (!urlCheck.valid) {
    toast(urlCheck.message, 'error');
    return;
  }

  let customHeaders = {};
  const rawHeaders = (headersInput?.value || '').trim();
  if (rawHeaders) {
    try {
      customHeaders = JSON.parse(rawHeaders);
    } catch (_) {
      toast('自定义请求头不是合法 JSON', 'error');
      return;
    }
  }

  const snapshot = storageClient.getSnapshot();
  const existing = state.editingProviderId ? snapshot.providers[state.editingProviderId] : null;
  const now = Date.now();

  const provider = {
    provider_id: state.editingProviderId || shortId('provider'),
    name,
    base_url: normalizeBaseUrl(baseUrlInput.value),
    api_key: (keyInput?.value || '').trim() || existing?.api_key || '',
    protocol: protocolSelect?.value || 'openai',
    endpoint_override: (overrideInput?.value || '').trim(),
    custom_headers: customHeaders,
    created_at: existing?.created_at || now,
    updated_at: now,
  };

  await storageClient.upsertProvider(provider);
  els.drawer.hidden = true;
  state.editingProviderId = null;
  toast('供应商已保存', 'success');
  renderAll();
}

/** 过滤偏好面板 */
function renderPreferences() {
  const settings = storageClient.getSnapshot().settings;
  els.preferencesPanel.innerHTML = '';

  // CJK 阈值
  const card = el('div', 'card');
  const head = el('div', 'card-head');
  const titleWrap = el('div');
  titleWrap.appendChild(el('div', 'card-title', '中文判定跳过阈值 (CJK Threshold)'));
  titleWrap.appendChild(
    el('div', 'panel-desc', '汉字纯度高于该阈值的段落直接保持原样，0 毫秒放行且不消耗 Token。'),
  );
  head.appendChild(titleWrap);
  const valueLabel = el('span', 'slider-value', `${Math.round(settings.cjk_threshold * 100)}%`);
  head.appendChild(valueLabel);
  card.appendChild(head);

  const sliderRow = el('div', 'slider-row');
  const slider = el('input', 'slider');
  slider.type = 'range';
  slider.min = String(STORAGE_LIMITS.CJK_THRESHOLD_MIN);
  slider.max = String(STORAGE_LIMITS.CJK_THRESHOLD_MAX);
  slider.step = '0.05';
  slider.value = String(settings.cjk_threshold);

  const playground = el('div', 'playground');
  const testInput = el('textarea', 'textarea');
  testInput.value = '针对这个 Pull Request，建议优化下 API 的缓存机制与 Concurrency 吞吐量。';
  const result = el('div', 'playground-result');

  const evaluate = (text, threshold) => {
    const raw = String(text);
    const stripped = raw.replace(/[\s\p{P}\p{N}\p{S}\p{C}]/gu, '');
    if (stripped.length < 3) return { ratio: 0, shouldTranslate: false };
    // 日文假名 / 韩文谚文直接视为外文
    if (/[\u3040-\u30ff\uff66-\uff9f\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(raw)) {
      return { ratio: 0, shouldTranslate: true };
    }
    const matches = stripped.match(/[\u4e00-\u9fa5\u3400-\u4dbf]/g);
    const chineseCount = matches ? matches.length : 0;
    const foreignWords = raw
      .split(/[^\p{L}\p{M}]+/u)
      .filter(Boolean)
      .filter((run) => !/[\u4e00-\u9fa5\u3400-\u4dbf]/.test(run)).length;
    const ratio = chineseCount + foreignWords === 0 ? 0 : chineseCount / (chineseCount + foreignWords);
    return { ratio: Math.round(ratio * 100), shouldTranslate: ratio < threshold };
  };

  const updateResult = () => {
    const threshold = Number(slider.value);
    valueLabel.textContent = `${Math.round(threshold * 100)}%`;
    const evaluation = evaluate(testInput.value, threshold);
    result.innerHTML = '';
    result.appendChild(el('span', 'mono', `当前汉字纯度占比：${evaluation.ratio}%`));
    const badge = el(
      'span',
      `chip ${evaluation.shouldTranslate ? 'chip-danger' : 'chip-success'}`,
      evaluation.shouldTranslate ? '触发大模型翻译' : '原生放行跳过',
    );
    result.appendChild(badge);
  };

  slider.addEventListener('input', updateResult);
  testInput.addEventListener('input', updateResult);
  slider.addEventListener('change', async () => {
    await storageClient.patchSettings({ cjk_threshold: Number(slider.value) });
    broadcastConfig({ cjk_threshold: Number(slider.value) });
  });

  sliderRow.appendChild(slider);
  card.appendChild(sliderRow);
  playground.appendChild(el('div', 'field-label', '实时过滤试炼场（可编辑文本验证）'));
  playground.appendChild(testInput);
  playground.appendChild(result);
  card.appendChild(playground);
  updateResult();
  els.preferencesPanel.appendChild(card);

  // 批处理参数
  const batchCard = el('div', 'card');
  batchCard.appendChild(el('div', 'card-title', '批处理与调度参数'));
  const batchGrid = el('div', 'grid-2');
  batchGrid.style.marginTop = '10px';

  const batchSizeInput = el('input', 'input');
  batchSizeInput.type = 'number';
  batchSizeInput.min = String(STORAGE_LIMITS.BATCH_SIZE_MIN);
  batchSizeInput.max = String(STORAGE_LIMITS.BATCH_SIZE_MAX);
  batchSizeInput.value = String(settings.batch_size);
  batchSizeInput.addEventListener('change', async () => {
    const value = clamp(Number(batchSizeInput.value) || 6, STORAGE_LIMITS.BATCH_SIZE_MIN, STORAGE_LIMITS.BATCH_SIZE_MAX);
    batchSizeInput.value = String(value);
    await storageClient.patchSettings({ batch_size: value });
    broadcastConfig({ batch_size: value });
  });
  batchGrid.appendChild(field('单批段落数 (1~15)', batchSizeInput, '段落越多，单次请求的 Token 越大'));

  const budgetInput = el('input', 'input');
  budgetInput.type = 'number';
  budgetInput.min = String(STORAGE_LIMITS.BATCH_BUDGET_MIN);
  budgetInput.max = String(STORAGE_LIMITS.BATCH_BUDGET_MAX);
  budgetInput.value = String(settings.batch_token_budget);
  budgetInput.addEventListener('change', async () => {
    const value = clamp(Number(budgetInput.value) || 1800, STORAGE_LIMITS.BATCH_BUDGET_MIN, STORAGE_LIMITS.BATCH_BUDGET_MAX);
    budgetInput.value = String(value);
    await storageClient.patchSettings({ batch_token_budget: value });
    broadcastConfig({ batch_token_budget: value });
  });
  batchGrid.appendChild(field('单批字符预算', budgetInput, '与段落数共同构成双重熔断'));
  batchCard.appendChild(batchGrid);
  els.preferencesPanel.appendChild(batchCard);

  // 翻译常驻模式（一次设置，所有页面生效）
  const modeCard = el('div', 'card');
  const modeText = el('div');
  modeText.appendChild(el('div', 'card-title', '翻译模式（常驻开关）'));
  modeText.appendChild(
    el(
      'div',
      'panel-desc',
      '常开：所有页面打开即自动翻译；常关：所有页面都不自动翻译；手动：每个页面都要点开关。站点豁免规则始终优先。',
    ),
  );
  modeCard.appendChild(modeText);

  const modeRow = el('div', 'seg-group');
  const activeMode =
    settings.translate_mode ||
    (settings.auto_translate ? TranslateMode.ALWAYS_ON : TranslateMode.MANUAL);
  for (const mode of [TranslateMode.MANUAL, TranslateMode.ALWAYS_ON, TranslateMode.ALWAYS_OFF]) {
    const button = el('button', 'seg-item', TRANSLATE_MODE_META[mode].label);
    button.type = 'button';
    button.dataset.mode = mode;
    if (mode === activeMode) button.classList.add('is-active');
    button.addEventListener('click', async () => {
      await storageClient.patchSettings({
        translate_mode: mode,
        auto_translate: mode === TranslateMode.ALWAYS_ON,
      });
      broadcastConfig({ translate_mode: mode, auto_translate: mode === TranslateMode.ALWAYS_ON });
      modeRow.querySelectorAll('.seg-item').forEach((item) => {
        item.classList.toggle('is-active', item.dataset.mode === mode);
      });
      toast(`翻译模式已切换为「${TRANSLATE_MODE_META[mode].label}」`, 'success');
    });
    modeRow.appendChild(button);
  }
  modeCard.appendChild(modeRow);
  els.preferencesPanel.appendChild(modeCard);
}

/** 站点规则面板 */
function renderRules() {
  const rules = Object.values(storageClient.getSnapshot().rules || {});
  els.ruleList.innerHTML = '';

  if (rules.length === 0) {
    els.ruleList.appendChild(el('div', 'empty', '暂无站点规则。可添加豁免域名，或为特定站点补充忽略选择器。'));
    return;
  }

  for (const rule of rules) {
    const card = el('div', 'card');
    const head = el('div', 'card-head');
    const info = el('div');
    const title = el('div', 'card-title');
    title.appendChild(el('span', null, rule.domain_pattern));
    title.appendChild(
      el('span', `chip ${rule.action === 'bypass' ? 'chip-danger' : 'chip-muted'}`, rule.action === 'bypass' ? '豁免翻译' : '正常翻译'),
    );
    info.appendChild(title);
    info.appendChild(
      el('div', 'model-sub', `忽略选择器：${(rule.excluded_selectors || []).join(', ') || '无'}`),
    );
    head.appendChild(info);

    const actions = el('div', 'btn-row');
    const delBtn = el('button', 'btn btn-sm btn-danger', '删除');
    delBtn.type = 'button';
    delBtn.addEventListener('click', async () => {
      await storageClient.removeRule(rule.rule_id);
      toast('规则已删除', 'success');
      renderAll();
    });
    actions.appendChild(delBtn);
    head.appendChild(actions);
    card.appendChild(head);
    els.ruleList.appendChild(card);
  }
}

/** 打开规则添加表单 */
function openRuleForm() {
  const card = el('div', 'card');
  const form = el('div', 'form-grid');

  const patternInput = el('input', 'input');
  patternInput.placeholder = '*.github.com';

  const actionSelect = el('select', 'select');
  for (const [value, label] of [
    ['translate', '正常翻译'],
    ['bypass', '豁免翻译（完全忽略该站点）'],
  ]) {
    const option = el('option', null, label);
    option.value = value;
    actionSelect.appendChild(option);
  }

  const selectorsInput = el('input', 'input');
  selectorsInput.placeholder = '.commit-title, .code-block';

  form.appendChild(field('域名通配符', patternInput, '支持 *.example.com 与精确主机名'));
  form.appendChild(field('动作', actionSelect));
  form.appendChild(field('额外忽略选择器（逗号分隔）', selectorsInput));

  const buttons = el('div', 'btn-row');
  const saveBtn = el('button', 'btn btn-primary btn-sm', '保存规则');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', async () => {
    const pattern = patternInput.value.trim();
    if (!pattern) {
      toast('请填写域名通配符', 'error');
      return;
    }
    const selectors = selectorsInput.value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    await storageClient.upsertRule({
      rule_id: shortId('rule'),
      domain_pattern: pattern,
      action: actionSelect.value,
      excluded_selectors: selectors,
    });
    toast('规则已保存', 'success');
    renderAll();
  });
  const cancelBtn = el('button', 'btn btn-sm', '取消');
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => renderAll());
  buttons.appendChild(saveBtn);
  buttons.appendChild(cancelBtn);
  form.appendChild(buttons);

  card.appendChild(form);
  const existing = els.ruleList.querySelector('.card .form-grid');
  if (existing) existing.closest('.card').remove();
  els.ruleList.insertBefore(card, els.ruleList.firstChild);
}

/** 外观定制面板 */
function renderAppearance() {
  const settings = storageClient.getSnapshot().settings;
  els.appearancePanel.innerHTML = '';

  // 主题模式
  const themeCard = el('div', 'card');
  themeCard.appendChild(el('div', 'card-title', '译文挂载主题'));
  const themeRow = el('div', 'btn-row');
  themeRow.style.marginTop = '10px';
  for (const [value, label] of [
    ['system', '跟随系统'],
    ['light', '浅色'],
    ['dark', '深色'],
  ]) {
    const btn = el('button', 'btn', label);
    btn.type = 'button';
    if (settings.theme_mode === value) btn.classList.add('btn-primary');
    btn.addEventListener('click', async () => {
      await storageClient.patchSettings({ theme_mode: value });
      broadcastConfig({ theme_mode: value });
      renderAll();
    });
    themeRow.appendChild(btn);
  }
  themeCard.appendChild(themeRow);
  els.appearancePanel.appendChild(themeCard);

  // 自定义 CSS
  const cssCard = el('div', 'card');
  cssCard.appendChild(el('div', 'card-title', '自定义注入样式'));
  cssCard.appendChild(
    el('div', 'panel-desc', '追加到页面中的 CSS 片段，可用于调整底色、字号等（不超过 2048 字符）。'),
  );
  const cssInput = el('textarea', 'textarea');
  cssInput.style.marginTop = '10px';
  cssInput.value = settings.custom_css || '';
  cssInput.placeholder = '.flow-translate-sub { background: rgba(16, 185, 129, 0.06) !important; }';

  const preview = el('div', 'preview');
  const origin = el('div', 'preview-origin', 'Chrome Extensions Manifest V3 brings significant changes to background execution.');
  const trans = el('div', 'preview-trans', 'Chrome 扩展程序 Manifest V3 对后台执行机制带来了重大变更。');
  preview.appendChild(origin);
  preview.appendChild(trans);

  const applyPreview = () => {
    const css = cssInput.value.trim();
    trans.style.cssText = '';
    if (css) {
      try {
        trans.style.cssText = css.replace(/!important/g, '').replace(/\.flow-translate-sub/g, '');
      } catch (_) {
        /* 忽略非法样式 */
      }
    }
  };
  cssInput.addEventListener('input', applyPreview);

  const buttons = el('div', 'btn-row');
  buttons.style.marginTop = '10px';
  const saveBtn = el('button', 'btn btn-primary btn-sm', '保存样式');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', async () => {
    const value = cssInput.value.slice(0, 2048);
    await storageClient.patchSettings({ custom_css: value });
    broadcastConfig({ custom_css: value });
    toast('自定义样式已保存', 'success');
  });
  const resetBtn = el('button', 'btn btn-sm', '清空');
  resetBtn.type = 'button';
  resetBtn.addEventListener('click', async () => {
    cssInput.value = '';
    applyPreview();
    await storageClient.patchSettings({ custom_css: '' });
    broadcastConfig({ custom_css: '' });
  });
  buttons.appendChild(saveBtn);
  buttons.appendChild(resetBtn);
  cssCard.appendChild(cssInput);
  cssCard.appendChild(buttons);
  cssCard.appendChild(el('div', 'field-label', '实时预览'));
  cssCard.appendChild(preview);
  applyPreview();
  els.appearancePanel.appendChild(cssCard);

  // 关于
  const aboutCard = el('div', 'card');
  aboutCard.appendChild(el('div', 'card-title', '关于 DualFlow Translator'));
  aboutCard.appendChild(
    el(
      'div',
      'panel-desc',
      '完全本地运行的 Chrome MV3 扩展：所有 API Key 仅保存在 chrome.storage.local，' +
        '请求由后台 Service Worker 直连用户配置的模型端点，不经过任何第三方中转服务器。',
    ),
  );
  els.appearancePanel.appendChild(aboutCard);
}

/** 统一渲染 */
function renderAll() {
  renderProviders();
  renderPreferences();
  renderRules();
  renderAppearance();
}

/** 事件绑定 */
function bindEvents() {
  els.nav.addEventListener('click', (event) => {
    const item = event.target.closest('.nav-item');
    if (!item) return;
    switchTab(item.dataset.tab);
  });

  els.btnAddProvider.addEventListener('click', () => openProviderDrawer(null));
  els.btnAddRule.addEventListener('click', openRuleForm);
  els.btnSaveProvider.addEventListener('click', () => {
    saveProvider().catch((error) => toast(`保存失败：${error.message}`, 'error'));
  });

  els.drawer.addEventListener('click', (event) => {
    if (event.target.hasAttribute('data-close')) els.drawer.hidden = true;
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !els.drawer.hidden) els.drawer.hidden = true;
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.providers || changes.models || changes.rules || changes.settings) renderAll();
  });
}

/** 初始化 */
async function init() {
  await storageClient.init();
  bindEvents();
  renderAll();
}

document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => {
    console.error('[DualFlow] 设置页初始化失败', error);
  });
});
