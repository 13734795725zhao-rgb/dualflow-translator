import { SYS_DEFAULTS } from '../../shared/constants.js';

/**
 * 并发限流信号量 + 指数退避（带随机抖动）调度器。
 * 对应技术方案文档「3.3 并发限流信号量与退避调度器」
 */
export class ConcurrencyScheduler {
  constructor(maxConcurrency = SYS_DEFAULTS.CONCURRENCY_LIMIT) {
    this.activeCount = 0;
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.waitQueue = [];
    /** 退避截止时间戳（0 表示无退避中） */
    this.backoffUntil = 0;
    this.retryCount = 0;
  }

  updateConcurrency(limit) {
    this.maxConcurrency = Math.min(10, Math.max(1, Number(limit) || 1));
  }

  async acquire() {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount += 1;
      return;
    }
    return new Promise((resolve) => {
      this.waitQueue.push(() => {
        this.activeCount += 1;
        resolve();
      });
    });
  }

  release() {
    this.activeCount = Math.max(0, this.activeCount - 1);
    const next = this.waitQueue.shift();
    if (next) next();
  }

  getActiveCount() {
    return this.activeCount;
  }

  getPendingCount() {
    return this.waitQueue.length;
  }

  /** 是否处于限流退避冻结期 */
  isBackingOff() {
    return Date.now() < this.backoffUntil;
  }

  getBackoffRemainingMs() {
    return Math.max(0, this.backoffUntil - Date.now());
  }

  /**
   * 指数退避计算：min(Tmax, Tbase * 2^retry) + random(0, 500)
   */
  computeBackoffDelay() {
    const attempt = this.retryCount + 1;
    const base = Math.min(
      SYS_DEFAULTS.BACKOFF_MAX_MS,
      SYS_DEFAULTS.BACKOFF_BASE_MS * Math.pow(2, attempt),
    );
    return base + Math.random() * 500;
  }

  enterBackoff() {
    const delay = this.computeBackoffDelay();
    this.retryCount += 1;
    this.backoffUntil = Date.now() + delay;
    return delay;
  }

  resetBackoff() {
    this.retryCount = 0;
    this.backoffUntil = 0;
  }
}

/**
 * 带退避重试的执行包装器：仅对 429 / 503 / 网络瞬时错误重试。
 */
export async function executeWithBackoff(fn, options = {}) {
  const maxRetries = options.maxRetries ?? SYS_DEFAULTS.MAX_RETRY;
  const scheduler = options.scheduler || null;
  let attempt = 0;

  for (;;) {
    try {
      const result = await fn(attempt);
      if (scheduler) scheduler.resetBackoff();
      return result;
    } catch (error) {
      attempt += 1;
      const status = error?.status;
      const retryable = status === 429 || status === 503 || status === 408 || error?.name === 'TimeoutError';
      if (attempt > maxRetries || !retryable) throw error;

      let delay;
      if (scheduler) {
        delay = scheduler.enterBackoff();
      } else {
        delay =
          Math.min(SYS_DEFAULTS.BACKOFF_MAX_MS, SYS_DEFAULTS.BACKOFF_BASE_MS * Math.pow(2, attempt)) +
          Math.random() * 500;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
