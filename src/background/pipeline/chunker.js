/**
 * 动态分块切片算法：段落数量上限 + 字符预算双重熔断。
 * 对应技术方案文档「3.3 批处理队列与并发调度管道」
 */
export function splitIntoChunks(items, maxBatchSize = 6, maxCharBudget = 1800) {
  const chunks = [];
  let currentChunk = [];
  let currentCharCount = 0;

  for (const item of items) {
    const itemLength = (item.text || '').length;
    const wouldExceedSize = currentChunk.length >= maxBatchSize;
    const wouldExceedBudget = currentCharCount + itemLength > maxCharBudget && currentChunk.length > 0;

    if (wouldExceedSize || wouldExceedBudget) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentCharCount = 0;
    }

    currentChunk.push(item);
    currentCharCount += itemLength;

    // 单条文本本身就超过预算时，单独成块（避免死循环）
    if (currentChunk.length === 1 && itemLength > maxCharBudget) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentCharCount = 0;
    }
  }

  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}
