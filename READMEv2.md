# DingTalk OpenClaw Connector

钉钉（DingTalk）是企业级即时通讯和协作平台。本插件通过 Stream 模式连接 OpenClaw 与钉钉机器人，实现消息的实时接收和响应，无需暴露公网 URL。

---

## 前置要求

安装钉钉连接器插件：

```bash
openclaw plugins install @dingtalk-real-ai/dingtalk-connector
```

本地开发（从 git 仓库运行）：

```bash
openclaw plugins install ./path/to/dingtalk-openclaw-connector
```

---

## 快速开始

有两种方式添加钉钉渠道：

### 方式 1：引导向导（推荐）

如果刚安装 OpenClaw，运行向导：

```bash
openclaw onboard
```

向导将引导你完成：

1. 创建钉钉应用并收集凭证
2. 在 OpenClaw 中配置应用凭证
3. 启动网关

✅ **配置完成后**，检查网关状态：

- `openclaw gateway status`
- `openclaw logs --follow`

### 方式 2：CLI 设置

如果已完成初始安装，通过 CLI 添加渠道：

```bash
openclaw channels add
```

选择 **DingTalk**，然后输入 ClientId 和 ClientSecret。

✅ **配置完成后**，管理网关：

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## 步骤 1：创建钉钉应用

### 1. 打开钉钉开放平台

访问 [钉钉开放平台](https://open-dev.dingtalk.com) 并登录。

### 2. 创建应用

1. 点击 **创建应用**
2. 选择 **机器人** 类型
3. 填写应用名称和描述
4. 选择应用图标

### 3. 复制凭证

从 **应用信息** 页面，复制：

- **ClientId**（应用 ID）
- **ClientSecret**（应用密钥）

❗ **重要**：妥善保管 ClientSecret，不要泄露。

### 4. 配置权限

在 **权限管理** 页面，添加以下权限：

**必需权限**：
- `qyapi_chat_manage`：群会话管理
- `qyapi_robot_sendmsg`：机器人发送消息
- `qyapi_get_userid_by_code`：通过临时授权码获取成员信息

**可选权限**（用于富媒体功能）：
- `qyapi_media_upload`：上传媒体文件
- `qyapi_media_get`：下载媒体文件

### 5. 启用机器人能力

在 **机器人配置** 中：

1. 启用机器人功能
2. 设置机器人名称和头像
3. 配置消息接收模式为 **Stream 模式**

### 6. 配置事件订阅

⚠️ **重要**：在设置事件订阅前，确保：

1. 已运行 `openclaw channels add` 配置钉钉渠道
2. 网关正在运行（`openclaw gateway status`）

在 **事件订阅** 中：

1. 选择 **Stream 模式**
2. 添加订阅事件：
   - `chat_receive_message`：接收消息
   - `chat_add_member`：群成员变更（可选）

⚠️ 如果网关未运行，Stream 连接设置可能无法保存。

### 7. 发布应用

1. 在 **版本管理与发布** 中创建版本
2. 提交审核并发布
3. 等待管理员审批（企业内部应用通常自动审批）

---

## 步骤 2：配置 OpenClaw

### 使用向导配置（推荐）

```bash
openclaw channels add
```

选择 **DingTalk** 并粘贴你的 ClientId 和 ClientSecret。

### 通过配置文件配置

编辑 `~/.openclaw/openclaw.json`：

```json5
{
  "channels": {
    "dingtalk-connector": {
      "enabled": true,
      "dmPolicy": "pairing",
      "accounts": {
        "default": {
          "clientId": "your-client-id",
          "clientSecret": "your-client-secret",
          "botName": "我的 AI 助手"
        }
      }
    }
  }
}
```

### 通过环境变量配置

```bash
export DINGTALK_CLIENT_ID="your-client-id"
export DINGTALK_CLIENT_SECRET="your-client-secret"
```

### 启用 Chat Completions 端点

钉钉连接器需要启用 OpenClaw Gateway 的 Chat Completions 端点：

```json5
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  }
}
```

### 配置认证

设置 Gateway 认证令牌：

```json5
{
  "gateway": {
    "auth": {
      "token": "your-secure-token"
    }
  }
}
```

### 配额优化标志

可以通过两个可选标志减少钉钉 API 使用量：

- `typingIndicator`（默认 `true`）：设为 `false` 时跳过输入状态指示
- `resolveSenderNames`（默认 `true`）：设为 `false` 时跳过发送者信息查询

在顶层或每个账号设置：

```json5
{
  "channels": {
    "dingtalk-connector": {
      "typingIndicator": false,
      "resolveSenderNames": false,
      "accounts": {
        "default": {
          "clientId": "your-client-id",
          "clientSecret": "your-client-secret",
          "typingIndicator": true,
          "resolveSenderNames": false
        }
      }
    }
  }
}
```

---

## 步骤 3：启动和测试

### 1. 启动网关

```bash
openclaw gateway
```

### 2. 发送测试消息

在钉钉中找到你的机器人并发送消息。

### 3. 批准配对

默认情况下，机器人会回复配对码。批准配对：

```bash
openclaw pairing approve dingtalk-connector <CODE>
```

批准后即可正常对话。

---

## 概述

- **钉钉机器人渠道**：由网关管理的钉钉机器人
- **确定性路由**：回复始终返回到钉钉
- **会话隔离**：单聊共享主会话；群聊相互隔离
- **Stream 连接**：通过钉钉 SDK 的长连接，无需公网 URL

---

## 访问控制

### 单聊消息

- **默认**：`dmPolicy: "pairing"`（未知用户获得配对码）
- **批准配对**：

  ```bash
  openclaw pairing list dingtalk-connector
  openclaw pairing approve dingtalk-connector <CODE>
  ```

- **白名单模式**：设置 `channels.dingtalk-connector.allowFrom` 指定允许的用户 ID

### 群聊消息

**1. 群聊策略**（`channels.dingtalk-connector.groupPolicy`）：

- `"open"` = 允许所有群聊（默认）
- `"allowlist"` = 仅允许 `groupAllowFrom` 中的群
- `"disabled"` = 禁用群聊消息

**2. @提及要求**（`channels.dingtalk-connector.groups.<chat_id>.requireMention`）：

- `true` = 需要 @提及（默认）
- `false` = 无需提及即可响应

---

## 群聊配置示例

### 允许所有群聊，需要 @提及（默认）

```json5
{
  "channels": {
    "dingtalk-connector": {
      "groupPolicy": "open"
      // 默认 requireMention: true
    }
  }
}
```

### 允许所有群聊，无需 @提及

```json5
{
  "channels": {
    "dingtalk-connector": {
      "groups": {
        "chatxxx": { "requireMention": false }
      }
    }
  }
}
```

### 仅允许特定群聊

```json5
{
  "channels": {
    "dingtalk-connector": {
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["chatxxx", "chatyyy"]
    }
  }
}
```

### 限制群聊中的发送者（发送者白名单）

除了允许群聊本身，该群中的**所有消息**都会根据发送者 ID 进行过滤：只有 `groups.<chat_id>.allowFrom` 中列出的用户才能处理其消息；其他成员的消息将被忽略。

```json5
{
  "channels": {
    "dingtalk-connector": {
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["chatxxx"],
      "groups": {
        "chatxxx": {
          "allowFrom": ["user1", "user2"]
        }
      }
    }
  }
}
```

---

## 获取群聊/用户 ID

### 群聊 ID（chat_id）

群聊 ID 格式为 `chatxxx`。

**方法 1（推荐）**

1. 启动网关并在群中 @提及机器人
2. 运行 `openclaw logs --follow` 并查找 `chat_id`

**方法 2**

使用钉钉 API 调试器列出群聊。

### 用户 ID（user_id）

用户 ID 格式为字符串。

**方法 1（推荐）**

1. 启动网关并向机器人发送私聊消息
2. 运行 `openclaw logs --follow` 并查找 `user_id`

**方法 2**

检查配对请求中的用户 ID：

```bash
openclaw pairing list dingtalk-connector
```

---

## 常用命令

| 命令 | 描述 |
| --------- | ----------------- |
| `/status` | 显示机器人状态 |
| `/reset` | 重置会话 |
| `/model` | 显示/切换模型 |
| `/new` | 开启新会话 |

> 注意：钉钉尚不支持原生命令菜单，因此命令必须作为文本发送。

## 网关管理命令

| 命令 | 描述 |
| -------------------------- | ----------------------------- |
| `openclaw gateway status` | 显示网关状态 |
| `openclaw gateway install` | 安装/启动网关服务 |
| `openclaw gateway stop` | 停止网关服务 |
| `openclaw gateway restart` | 重启网关服务 |
| `openclaw logs --follow` | 查看网关日志 |

---

## 故障排查

### 机器人在群聊中不响应

1. 确保机器人已添加到群聊
2. 确保你 @提及了机器人（默认行为）
3. 检查 `groupPolicy` 未设置为 `"disabled"`
4. 查看日志：`openclaw logs --follow`

### 机器人不接收消息

1. 确保应用已发布并审批通过
2. 确保事件订阅包含 `chat_receive_message`
3. 确保启用了 **Stream 模式**
4. 确保应用权限完整
5. 确保网关正在运行：`openclaw gateway status`
6. 查看日志：`openclaw logs --follow`

### ClientSecret 泄露

1. 在钉钉开放平台重置 ClientSecret
2. 更新配置中的 ClientSecret
3. 重启网关

### 消息发送失败

1. 确保应用具有 `qyapi_robot_sendmsg` 权限
2. 确保应用已发布
3. 查看日志获取详细错误信息

### 出现 405 错误

需要在 `~/.openclaw/openclaw.json` 中启用 chatCompletions 端点：

```json5
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true
        }
      }
    }
  }
}
```

### 出现 401 错误

检查 `~/.openclaw/openclaw.json` 中的 `gateway.auth` 鉴权 token 是否正确。

### Stream 客户端连接 400 错误

日志中出现 `channel exited: Request failed with status code 400`，表示钉钉 Stream 连接失败。

**常见原因：**

| 原因 | 排查方法 |
|------|----------|
| **应用未发布** | 钉钉开放平台 → 应用 → 版本管理 → 确认已发布 |
| **凭证错误** | 检查 `clientId`/`clientSecret` 是否有空格或换行 |
| **非 Stream 模式** | 确认机器人消息接收模式为 **Stream 模式** |
| **IP 白名单限制** | 检查应用是否设置了 IP 白名单 |

**排查步骤：**

1. **验证凭证有效性**
   ```bash
   curl -X POST "https://api.dingtalk.com/v1.0/oauth2/accessToken" \
     -H "Content-Type: application/json" \
     -d '{"appKey": "你的clientId", "appSecret": "你的clientSecret"}'
   ```
   - 返回 `accessToken` → 凭证正确
   - 返回 `400`/`invalid` → 凭证错误或应用未发布

2. **检查应用状态**
   - 登录钉钉开放平台
   - 确认应用已发布（版本管理 → 发布）
   - 确认机器人已启用且为 Stream 模式

3. **重新发布应用**
   - 修改任何配置后，必须点击 **保存** → **发布**

### 图片不显示

1. 确认 `enableMediaUpload: true`（默认开启）
2. 检查日志 `[DingTalk][Media]` 相关输出
3. 确认钉钉应用有图片上传权限

### 图片消息无法识别

1. 检查图片是否成功下载到 `~/.openclaw/workspace/media/inbound/` 目录
2. 确认 Gateway 配置的模型支持视觉能力（vision model）
3. 查看日志中是否有图片下载或处理的错误信息

### 文件附件无法解析

1. **Word 文档（.docx）**：确认已安装 `mammoth` 依赖包
2. **PDF 文档**：确认已安装 `pdf-parse` 依赖包
3. 检查文件是否成功下载，查看日志中的文件处理信息
4. 对于不支持的二进制文件，会保存到磁盘并在消息中报告文件路径

---

## 高级配置

### 多账号

```json5
{
  "channels": {
    "dingtalk-connector": {
      "defaultAccount": "main",
      "accounts": {
        "main": {
          "clientId": "client-id-1",
          "clientSecret": "client-secret-1",
          "botName": "主机器人"
        },
        "backup": {
          "clientId": "client-id-2",
          "clientSecret": "client-secret-2",
          "botName": "备用机器人",
          "enabled": false
        }
      }
    }
  }
}
```

`defaultAccount` 控制当出站 API 未明确指定 `accountId` 时使用哪个钉钉账号。

### 消息限制

- `textChunkLimit`：出站文本块大小（默认：2000 字符）
- `mediaMaxMb`：媒体上传/下载限制（默认：30MB）

### 流式输出

钉钉支持通过交互式卡片进行流式回复。启用后，机器人会在生成文本时更新卡片。

```json5
{
  "channels": {
    "dingtalk-connector": {
      "streaming": true, // 启用流式卡片输出（默认 true）
      "blockStreaming": true // 启用块级流式输出（默认 true）
    }
  }
}
```

设置 `streaming: false` 以等待完整回复后再发送。

### 多 Agent 路由

使用 `bindings` 将钉钉单聊或群聊路由到不同的 Agent。

```json5
{
  "agents": {
    "list": [
      { "id": "main" },
      {
        "id": "assistant-1",
        "workspace": "/home/user/assistant-1",
        "agentDir": "/home/user/.openclaw/agents/assistant-1/agent"
      },
      {
        "id": "assistant-2",
        "workspace": "/home/user/assistant-2",
        "agentDir": "/home/user/.openclaw/agents/assistant-2/agent"
      }
    ]
  },
  "bindings": [
    {
      "agentId": "main",
      "match": {
        "channel": "dingtalk-connector",
        "peer": { "kind": "direct", "id": "user123" }
      }
    },
    {
      "agentId": "assistant-1",
      "match": {
        "channel": "dingtalk-connector",
        "peer": { "kind": "direct", "id": "user456" }
      }
    },
    {
      "agentId": "assistant-2",
      "match": {
        "channel": "dingtalk-connector",
        "peer": { "kind": "group", "id": "chatxxx" }
      }
    }
  ]
}
```

路由字段：

- `match.channel`：`"dingtalk-connector"`
- `match.peer.kind`：`"direct"` 或 `"group"`
- `match.peer.id`：用户 ID 或群聊 ID

参见 [获取群聊/用户 ID](#获取群聊用户-id) 了解查找技巧。

### 基于单聊/群聊的路由（peer.kind）

连接器支持根据会话类型（单聊/群聊）将消息路由到不同的 Agent。这对于以下场景非常有用：

- **安全隔离**：群聊使用受限功能的 Agent，单聊使用完整功能的 Agent
- **多角色支持**：不同用户或会话类型分配不同的 Agent
- **成本优化**：普通用户路由到低成本模型，VIP 用户使用高端模型

#### 配置示例

```json5
{
  "bindings": [
    // 场景1：特定用户的单聊 → main agent（完整功能）
    {
      "agentId": "main",
      "match": {
        "channel": "dingtalk-connector",
        "peer": {
          "kind": "direct",
          "id": "YOUR_VIP_USER_ID"
        }
      }
    },
    // 场景2：所有群聊 → guest agent（受限功能）
    {
      "agentId": "guest",
      "match": {
        "channel": "dingtalk-connector",
        "peer": {
          "kind": "group",
          "id": "*"
        }
      }
    },
    // 场景3：其他单聊 → guest agent（受限功能）
    {
      "agentId": "guest",
      "match": {
        "channel": "dingtalk-connector",
        "peer": {
          "kind": "direct",
          "id": "*"
        }
      }
    }
  ]
}
```

#### peer.kind 配置说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `peer.kind` | `'direct'` \| `'group'` | 会话类型：`direct` 表示单聊，`group` 表示群聊 |
| `peer.id` | `string` | 发送者 ID（单聊）或群聊 ID，或 `*` 通配符匹配所有 |

#### 匹配优先级

bindings 按以下优先级匹配（从高到低）：

1. **peer.kind + peer.id 精确匹配**：指定会话类型和具体用户/群聊 ID
2. **peer.kind + peer.id='*' 通配匹配**：指定会话类型，匹配所有用户/群聊
3. **仅 peer.kind 匹配**：只指定会话类型（无 peer.id）
4. **accountId 匹配**：按钉钉账号路由
5. **channel 匹配**：仅指定 channel
6. **默认 fallback**：使用 `main` agent

---

## 富媒体功能

### 图片消息支持

连接器支持接收和处理钉钉中的图片消息：

- **JPEG 图片** - 直接发送的 JPEG 图片会自动下载到 `~/.openclaw/workspace/media/inbound/` 目录
- **PNG 图片** - 富文本消息中包含的 PNG 图片会自动提取 URL 和 downloadCode 并下载
- **视觉模型集成** - 下载的图片会自动传递给视觉模型，AI 可以识别和分析图片内容

### 媒体文件存储

所有接收的媒体文件会保存在：

```bash
~/.openclaw/workspace/media/inbound/
```

文件命名格式：`openclaw-media-{timestamp}.{ext}`

查看媒体目录：

```bash
ls -la ~/.openclaw/workspace/media/inbound/
```

### 文件附件提取

连接器支持自动提取和处理钉钉消息中的文件附件：

#### 支持的文件类型

| 文件类型 | 处理方式 | 说明 |
|---------|---------|------|
| `.docx` | 通过 `mammoth` 解析 | 提取 Word 文档中的文本内容，注入到 AI 上下文 |
| `.pdf` | 通过 `pdf-parse` 解析 | 提取 PDF 文档中的文本内容，注入到 AI 上下文 |
| `.txt`、`.md`、`.json` 等 | 直接读取 | 纯文本文件内容直接读取并注入到消息中 |
| `.xlsx`、`.pptx`、`.zip` 等 | 保存到磁盘 | 二进制文件保存到磁盘，文件路径和名称会在消息中报告 |

#### 使用方式

直接在钉钉中发送文件附件，连接器会自动：
1. 下载文件到本地
2. 根据文件类型进行解析或保存
3. 将文本内容注入到 AI 对话上下文中

---

## 钉钉文档 API

连接器提供了丰富的钉钉文档操作能力，可在 OpenClaw Agent 中调用：

### 创建文档

```javascript
dingtalk-connector.docs.create({
  spaceId: "your-space-id",
  title: "测试文档",
  content: "# 测试内容"
})
```

### 追加内容

```javascript
dingtalk-connector.docs.append({
  docId: "your-doc-id",
  markdownContent: "\n## 追加的内容"
})
```

### 搜索文档

```javascript
dingtalk-connector.docs.search({
  keyword: "搜索关键词"
})
```

### 列举文档

```javascript
dingtalk-connector.docs.list({
  spaceId: "your-space-id"
})
```

---

## 配置参考

完整配置：[Gateway 配置](/gateway/configuration)

关键选项：

| 设置 | 描述 | 默认值 |
| ------------------------------------------------- | --------------------------------------- | ---------------- |
| `channels.dingtalk-connector.enabled` | 启用/禁用渠道 | `true` |
| `channels.dingtalk-connector.defaultAccount` | 出站路由的默认账号 ID | `default` |
| `channels.dingtalk-connector.accounts.<id>.clientId` | Client ID | - |
| `channels.dingtalk-connector.accounts.<id>.clientSecret` | Client Secret | - |
| `channels.dingtalk-connector.dmPolicy` | 单聊策略 | `pairing` |
| `channels.dingtalk-connector.allowFrom` | 单聊白名单（用户 ID 列表） | - |
| `channels.dingtalk-connector.groupPolicy` | 群聊策略 | `open` |
| `channels.dingtalk-connector.groupAllowFrom` | 群聊白名单 | - |
| `channels.dingtalk-connector.groups.<chat_id>.requireMention` | 需要 @提及 | `true` |
| `channels.dingtalk-connector.groups.<chat_id>.enabled` | 启用群聊 | `true` |
| `channels.dingtalk-connector.textChunkLimit` | 消息块大小 | `2000` |
| `channels.dingtalk-connector.mediaMaxMb` | 媒体大小限制 | `30` |
| `channels.dingtalk-connector.streaming` | 启用流式卡片输出 | `true` |
| `channels.dingtalk-connector.blockStreaming` | 启用块级流式输出 | `true` |

---

## dmPolicy 参考

| 值 | 行为 |
| ------------- | --------------------------------------------------------------- |
| `"pairing"` | **默认。** 未知用户获得配对码；必须批准 |
| `"allowlist"` | 仅 `allowFrom` 中的用户可以聊天 |
| `"open"` | 允许所有用户（需要在 allowFrom 中设置 `"*"`） |
| `"disabled"` | 禁用单聊 |

---

## 支持的消息类型

### 接收

- ✅ 文本
- ✅ 富文本
- ✅ 图片
- ✅ 文件
- ✅ 音频
- ✅ 视频

### 发送

- ✅ 文本
- ✅ 图片
- ✅ 文件
- ✅ 音频
- ⚠️ 富文本（部分支持）

---

## 依赖

| 包 | 用途 |
|----|------|
| `dingtalk-stream` | 钉钉 Stream 协议客户端 |
| `axios` | HTTP 客户端 |
| `mammoth` | Word 文档（.docx）解析 |
| `pdf-parse` | PDF 文档解析 |

---

## 项目结构

```
dingtalk-openclaw-connector/
├── plugin.ts              # 插件入口
├── openclaw.plugin.json   # 插件清单
├── package.json           # npm 依赖
└── LICENSE
```

---

## License

[MIT](LICENSE)
