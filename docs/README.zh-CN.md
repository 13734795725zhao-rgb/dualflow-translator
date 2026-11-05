# DualFlow Translator（双流沉浸译）

> 极轻量、**自带大模型 API Key** 的全语种网页沉浸式双语对照翻译插件。
> 纯前端 Chrome Extension（Manifest V3），零后端、零中间商、零隐私外流。

本项目是《自带 API 大模型双语翻译插件方案》（PRD + 系统技术方案 + UI/UX 设计说明书）的**工程化实现**。

---

## 1. 核心能力

| 能力 | 说明 |
| --- | --- |
| 多厂商 API 仓库 | Base URL + API Key + Model 三段式配置，内置 DeepSeek / OpenAI / Gemini / Claude / SiliconFlow / Kimi / 通义 / 智谱 / Ollama / LM Studio 预设模板 |
| 智能端点拼接 | 缺 `/v1` 自动补全、完整路径不重复拼接、支持「完整端点覆盖」；Popup 与设置页实时展示**实际请求 URL** |
| 一键自检 | 配置 / 端点拼接 / 连通性 Ping / 结果解析 四层体检，逐项给出修复建议 |
| 协议适配 | OpenAI 兼容 `/chat/completions`、Anthropic 原生 `/messages`、Gemini 原生 `:generateContent` |
| 即时切换模型 | Popup 一键切换激活模型，下一批请求立即生效，无需刷新页面 |
| 双语原位注入 | 译文容器**挂在所属段落的锚点节点之后**（同一宿主内可并存多个译文段，互不覆盖），不破坏宿主 Flex/Grid 排版；左侧 2px 科技蓝标线 + 低饱和底色 |
| 导航/标签免打扰 | 自动跳过 `nav`/菜单/面包屑区域、`HOME`、`Sign in` 这类短标签文本，以及「链接占比高且都是短词」的菜单型链接块，不浪费额度也不撑乱菜单 |
| 通用段落识别 | **文本段（segment）切分**：先定位承载正文的宿主元素（任意块级容器），再按 `<br>` 与块级子元素把直属文本切成若干段逐段翻译，兼容「裸文本 + `<br>`」「`div.para`」「`div.article_right`」等非标准结构 |
| 噪音源码过滤 | `<script>` / `<style>` / `<pre>` / `<code>` / `<svg>` 等黑名单元素的内容不会进入待译文本（避免把 `load_file("…")` 这类内联脚本当正文送模型） |
| 中文零成本放行 | 客户端 CJK 纯度判定：纯中文段落 0 毫秒放行，不发起任何 API 请求 |
| 批处理与并发 | 段落数 + 字符预算双重熔断切片，模型级并发信号量 + 429/503 指数退避（带随机抖动） |
| 容灾兜底 | 15 秒强制超时熔断、Markdown 围栏剥离、截断 JSON 自动修复、整批降级为单条重发 |
| 动态页面适配 | IntersectionObserver 视口懒加载（扫描时不可见的元素进入视口后仍会被翻译）+ MutationObserver 300ms 防抖增量扫描（含文本变更监听），自身挂载自动阻断，零死循环 |
| 一键无损还原 | 移除全部 `.flow-translate-container` 与 `data-df-*` 标记，100% 还原原始 DOM |
| **常驻翻译模式** | Popup 里选一次即可对**所有页面**生效：`常开`=打开任何页面都自动翻译、`常关`=任何页面都不自动翻译、`手动`=保持「每个页面点一次开关」的旧行为。站点豁免规则始终优先 |

---

## 2. 安装包

```bash
node scripts/build.mjs      # 生成安装包：npm run build
node scripts/verify-package.mjs   # 校验安装包：npm run verify
npm run release            # 自检 + 联调 + 打包 + 校验 一条龙
```

产物位于 `dist/`：

| 产物 | 用途 |
| --- | --- |
| `dualflow-translator-v1.1.0/` | **加载已解压的扩展程序**直接选这个目录（推荐） |
| `dualflow-translator-v1.1.0.zip` | Chrome Web Store 上传包（商店后台要求 zip），也可解压后加载 |
| `dualflow-translator-v1.1.0.crx` | 自签名 CRX3 本地安装包（密钥存于 `.keys/`，不进包） |
| `dualflow-translator-v1.1.0.sha256` | 校验和清单，便于分发后核对完整性 |

> 说明：Chrome 137+ 已收紧本地 CRX 安装策略，双击 `.crx` 可能被浏览器拦截；
> **本地安装请优先用 `dist/dualflow-translator-v1.1.0/` 目录「加载已解压」**，或把 `.zip` 上传到 Chrome Web Store 走审核分发。

## 3. 安装（免构建）

本项目采用**零依赖、零构建**的原生 ES Module 实现，克隆后即可直接加载：

1. 打开 Chrome，访问 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目根目录（含 `manifest.json` 的那一层）
4. 建议把扩展固定到工具栏（拼图图标 → 右侧图钉）

> Edge / Brave / Arc 等 Chromium 内核浏览器同样适用。
> 快捷键默认为 `Alt + T`（可在 `chrome://extensions/shortcuts` 修改）。

## 4. 快速开始

1. 点击扩展图标 → 右上角 ⚙ 进入**设置页**
2. 「模型仓库」→「+ 添加供应商」→ 选择预设（如 DeepSeek）→ 填入 API Key → 保存
3. 在供应商卡片下「+ 添加模型」（预设已自带常用模型名）→ 保存
4. 回到 Popup，顶部「激活模型」下拉选中该模型 → 选择**翻译模式**：

| 模式 | 行为 |
| --- | --- |
| **手动**（默认） | 每个页面都要点右上角的开关才翻译（不产生任何意外 API 消耗） |
| **常开** | **所有页面打开即自动翻译**，以后新开网页无需再点任何按钮 |
| **常关** | 所有页面都不自动翻译；当前页仍可手动点开关临时翻译 |

> 「常开」对**所有站点**生效，会自动消耗 API 额度。不希望被翻译的站点可在 Popup 底部勾选「在当前站点禁用翻译」，豁免规则优先于常开模式。

翻译结果会以中文对照形式插入在原文正下方；鼠标悬浮译文可**复制**或**单句隐藏**；失败段落显示浅红「重试」条。

---

## 5. 目录结构（与技术方案模块映射）

```
manifest.json                     MV3 清单：权限 / 内容脚本 / 后台 SW / 快捷键
icons/                            16 / 48 / 128 图标
src/
├── shared/                       跨上下文共享层
│   ├── constants.js              NodeProcessStatus / MessageAction / SYS_DEFAULTS / 黑白名单
│   ├── messages.js               跨上下文消息契约（Port 通道 + 统一包裹体）
│   ├── providers.js              供应商预设模板 / Base URL 归一化与校验 / Key 掩码
│   ├── types/storage.js          ProviderConfig / ModelRegistry / DomainRule / AppSettings
│   └── storage/
│       ├── migration.js          Schema 版本检测与缺字段补丁（出厂预设写入）
│       └── storage-client.js     内存快照 + onChanged 热更新 + CRUD + 域名匹配
├── background/                   后台调度管道（Service Worker, type: module）
│   ├── index.js                  Port 接入 / 批处理流水线 / 错误码映射 / 配置广播 / 快捷键
│   ├── pipeline/chunker.js       双重熔断切片（段落数 + 字符预算）
│   ├── pipeline/scheduler.js     并发信号量 + 指数退避（带抖动）
│   └── client/llm-client.js      OpenAI / Anthropic / Gemini 请求装配 + JSON 容错解析
├── content/                      页面 DOM 执行层（经典脚本，共享 DF 命名空间）
│   ├── content.js                主编排：配置装载 / 批缓冲 / 端口通信 / 回填 / 统计
│   ├── filter/cjk-detector.js    CJK 纯度判定（0ms 过滤 + 日韩文识别）
│   ├── ingestion/dom-observer.js TreeWalker 式抓取 / 视口懒加载 / 增量防抖监听
│   ├── render/in-place-renderer.js 骨架态 / 译文态 / 重试态 / 复制 / 隐藏 / 一键还原
│   └── style.css                 注入层强隔离样式（Design Tokens + 明暗双模）
├── popup/                        360×480 快捷控制面板
└── options/                      模型仓库 / 过滤偏好 / 站点规则 / 外观定制
scripts/
├── check.mjs                     离线自检：语法 + manifest + 单元测试 + DOM id 一致性
├── mock-test.mjs                 后台流水线 mock 联调（三协议请求装配）
├── build.mjs                     打包：dist 目录 + ZIP + 自签名 CRX3 + SHA256
└── verify-package.mjs            安装包校验：ZIP 目录 / CRX3 签名 / 资源引用 / 校验和
```

## 6. 消息协议

| Action | 方向 | 说明 |
| --- | --- | --- |
| `REQ_BATCH_TRANSLATE` | Content → Background | Port 长连接发送批量待译段落 `{items:[{seqId,text}]}` |
| `RESP_BATCH_TRANSLATE` | Background → Content | 回填 `{results:[{seqId,translatedText,error,errorCode}]}` |
| `REQ_TEST_CONNECTION` | Options → Background | Ping 探针，返回 `{success,latencyMs,errorMessage}` |
| `EVENT_CONFIG_CHANGED` | Popup/Options → Worker → Content | 配置热更新广播（模型 / 阈值 / 主题 / 自定义 CSS） |
| `CMD_START_TRANSLATION` / `CMD_SWEEP_TRANSLATION` | Popup/快捷键 → Content | 启动翻译 / 一键还原 |
| `REQ_TAB_STATS` / `RESP_TAB_STATS` | Popup → Content | 当前页统计（待译 / 已译 / 跳过 / 失败） |

## 7. 隐私与安全

- API Key、Base URL、请求头仅存于 `chrome.storage.local` 沙箱，**不会**上传任何第三方服务器；
- 所有模型请求由后台 Service Worker **直连**用户配置的端点，扩展内无任何中转/埋点/上报 SDK；
- 日志与错误提示统一走脱敏中间件（剥离 `Bearer`、`sk-`、`key=` 形式的凭据）；
- 权限最小化：`storage` + `activeTab`，外加访问模型端点所需的 `host_permissions`。

## 8. 自检

```bash
node scripts/check.mjs      # 静态自检：npm run check
node scripts/mock-test.mjs  # 管道联调：npm run test:mock
```

- `check.mjs`：全部 JS 语法检查、manifest 与资源存在性、CJK 过滤 10 条 UAT 用例、JSON 容错解析、批处理切片、页面 DOM id 一致性、导航标签过滤规则、**文本段切分（裸文本 + `<br>` 正文结构）**；
- `mock-test.mjs`：以 mock 的 `chrome.*` 与 `fetch` 驱动真实后台流水线，校验存储读取 → 激活模型 → 分块 → HTTP 请求装配（OpenAI / Anthropic / Gemini 三协议端点与鉴权头）→ 响应提取 → 结果回填。

## 9. 与原方案的差异说明

| 项 | 方案原文 | 本实现 | 原因 |
| --- | --- | --- | --- |
| 构建链路 | TypeScript + Vite + @crxjs | 原生 ES Module，零构建 | 免 npm 安装，`加载已解压` 即可运行，源码即运行代码，便于审计 |
| CJK 纯度分母 | 汉字数 / 全部有效字符数 | 汉字数 /（汉字数 + 外文单词数），并新增日文假名 / 韩文谚文直判 | 原公式无法通过方案自身的 UAT 用例 TC-LANG-04（纯日文被误判为中文）与 TC-LANG-05（中文为主的混排被误判为外文） |
| 父子节点 | 同层级块级元素全部抓取 | 仅抓取**最内层**语义节点 | 避免 `li > p`、`td > p` 等结构重复翻译同一段文字 |
| 协议 | 仅 OpenAI 兼容 | 追加 Anthropic / Gemini 原生适配 | 方案预设中包含 Claude 与 Gemini，二者并非 OpenAI 协议 |
| 流式 | 方案提到流式响应 | 统一非流式 | 译文需整段 JSON 解析后回填，流式不带来用户可感知收益，反而增加解析复杂度 |

## 10. 排障速查表（翻译完全没反应时）

> 判断依据：**大模型再慢也会先出现骨架屏**。若页面毫无动静，问题一定在「链路」而不在「模型速度」。

### 第 1 步：分清是哪个控制台在报错

| 控制台 | 打开方式 | 看什么 |
| --- | --- | --- |
| Service Worker（后台发请求） | `chrome://extensions` → 本插件 →「Service Worker」 | Network 面板里的状态码：CORS / 401 / 403 / 404 / 429 |
| 目标网页（DOM 与消息） | 目标页 `F12` → Console | `[DualFlow] 内容脚本已注入｜阈值=…` 是否出现；`[DualFlow] 扫描完成：宿主 N → 待处理 M`；是否 `Could not establish connection` |

后台每次请求都会打印**实际请求的完整 URL**（凭据已脱敏）：

```
[DualFlow] 实际请求的完整 URL: https://api.deepseek.com/v1/chat/completions | 协议=openai | 模型=deepseek-chat
```

Popup 底部也会显示同一条「实际端点」，可直接与 Network 面板对照。

### 第 2 步：四大元凶与对应处理

| 症状 | 根因 | 本插件的处理 |
| --- | --- | --- |
| 请求根本没发出 | 在 Content Script 里 fetch 被页面 CSP 拦 | 请求全部在 **Service Worker** 内发起，不受页面 CSP 约束；`host_permissions` 已含 `https://*/*` 与 `http://*/*` |
| 404 Not Found | Base URL 缺 `/v1`，或重复拼接 `/chat/completions` | 智能拼接：只填域名→自动补 `/v1`；已带完整路径→原样使用；还可用「完整端点覆盖」强制指定 |
| 401 / 403 | Key 无效或无模型权限 | 错误提示直指「密钥无效」「无该模型权限」 |
| 页面完全没反应 | 旧标签页没注入内容脚本 | Popup 会提示并提供 **「刷新页面并翻译」** 一键按钮（刷新后自动开译） |
| HTTP 200 但不渲染 | 模型返回 Markdown 围栏 / 截断 JSON | 解析层自动剥离 ```json 围栏、修复截断数组、正则兜底抽取 |

### 第 3 步：用「一键自检」定位问题

设置页 → 模型仓库 → **「开始自检」**：逐项体检配置 / 端点拼接 / 连通性 Ping / 结果解析。

- 四项全绿 → 配置与 API 都没问题，问题在页面侧（刷新页面、确认内容脚本已注入）；
- 「连通性（Ping）」失败 → 按提示处理 401/403/404/429/超时；
- 「模型配置」失败 → 回设置页补齐 Key 或点「设为默认」。

### 第 4 步：一键自检（推荐）

设置页 → 模型仓库 → **「开始自检」**，逐项给出结论与修复建议：

| 检查项 | 通过标准 | 异常时怎么办 |
| --- | --- | --- |
| 模型配置 | 激活模型 + 供应商 + API Key 齐全 | 按提示点「编辑」补齐 Key / 「设为默认」选模型 |
| 端点拼接 | 打印出的完整 URL 可解析 | URL 不符预期就用「完整端点覆盖」强制指定 |
| 连通性（Ping） | HTTP 200 + 延迟毫秒数 | 401/403→Key 与权限；404→端点路径；429→限流；CORS→服务商未开放浏览器直连 |
| 结果解析 | 本地解析链路正常 | 若此项异常则是扩展内部问题（其他项排查无意义） |

### 常用命令

```bash
npm run check        # 静态自检
npm run test:mock    # 流水线联调（含端点拼接矩阵与自检链路）
npm run build        # 重新打包安装包
```

---

## 11. 已知限制

- 仅处理顶层文档，未注入 iframe（可在 `manifest.json` 的 `content_scripts` 中开启 `all_frames`）；
- 译文在整段 JSON 解析完成后一次性回填，超长段落不会逐字流式显示；
- 首屏之外的段落采用视口懒加载，需滚动到该区域才会触发翻译；
- 不支持 PDF / EPUB 等二进制文档（方案已明确列为非目标范围）。

---

许可：MIT。方案文档版权归原作者所有。


