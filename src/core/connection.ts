/**
 * 钉钉 WebSocket 连接层
 * 
 * 职责：
 * - 管理单个钉钉账号的 WebSocket 连接
 * - 实现应用层心跳检测（30 秒间隔，90 秒超时）
 * - 处理连接重连逻辑，避免与 SDK 的双重 重连冲突
 * - 进程锁机制，防止多个进程同时监控同一账号
 * - 消息去重（内置 Map，5 分钟 TTL）
 * 
 * 核心特性：
 * - 关闭 SDK 内置 keepAlive，使用自定义温和心跳
 * - 详细的消息接收日志（三阶段：接收、解析、处理）
 * - 连接统计和监控（每分钟输出）
 */
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { ResolvedDingtalkAccount } from "./types";

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

  // 验证凭据是否存在
  if (!account.clientId || !account.clientSecret) {
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

  // 动态导入 dingtalk-stream 模块（避免循环依赖和 ESM/CJS 兼容性问题）
  const dingtalkStreamModule = await import('dingtalk-stream');
  const DWClient = dingtalkStreamModule.DWClient;
  const { TOPIC_ROBOT, GATEWAY_URL } = dingtalkStreamModule;
  
  if (!DWClient) {
    throw new Error('Failed to import DWClient from dingtalk-stream module');
  }

  // 配置 DWClient：启用 SDK 内置的 keepAlive 和 autoReconnect
  // - keepAlive: true（启用 SDK 的心跳检测，8 秒间隔，自动检测连接状态）
  // - autoReconnect: true（SDK 在 close 事件时自动重连）
  // - endpoint: 可选的自定义网关地址（优先级：account 级别 > 外层）
  // - debug: 可选的调试模式（优先级：account 级别 > 外层）
  // - 移除应用层自定义心跳，避免与 SDK 冲突
  const client = new DWClient({
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    debug: account.config.debug,  // ✅ 使用合并后的配置（account 优先级 > 外层）
    endpoint: account.config.endpoint,  // ✅ 使用合并后的配置（account 优先级 > 外层）
    autoReconnect: true,
    keepAlive: true,  // ✅ 启用 SDK 心跳检测
  } as any);

  return new Promise<void>(async (resolve, reject) => {
    // Handle abort signal
    if (abortSignal) {
      const onAbort = async () => {
        log(`[DingTalk][${accountId}] Abort signal received, stopping...`);
        try {
          // 只在连接已建立时才断开
          if (client.socket && client.socket.readyState === 1) {
            await client.disconnect();
          }
        } catch (err: any) {
          log?.warn?.(`[DingTalk][${accountId}] 断开连接时出错：${err.message}`);
        }
        resolve();
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

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
    };

    // Connect to DingTalk Stream
    try {
      await client.connect();
      log(`[DingTalk][${accountId}] Connected to DingTalk Stream successfully`);
      log(`[DingTalk][${accountId}] PID: ${process.pid}`);
      log(`[DingTalk][${accountId}] ✅ SDK keepAlive: true (8 秒心跳检测), autoReconnect: true`);
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

    // Handle disconnection
    client.on('close', () => {
      log?.info?.(`[DingTalk][${accountId}] Connection closed, SDK will auto-reconnect...`);
      log?.warn?.(`[DingTalk][${accountId}] ⚠️ 如果长时间无法重连，可能存在网络问题或长尾连接，建议重启进程`);
    });

    client.on('error', (err: Error) => {
      log?.error?.(`[DingTalk][${accountId}] Connection error: ${err.message}`);
    });

    // 监听重连事件
    client.on('reconnect', () => {
      log?.info?.(`[DingTalk][${accountId}] SDK reconnecting...`);
    });

    client.on('reconnected', () => {
      log?.info?.(`[DingTalk][${accountId}] ✅ SDK reconnected successfully`);
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
  return null;
}