import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import * as monitorState from "./monitor.state";

// 只解构 monitorState 的导出
const {
  clearDingtalkWebhookRateLimitStateForTest,
  getDingtalkWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
  stopDingtalkMonitorState,
} = monitorState;

console.log('[monitor.ts] 模块加载完成');

export type MonitorDingtalkOpts = {
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

export {
  clearDingtalkWebhookRateLimitStateForTest,
  getDingtalkWebhookRateLimitStateSizeForTest,
  isWebhookRateLimitedForTest,
} from "./monitor.state";

// 重新导出 monitor-single 的内容（使用 re-export 避免循环依赖）
export {
  monitorSingleAccount,
  resolveReactionSyntheticEvent,
} from "./monitor-single";

export type { DingtalkReactionCreatedEvent } from "./monitor-single";

export async function monitorDingtalkProvider(opts: MonitorDingtalkOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for DingTalk monitor");
  }

  const log = opts.runtime?.log ?? console.log;

  log?.info?.(`[monitorDingtalkProvider] 开始执行，accountId=${opts.accountId}`);

  // 在函数内部动态导入模块，避免循环依赖导致的初始化问题
  // 顺序导入：先导入 monitor.account.ts 设置消息处理器，再导入 monitor-single.ts 注册监听器
  // 不能使用 Promise.all 并行导入，因为 monitor-single.ts 的顶层代码会立即执行，
  // 而 monitor.account.ts 的顶层代码需要先生设置消息处理器
  const accountsModule = await import("./accounts");
  await import("./monitor.account"); // 先执行，设置消息处理器
  const monitorSingleModule = await import("./monitor-single"); // 后执行，注册监听器
  
  const { resolveDingtalkAccount, listEnabledDingtalkAccounts } = accountsModule;
  const { monitorSingleAccount, resolveReactionSyntheticEvent } = monitorSingleModule;

  if (opts.accountId) {
    log?.info?.(`[monitorDingtalkProvider] 监控单个账号：${opts.accountId}`);
    const account = resolveDingtalkAccount({ cfg, accountId: opts.accountId });
    if (!account.enabled || !account.configured) {
      throw new Error(`DingTalk account "${opts.accountId}" not configured or disabled`);
    }
    log?.info?.(`[monitorDingtalkProvider] 调用 monitorSingleAccount for ${opts.accountId}`);
    log?.info?.(`[monitorDingtalkProvider] monitorSingleAccount 类型：${typeof monitorSingleAccount}`);
    if (typeof monitorSingleAccount !== 'function') {
      log?.error?.(`[monitorDingtalkProvider] monitorSingleAccount 不是函数！类型：${typeof monitorSingleAccount}`);
      throw new Error(`monitorSingleAccount is not a function, type: ${typeof monitorSingleAccount}`);
    }
    return monitorSingleAccount({
      cfg,
      account,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
    });
  }

  const accounts = listEnabledDingtalkAccounts(cfg);
  log?.info?.(`[monitorDingtalkProvider] 找到 ${accounts.length} 个启用的账号`);
  if (accounts.length === 0) {
    throw new Error("No enabled DingTalk accounts configured");
  }

  log?.info?.(
    `dingtalk-connector: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`,
  );

  const monitorPromises: Promise<void>[] = [];
  for (const account of accounts) {
    if (opts.abortSignal?.aborted) {
      log("dingtalk-connector: abort signal received during startup preflight; stopping startup");
      break;
    }

    log?.info?.(`[monitorDingtalkProvider] 准备启动账号：${account.accountId}`);
    monitorPromises.push(
      monitorSingleAccount({
        cfg,
        account,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
      }),
    );
  }

  await Promise.all(monitorPromises);
}

export function stopDingtalkMonitor(accountId?: string): void {
  stopDingtalkMonitorState(accountId);
}