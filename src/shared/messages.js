/**
 * DualFlow Translator — 跨上下文消息协议定义
 * 对应技术方案文档「第 5 部分：跨上下文通信接口规范」
 */

export const PORT_NAME = 'dualflow-translate';

/** 统一消息包裹体 */
export function createMessage(action, payload, traceId) {
  return {
    action,
    traceId: traceId || `tr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    payload: payload ?? {},
  };
}

/** 批量翻译请求（Content Script -> Background） */
export function createBatchRequest(items, meta) {
  return createMessage('REQ_BATCH_TRANSLATE', {
    items,
    ...(meta || {}),
  });
}

/** 批量翻译回填（Background -> Content Script） */
export function createBatchResponse(traceId, results, extra) {
  return createMessage('RESP_BATCH_TRANSLATE', {
    results,
    ...(extra || {}),
  });
}

/** 生成可读的错误负载 */
export function errorResult(seqId, code, message) {
  return { seqId, translatedText: '', error: message, errorCode: code || 'ERR_UNKNOWN' };
}
