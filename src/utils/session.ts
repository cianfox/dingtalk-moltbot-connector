/**
 * 会话管理模块
 * 构建 OpenClaw 标准会话上下文
 */

import { NEW_SESSION_COMMANDS } from './constants.ts';

/** OpenClaw 标准会话上下文 */
export interface SessionContext {
  channel: 'dingtalk-connector';
  accountId: string;
  chatType: 'direct' | 'group';
  peerId: string;
  conversationId?: string;
  senderName?: string;
  groupSubject?: string;
}

/**
 * 构建 OpenClaw 标准会话上下文
 * 遵循 OpenClaw session.dmScope 机制，让 Gateway 根据配置自动处理会话隔离
 */
export function buildSessionContext(params: {
  accountId: string;
  senderId: string;
  senderName?: string;
  conversationType: string;
  conversationId?: string;
  groupSubject?: string;
  separateSessionByConversation?: boolean;
  groupSessionScope?: 'group' | 'group_sender';
}): SessionContext {
  const {
    accountId,
    senderId,
    senderName,
    conversationType,
    conversationId,
    groupSubject,
    separateSessionByConversation,
    groupSessionScope,
  } = params;
  const isDirect = conversationType === '1';

  if (separateSessionByConversation === false) {
    return {
      channel: 'dingtalk-connector',
      accountId,
      chatType: isDirect ? 'direct' : 'group',
      peerId: senderId,
      senderName,
    };
  }

  if (isDirect) {
    return {
      channel: 'dingtalk-connector',
      accountId,
      chatType: 'direct',
      peerId: senderId,
      senderName,
    };
  }

  if (groupSessionScope === 'group_sender') {
    return {
      channel: 'dingtalk-connector',
      accountId,
      chatType: 'group',
      peerId: `${conversationId}:${senderId}`,
      conversationId,
      senderName,
      groupSubject,
    };
  }

  return {
    channel: 'dingtalk-connector',
    accountId,
    chatType: 'group',
    peerId: conversationId || senderId,
    conversationId,
    senderName,
    groupSubject,
  };
}

/**
 * 检查消息是否是新会话命令
 */
export function normalizeSlashCommand(text: string): string {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (NEW_SESSION_COMMANDS.some((cmd) => lower === cmd.toLowerCase())) {
    return '/new';
  }
  return text;
}
