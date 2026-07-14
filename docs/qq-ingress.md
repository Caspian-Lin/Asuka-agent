# NapCat QQ 入站接入（第一小步）

当前只接收 OneBot 11 的 `message.private` 与 `message.group`，保存所有原始 JSON，并把可读消息段保存为结构化 `content`。不发送消息、不调用 Agent，也不把 QQ 内容当系统指令。

## 为什么先这样做

`inbound_deliveries` 是外部消息的不可变接收箱。唯一约束 `(channel_id, external_message_id)` 使 WebSocket 断线重连或重复上报不会重复入库；Agent worker 只在事务里以 `FOR UPDATE SKIP LOCKED` 领取 `status = 'received'` 的记录，再投影到本地 `messages/events` 并标记 `processed`。这样 Agent 的触发源是本地数据库，而不是 WebSocket 回调。

## PostgreSQL 初始化

请管理员执行（密码请替换，并仅赋予该库权限）：

```sql
CREATE ROLE asuka_agent LOGIN PASSWORD 'replace-with-a-long-secret';
CREATE DATABASE asuka_agent OWNER asuka_agent;
```

把真实连接串填入 `.env` 的 `DATABASE_URL` 后运行：

```bash
npm run db:migrate
```

以后任何结构变更都只能先生成/审阅新的 `drizzle-pg/*.sql` migration，再运行同一命令；不得通过应用启动时 `CREATE TABLE` 或手工改生产表。

## NapCat 配置

在 NapCat WebUI 新建并启用 **WebSocket 服务端（正向 WS）**，监听 `127.0.0.1:3001`，`messagePostFormat` 设置为 `array`，关闭 `reportSelfMessage`，并设置 Token。填入 `.env` 的 `NAPCAT_WS_URL` 和 `NAPCAT_ACCESS_TOKEN` 后启动：

```bash
npm run qq:gateway
```

NapCat 官方说明将正向 WebSocket 定义为可推送事件、也可接收请求的双工通道；配置页也列出了 `messagePostFormat`、Token 和 `reportSelfMessage`。`message.private` 与 `message.group` 均是已支持的事件类型。[网络配置说明](https://doc.napneko.icu/config/basic)；[事件兼容表](https://napneko.github.io/develop/event)。

每次要把新消息送入 Agent 前运行：

```bash
npm run agent:inbound
```

这一步当前仅处理文本段；图片、语音、文件等仍完整保存在接收箱的 `raw_payload` 与结构化 `content`，但被标记为 `ignored`，不会进入认知流水线。

## 下一步

把该 worker 投影后的新消息接到现有 `agent-service.ts` 的认知流水线：检索 active memory、生成候选/Shadow thought 和回复提案；QQ 外发继续保持关闭，直到存在审批、预算和全局 kill switch。
