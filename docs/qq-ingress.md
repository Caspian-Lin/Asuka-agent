# NapCat QQ 接入

Asuka Agent 使用 NapCat OneBot 11 正向 WebSocket。网关是客户端，主动连接 NapCat；NapCat 默认在 `127.0.0.1:3001` 监听。

## 安全范围

接收 `message.group` 与 `message.private`。群号必须存在于 `NAPCAT_GROUP_WHITELIST`，私聊发送者必须存在于 `NAPCAT_PRIVATE_USER_WHITELIST`。自身消息、非白名单群和非白名单联系人不会写入数据库。两个白名单都为空表示拒绝所有 QQ 消息。

当前只把文本段投影到 `conversations/messages/events`。图片、语音和文件仍可随允许群消息保存在 `inbound_deliveries.raw_payload/content`，但会被 worker 标记为 `ignored`。

## 配置

NapCat WebUI 新建并启用 **WebSocket 服务端（正向 WS）**：

- Host：`127.0.0.1`
- Port：`3001`
- 消息格式：`array`
- Token：与 `.env` 的 `NAPCAT_ACCESS_TOKEN` 一致

项目环境变量：

```dotenv
NAPCAT_WS_URL=ws://127.0.0.1:3001/
NAPCAT_ACCESS_TOKEN=replace-me
NAPCAT_ACCOUNT_ID=1234567890
NAPCAT_GROUP_WHITELIST=123456789,987654321
NAPCAT_PRIVATE_USER_WHITELIST=1122334455
NAPCAT_OUTBOUND_POLL_MS=500
NAPCAT_OUTBOUND_RESPONSE_TIMEOUT_MS=30000
```

## 运行与数据流

```bash
make db-migrate
make dev
```

`make dev` 同时运行 Web、网关、PostgreSQL 控制 API 和持续 worker：

```text
NapCat WS
  → group/private whitelist filter
  → inbound_deliveries（幂等原始接收箱）
  → worker / FOR UPDATE SKIP LOCKED
  → conversations + messages + events
  → IM Channel 页面
```

唯一约束 `(channel_id, external_message_id)` 防止断线重连造成重复入库。消息默认 `read_at = NULL`，前端“全部标为已读”只更新对应会话的用户消息。

## 自主外发

NapCat gateway 也是唯一允许调用 `send_group_msg` / `send_private_msg` 的出站 adapter。模型不能直接调用它：primary 先生成自然思绪和回复草稿，fast 模型编译为 `reply` 或 `no_action`，服务端硬策略再决定 `silent / defer / blocked / shadow_speak / speak`。

真实发送要求同时满足：自主发言总开关开启、Agent 为 active、Channel 与会话在白名单中、证据和目标匹配、未过时、未重复、不在静默时段、未超每日额度且会话冷却结束。发送前先创建本地 `messages` 与 `outbound_deliveries`；OneBot 响应必须带同一 `echo`，成功才写入 QQ `message_id`。若发送后响应超时，delivery 标记为 `failed_uncertain` 且不会自动重试，避免重复消息。完整协议见 [`autonomous-speech.md`](autonomous-speech.md)。

## 本地接口

- `GET http://127.0.0.1:3002/health`
- `GET http://127.0.0.1:3002/api/im`
- `POST http://127.0.0.1:3002/api/im/read`
- `GET http://127.0.0.1:3002/api/jobs`
- `GET http://127.0.0.1:3002/api/outbound`
- `PUT http://127.0.0.1:3002/api/outbound/policy`
- `POST http://127.0.0.1:3002/api/outbound/decisions/:id/feedback`

所有 PostgreSQL 结构变更必须先修改 `packages/db/src/postgres/schema.ts`，生成并审阅 `packages/db/drizzle-pg/*.sql`，再运行 `make db-migrate`。禁止应用启动时建表或手工修改数据库结构。
