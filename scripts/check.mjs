/**
 * DualFlow Translator — 离线自检脚本
 * 1. 语法检查全部 JS 源文件
 * 2. 校验 manifest.json 与其引用的资源是否存在
 * 3. 单元测试：CJK 过滤 / JSON 容错解析 / 批处理切片
 *
 * 运行： node scripts/check.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;

function ok(label) {
  console.log(`  [PASS] ${label}`);
}

function fail(label, detail) {
  failures += 1;
  console.log(`  [FAIL] ${label}${detail ? ` -> ${detail}` : ''}`);
}

/** 递归收集 js 文件 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collect(full, out);
    else if (extname(full) === '.js' || extname(full) === '.mjs') out.push(full);
  }
  return out;
}

console.log('\n[1/8] 语法检查');
for (const file of collect(join(ROOT, 'src'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    ok(relative(ROOT, file));
  } catch (error) {
    fail(relative(ROOT, file), String(error.stderr || error.message).split('\n').slice(0, 3).join(' '));
  }
}

console.log('\n[2/8] manifest 校验');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
].filter(Boolean);

for (const ref of referenced) {
  const full = join(ROOT, ref);
  if (existsSync(full)) ok(ref);
  else fail(ref, '文件缺失');
}

if (manifest.manifest_version === 3) ok('manifest_version = 3');
else fail('manifest_version', '必须为 3');

console.log('\n[3/8] CJK 过滤算法单元测试');
const detectorSource = readFileSync(join(ROOT, 'src/content/filter/cjk-detector.js'), 'utf8');
const sandbox = { globalThis: {} };
vm.createContext(sandbox);
vm.runInContext(detectorSource, sandbox);
const evaluate = sandbox.globalThis.DF.evaluateTextForTranslation;

const cases = [
  { name: '纯简体中文段落应跳过', text: '大语言模型的注意力机制显著提升了长文本理解效率。', expect: false },
  { name: '纯繁体中文段落应跳过', text: '這項技術大幅降低了跨語言溝通的障礙與成本。', expect: false },
  { name: '纯英文技术文档应翻译', text: 'Transformer models rely on self-attention mechanisms to process input.', expect: true },
  { name: '日文应翻译', text: '新しいアーキテクチャは高い効率を実現します。', expect: true },
  { name: '俄文应翻译', text: 'Модель обеспечивает высокую скорость генерации.', expect: true },
  { name: '中文为主的混排应跳过', text: '针对这个 PR，我建议优化一下 API 的吞吐量和 Cache 命中率。', expect: false },
  { name: '英文为主的混排应翻译', text: 'This patch addresses the memory leak described in issue #402. 请尽快合入。', expect: true },
  { name: '纯符号应跳过', text: '---', expect: false },
  { name: '纯数字应跳过', text: '123456789', expect: false },
  { name: '版权声明应翻译', text: '© 2026 All Rights Reserved.', expect: true },
];

for (const testCase of cases) {
  const result = evaluate(testCase.text, 0.7);
  if (result.shouldTranslate === testCase.expect) ok(testCase.name);
  else fail(testCase.name, `期望 ${testCase.expect}，实际 ${result.shouldTranslate}（纯度 ${result.chineseRatio.toFixed(2)}）`);
}

console.log('\n[4/8] JSON 容错解析与批处理切片');
const { parseAndSanitizeJSON, repairTruncatedArray } = await import('../src/background/client/llm-client.js');
const { splitIntoChunks } = await import('../src/background/pipeline/chunker.js');

const plain = parseAndSanitizeJSON('[{"id":1,"t":"你好"},{"id":2,"t":"世界"}]');
if (plain.get(1) === '你好' && plain.get(2) === '世界') ok('标准 JSON 数组解析');
else fail('标准 JSON 数组解析', JSON.stringify([...plain]));

const fenced = parseAndSanitizeJSON('```json\n[{"id":7,"t":"围栏包裹"}]\n```');
if (fenced.get(7) === '围栏包裹') ok('Markdown 围栏剥离');
else fail('Markdown 围栏剥离', JSON.stringify([...fenced]));

const truncated = parseAndSanitizeJSON('[{"id":9,"t":"被截断的译');
if (truncated.get(9) === '被截断的译') ok('截断 JSON 修复');
else fail('截断 JSON 修复', JSON.stringify([...truncated]));

const noisy = parseAndSanitizeJSON('当然可以！以下是翻译：\n[{"id":3,"t":"带解释文本"}]\n希望对你有帮助。');
if (noisy.get(3) === '带解释文本') ok('前后杂质文本容忍');
else fail('前后杂质文本容忍', JSON.stringify([...noisy]));

if (repairTruncatedArray('[{"id":1,"t":"abc').endsWith(']')) ok('截断修复辅助函数');
else fail('截断修复辅助函数');

const chunks = splitIntoChunks(
  [
    { seqId: 1, text: 'a'.repeat(500) },
    { seqId: 2, text: 'b'.repeat(500) },
    { seqId: 3, text: 'c'.repeat(500) },
    { seqId: 4, text: 'd'.repeat(500) },
    { seqId: 5, text: 'e'.repeat(500) },
    { seqId: 6, text: 'f'.repeat(500) },
    { seqId: 7, text: 'g'.repeat(500) },
  ],
  6,
  1800,
);
if (chunks.length >= 2 && chunks.every((chunk) => chunk.length <= 6)) ok('双重熔断切片');
else fail('双重熔断切片', `得到 ${chunks.length} 块`);

console.log('\n[5/8] 页面 DOM id 一致性');
function collectIds(html) {
  const ids = new Set();
  const regex = /id="([^"]+)"/g;
  let match = regex.exec(html);
  while (match !== null) {
    ids.add(match[1]);
    match = regex.exec(html);
  }
  return ids;
}

for (const [page, script] of [
  ['src/popup/popup.html', 'src/popup/popup.js'],
  ['src/options/options.html', 'src/options/options.js'],
]) {
  const html = readFileSync(join(ROOT, page), 'utf8');
  const js = readFileSync(join(ROOT, script), 'utf8');
  const htmlIds = collectIds(html);
  const usedIds = new Set();
  const useRegex = /getElementById\('([^']+)'\)/g;
  let hit = useRegex.exec(js);
  while (hit !== null) {
    usedIds.add(hit[1]);
    hit = useRegex.exec(js);
  }
  const missing = [...usedIds].filter((id) => !htmlIds.has(id));
  if (missing.length === 0) ok(`${page} 的脚本引用 id 全部存在`);
  else fail(`${page} 缺少 id`, missing.join(', '));
}

console.log('\n[6/8] 导航/标签类文本过滤规则');
const ingestionSource = readFileSync(join(ROOT, 'src/content/ingestion/dom-observer.js'), 'utf8');
const ingestionSandbox = { globalThis: {}, document: {}, window: {} };
vm.createContext(ingestionSandbox);
vm.runInContext(ingestionSource, ingestionSandbox);
const isLabelLike = ingestionSandbox.globalThis.DF.DomIngestionEngine.isLabelLike;

const labelCases = [
  ['HOME', true],
  ['CHINA', true],
  ['BUSINESS', true],
  ['OPINION', true],
  ['IN-DEPTH', true],
  ['Sign in', true],
  ['Newsletter', true],
  ['Subscribe', true],
  ['Global Times', true],
  ['Photo: Reuters', true],
  ['Hello world.', false],
  [
    'China in communication with relevant parties regarding a meeting of the Chinese, Russian and US leaders: Chinese FM',
    false,
  ],
  [
    "Taiwan region can participate in the Asia-Pacific Economic Cooperation (APEC) Economic Leaders' Meeting as long as it follows the one-China principle.",
    false,
  ],
];

for (const [text, expected] of labelCases) {
  const actual = isLabelLike(text);
  if (actual === expected) ok(`「${text.slice(0, 34)}${text.length > 34 ? '…' : ''}」→ ${actual ? '按标签跳过' : '正常翻译'}`);
  else fail(`「${text.slice(0, 34)}」`, `期望 ${expected}，实际 ${actual}`);
}

console.log('\n[7/8] 段落级翻译（Global Times 真实页面结构）');
/* ---------------- 迷你 DOM（只实现抓取层用到的接口） ---------------- */
class MiniText {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    this.parentNode = null;
    this.childNodes = [];
  }
  get textContent() {
    return this.data;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
}

/** 支持 tag / .class / [attr="value"] 三种简单选择器 */
function matchSimple(el, sel) {
  if (!sel) return false;
  const attrMatch = sel.match(/^\[([\w-]+)=["']?([^\]"']*)["']?\]$/);
  if (attrMatch) return el.attrs[attrMatch[1]] === attrMatch[2];
  const parts = sel.split('.');
  const tag = parts[0];
  if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  for (const cls of parts.slice(1)) if (!el.classes.includes(cls)) return false;
  return true;
}

class MiniElement {
  constructor(tag, attrs = {}, children = []) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.classes = (this.attrs.class || '').split(/\s+/).filter(Boolean);
    this.childNodes = [];
    this.parentNode = null;
    this.classList = { contains: (name) => this.classes.includes(name) };
    for (const child of children) this.append(child);
  }
  append(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join('');
  }
  matches(selector) {
    return selector.split(',').some((part) => matchSimple(this, part.trim()));
  }
  closest(selector) {
    let el = this;
    while (el) {
      if (el.matches(selector)) return el;
      el = el.parentElement;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  get offsetParent() {
    return this.parentElement;
  }
  getClientRects() {
    return [{}];
  }
}

const T = (data) => new MiniText(data);
const E = (tag, attrs, ...children) => new MiniElement(tag, attrs || {}, children.flat());

const DISPLAY_MAP = {
  div: 'block', p: 'block', center: 'block', ul: 'block', ol: 'block', li: 'list-item',
  h1: 'block', h2: 'block', h3: 'block', h4: 'block', h5: 'block', h6: 'block',
  section: 'block', article: 'block', header: 'block', footer: 'block', nav: 'block',
  table: 'block', tbody: 'block', tr: 'table-row', td: 'table-cell', th: 'table-cell',
  span: 'inline', a: 'inline', b: 'inline', i: 'inline', em: 'inline', strong: 'inline',
  br: 'inline', img: 'inline', time: 'inline', script: 'none', style: 'none', noscript: 'none',
};

class MiniIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
  }
  observe(el) {
    this.targets.add(el);
  }
  unobserve(el) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  /** 测试辅助：模拟全部进入视口 */
  flush() {
    const entries = [...this.targets].map((target) => ({ target, isIntersecting: true }));
    this.targets.clear();
    this.callback(entries, this);
  }
}

/* ---------------- Global Times 真实页面结构 ---------------- */
const GT_CAPTION =
  'Chinese Foreign Minister Wang Yi, also a member of the Political Bureau of the Communist Party of China Central Committee, and Chinese Minister of Commerce Wang Wentao co-chair the 37th Asia-Pacific Economic Cooperation (APEC) Ministerial Meeting via video conference in Beijing, capital of China, Nov. 3, 2026. (Xinhua/Tian Yu)';
const GT_TITLE =
  "China willing to work with parties for fruitful APEC Economic Leaders' Meeting: top diplomat";
const GT_PARAGRAPHS = [
  'China is willing to work with all parties to do a good job in the final stage of the 2026 APEC "China Year" and contribute to the fruitful results at the upcoming Asia-Pacific Economic Cooperation (APEC) Economic Leaders\' Meeting, Chinese Foreign Minister Wang Yi said on Tuesday.',
  "The upcoming leaders' meeting is an important one concerning the future development of the Asia-Pacific region, Wang said when co-chairing the 37th APEC Ministerial Meeting via video conference with Minister of Commerce Wang Wentao.",
  "China will host the 33rd APEC Economic Leaders' Meeting in Shenzhen in south China in November this year, which will mark the country's third hosting of the event following Shanghai in 2001 and Beijing in 2014. The theme of this year's summit is \"Building an Asia-Pacific Community to Prosper Together,\" while China has identified openness, innovation and cooperation as the three priority areas for this year's APEC cooperation.",
  'More than 300 meetings and events have been successfully held during the APEC "China Year," producing a series of cooperation outcomes, said Wang Yi, who is also a member of the Political Bureau of the Communist Party of China Central Committee.',
  'Expressing readiness to work with all members to make solid and substantive progress in building an Asia-Pacific community, he called on members to uphold mutual respect, deepen solidarity, foster an open environment and sustain the momentum of integration.',
  'He said all members should jointly build an innovation ecosystem to cultivate new growth drivers, and expand pathways for cooperation and achieve sustainable development.',
  'APEC parties should continue to contribute practical and effective "Asia-Pacific solutions" to the development of the Asia-Pacific region and the world at large, Commerce Minister Wang Wentao said.',
  'He noted the international situation is fraught with changes and turmoil, risks of fragmentation in industrial and supply chains are mounting, and the world economy is growing sluggishly.',
  'He called on all APEC parties to uphold free trade and innovation-driven development, foster a vibrant engine for growth, advance discussions and policy coordination on digital and intelligent economic and trade rules, and build a fair and equitable international economic and trade order.',
  'China will always stay committed to promoting high-level opening up, fully implementing national treatment for foreign-funded enterprises, and encouraging the open-source development and cooperation of new technologies such as artificial intelligence, the commerce minister noted.',
  'Representatives of APEC economies and other participants commended the progress of cooperation in various fields and the extensive consensus reached by all parties during the APEC "China Year", expressing their willingness to work with China for the success of the leaders\' meeting.',
];

const gtRightChildren = [
  T(' '),
  E('center', {}, E('img', { id: '798509', src: 'a.jpeg' })),
  T('\n'),
  E('p', { class: 'picture', style: 'font-size: 13px' }, T(GT_CAPTION)),
  E('br'),
  E('br'),
];
for (const paragraph of GT_PARAGRAPHS) {
  gtRightChildren.push(T(paragraph), E('br'), E('br'));
}
gtRightChildren.push(
  T('\n'),
  E('center', {}, E('img', { id: '798510', src: 'b.jpeg' })),
  T('\n'),
  E('p', { class: 'picture', style: 'font-size: 13px' }, T(GT_CAPTION)),
  E('br'),
  T(' '),
  E('br'),
  T('\n'),
);
const gtArticleRight = E('div', { class: 'article_right' }, gtRightChildren);
const gtTitle = E('div', { class: 'article_title' }, T(GT_TITLE));
const gtColumn = E(
  'div',
  { class: 'article_column' },
  E('span', { class: 'cloumm_level_one' }, E('a', { href: '#' }, T('CHINA'))),
  T('\u00a0/\u00a0'),
  E('span', { class: 'cloumm_level_two' }, E('a', { href: '#' }, T('SOCIETY'))),
);
const gtShare = E(
  'span',
  { class: 'article_top_share share_section' },
  E('script', {}, T(' load_file("/includes-n/article_share_new.html"); ')),
);
const gtByline = E(
  'div',
  { class: 'author_share_left' },
  E('span', { class: 'byline' }, T('By Xinhua ')),
  E('span', { class: 'pub_time' }, T('Published: Nov 04, 2026 08:48 AM')),
);
const gtPage = E(
  'body',
  {},
  E(
    'div',
    { class: 'container article_section' },
    E(
      'div',
      { class: 'row' },
      E(
        'div',
        { class: 'article_page' },
        E(
          'div',
          { class: 'article_left' },
          E(
            'ul',
            { class: 'article_left_share share_section' },
            E('script', {}, T(' load_file("/includes-n/float_share_new.html"); ')),
          ),
        ),
        E(
          'div',
          { class: 'article' },
          E('div', { class: 'article_top' }, gtColumn, gtTitle, E('div', { class: 'author_share' }, gtByline, gtShare)),
          E('div', { class: 'article_content' }, gtArticleRight),
          E(
            'div',
            { class: 'article_footer' },
            E(
              'div',
              { class: 'article_footer_share share_section' },
              E('script', {}, T(' load_file("/includes-n/article_share_new.html"); ')),
            ),
          ),
        ),
      ),
    ),
  ),
);

/* ---------------- 在迷你 DOM 上跑真实抓取引擎 ---------------- */
const domSandbox = {
  globalThis: {},
  document: { body: gtPage },
  window: {
    getComputedStyle: (el) => ({
      display: DISPLAY_MAP[(el.tagName || '').toLowerCase()] || 'inline',
      position: 'static',
    }),
  },
  IntersectionObserver: MiniIntersectionObserver,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console: { info() {}, warn() {}, error() {}, log() {} },
};
vm.createContext(domSandbox);
vm.runInContext(detectorSource, domSandbox);
vm.runInContext(ingestionSource, domSandbox);

const collected = [];
const engine = new domSandbox.globalThis.DF.DomIngestionEngine({
  threshold: 0.7,
  excludedSelectors: [],
  onBatchReady: (items) => collected.push(...items),
  onSkipped: () => {},
});
engine.scanDocument(gtPage, { force: true });
engine.intersectionObserver.flush();

const bodyItems = collected.filter((item) => item.host === gtArticleRight);
if (bodyItems.length === GT_PARAGRAPHS.length) {
  ok(`正文按自然段切成 ${bodyItems.length} 段（每个 <br><br> 之间为一段）`);
} else {
  fail('正文段落数', `期望 ${GT_PARAGRAPHS.length} 段，实际 ${bodyItems.length} 段`);
}

const mismatched = bodyItems.filter((item, i) => item.text !== GT_PARAGRAPHS[i]);
if (mismatched.length === 0 && bodyItems.length === GT_PARAGRAPHS.length) {
  ok('每段原文与自然段一一对应（未合并、未截断）');
} else {
  fail('段落对应关系', JSON.stringify(mismatched.map((m) => m.text.slice(0, 48))));
}

const anchorBroken = bodyItems.filter((item) => !item.anchor || item.anchor.parentElement !== item.host);
if (anchorBroken.length === 0) ok('每段锚点直属宿主（译文可精确插到该段之后）');
else fail('锚点归属', `${anchorBroken.length} 段锚点异常`);

const blobItem = collected.find(
  (item) => item.text.includes(GT_PARAGRAPHS[0]) && item.text.includes(GT_PARAGRAPHS[10]),
);
if (!blobItem) ok('正文未被打包成整块请求（逐段下发）');
else fail('整块请求', '存在包含多个自然段的条目');

const leaked = collected.filter((item) => /load_file|<script/.test(item.text));
if (leaked.length === 0) ok('内联 <script> 代码未泄漏进待译文本');
else fail('脚本泄漏', JSON.stringify(leaked.map((i) => i.text)));

const navItems = collected.filter((item) => item.text.includes('CHINA'));
if (navItems.length === 0) ok('频道列（CHINA / SOCIETY）未进入翻译队列');
else fail('导航列泄漏', JSON.stringify(navItems.map((i) => i.text)));

const titleItems = collected.filter((item) => item.host === gtTitle);
if (titleItems.length === 1 && titleItems[0].text === GT_TITLE) ok('标题单独成段');
else fail('标题段', JSON.stringify(titleItems.map((i) => i.text)));

const captionItems = collected.filter((item) => item.text === GT_CAPTION);
if (captionItems.length === 2) ok('两张图片的图注各自成段');
else fail('图注段', `期望 2 段，实际 ${captionItems.length} 段`);

if (collected.length === GT_PARAGRAPHS.length + 4) ok(`全页共 ${collected.length} 个待译段（正文 11 + 图注 2 + 标题 1 + 作者行 1）`);
else fail('待译段总数', `得到 ${collected.length} 段：${JSON.stringify(collected.map((i) => i.text.slice(0, 24)))}`);

/* ---------------- 段切分基础规则 ---------------- */
const collectOwnSegments = domSandbox.globalThis.DF.DomIngestionEngine.collectOwnSegments;

const inlineHost = E('p', {}, T('Hello '), E('b', {}, T('world')), T(' today'));
const inlineSegments = collectOwnSegments(inlineHost);
if (inlineSegments.length === 1 && inlineSegments[0].text === 'Hello world today') ok('行内元素合并为单段');
else fail('行内元素合并', JSON.stringify(inlineSegments.map((s) => s.text)));

const injectedHost = E(
  'div',
  {},
  T('First paragraph text here.'),
  E('div', { class: 'flow-translate-container' }, T('译文：这是注入的中文')),
  T('Second paragraph text here.'),
);
const injectedSegments = collectOwnSegments(injectedHost);
if (injectedSegments.length === 2 && injectedSegments.every((s) => !s.text.includes('注入的中文'))) {
  ok('自身注入的译文容器被排除且正确断段');
} else {
  fail('注入节点排除', JSON.stringify(injectedSegments.map((s) => s.text)));
}

const scriptHost = E('div', {}, T('Real body text goes here.'), E('script', {}, T(' load_file("/x.html"); ')));
const scriptSegments = collectOwnSegments(scriptHost);
if (scriptSegments.length === 1 && !scriptSegments[0].text.includes('load_file')) {
  ok('黑名单元素（script/style）内容不进正文段');
} else {
  fail('脚本内容过滤', JSON.stringify(scriptSegments.map((s) => s.text)));
}

console.log('\n[8/8] 翻译常驻模式（一次设置，所有页面生效）');
const constants = await import('../src/shared/constants.js');
const { buildDefaultSchema } = await import('../src/shared/storage/migration.js');

const modeValues = Object.values(constants.TranslateMode);
if (
  modeValues.includes('manual') &&
  modeValues.includes('always_on') &&
  modeValues.includes('always_off')
) {
  ok(`模式枚举齐全：${modeValues.join(' / ')}`);
} else {
  fail('模式枚举', modeValues.join(', '));
}

if (constants.SYS_DEFAULTS.TRANSLATE_MODE === 'manual') ok('默认模式为 manual（不产生意外 API 消耗）');
else fail('默认模式', String(constants.SYS_DEFAULTS.TRANSLATE_MODE));

for (const mode of modeValues) {
  if (constants.TRANSLATE_MODE_META[mode]?.label && constants.TRANSLATE_MODE_META[mode]?.hint) {
    ok(`模式「${constants.TRANSLATE_MODE_META[mode].label}」有标签与说明`);
  } else {
    fail('模式文案缺失', mode);
  }
}

const defaultSettings = buildDefaultSchema().settings;
if (defaultSettings.translate_mode === 'manual') ok('出厂 schema 含 translate_mode = manual');
else fail('出厂 schema', String(defaultSettings.translate_mode));

const contentSource = readFileSync(join(ROOT, 'src/content/content.js'), 'utf8');
const modeBranches = ['always_on', 'always_off', 'applyTranslateMode', 'translate_mode'];
const missingBranches = modeBranches.filter((token) => !contentSource.includes(token));
if (missingBranches.length === 0) ok('内容脚本实现了常开 / 常关分支（auto_translate 兼容）');
else fail('内容脚本模式分支', `缺少 ${missingBranches.join(', ')}`);

const popupHtml = readFileSync(join(ROOT, 'src/popup/popup.html'), 'utf8');
const popupModes = ['manual', 'always_on', 'always_off'].filter(
  (mode) => !popupHtml.includes(`data-mode="${mode}"`),
);
if (popupModes.length === 0) ok('Popup 提供三态模式控件（手动 / 常开 / 常关）');
else fail('Popup 模式控件', `缺少 ${popupModes.join(', ')}`);

console.log(`\n结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
