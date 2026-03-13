/**
 * 钉钉单账号监控模块
 * 独立于 monitor.account.ts，避免循环依赖
 */

console.log('='.repeat(60));
console.log('[monitor-single.ts] 模块开始加载');
console.log('[monitor-single.ts] 当前 globalMessageHandler 初始值:', null);
console.log('='.repeat(60));

import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { ResolvedDingtalkAccount } from "./types";
import { TOPIC_ROBOT, GATEWAY_URL } from 'dingtalk-stream';
import { 
  isMessageProcessed, 
  markMessageProcessed, 
} from "./utils";

// ============ 类型定义 ============

export type DingtalkReactionCreatedEvent = {
  type: "reaction_created";
  channelId: string;
  messageId: string;
  userId: string;
  emoji: string;
};

export type MonitorDingtalkAccountOpts = {
  cfg: ClawdbotConfig;
  account: ResolvedDingtalkAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

// 消息处理器函数类型
export type MessageHandler = (params: {
  accountId: string;
  config: any;
  data: any;
  sessionWebhook: string;
  runtime?: RuntimeEnv;
  log?: any;
}) => Promise<void>;

// 全局消息处理器（由 monitor.account.ts 设置）
let globalMessageHandler: MessageHandler | null = null;

export function setMessageHandler(handler: MessageHandler): void {
  console.log('='.repeat(60));
  console.log('[monitor-single.ts] setMessageHandler 被调用');
  console.log('[monitor-single.ts] handler 类型:', typeof handler);
  console.log('[monitor-single.ts] handler 是否为函数:', typeof handler === 'function');
  globalMessageHandler = handler;
  console.log('[monitor-single.ts] globalMessageHandler 已设置:', globalMessageHandler !== null);
  console.log('='.repeat(60));
}

export function getMessageHandler(): MessageHandler | null {
  const handler = globalMessageHandler;
  console.log('[monitor-single.ts] getMessageHandler 被调用，返回值:', handler !== null ? '有处理器' : 'null');
  return handler;
}

// ============ 监控账号 ============

export async function monitorSingleAccount(opts: MonitorDingtalkAccountOpts): Promise<void> {
  const { cfg, account, runtime, abortSignal } = opts;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;

  if (!account.clientId || !account.clientSecret) {
    throw new Error(`DingTalk account "${accountId}" missing credentials`);
  }

  log(`[DingTalk][${accountId}] Starting DingTalk Stream client...`);

  // 检查消息处理器是否已设置
  const currentHandler = getMessageHandler();
  log(`[DingTalk][${accountId}] 消息处理器状态：${currentHandler ? '已设置 ✓' : '未设置 ✗'}`);

  // 动态导入 dingtalk-stream 模块，避免动态导入场景下的导出问题
  log(`[DingTalk][${accountId}] 开始动态导入 dingtalk-stream 模块...`);
  const dingtalkStreamModule = await import('dingtalk-stream');
  log(`[DingTalk][${accountId}] dingtalk-stream 模块导入完成，keys:`, Object.keys(dingtalkStreamModule).join(', '));
  
  const DWClient = dingtalkStreamModule.DWClient ?? dingtalkStreamModule.default?.DWClient;
  log(`[DingTalk][${accountId}] DWClient 获取结果：`, DWClient ? '成功 ✓' : '失败 ✗');
  
  if (!DWClient) {
    throw new Error('Failed to import DWClient from dingtalk-stream module');
  }

  log(`[DingTalk][${accountId}] 创建 DWClient 实例...`);
  log(`[DingTalk][${accountId}] 使用网关地址：${GATEWAY_URL}`);
  const client = new DWClient({
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    debug: true, // 启用调试模式，查看详细连接日志
  });
  // 显式设置网关地址，避免使用钉钉后台配置的错误地址
  (client as any).dw_url = GATEWAY_URL;
  log(`[DingTalk][${accountId}] DWClient 实例创建完成，dw_url=${(client as any).dw_url}`);

  return new Promise<void>((resolve, reject) => {
    // Handle abort signal
    if (abortSignal) {
      const onAbort = () => {
        log(`[DingTalk][${accountId}] Abort signal received, stopping...`);
        client.disconnect();
        resolve();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    // Register message handler
    console.log(`[DingTalk][${accountId}] 注册消息监听器...`);
    client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
      const messageId = res.headers?.messageId;
      console.log(`[DingTalk][${accountId}] 收到 Stream 回调，messageId=${messageId}, hasData=${!!res.data}`);

      // 立即确认回调
      if (messageId) {
        client.socketCallBackResponse(messageId, { success: true });
        console.log(`[DingTalk][${accountId}] 已立即确认回调：messageId=${messageId}`);
      }

      // 消息去重
      if (messageId && isMessageProcessed(accountId, messageId)) {
        console.warn(`[DingTalk][${accountId}] 检测到重复消息，跳过处理：messageId=${messageId}`);
        return;
      }

      if (messageId) {
        markMessageProcessed(accountId, messageId);
      }

      // 异步处理消息
      try {
        const data = JSON.parse(res.data);
        console.log(`[DingTalk][${accountId}] 开始处理消息：accountId=${accountId}, hasConfig=${!!account.config}, dataKeys=${Object.keys(data).join(',')}`);
        
        const handler = getMessageHandler();
        if (handler) {
          await handler({
            accountId,
            config: account.config,
            data,
            sessionWebhook: data.sessionWebhook,
            runtime,
            log,
          });
        } else {
          console.error(`[DingTalk][${accountId}] 消息处理器未设置`);
        }
        
        console.log(`[DingTalk][${accountId}] 消息处理完成`);
      } catch (error: any) {
        console.error(`[DingTalk][${accountId}] 处理消息异常：${error.message}\n${error.stack}`);
      }
    });
    console.log(`[DingTalk][${accountId}] 消息监听器注册完成`);

    // Connect to DingTalk Stream
    client.connect()
      .then(() => {
        log(`[DingTalk][${accountId}] Connected to DingTalk Stream`);
      })
      .catch((err) => {
        log(`[DingTalk][${accountId}] Failed to connect: ${err.message}`);
        reject(err);
      });

    // Handle disconnection
    client.on('close', () => {
      log(`[DingTalk][${accountId}] Connection closed`);
      resolve();
    });

    client.on('error', (err: Error) => {
      log(`[DingTalk][${accountId}] Connection error: ${err.message}`);
      reject(err);
    });
  });
}

export function resolveReactionSyntheticEvent(
  event: any,
): DingtalkReactionCreatedEvent | null {
  // DingTalk doesn't support reactions in the same way as Feishu
  return null;
}

console.log('[monitor-single.ts] 模块加载完成，monitorSingleAccount 已导出');
