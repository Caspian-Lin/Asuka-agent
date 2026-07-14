# NapCat QQ 入站接入

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

## 本地接口

- `GET http://127.0.0.1:3002/health`
- `GET http://127.0.0.1:3002/api/im`
- `POST http://127.0.0.1:3002/api/im/read`
- `GET http://127.0.0.1:3002/api/jobs`

所有 PostgreSQL 结构变更必须先修改 `db/postgres/schema.ts`，生成并审阅 `drizzle-pg/*.sql`，再运行 `make db-migrate`。禁止应用启动时建表或手工修改数据库结构。
