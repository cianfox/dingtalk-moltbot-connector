/**
 * 钉钉单账号监控模块
 * 独立于 monitor.account.ts，避免循环依赖
 */

import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { ResolvedDingtalkAccount } from "./types";
import { TOPIC_ROBOT, GATEWAY_URL } from 'dingtalk-stream';
import { acquireProcessLock, releaseProcessLock, registerLockCleanup } from './process-lock';

// ============ 消息去重（内置，避免循环依赖） ============

/** 消息去重缓存 Map<messageId, timestamp> */
const processedMessages = new Map<string, number>();

/** 消息去重缓存过期时间（5 分钟） */
const MESSAGE_DEDUP_TTL = 5 * 60 * 1000;

/** 清理过期的消息去重缓存 */
function cleanupProcessedMessages(): void {
  const now = Date.now();
  for (const [msgId, timestamp] of processedMessages.entries()) {
    if (now - timestamp > MESSAGE_DEDUP_TTL) {
      processedMessages.delete(msgId);
    }
  }
}

/** 检查消息是否已处理过（去重） */
function isMessageProcessed(messageId: string): boolean {
  if (!messageId) return false;
  return processedMessages.has(messageId);
}

/** 标记消息为已处理 */
function markMessageProcessed(messageId: string): void {
  if (!messageId) return;
  processedMessages.set(messageId, Date.now());
  // 定期清理（每处理 100 条消息清理一次）
  if (processedMessages.size >= 100) {
    cleanupProcessedMessages();
  }
}

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
  messageHandler: MessageHandler; // 直接传入消息处理器
};

// 消息处理器函数类型
export type MessageHandler = (params: {
  accountId: string;
  config: any;
  data: any;
  sessionWebhook: string;
  runtime?: RuntimeEnv;
  log?: any;
  cfg: ClawdbotConfig;
}) => Promise<void>;

// ============ 监控账号 ============

export async function monitorSingleAccount(opts: MonitorDingtalkAccountOpts): Promise<void> {
  const { cfg, account, runtime, abortSignal, messageHandler } = opts;
  const { accountId } = account;
  
  // 保存 cfg 以便传递给 messageHandler
  const clawdbotConfig = cfg;
  const log = runtime?.log ?? console.log;

  // ===== 进程锁检查：防止多个进程同时监控同一个账号 =====
  if (!acquireProcessLock(accountId)) {
    throw new Error(
      `[DingTalk][${accountId}] 无法获取进程锁！\n` +
      `该账号已被另一个 OpenClaw 进程监控。\n` +
      `请检查是否有多个 OpenClaw 进程在运行：\n` +
      `  ps aux | grep openclaw\n` +
      `如需停止所有进程：\n` +
      `  pkill -9 -f openclaw`
    );
  }

  // 注册进程退出时自动释放锁
  registerLockCleanup(accountId);
  log(`[DingTalk][${accountId}] ✅ 成功获取进程锁，开始监控...`);

  // 验证凭据是否存在
  if (!account.clientId || !account.clientSecret) {
    releaseProcessLock(accountId); // 释放锁
    throw new Error(
      `[DingTalk][${accountId}] Missing credentials: ` +
      `clientId=${!!account.clientId ? 'present' : 'MISSING'}, ` +
      `clientSecret=${!!account.clientSecret ? 'present' : 'MISSING'}. ` +
      `Please check your configuration in channels.dingtalk-connector.`
    );
  }

  // 验证凭据格式
  const clientIdStr = String(account.clientId);
  const clientSecretStr = String(account.clientSecret);
  
  if (clientIdStr.length < 10 || clientSecretStr.length < 10) {
    throw new Error(
      `[DingTalk][${accountId}] Invalid credentials format: ` +
      `clientId length=${clientIdStr.length}, clientSecret length=${clientSecretStr.length}. ` +
      `Credentials appear to be too short or invalid.`
    );
  }

  log(`[DingTalk][${accountId}] Starting DingTalk Stream client...`);
  log?.info?.(
    `[DingTalk][${accountId}] Initializing with clientId: ${clientIdStr.substring(0, 8)}...`
  );
  log?.info?.(
    `[DingTalk][${accountId}] WebSocket keepAlive: false (using application-layer heartbeat)`
  );

  // 动态导入 dingtalk-stream 模块
  const dingtalkStreamModule = await import('dingtalk-stream');
  const DWClient = dingtalkStreamModule.DWClient ?? dingtalkStreamModule.default?.DWClient;
  
  if (!DWClient) {
    throw new Error('Failed to import DWClient from dingtalk-stream module');
  }
  
  // 配置 DWClient：关闭 SDK 内置的 keepAlive，使用应用层自定义心跳
  // - autoReconnect: true（SDK 在 close 事件时自动重连）
  // - keepAlive: false（关闭 SDK 的激进心跳检测，避免 15 秒超时强制终止连接）
  // - 注意：通过 isReconnecting 锁避免 SDK 和 应用层的双重 重连冲突
  const client = new DWClient({
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    debug: false,
    autoReconnect: true,
    keepAlive: false,
  } as any);

  return new Promise<void>(async (resolve, reject) => {
    // Handle abort signal
    if (abortSignal) {
      const onAbort = () => {
        log(`[DingTalk][${accountId}] Abort signal received, stopping...`);
        clearInterval(statsInterval);
        clearInterval(heartbeatTimer);
        releaseProcessLock(accountId); // 释放锁
        client.disconnect();
        resolve();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    // 【重连状态锁】避免 SDK 和 应用层的双重 重连冲突
    // - SDK 的 autoReconnect 会在 close 事件时触发重连
    // - 应用层心跳定时器也会在超时时触发重连
    // - 通过此锁确保同一时间只有一个重连在运行
    let isReconnecting = false;

    // 消息接收统计（用于检测消息丢失）
    let receivedCount = 0;
    let processedCount = 0;
    let lastMessageTime = Date.now();

    // 定期输出统计信息
    const statsInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastMessage = Math.round((now - lastMessageTime) / 1000);
      log?.info?.(
        `[DingTalk][${accountId}] 统计：收到=${receivedCount}, 处理=${processedCount}, ` +
        `丢失=${receivedCount - processedCount}, 距上次消息=${timeSinceLastMessage}s`
      );
    }, 60000); // 每分钟输出一次

    // 【应用层心跳机制】自定义温和的心跳检测，避免 SDK 的激进检测
    // - 心跳间隔：30 秒（比 SDK 的 8 秒更宽松）
    // - 超时时间：90 秒（允许 3 次心跳丢失）
    // - 检测方式：检查最后收到消息的时间，如果超时则主动重连
    const HEARTBEAT_INTERVAL = 30 * 1000; // 30 秒
    const HEARTBEAT_TIMEOUT = 90 * 1000;  // 90 秒
    
    // 启动心跳检测定时器
    const heartbeatTimer = setInterval(async () => {
      const elapsed = Date.now() - lastMessageTime;
      
      // 如果超过 90 秒没有收到任何消息（包括心跳），认为连接可能已断开
      if (elapsed > HEARTBEAT_TIMEOUT) {
        // 【重连状态锁】检查是否已有重连在运行，避免与 SDK 的 autoReconnect 冲突
        if (isReconnecting) {
          log?.debug?.(`[${accountId}] 重连中，跳过心跳超时检测`);
          return;
        }
        
        log?.warn?.(`[${accountId}] ⚠️ 心跳超时：已 ${Math.round(elapsed / 1000)} 秒未收到消息，触发重连...`);
        
        // 主动重连：先断开再重新建立连接
        isReconnecting = true;
        try {
          await client.disconnect();
          log?.info?.(`[${accountId}] 已断开旧连接`);
          
          await client.connect();
          lastMessageTime = Date.now();
          
          log?.info?.(`[${accountId}] ✅ 重连成功`);
        } catch (err: any) {
          log?.error?.(`[${accountId}] ❌ 重连失败：${err.message}`);
          // 重连失败后，等待 5 秒后再次尝试
          log?.info?.(`[${accountId}] 5 秒后再次尝试重连...`);
          setTimeout(async () => {
            try {
              await client.connect();
              lastMessageTime = Date.now();
              log?.info?.(`[${accountId}] ✅ 重试重连成功`);
            } catch (retryErr: any) {
              log?.error?.(`[${accountId}] ❌ 重试重连失败：${retryErr.message}`);
            }
          }, 5000);
        } finally {
          isReconnecting = false;
        }
      }
    }, HEARTBEAT_INTERVAL);

    // Register message handler
    client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
      receivedCount++;
      lastMessageTime = Date.now();
      const messageId = res.headers?.messageId;
      const timestamp = new Date().toISOString();
      
      // ===== 第一步：记录原始消息接收 =====
      console.log(`\n========== [DingTalk][${accountId}] 收到新消息 ==========`);
      console.log(`时间: ${timestamp}`);
      console.log(`MessageId: ${messageId || 'N/A'}`);
      console.log(`Headers: ${JSON.stringify(res.headers || {})}`);
      console.log(`Data 长度: ${res.data?.length || 0} 字符`);

      // 立即确认回调
      if (messageId) {
        client.socketCallBackResponse(messageId, { success: true });
        console.log(`[DingTalk][${accountId}] ✅ 已立即确认回调: messageId=${messageId}`);
      } else {
        console.warn(`[DingTalk][${accountId}] ⚠️ 警告: 消息没有 messageId`);
      }

      // 消息去重
      if (messageId && isMessageProcessed(messageId)) {
        console.warn(`[DingTalk][${accountId}] ⚠️ 检测到重复消息，跳过处理: messageId=${messageId}`);
        console.log(`========== 消息处理结束（重复） ==========\n`);
        return;
      }

      if (messageId) {
        markMessageProcessed(messageId);
        console.log(`[DingTalk][${accountId}] 标记消息为已处理: messageId=${messageId}`);
      }

      // 异步处理消息
      try {
        // 解析消息数据
        const data = JSON.parse(res.data);
        
        // ===== 第二步：记录解析后的消息详情 =====
        console.log(`\n----- 消息详情 -----`);
        console.log(`消息类型: ${data.msgtype || 'unknown'}`);
        console.log(`会话类型: ${data.conversationType === '1' ? 'DM (单聊)' : data.conversationType === '2' ? 'Group (群聊)' : data.conversationType}`);
        console.log(`发送者: ${data.senderNick || 'unknown'} (${data.senderStaffId || data.senderId || 'unknown'})`);
        console.log(`会话ID: ${data.conversationId || 'N/A'}`);
        console.log(`消息ID: ${data.msgId || 'N/A'}`);
        console.log(`SessionWebhook: ${data.sessionWebhook ? '已提供' : '未提供'}`);
        console.log(`RobotCode: ${data.robotCode || account.config?.clientId || 'N/A'}`);
        
        // 记录消息内容（简化版，避免过长）
        let contentPreview = 'N/A';
        if (data.text?.content) {
          contentPreview = data.text.content.length > 100 
            ? data.text.content.substring(0, 100) + '...' 
            : data.text.content;
        } else if (data.content) {
          contentPreview = JSON.stringify(data.content).substring(0, 100) + '...';
        }
        console.log(`消息内容预览: ${contentPreview}`);
        console.log(`完整数据字段: ${Object.keys(data).join(', ')}`);
        console.log(`----- 消息详情结束 -----\n`);
        
        // ===== 第三步：开始处理消息 =====
        console.log(`[DingTalk][${accountId}] 🚀 开始处理消息...`);
        console.log(`AccountId: ${accountId}`);
        console.log(`HasConfig: ${!!account.config}`);
        
        await messageHandler({
          accountId,
          config: account.config,
          data,
          sessionWebhook: data.sessionWebhook,
          runtime,
          log,
          cfg: clawdbotConfig,
        });
        
        processedCount++;
        console.log(`[DingTalk][${accountId}] ✅ 消息处理完成 (${processedCount}/${receivedCount})`);
        console.log(`========== 消息处理结束（成功） ==========\n`);
        
      } catch (error: any) {
        processedCount++;
        console.error(`\n[DingTalk][${accountId}] ❌ 处理消息异常 (${processedCount}/${receivedCount}):`);
        console.error(`错误类型: ${error.name || 'Error'}`);
        console.error(`错误信息: ${error.message}`);
        console.error(`错误堆栈:\n${error.stack}`);
        console.log(`========== 消息处理结束（失败） ==========\n`);
      }
    });

    // 清理定时器
    const cleanup = () => {
      clearInterval(statsInterval);
      clearInterval(heartbeatTimer);
      releaseProcessLock(accountId);
    };

    // Connect to DingTalk Stream
    try {
      await client.connect();
      log(`[DingTalk][${accountId}] Connected to DingTalk Stream successfully`);
      log(`[DingTalk][${accountId}] PID: ${process.pid}`);
    } catch (error: any) {
      cleanup(); // 连接失败时清理资源
      
      // 处理 401 认证错误
      if (error.response?.status === 401 || error.message?.includes('401')) {
        throw new Error(
          `[DingTalk][${accountId}] Authentication failed (401 Unauthorized):\n` +
          `  - Your clientId or clientSecret is invalid, expired, or revoked\n` +
          `  - clientId: ${clientIdStr.substring(0, 8)}...\n` +
          `  - Please verify your credentials at DingTalk Developer Console\n` +
          `  - Error details: ${error.message}`
        );
      }
      
      // 处理其他连接错误
      throw new Error(
        `[DingTalk][${accountId}] Failed to connect to DingTalk Stream: ${error.message}`
      );
    }

    // 连接状态追踪
    let connectionStartTime = Date.now();
    let reconnectCount = 0;

    // Handle disconnection
    client.on('close', () => {
      const connectionDuration = Date.now() - connectionStartTime;
      log?.info?.(`[DingTalk][${accountId}] Connection closed after ${Math.round(connectionDuration / 1000)}s, will auto-reconnect...`);
      log?.warn?.(`[DingTalk][${accountId}] ⚠️ 如果长时间无法重连，可能存在长尾连接问题，建议重启进程`);
    });

    client.on('error', (err: Error) => {
      log?.error?.(`[DingTalk][${accountId}] Connection error: ${err.message}`);
    });

    // 监听重连事件（如果 SDK 支持）
    client.on('reconnect', () => {
      reconnectCount++;
      connectionStartTime = Date.now();
      log?.info?.(`[DingTalk][${accountId}] Reconnecting... (attempt ${reconnectCount})`);
      
      // 如果重连次数过多，警告可能存在问题
      if (reconnectCount > 5) {
        log?.warn?.(
          `[DingTalk][${accountId}] ⚠️ 重连次数过多 (${reconnectCount})，可能存在网络问题或长尾连接\n` +
          `建议检查：\n` +
          `1. 网络连接是否稳定\n` +
          `2. 是否有其他进程占用连接\n` +
          `3. 考虑重启进程`
        );
      }
    });

    client.on('reconnected', () => {
      log?.info?.(`[DingTalk][${accountId}] Reconnected successfully after ${reconnectCount} attempts`);
    });

    // 进程退出时清理
    process.on('exit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}

export function resolveReactionSyntheticEvent(
  event: any,
): DingtalkReactionCreatedEvent | null {
  // DingTalk doesn't support reactions in the same way as Feishu
  return null;
}


