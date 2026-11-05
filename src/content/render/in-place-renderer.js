/**
 * DualFlow Translator — 原位渲染引擎（In-Place Renderer）
 * 对应技术方案文档「3.5 原位渲染引擎」
 *
 * 译文容器挂在「所属文本段的锚点节点之后」：
 *   - 锚点 = 该段最后一个 DOM 节点（文本节点或行内元素）
 *   - 插入位置 = anchor.after(container)，因此译文精确落在对应段落下方
 *   - 同一个宿主（如 div.article_right）里可以并存多个译文容器，互不覆盖
 */
(function () {
  const DF = (globalThis.DF = globalThis.DF || {});

  const CONTAINER_CLASS = 'flow-translate-container';
  const SUB_CLASS = 'flow-translate-sub';
  const SKELETON_CLASS = 'flow-translate-skeleton';
  const ERROR_CLASS = 'flow-translate-error';
  const RESTORE_CLASS = 'flow-translate-restore';

  const COPY_ICON =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
  const CHECK_ICON =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  const EYE_OFF_ICON =
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><path d="M6.61 6.61A18 18 0 0 0 2 12s3 8 10 8a9 9 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/></svg>';
  const RESTORE_ICON =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z"/><circle cx="12" cy="12" r="3"/></svg>';

  /** seqId → 译文容器（同一宿主可能挂载多个容器，不能只按宿主查找） */
  const containerRegistry = new Map();

  /**
   * 解析锚点：向上找到「宿主直属」的顶层节点，作为插入位置
   * （锚点可能在行内元素内部，例如 <p>Hello <b>world</b></p> 的锚点是 <b>）
   */
  function resolveInsertPoint(host, anchor) {
    if (!host || !anchor) return null;
    let node = anchor;
    while (node && node.parentNode && node.parentNode !== host) node = node.parentNode;
    if (node && node.parentNode === host) return node;
    return null;
  }

  /** 找到已挂载的译文容器：先按 seqId 精确匹配，再回退到锚点相邻节点 */
  function findContainer(host, seqId, anchor) {
    if (seqId !== undefined && seqId !== null && containerRegistry.has(seqId)) {
      const cached = containerRegistry.get(seqId);
      if (cached && cached.isConnected) return cached;
      containerRegistry.delete(seqId);
    }

    const point = resolveInsertPoint(host, anchor);
    if (point) {
      let next = point.nextSibling;
      while (next && next.nodeType === 3 && !(next.textContent || '').trim()) next = next.nextSibling;
      if (next && next.nodeType === 1 && next.classList.contains(CONTAINER_CLASS)) return next;
    }
    return null;
  }

  /** 在锚点之后创建译文容器 */
  function createContainer(host, seqId, theme, anchor) {
    const container = document.createElement('div');
    container.className = CONTAINER_CLASS;
    container.dataset.dfRef = String(seqId);
    container.dataset.dfStatus = 'fetching';
    container.dataset.dfTheme = theme || 'system';

    const point = resolveInsertPoint(host, anchor);
    if (point) point.after(container);
    else host.appendChild(container);

    if (seqId !== undefined && seqId !== null) containerRegistry.set(seqId, container);
    return container;
  }

  /** 复制文本到剪贴板（兼容剪贴板 API 不可用的场景） */
  function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
        return;
      }
      fallbackCopy(text);
    } catch (_) {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (_) {
      /* 忽略复制失败 */
    }
  }

  const Renderer = {
    CONTAINER_CLASS,
    SUB_CLASS,
    SKELETON_CLASS,
    ERROR_CLASS,
    RESTORE_CLASS,

    /**
     * 插入骨架占位态（FETCHING）
     */
    mountSkeleton(host, seqId, theme, anchor) {
      let container = findContainer(host, seqId, anchor);
      if (!container) {
        container = createContainer(host, seqId, theme, anchor);
      }
      container.dataset.dfTheme = theme || 'system';
      container.dataset.dfStatus = 'fetching';
      container.innerHTML = `<div class="${SKELETON_CLASS}" aria-hidden="true"></div>`;
      return container;
    },

    /**
     * 渲染正式译文（RENDERED）
     */
    renderTranslation(host, seqId, translatedText, theme, anchor) {
      const text = String(translatedText || '').trim();
      let container = findContainer(host, seqId, anchor);

      if (!text || text === '[SKIP]') {
        if (container) container.remove();
        if (seqId !== undefined && seqId !== null) containerRegistry.delete(seqId);
        return null;
      }
      // 骨架态丢失（页面重渲染等）时补建容器，保证译文不丢
      if (!container) container = createContainer(host, seqId, theme, anchor);

      container.dataset.dfTheme = theme || 'system';
      container.dataset.dfStatus = 'rendered';

      const sub = document.createElement('div');
      sub.className = SUB_CLASS;

      const textNode = document.createElement('div');
      textNode.className = 'flow-translate-text';
      textNode.textContent = text;

      const actions = document.createElement('div');
      actions.className = 'flow-translate-actions';

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'flow-action-btn';
      copyBtn.title = '复制中文译文';
      copyBtn.setAttribute('aria-label', '复制中文译文');
      copyBtn.innerHTML = COPY_ICON;
      copyBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        copyToClipboard(text);
        copyBtn.innerHTML = CHECK_ICON;
        copyBtn.classList.add('is-copied');
        setTimeout(() => {
          copyBtn.innerHTML = COPY_ICON;
          copyBtn.classList.remove('is-copied');
        }, 1200);
      });

      const hideBtn = document.createElement('button');
      hideBtn.type = 'button';
      hideBtn.className = 'flow-action-btn';
      hideBtn.title = '隐藏此句译文';
      hideBtn.setAttribute('aria-label', '隐藏此句译文');
      hideBtn.innerHTML = EYE_OFF_ICON;
      hideBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        Renderer.hideTranslation(container);
      });

      actions.appendChild(copyBtn);
      actions.appendChild(hideBtn);
      sub.appendChild(textNode);
      sub.appendChild(actions);
      container.innerHTML = '';
      container.appendChild(sub);
      return container;
    },

    /**
     * 隐藏单句译文，并留下一个半透明还原标记
     */
    hideTranslation(container) {
      if (!container) return;
      container.classList.add('is-hidden');
      const restore = document.createElement('span');
      restore.className = RESTORE_CLASS;
      restore.title = '显示译文';
      restore.innerHTML = `${RESTORE_ICON}<span>显示译文</span>`;
      restore.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        container.classList.remove('is-hidden');
        restore.remove();
      });
      container.insertAdjacentElement('afterend', restore);
    },

    /**
     * 渲染失败态与单段手动重试触发器（FAILED）
     */
    renderFailure(host, seqId, message, onRetry, theme, anchor) {
      let container = findContainer(host, seqId, anchor);
      if (!container) {
        container = createContainer(host, seqId, theme, anchor);
      }
      container.dataset.dfTheme = theme || 'system';
      container.dataset.dfStatus = 'failed';

      const errorBox = document.createElement('div');
      errorBox.className = ERROR_CLASS;

      const text = document.createElement('span');
      text.className = 'flow-error-text';
      text.textContent = message || '翻译请求失败';

      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'flow-retry-btn';
      retryBtn.textContent = '重试';
      retryBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof onRetry === 'function') onRetry(seqId, host, anchor);
      });

      errorBox.appendChild(text);
      errorBox.appendChild(retryBtn);
      container.innerHTML = '';
      container.appendChild(errorBox);
      return container;
    },

    /**
     * 移除某一段的译文容器
     */
    removeContainer(host, seqId, anchor) {
      const container = findContainer(host, seqId, anchor);
      if (container) container.remove();
      if (seqId !== undefined && seqId !== null) containerRegistry.delete(seqId);
    },

    /**
     * 一键无损还原：移除所有注入节点并清理状态标记
     */
    sweepAll() {
      document.querySelectorAll(`.${CONTAINER_CLASS}`).forEach((node) => node.remove());
      document.querySelectorAll(`.${RESTORE_CLASS}`).forEach((node) => node.remove());
      document.querySelectorAll('[data-df-status]').forEach((el) => {
        delete el.dataset.dfStatus;
        delete el.dataset.dfSeqId;
      });
      containerRegistry.clear();
    },
  };

  DF.Renderer = Renderer;
})();
