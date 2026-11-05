/**
 * DualFlow Translator — CJK 汉字纯度判定（零延迟客户端过滤）
 * 对应技术方案文档「3.1 客户端 CJK 汉字纯度判定算法」
 * 内容脚本无法使用 ES Module，此处挂载到隔离世界的全局命名空间 DF。
 */
(function () {
  const DF = (globalThis.DF = globalThis.DF || {});

  /** CJK 统一表意文字基本区 + 扩展区 A */
  const CJK_IDEOGRAPH_REGEX = /[\u4e00-\u9fa5\u3400-\u4dbf]/g;
  const CJK_TEST_REGEX = /[\u4e00-\u9fa5\u3400-\u4dbf]/;

  /** 日文假名（含半角片假名） */
  const JAPANESE_KANA_REGEX = /[\u3040-\u30ff\uff66-\uff9f]/;
  /** 韩文谚文（含兼容字母与字母区） */
  const KOREAN_HANGUL_REGEX = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/;

  /** 空白、标点、数字、符号与控制字符清理正则 */
  const STRIP_REGEX = /[\s\p{P}\p{N}\p{S}\p{C}]/gu;

  /** 词元切分：连续字母（含组合记号）视为一个词 */
  const LETTER_RUN_SPLIT_REGEX = /[^\p{L}\p{M}]+/u;

  /**
   * 统计文本中的「外文单词数」：不含汉字的字母词元个数
   * 注意：必须基于原始文本（含空格）统计，否则英文单词会被粘连成一个大词元。
   */
  function countForeignWords(text) {
    const runs = text.split(LETTER_RUN_SPLIT_REGEX).filter(Boolean);
    let count = 0;
    for (const run of runs) {
      if (!CJK_TEST_REGEX.test(run)) count += 1;
    }
    return count;
  }

  /**
   * 评估文本的汉字密度与翻译必要性
   * @param {string} text
   * @param {number} threshold 汉字纯度阈值（默认 0.70）
   * @returns {{shouldTranslate:boolean, chineseRatio:number, effectiveCharLength:number}}
   */
  function evaluateTextForTranslation(text, threshold = 0.7) {
    if (!text) {
      return { shouldTranslate: false, chineseRatio: 0, effectiveCharLength: 0 };
    }

    const raw = String(text);
    const cleanText = raw.replace(STRIP_REGEX, '');
    const effectiveCharLength = cleanText.length;

    // 极短文本（少于 3 个有效字符）直接豁免
    if (effectiveCharLength < 3) {
      return { shouldTranslate: false, chineseRatio: 0, effectiveCharLength };
    }

    // 日文 / 韩文：命中假名或谚文直接判定为外文
    if (JAPANESE_KANA_REGEX.test(raw) || KOREAN_HANGUL_REGEX.test(raw)) {
      return { shouldTranslate: true, chineseRatio: 0, effectiveCharLength };
    }

    const matchedChinese = cleanText.match(CJK_IDEOGRAPH_REGEX);
    const chineseCount = matchedChinese ? matchedChinese.length : 0;
    const foreignWords = countForeignWords(raw);
    const denominator = chineseCount + foreignWords;
    const chineseRatio = denominator === 0 ? 0 : chineseCount / denominator;

    return {
      shouldTranslate: chineseRatio < threshold,
      chineseRatio,
      effectiveCharLength,
    };
  }

  DF.evaluateTextForTranslation = evaluateTextForTranslation;
  DF.countForeignWords = countForeignWords;
  DF.CJK_IDEOGRAPH_REGEX = CJK_IDEOGRAPH_REGEX;
})();
