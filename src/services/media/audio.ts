/**
 * 音频处理模块
 * 支持音频消息发送
 */

import type { Logger } from 'openclaw/plugin-sdk';
import type { DingtalkConfig } from '../../types/index.ts';
import { AUDIO_MARKER_PATTERN, toLocalPath, uploadMediaToDingTalk } from './common.ts';

/**
 * 提取音频标记并发送音频消息
 */
export async function processAudioMarkers(
  content: string,
  sessionWebhook: string,
  config: DingtalkConfig,
  oapiToken: string | null,
  log?: Logger,
  useProactiveApi: boolean = false,
  target?: any,
): Promise<string> {
  const logPrefix = useProactiveApi ? '[DingTalk][Audio][Proactive]' : '[DingTalk][Audio]';

  if (!oapiToken) {
    log?.warn?.(`${logPrefix} 无 oapiToken，跳过音频处理`);
    return content;
  }

  const matches = [...content.matchAll(AUDIO_MARKER_PATTERN)];
  const audioPaths: string[] = [];

  for (const match of matches) {
    try {
      const audioData = JSON.parse(match[1]);
      const rawPath = audioData.path;
      const absPath = toLocalPath(rawPath);
      audioPaths.push(absPath);
    } catch (err) {
      log?.warn?.(`${logPrefix} 解析音频标记失败：${match[1]}`);
    }
  }

  if (audioPaths.length === 0) {
    return content;
  }

  log?.info?.(`${logPrefix} 检测到 ${audioPaths.length} 个音频，开始上传...`);

  let result = content;
  for (const audioPath of audioPaths) {
    const mediaId = await uploadMediaToDingTalk(audioPath, 'voice', oapiToken, 20 * 1024 * 1024, log);
    if (mediaId) {
      result = result.replace(
        `[DINGTALK_AUDIO]${JSON.stringify({ path: audioPath })}[/DINGTALK_AUDIO]`,
        `[音频已上传：${mediaId}]`,
      );
    }
  }

  return result;
}
