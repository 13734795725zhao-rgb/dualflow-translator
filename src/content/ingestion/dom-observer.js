/**
 * DualFlow Translator — DOM 解析与增量监听引擎（Ingestion Engine）
 *
 * 核心概念：**文本段（segment）是最小翻译单元**
 *
 * 真实站点（新闻站 / 论坛 / 博客）的正文往往不是 <p>，而是「裸文本 + <br />」直接塞在 div 里：
 *   <div class="article_right">
 *     <center><img/></center>
 *     <p class="picture">…图注…</p>
 *     <br /><br />
 *     正文第一段（裸文本节点）
 *     <br /><br />
 *     正文第二段（裸文本节点）
 *   </div>
 * 旧的「按元素翻译」方案在这里会整体失效：
 *   - 白名单标签匹配不到 div.article_right
 *   - 「子元素全为行内」的叶块判定也失效（同一个 div 里混着 <center> 与 <p>）
 *
 * 本引擎改为三步走：
 *   1) 找出「宿主元素」：块级、且含有属于它自己的直属文本
 *   2) 把宿主直属文本按 <br> / 块级子元素切成若干「文本段」
 *   3) 逐段送翻译；译文挂在该段最后一个节点（anchor）之后
 */
(function () {
  const DF = (globalThis.DF = globalThis.DF || {});

  const CONTAINER_CLASS = 'flow-translate-container';
  const RESTORE_CLASS = 'flow-translate-restore';

  /** 目标语义标签白名单 */
  const TARGET_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,dd,dt,td,th';

  /** 严格跳过的黑名单 */
  const BLACKLIST_SELECTOR =
    'pre,code,kbd,samp,script,style,noscript,svg,canvas,video,audio,iframe,input,textarea,select,option,[contenteditable="true"]';

  /** 导航 / 菜单 / 面包屑区域：其中的文本属于 UI 标签，翻译会破坏宿主排版 */
  const NAV_SELECTOR =
    'nav,[role="navigation"],.navbar,.nav,.menu,.menu-list,.nav-list,.site-nav,.main-nav,.top-nav,.header-nav,.side-nav,.subnav,.sub-nav,.breadcrumb,.breadcrumbs,.pagination,.pager,.paginator,.tab-nav,.tabs-nav,.category-nav,.footer-nav,.social-nav,.lang-nav';

  /** 短标签判定阈值 */
  const MIN_LABEL_LENGTH = 6;
  const LABEL_MAX_WORDS = 2;

  /** 文本段长度约束 */
  const MIN_SEGMENT_LENGTH = 12;
  const MAX_SEGMENT_LENGTH = 1500;

  /** 常见块级标签：快速判定，避免逐个 getComputedStyle */
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'body', 'blockquote', 'canvas', 'center', 'dd', 'details', 'dialog', 'dir',
    'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5',
    'h6', 'header', 'hr', 'html', 'iframe', 'legend', 'li', 'main', 'marquee', 'menu', 'nav', 'noscript',
    'ol', 'p', 'picture', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
    'ul', 'video', 'audio',
  ]);

  /** 视为「块级」的 display 取值（inline-block 等按行内处理，避免误判父级为容器） */
  const BLOCK_DISPLAYS = new Set([
    'block',
    'flow-root',
    'list-item',
    'table-cell',
    'table-row',
    'flex',
    'grid',
  ]);

  /** 判定元素是否为块级 */
  function isBlockLevel(element) {
    if (!element || element.nodeType !== 1) return false;
    const tag = (element.tagName || '').toLowerCase();
    if (BLOCK_TAGS.has(tag)) return true;
    try {
      const display = window.getComputedStyle(element).display;
      return BLOCK_DISPLAYS.has(display);
    } catch (_) {
      return false;
    }
  }

  /** 是否为插件自身注入的节点（译文容器 / 还原标记） */
  function isOwnElement(node) {
    if (!node || node.nodeType !== 1 || !node.classList) return false;
    return node.classList.contains(CONTAINER_CLASS) || node.classList.contains(RESTORE_CLASS);
  }

  /**
   * 是否为黑名单元素（script / style / pre / code / svg …）
   * 这类元素的内容不是正文：<script> 里的 JS 源码若被抓进正文，
   * 会被当成待翻译文本发给模型（GT 页面就有 load_file("…") 这类内联脚本）。
   */
  function isBlacklisted(node) {
    if (!node || node.nodeType !== 1) return false;
    try {
      return node.matches(BLACKLIST_SELECTOR);
    } catch (_) {
      return false;
    }
  }

  /**
   * 判定元素是否为「菜单型链接块」：
   * 站点导航常写成 <div class="nav"><a>HOME</a><a>CHINA</a>…</div>，
   * 这些 <a> 是行内元素，会被合并成一段文本（"HOME CHINA BUSINESS …"），
   * 从而绕过「短标签」过滤并把菜单整体翻成中文、撑乱版式。
   * 特征：链接文本占比高，且链接都很短（平均 ≤ 3 个词）。
   */
  function isMenuLike(element) {
    if (!element || !element.querySelectorAll) return false;
    let links;
    try {
      links = element.querySelectorAll('a');
    } catch (_) {
      return false;
    }
    if (links.length < 2) return false;

    const total = (element.textContent || '').replace(/\s+/g, ' ').trim();
    if (!total) return false;

    let linkChars = 0;
    let linkWords = 0;
    for (const link of links) {
      const text = (link.textContent || '').replace(/\s+/g, ' ').trim();
      linkChars += text.length;
      linkWords += text.split(/\s+/).filter(Boolean).length;
    }
    if (linkChars / total.length < 0.6) return false;
    return linkWords / links.length <= 3;
  }

  /**
   * 提取宿主元素「自身直属」的文本段。
   *
   * 规则：
   *   - 文本节点与行内元素（含其内部文本）归入当前段
   *   - 遇到 <br> → 断段
   *   - 遇到块级子元素 → 断段（该子元素的内容由它自己作为宿主处理）
   *   - 遇到插件自身注入的节点 → 断段并忽略其内容
   *   - 遇到黑名单元素（script/style/pre/code/svg…）→ 断段并忽略其内容
   *
   * 返回：[{ nodes: Node[], text: string }]，nodes 用于定位锚点
   */
  function collectOwnSegments(host) {
    const segments = [];
    let nodes = [];

    const flush = () => {
      if (nodes.length) {
        const text = nodes
          .map((node) => node.textContent || '')
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) segments.push({ nodes, text });
      }
      nodes = [];
    };

    const visit = (node) => {
      if (!node) return;
      if (node.nodeType === 3) {
        if ((node.textContent || '').trim()) nodes.push(node);
        return;
      }
      if (node.nodeType !== 1) return;
      // 插件自身注入的节点：断段但忽略内容，避免把译文/还原标记混进原文
      if (isOwnElement(node)) {
        flush();
        return;
      }
      // 黑名单元素（script/style/pre/code/svg…）：断段并忽略其内容
      if (isBlacklisted(node)) {
        flush();
        return;
      }
      const tag = (node.tagName || '').toLowerCase();
      if (tag === 'br') {
        flush();
        return;
      }
      // 块级子元素：它的文本属于它自己，这里只负责断开当前段
      if (isBlockLevel(node)) {
        flush();
        return;
      }
      for (const child of node.childNodes) visit(child);
    };

    for (const child of host.childNodes) visit(child);
    flush();
    return segments;
  }

  /** 提取文本时需要剔除的子节点 */
  const TEXT_STRIP_SELECTOR = 'pre,code,kbd,samp,script,style,noscript,svg,textarea,input';

  function extractText(element) {
    try {
      const clone = element.cloneNode(true);
      clone.querySelectorAll(TEXT_STRIP_SELECTOR).forEach((node) => node.remove());
      // 剔除插件自身注入的译文，避免把中文混进原文
      clone.querySelectorAll(`.${CONTAINER_CLASS}, .${RESTORE_CLASS}`).forEach((node) => node.remove());
      return (clone.textContent || '').replace(/\s+/g, ' ').trim();
    } catch (_) {
      return (element.textContent || '').replace(/\s+/g, ' ').trim();
    }
  }

  /**
   * 是否属于「导航/标签」类短文本（HOME、CHINA、Sign in、Subscribe…）
   * 这类文本翻译后既无信息量，又会撑乱菜单布局。
   */
  function isLabelLike(text) {
    if (!text) return true;
    const effective = text.replace(/[\s\p{P}\p{N}\p{S}\p{C}]/gu, '');
    if (effective.length < MIN_LABEL_LENGTH) return true;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length > LABEL_MAX_WORDS) return false;
    // 单词很少但以句末标点结尾 → 视为完整句子，仍然翻译
    return !/[.!?。！？;；:：]$/.test(text.trim());
  }

  function isVisible(element) {
    if (element.offsetParent !== null) return true;
    try {
      const style = window.getComputedStyle(element);
      if (style && style.position === 'fixed') return true;
      if (style && style.display === 'none') return false;
    } catch (_) {
      /* ignore */
    }
    return element.getClientRects().length > 0;
  }

  class DomIngestionEngine {
    constructor(options) {
      const opts = options || {};
      this.threshold = typeof opts.threshold === 'number' ? opts.threshold : 0.7;
      this.excludedSelectors = opts.excludedSelectors || [];
      this.onBatchReady = opts.onBatchReady || (() => {});
      this.onSkipped = opts.onSkipped || (() => {});
      this.sequenceCounter = opts.sequenceCounter || 0;
      this.intersectionObserver = null;
      this.mutationObserver = null;
      this.debounceTimer = null;
      this.pendingScanTimer = null;
      this.heartbeatTimer = null;
      this.destroyed = false;
      /** 宿主 → 已处理过的段文本集合（同一段文本不重复翻译） */
      this.processedTexts = new WeakMap();
      /** 宿主 → 状态（done 表示当前文本已全部处理完） */
      this.hostStates = new WeakMap();
      /** 扫描节流 */
      this.scanInterval = 1000;
      this.lastScanAt = 0;
      /** 统计日志节流 */
      this.lastLogText = '';
      this.lastLogAt = 0;
      this.setupIntersectionObserver();
    }

    /** 宿主状态（惰性创建） */
    getHostState(host) {
      let state = this.hostStates.get(host);
      if (!state) {
        state = { done: false };
        this.hostStates.set(host, state);
      }
      return state;
    }

    /** 标记该段文本已处理，避免重复入队 */
    markProcessed(host, text) {
      let set = this.processedTexts.get(host);
      if (!set) {
        set = new Set();
        this.processedTexts.set(host, set);
      }
      set.add(text);
    }

    setupIntersectionObserver() {
      this.intersectionObserver = new IntersectionObserver(
        (entries) => {
          const ready = [];
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const host = entry.target;
            this.intersectionObserver.unobserve(host);

            const state = this.getHostState(host);
            if (state.done) continue;

            // 元素进入视口但仍不可见（如父级 display:none）：等真正可见再处理
            if (!isVisible(host)) {
              try {
                if (host.getClientRects().length === 0) this.intersectionObserver.observe(host);
              } catch (_) {
                /* ignore */
              }
              state.done = false;
              continue;
            }

            const segments = this.prepareSegments(host);
            if (segments.length > 0) ready.push(...segments);
            state.done = true;
          }
          if (ready.length > 0) this.onBatchReady(ready);
        },
        { rootMargin: '400px 0px 600px 0px' },
      );
    }

    /** 是否为插件自身挂载的节点（阻断死循环） */
    static isOwnNode(node) {
      return isOwnElement(node);
    }

    /**
     * 发现「宿主元素」：递归遍历，收集含自身直属文本的块级元素。
     * 白名单标签（p / h1-h6 / li / td …）只要有文本即可作为宿主；
     * 其它块级容器（如 div.article_right）则要求直属文本达到最小长度。
     */
    collectHosts(scope) {
      const hosts = [];
      const seen = new Set();

      const walk = (element, depth) => {
        if (this.destroyed || depth > 60) return;
        if (!element || element.nodeType !== 1) return;
        // 黑名单 / 导航区域：整棵子树跳过
        try {
          if (element.matches(BLACKLIST_SELECTOR)) return;
          if (element.matches(NAV_SELECTOR)) return;
        } catch (_) {
          /* ignore */
        }

        const excluded = this.isExcludedBySiteRule(element);
        const whitelist = !excluded && element.matches(TARGET_SELECTOR);
        const blockLevel = whitelist || isBlockLevel(element);

        if (!excluded && blockLevel) {
          // 菜单型链接块整块跳过：翻译菜单会破坏宿主排版
          if (!whitelist && isMenuLike(element)) {
            /* skip */
          } else {
            const segments = collectOwnSegments(element);
            const usable = segments.filter((segment) => {
              if (segment.text.length > MAX_SEGMENT_LENGTH) return false;
              if (whitelist) return true;
              return segment.text.length >= MIN_SEGMENT_LENGTH;
            });
            if (usable.length > 0 && (whitelist || blockLevel || element === scope)) {
              if (!seen.has(element)) {
                seen.add(element);
                hosts.push({ element, whitelist });
              }
            }
          }
        }

        // 继续深入子元素：块级子元素会作为独立宿主被单独处理
        for (const child of element.children) walk(child, depth + 1);
      };

      walk(scope, 0);
      return hosts;
    }

    /**
     * 把宿主切成可翻译的文本段，并过滤掉不需要翻译的段落。
     * 返回：[{ seqId, host, anchor, text, from }]
     */
    prepareSegments(host) {
      const out = [];
      if (!host || host.nodeType !== 1) return out;
      if (host.closest(`.${CONTAINER_CLASS}`)) return out;
      try {
        if (host.matches(BLACKLIST_SELECTOR)) return out;
        if (host.matches(NAV_SELECTOR)) return out;
      } catch (_) {
        /* ignore */
      }
      if (this.isExcludedBySiteRule(host)) return out;

      const whitelist = host.matches(TARGET_SELECTOR);
      if (!whitelist && isMenuLike(host)) return out;
      const segments = collectOwnSegments(host);
      let skipped = 0;

      for (const segment of segments) {
        const text = segment.text;
        if (!text || text.length > MAX_SEGMENT_LENGTH) continue;
        if (!whitelist && text.length < MIN_SEGMENT_LENGTH) continue;

        const processed = this.processedTexts.get(host);
        if (processed && processed.has(text)) continue;

        // 短标签类文本（HOME / Sign in / Subscribe）直接跳过，不发请求
        if (isLabelLike(text)) {
          this.markProcessed(host, text);
          skipped += 1;
          continue;
        }

        const evaluation = DF.evaluateTextForTranslation(text, this.threshold);
        if (!evaluation.shouldTranslate) {
          this.markProcessed(host, text);
          skipped += 1;
          continue;
        }

        this.markProcessed(host, text);
        this.sequenceCounter += 1;
        out.push({
          seqId: this.sequenceCounter,
          host,
          // 锚点 = 该段最后一个节点，译文容器插在它之后
          anchor: segment.nodes[segment.nodes.length - 1],
          text,
          from: whitelist ? 'whitelist' : 'block',
        });
      }

      if (skipped > 0) this.onSkipped(skipped);
      return out;
    }

    /**
     * 扫描页面：发现宿主 → 交给 IntersectionObserver 判定可见性
     */
    scanDocument(root, options) {
      const force = !!(options && options.force);
      const now = Date.now();

      if (!force && now - this.lastScanAt < this.scanInterval) {
        // 节流：安排一次尾随扫描，保证不会漏掉刚渲染出来的内容
        if (!this.pendingScanTimer) {
          this.pendingScanTimer = setTimeout(() => {
            this.pendingScanTimer = null;
            this.scanDocument();
          }, this.scanInterval);
        }
        return;
      }
      this.lastScanAt = now;

      const scope = root && root.querySelectorAll ? root : document.body;
      if (!scope) return;

      const hosts = this.collectHosts(scope);
      let pending = 0;

      for (const { element } of hosts) {
        const state = this.getHostState(element);
        if (state.done) continue;
        this.intersectionObserver.observe(element);
        pending += 1;
      }

      const logText = `[DualFlow] 扫描完成：宿主 ${hosts.length} → 待处理 ${pending}`;
      if (logText !== this.lastLogText || now - this.lastLogAt > 5000) {
        console.info(logText);
        this.lastLogText = logText;
        this.lastLogAt = now;
      }
    }

    isExcludedBySiteRule(element) {
      for (const selector of this.excludedSelectors) {
        if (!selector) continue;
        try {
          if (element.matches(selector) || element.closest(selector)) return true;
        } catch (_) {
          /* 非法选择器忽略 */
        }
      }
      return false;
    }

    /**
     * 启动 SPA 增量监听（300ms 防抖 + 自身挂载阻断）
     */
    startObservingMutations() {
      if (this.mutationObserver) return;

      this.mutationObserver = new MutationObserver((mutations) => {
        let shouldProcess = false;

        for (const mutation of mutations) {
          if (mutation.type === 'childList') {
            for (const addedNode of mutation.addedNodes) {
              if (DomIngestionEngine.isOwnNode(addedNode)) continue;
              if (addedNode.nodeType === 1 && addedNode.querySelector) {
                if (addedNode.querySelector(`.${CONTAINER_CLASS}`)) continue;
              }
              shouldProcess = true;
              break;
            }
            if (shouldProcess) {
              this.markDirty(mutation.target);
              break;
            }
          } else if (mutation.type === 'characterData') {
            shouldProcess = true;
            this.markDirty(mutation.target);
          }
          if (shouldProcess) break;
        }

        if (!shouldProcess) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          this.scanDocument();
        }, 300);
      });

      this.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });

      // 心跳扫描：兜底处理「元素后来才可见 / 才被 JS 填充」的场景
      this.heartbeatTimer = setInterval(() => {
        this.scanDocument();
      }, 5000);
    }

    /** 宿主内容发生变化 → 置为待处理，等待下一轮观察 */
    markDirty(node) {
      let element = node && node.nodeType === 1 ? node : node && node.parentElement;
      while (element) {
        const state = this.hostStates.get(element);
        if (state) {
          state.done = false;
          return;
        }
        element = element.parentElement;
      }
    }

    /** 立即刷新（不等待防抖 / 节流） */
    refresh() {
      this.scanDocument(null, { force: true });
    }

    destroy() {
      this.destroyed = true;
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      if (this.pendingScanTimer) clearTimeout(this.pendingScanTimer);
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.intersectionObserver.disconnect();
      if (this.mutationObserver) this.mutationObserver.disconnect();
    }
  }

  DF.DomIngestionEngine = DomIngestionEngine;
  /** 暴露文本提取能力（重试时需要剔除已注入的译文） */
  DF.DomIngestionEngine.extractText = extractText;
  DF.DomIngestionEngine.isLabelLike = isLabelLike;
  /** 暴露段切分能力（单元测试使用） */
  DF.DomIngestionEngine.collectOwnSegments = collectOwnSegments;
})();
