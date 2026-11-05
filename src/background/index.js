import { storageClient } from '../shared/storage/storage-client.js';
import { runStorageMigration } from '../shared/storage/migration.js';
import { MessageAction, ERROR_CODES } from '../shared/constants.js';
import { PORT_NAME } from '../shared/messages.js';
import { describeEndpoint, buildEndpointUrl, maskApiKey } from '../shared/providers.js';
import { splitIntoChunks } from './pipeline/chunker.js';
import { ConcurrencyScheduler } from './pipeline/scheduler.js';
import {
  translateBatch,
  parseAndSanitizeJSON,
  pingModelEndpoint,
  sanitizeErrorMessage,
} from './client/llm-client.js';

/** 每个模型的并发调度器（内存态，SW 重启后自动重建） */
const modelSchedulers = new Map();
/** 全局并发上限，防止多模型同时打爆服务商 */
const globalScheduler = new ConcurrencyScheduler(6);

/**
 * 获取（或创建）模型级调度器
 */
function getModelScheduler(modelId, concurrency) {
  let scheduler = modelSchedulers.get(modelId);
  if (!scheduler) {
    scheduler = new ConcurrencyScheduler(concurrency);
    modelSchedulers.set(modelId, scheduler);
  } else {
    scheduler.updateConcurrency(concurrency);
  }
  return scheduler;
}

/**
 * 错误码映射
 */
function mapErrorCode(error) {
  const status = error?.status;
  if (status === 401) return 'ERR_UNAUTHORIZED';
  if (status === 403) return 'ERR_FORBIDDEN';
  if (status === 404) return 'ERR_NOT_FOUND';
  if (status === 400) return 'ERR_BAD_REQUEST';
  if (status === 429) return 'ERR_RATE_LIMITED';
  if (status === 408 || error?.name === 'TimeoutError') return 'ERR_NETWORK_TIMEOUT';
  return 'ERR_NETWORK';
}

/**
 * 处理一批翻译请求（完整流水线）
 */
async function processBatchRequest(items, traceId) {
  if (!Array.isArray(items) || items.length === 0) {
    return { results: [], usage: null };
  }

  // 等待存储迁移与快照预热完成
  await readyPromise;

  const snapshot = storageClient.getSnapshot();
  const context = storageClient.getActiveModelContext();
  if (!context) {
    return {
      results: items.map((item) => ({
        seqId: item.seqId,
        translatedText: '',
        error: ERROR_CODES.ERR_NO_ACTIVE_MODEL,
        errorCode: 'ERR_NO_ACTIVE_MODEL',
      })),
      usage: null,
    };
  }

  const { model, provider } = context;
  const settings = snapshot.settings || {};
  const endpoint = describeEndpoint(provider, model);
  const scheduler = getModelScheduler(model.model_id, model.concurrency);

  const chunks = splitIntoChunks(
    items,
    Math.min(15, Math.max(1, settings.batch_size || 6)),
    Math.min(6000, Math.max(200, settings.batch_token_budget || 1800)),
  );

  const allResults = [];
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const runChunk = async (chunk, depth = 0) => {
    await scheduler.acquire();
    await globalScheduler.acquire();
    try {
      // 退避冻结期：等待冷却结束
      while (scheduler.isBackingOff()) {
        await new Promise((resolve) => setTimeout(resolve, scheduler.getBackoffRemainingMs() + 50));
      }

      const { rawContent, usage: chunkUsage, finishReason } = await translateBatch(chunk, provider, model);
      const parsed = parseAndSanitizeJSON(rawContent);

      if (chunkUsage) {
        usage.prompt_tokens += chunkUsage.prompt_tokens || 0;
        usage.completion_tokens += chunkUsage.completion_tokens || 0;
        usage.total_tokens += chunkUsage.total_tokens || 0;
      }

      const truncated = finishReason === 'length' || finishReason === 'max_tokens';
      const missingCount = chunk.filter((item) => !parsed.has(item.seqId)).length;

      // 解析不完整（多半是批次过长被 max_tokens 截断）→ 二分拆批重发
      if (missingCount > 0 && chunk.length > 1 && depth < 2) {
        console.warn(
          `[DualFlow] 第 ${chunk.length} 段有 ${missingCount} 条未能解析（finish_reason=${finishReason || 'n/a'}），拆分为两半重发`,
        );
        const mid = Math.ceil(chunk.length / 2);
        return { status: 'split', left: chunk.slice(0, mid), right: chunk.slice(mid) };
      }

      for (const item of chunk) {
        const value = parsed.get(item.seqId);
        if (value && value.trim() && value.trim() !== '[SKIP]') {
          allResults.push({ seqId: item.seqId, translatedText: value.trim(), error: null });
        } else if (parsed.has(item.seqId)) {
          allResults.push({ seqId: item.seqId, translatedText: '', error: null, skipped: true });
        } else {
          const code = truncated ? 'ERR_TRUNCATED' : 'ERR_JSON_MALFORMED';
          allResults.push({
            seqId: item.seqId,
            translatedText: '',
            error: ERROR_CODES[code] || ERROR_CODES.ERR_JSON_MALFORMED,
            errorCode: code,
          });
        }
      }
      return { status: 'done' };
    } catch (error) {
      const code = mapErrorCode(error);
      const message = ERROR_CODES[code] || ERROR_CODES.ERR_UNKNOWN;
      const detail = sanitizeErrorMessage(error?.message);
      for (const item of chunk) {
        allResults.push({
          seqId: item.seqId,
          translatedText: '',
          error: `${message}｜${detail}｜端点：${endpoint}`,
          errorCode: code,
        });
      }
      return { status: 'error', code };
    } finally {
      globalScheduler.release();
      scheduler.release();
    }
  };

  // 限流退避重试 + 解析失败二分重发
  const runWithRetry = async (chunk, depth = 0) => {
    let attempt = 0;
    for (;;) {
      const before = allResults.length;
      const outcome = await runChunk(chunk, depth);

      if (outcome.status === 'split') {
        await runWithRetry(outcome.left, depth + 1);
        await runWithRetry(outcome.right, depth + 1);
        return;
      }

      const produced = allResults.slice(before);
      const rateLimited = produced.some((r) => r.errorCode === 'ERR_RATE_LIMITED');
      const timeout = produced.some((r) => r.errorCode === 'ERR_NETWORK_TIMEOUT');

      if ((rateLimited || timeout) && attempt < 3) {
        attempt += 1;
        const delay = scheduler.enterBackoff();
        await new Promise((resolve) => setTimeout(resolve, delay));
        // 移除上一轮失败结果，重试时覆盖
        allResults.length = before;
        continue;
      }
      return;
    }
  };

  // 并发执行各分块
  await Promise.all(chunks.map((chunk) => runWithRetry(chunk)));

  // 注：解析失败的单条隔离已由 runChunk 的「二分拆批重发」实现（depth ≤ 2），
  // 因此这里不再重复整批单条重发，避免额外消耗配额。

  return { results: allResults, usage, traceId, endpoint };
}

/**
 * Port 通道：内容脚本 -> 后台 的长连接
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  port.onMessage.addListener(async (message) => {
    if (!message || !message.action) return;

    if (message.action === MessageAction.REQ_BATCH_TRANSLATE) {
      const items = message.payload?.items || [];
      try {
        const result = await processBatchRequest(items, message.traceId);
        port.postMessage({
          action: MessageAction.RESP_BATCH_TRANSLATE,
          traceId: message.traceId,
          payload: result,
        });
      } catch (error) {
        port.postMessage({
          action: MessageAction.RESP_BATCH_TRANSLATE,
          traceId: message.traceId,
          payload: {
            results: items.map((item) => ({
              seqId: item.seqId,
              translatedText: '',
              error: sanitizeErrorMessage(error?.message),
              errorCode: 'ERR_UNKNOWN',
            })),
          },
        });
      }
    }
  });
});

/**
 * 一键自检：把「链路 / 配置 / 端点 / 连通性 / 解析」五层逐项体检
 * 用法：设置页 → 模型仓库 → 「一键自检」
 */
async function runSelfCheck() {
  await readyPromise;
  const snapshot = storageClient.getSnapshot();
  const report = {
    checks: [],
  };

  const push = (name, ok, detail, fix = '') => report.checks.push({ name, ok, detail, fix });

  // 1. 配置完整性
  const activeModelId = snapshot.settings?.active_model_id;
  const model = snapshot.models?.[activeModelId];
  const provider = model ? snapshot.providers?.[model.provider_ref] : null;

  if (!model) {
    push('模型配置', false, '没有选中激活模型', '请在下方模型列表点击「设为默认」');
  } else if (!provider) {
    push('模型配置', false, `模型「${model.display_label || model.model_name}」没有对应的供应商`, '请检查供应商是否被删除');
  } else if (!provider.api_key) {
    push('模型配置', false, `供应商「${provider.name}」尚未填写 API Key`, '点击「编辑」补齐 API Key');
  } else {
    push('模型配置', true, `供应商「${provider.name}」· 模型「${model.model_name}」· Key ${maskApiKey(provider.api_key)}`);
  }

  if (!provider) {
    return report;
  }

  // 2. 端点拼接
  const endpoint = buildEndpointUrl(provider, model);
  let endpointOk = true;
  let endpointDetail = endpoint;
  try {
    const parsed = new URL(endpoint);
    if (!/^https?:$/.test(parsed.protocol)) {
      endpointOk = false;
      endpointDetail = `协议非法：${parsed.protocol}`;
    }
  } catch (_) {
    endpointOk = false;
    endpointDetail = `无法解析为 URL：${endpoint}`;
  }
  if (provider.base_url && !/\/v\d/.test(provider.base_url) && !provider.endpoint_override) {
    endpointDetail += '（Base URL 未含版本号，已自动补全；如不符请用「完整端点覆盖」）';
  }
  push('端点拼接', endpointOk, endpointDetail, endpointOk ? '' : '请修正 Base URL');

  // 3. 连通性（真实 HTTP 探针）
  const ping = await pingModelEndpoint(provider, model);
  push(
    '连通性（Ping）',
    !!ping.success,
    ping.success ? `HTTP 200 · ${ping.latencyMs}ms` : `${ping.errorMessage || '请求失败'}`,
    ping.success ? '' : '401/403→Key 或权限；404→端点路径；429→限流；CORS→服务商未开放浏览器直连',
  );

  // 4. 解析链路自检（用本地样例，不依赖网络）
  const sample = parseAndSanitizeJSON('```json\n[{"id":1,"t":"【自检】解析链路正常"}]\n```');
  const parsedOk = sample.get(1) === '【自检】解析链路正常';
  push('结果解析', parsedOk, parsedOk ? 'Markdown 围栏剥离 + JSON 解析正常' : '本地解析异常（扩展内部问题）');

  return report;
}

/**
 * 一次性消息通道（Options / Popup 使用）
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;

  switch (message.action) {
    case MessageAction.REQ_BATCH_TRANSLATE: {
      // Port 通道不可用时的降级路径
      const items = message.payload?.items || [];
      processBatchRequest(items, message.traceId)
        .then((result) => sendResponse({ action: MessageAction.RESP_BATCH_TRANSLATE, traceId: message.traceId, payload: result }))
        .catch((error) =>
          sendResponse({
            action: MessageAction.RESP_BATCH_TRANSLATE,
            traceId: message.traceId,
            payload: {
              results: items.map((item) => ({
                seqId: item.seqId,
                translatedText: '',
                error: sanitizeErrorMessage(error?.message),
                errorCode: 'ERR_UNKNOWN',
              })),
            },
          }),
        );
      return true; // 异步响应
    }

    case MessageAction.REQ_TEST_CONNECTION: {
      const { provider, model } = message.payload || {};
      if (!provider || !model) {
        sendResponse({ success: false, errorMessage: '缺少供应商或模型参数' });
        return false;
      }
      pingModelEndpoint(provider, model).then((result) => sendResponse(result));
      return true; // 异步响应
    }

    case MessageAction.REQ_SELF_CHECK: {
      runSelfCheck()
        .then((report) => sendResponse({ success: true, report }))
        .catch((error) =>
          sendResponse({ success: false, errorMessage: sanitizeErrorMessage(error?.message) }),
        );
      return true; // 异步响应
    }

    case MessageAction.EVENT_CONFIG_CHANGED: {
      broadcastConfigChanged(message.payload || {});
      sendResponse({ ok: true });
      return false;
    }

    case MessageAction.CMD_START_TRANSLATION:
    case MessageAction.CMD_SWEEP_TRANSLATION: {
      forwardToActiveTab(message.action);
      sendResponse({ ok: true });
      return false;
    }

    default:
      return false;
  }
});

/**
 * 将配置变更广播到全部标签页
 */
async function broadcastConfigChanged(payload) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs
      .sendMessage(tab.id, {
        action: MessageAction.EVENT_CONFIG_CHANGED,
        payload,
      })
      .catch(() => {
        /* 忽略无法注入的页面 */
      });
  }
}

/**
 * 转发指令到当前激活标签页
 */
async function forwardToActiveTab(action) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { action }).catch(() => {
    /* 页面未注入内容脚本时忽略 */
  });
}

/**
 * 快捷键命令
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translate') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  chrome.tabs
    .sendMessage(tab.id, { action: MessageAction.REQ_TAB_STATS })
    .then((response) => {
      const nextAction = response?.isActive
        ? MessageAction.CMD_SWEEP_TRANSLATION
        : MessageAction.CMD_START_TRANSLATION;
      return chrome.tabs.sendMessage(tab.id, { action: nextAction }).catch(() => {});
    })
    .catch(() => {
      chrome.tabs
        .sendMessage(tab.id, { action: MessageAction.CMD_START_TRANSLATION })
        .catch(() => {});
    });
});

/**
 * 初始化：迁移 + 预热快照
 */
async function bootstrap() {
  try {
    await runStorageMigration();
    await storageClient.init();
  } catch (error) {
    console.warn('[DualFlow] 初始化失败：', sanitizeErrorMessage(error?.message));
  }
}

/** 初始化完成信号（供请求链路 await） */
const readyPromise = bootstrap();

chrome.runtime.onInstalled.addListener(() => {
  bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  bootstrap();
});

/** 导出以便离线联调脚本直接驱动整条流水线（不影响 Service Worker 行为） */
export { processBatchRequest, bootstrap, runSelfCheck };
