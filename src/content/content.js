/**
 * DualFlow Translator — 内容脚本主入口（Orchestrator）
 * 负责：配置装载 / 批处理缓冲 / 端口通信 / 结果回填 / 统计上报
 */
(function () {
  const DF = (globalThis.DF = globalThis.DF || {});

  const PORT_NAME = 'dualflow-translate';

  const DEFAULT_SETTINGS = {
    cjk_threshold: 0.7,
    batch_size: 6,
    batch_token_budget: 1800,
    theme_mode: 'system',
    custom_css: '',
    auto_translate: false,
    translate_mode: 'manual',
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    excludedSelectors: [],
    bypassed: false,
    active: false,
    stats: { pending: 0, rendered: 0, skipped: 0, failed: 0 },
    buffer: [],
    flushTimer: null,
    pending: new Map(),
    /** seqId → 原始文本（重试时复用，避免把整篇宿主文本回传给模型） */
    textCache: new Map(),
    port: null,
    engine: null,
    reconnectTimer: null,
    destroyed: false,
    /** 上一次生效的翻译模式（用于识别模式变更） */
    lastMode: '',
  };

  /** 域名通配符匹配 */
  function matchDomainPattern(hostname, pattern) {
    if (!hostname || !pattern) return false;
    const host = String(hostname).toLowerCase();
    const pat = String(pattern).trim().toLowerCase();
    if (!pat) return false;
    if (pat === '*') return true;
    if (pat.startsWith('*.')) {
      const suffix = pat.slice(1);
      return host.endsWith(suffix) || host === pat.slice(2);
    }
    return host === pat;
  }

  /** 解析站点规则 */
  function resolveSiteRules(hostname, rules) {
    const list = rules || {};
    let bypassed = false;
    const selectors = [];
    for (const rule of Object.values(list)) {
      if (!matchDomainPattern(hostname, rule.domain_pattern)) continue;
      if (rule.action === 'bypass') bypassed = true;
      for (const selector of rule.excluded_selectors || []) selectors.push(selector);
    }
    return { bypassed, excludedSelectors: [...new Set(selectors)] };
  }

  /** 注入用户自定义 CSS */
  function applyCustomCSS(css) {
    let styleTag = document.getElementById('df-custom-style');
    const content = String(css || '').slice(0, 2048);
    if (!content) {
      if (styleTag) styleTag.remove();
      return;
    }
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = 'df-custom-style';
      (document.head || document.documentElement).appendChild(styleTag);
    }
    styleTag.textContent = content;
  }

  /** 装载本地配置（设置 + 站点规则） */
  async function loadConfig() {
    try {
      const data = await chrome.storage.local.get(['settings', 'rules']);
      state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
      const siteRules = resolveSiteRules(window.location.hostname, data.rules);
      state.bypassed = siteRules.bypassed;
      state.excludedSelectors = siteRules.excludedSelectors;
      applyCustomCSS(state.settings.custom_css);
      if (state.engine) {
        state.engine.threshold = state.settings.cjk_threshold;
        state.engine.excludedSelectors = state.excludedSelectors;
      }
    } catch (error) {
      console.warn('[DualFlow] 配置读取失败', error);
    }
  }

  /** 建立与后台 Service Worker 的长连接 */
  function connectPort() {
    if (state.destroyed) return;
    try {
      state.port = chrome.runtime.connect({ name: PORT_NAME });
    } catch (error) {
      // 典型原因：扩展被重新加载 / Service Worker 正在重启
      console.warn('[DualFlow] 无法连接后台 Service Worker，将 1 秒后重试：', error?.message);
      scheduleReconnect();
      return;
    }

    state.port.onMessage.addListener((message) => {
      if (!message || message.action !== 'RESP_BATCH_TRANSLATE') return;
      handleBatchResponse(message.payload || {});
    });

    state.port.onDisconnect.addListener(() => {
      // Service Worker 被回收属于正常现象，这里静默重连即可
      state.port = null;
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (state.destroyed || state.reconnectTimer) return;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connectPort();
    }, 1000);
  }

  /** 入队待译段落 */
  function enqueue(items, immediate) {
    for (const item of items) {
      state.buffer.push(item);
      state.pending.set(item.seqId, item);
      state.textCache.set(item.seqId, item.text);
    }
    const batchSize = Math.min(15, Math.max(1, state.settings.batch_size || 6));
    if (immediate || state.buffer.length >= batchSize) {
      flush();
      return;
    }
    if (state.flushTimer) clearTimeout(state.flushTimer);
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      flush();
    }, 300);
  }

  /** 发送批次到后台 */
  function flush() {
    if (state.buffer.length === 0) return;
    const batch = state.buffer.splice(0, state.buffer.length);
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }

    // 先挂载骨架态，给用户即时反馈
    for (const item of batch) {
      DF.Renderer.mountSkeleton(item.host, item.seqId, state.settings.theme_mode, item.anchor);
      state.stats.pending += 1;
    }

    if (!state.port) {
      connectPort();
    }

    const payload = {
      action: 'REQ_BATCH_TRANSLATE',
      traceId: `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      payload: { items: batch.map((item) => ({ seqId: item.seqId, text: item.text })) },
    };

    try {
      if (state.port) {
        state.port.postMessage(payload);
      } else {
        chrome.runtime
          .sendMessage(payload)
          .then((response) => {
            if (response && response.payload) handleBatchResponse(response.payload);
          })
          .catch(() => {
            for (const item of batch) {
              state.stats.pending = Math.max(0, state.stats.pending - 1);
              DF.Renderer.renderFailure(
                item.host,
                item.seqId,
                '无法连接后台服务，请重新加载扩展',
                retryItem,
                state.settings.theme_mode,
                item.anchor,
              );
              state.stats.failed += 1;
            }
          });
      }
    } catch (error) {
      // 通道在发送瞬间断开（例如 Service Worker 正在重启）
      console.warn('[DualFlow] 发送批次失败：', error?.message);
      scheduleReconnect();
      for (const item of batch) {
        state.stats.pending = Math.max(0, state.stats.pending - 1);
        DF.Renderer.renderFailure(
          item.host,
          item.seqId,
          '后台连接中断（Service Worker 正在重启），点击重试',
          retryItem,
          state.settings.theme_mode,
          item.anchor,
        );
        state.stats.failed += 1;
      }
    }
  }

  /** 处理后台回填结果 */
  function handleBatchResponse(payload) {
    const results = payload.results || [];
    for (const result of results) {
      const item = state.pending.get(result.seqId);
      if (!item) continue;
      state.pending.delete(result.seqId);
      state.stats.pending = Math.max(0, state.stats.pending - 1);

      if (result.error) {
        state.stats.failed += 1;
        DF.Renderer.renderFailure(
          item.host,
          item.seqId,
          result.error,
          retryItem,
          state.settings.theme_mode,
          item.anchor,
        );
        continue;
      }

      const text = (result.translatedText || '').trim();
      if (!text) {
        state.stats.skipped += 1;
        DF.Renderer.removeContainer(item.host, item.seqId, item.anchor);
        continue;
      }

      state.stats.rendered += 1;
      DF.Renderer.renderTranslation(item.host, item.seqId, text, state.settings.theme_mode, item.anchor);
    }
  }

  /** 单段重试 */
  function retryItem(seqId, host, anchor) {
    // 优先复用该段原始文本（宿主内可能有多段，回传整篇会污染结果）
    let text = state.textCache.get(seqId);
    if (!text && host) {
      text = DF.DomIngestionEngine.extractText
        ? DF.DomIngestionEngine.extractText(host)
        : (host.textContent || '').replace(/\s+/g, ' ').trim();
    }
    if (!text || !host) return;
    if (!state.engine) createEngine();
    state.engine.sequenceCounter += 1;
    const newSeqId = state.engine.sequenceCounter;
    enqueue([{ seqId: newSeqId, host, anchor, text }], true);
  }

  /** 启动整页翻译 */
  function startTranslation() {
    if (state.bypassed) {
      console.info('[DualFlow] 当前站点在豁免规则中，已跳过翻译。');
      return;
    }
    state.active = true;
    if (!state.engine) createEngine();
    state.engine.refresh();
    state.engine.startObservingMutations();
  }

  /**
   * 当前生效的翻译模式（常驻开关）：
   *   manual      手动：每个页面都要点开关
   *   always_on   常开：所有页面打开即自动翻译
   *   always_off  常关：所有页面都不自动翻译
   * 兼容旧版 auto_translate 布尔开关。
   */
  function currentMode() {
    const mode = state.settings.translate_mode;
    if (mode === 'always_on' || mode === 'always_off') return mode;
    return state.settings.auto_translate ? 'always_on' : 'manual';
  }

  /**
   * 按模式落地到当前页面：
   *   always_on  → 自动开译（站点豁免优先）
   *   always_off → 立刻停掉本页翻译
   *   manual     → 保持当前页面状态不变（由用户开关控制）
   */
  function applyTranslateMode(force) {
    const mode = currentMode();
    const changed = state.lastMode !== mode;
    state.lastMode = mode;

    if (mode === 'always_on') {
      if (!state.active && (changed || force)) startTranslation();
      return;
    }
    if (mode === 'always_off' && state.active) {
      sweepTranslation();
    }
  }

  /** 一键无损还原 */
  function sweepTranslation() {
    state.active = false;
    DF.Renderer.sweepAll();
    if (state.engine) {
      state.engine.destroy();
      state.engine = null;
    }
    state.buffer = [];
    state.pending.clear();
    state.textCache.clear();
    state.stats = { pending: 0, rendered: 0, skipped: 0, failed: 0 };
  }

  /** 创建 DOM 抓取引擎 */
  function createEngine() {
    if (state.engine) state.engine.destroy();
    state.engine = new DF.DomIngestionEngine({
      threshold: state.settings.cjk_threshold,
      excludedSelectors: state.excludedSelectors,
      onBatchReady: (items) => enqueue(items, false),
      onSkipped: (count) => {
        state.stats.skipped += count;
      },
    });
  }

  /** 消息通道：Popup / 后台 / 快捷键指令 */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return false;

    switch (message.action) {
      case 'CMD_START_TRANSLATION':
        startTranslation();
        sendResponse({ ok: true });
        return false;
      case 'CMD_SWEEP_TRANSLATION':
        sweepTranslation();
        sendResponse({ ok: true });
        return false;
      case 'REQ_TAB_STATS':
        sendResponse({
          isActive: state.active,
          bypassed: state.bypassed,
          queuedCount: state.stats.pending,
          renderedCount: state.stats.rendered,
          skippedCount: state.stats.skipped,
          failedCount: state.stats.failed,
        });
        return false;
      case 'EVENT_CONFIG_CHANGED':
        loadConfig().then(() => {
          applyTranslateMode();
          if (state.active && state.engine) state.engine.refresh();
        });
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });

  /** 配置热更新（Options 页修改后实时生效） */
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.settings || changes.rules) {
      loadConfig().then(() => {
        applyTranslateMode();
        if (state.engine && state.active) state.engine.refresh();
      });
    }
  });

  /** 初始化 */
  async function init() {
    await loadConfig();
    createEngine();
    connectPort();

    // 诊断日志：确认内容脚本已注入、配置已生效（排查第 1 步）
    console.info(
      `[DualFlow] 内容脚本已注入｜阈值=${state.settings.cjk_threshold}｜批量=${state.settings.batch_size}` +
        `｜模式=${currentMode()}` +
        `${state.bypassed ? '｜当前站点已豁免' : ''}`,
    );

    // 常驻模式落地：常开 → 自动开译；常关 → 不自动开译
    applyTranslateMode(true);

    window.addEventListener('beforeunload', () => {
      state.destroyed = true;
      if (state.engine) state.engine.destroy();
    });
  }

  init();

  DF.contentState = state;
})();
