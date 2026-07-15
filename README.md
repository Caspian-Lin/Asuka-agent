# Asuka Agent

一个可运行、可追溯，并能接入 IM Channel 的持续型聊天 Agent。

PostgreSQL 是唯一应用数据库，统一保存 NapCat QQ 入站、Channel、消息、思绪运行、模型调用和记忆候选。Web 控制台只通过本机 control API 读取这些真实数据；项目不再包含 D1 或 OpenAI Sites 部署链路。QQ 内容不会直接触发外部发送，所有允许的消息必须先进入本地不可变接收箱。

## 已实现

- NapCat OneBot 11 正向 WebSocket 接入；
- 仅保存 `.env` 白名单内的 QQ 群和私聊联系人消息，自身消息被拒绝；
- PostgreSQL 幂等接收箱、持续消息投影和逐条未读状态；
- IM Channel、群会话历史和定时任务可视化页面；
- 主模型与快速小模型双档配置、加密密钥和独立连接测试；
- 带 lease、重试、dead letter 和会话 watermark 的定时思绪/记忆候选闭环；
- 思绪触发、逐轮模型上下文、token、消息/记忆引用和记忆来源追踪；
- primary 自然思绪 → fast 动作编译 → 硬策略门 → NapCat 出站的自主发言闭环；
- 默认关闭的外发总开关、影子模式、静默时段、每日额度、冷却、去重和送达审计；
- Drizzle PostgreSQL schema、版本化 migration 与一致性检查。

## 快速开始

要求 Node.js `>=22.13.0`、PostgreSQL 和已登录的 NapCat。

```bash
cp .env.example .env
make install
make db-migrate
make dev
```

NapCat 正向 WebSocket 默认监听 `127.0.0.1:3001`。在 `.env` 中设置相同 Token，并用逗号填写允许保存的群号：

```dotenv
NAPCAT_GROUP_WHITELIST=123456789,987654321
NAPCAT_PRIVATE_USER_WHITELIST=1122334455
```

两个白名单都为空表示不保存任何 QQ 消息。Web 默认运行在 `3000`，本地 PostgreSQL 控制 API 运行在 `3002`。

模型 API Key 使用 `SETTINGS_ENCRYPTION_KEY` 做 AES-256-GCM 加密。首次运行前生成本机密钥：

```bash
openssl rand -base64 32
```

将结果填入 `.env`，随后执行 `make db-migrate`。设置页只显示 Key 是否已配置，不会回填明文。

定时思绪先使用 `primary` 生成自然思绪，再由 `fast` 编译动作；夜间记忆沉淀仍使用 `primary` 档。两档需在设置页分别保存并启用。任务可在“定时任务”页面手动入队，运行详情会显示重试、模型审计、结构化结果和会话 watermark。“思绪”页面按一次完整认知过程展示触发原因与每轮调用；“记忆”页面当前只展示待审候选，正式激活与召回尚未实现。详细协议见 [`docs/scheduled-cognition.md`](docs/scheduled-cognition.md)。

自主发言默认 `总开关关闭 + shadow`。先在“自主发言”页面观察模型本来会说什么及硬策略原因；只有显式打开总开关并切换为“真实发送”，通过全部检查的白名单会话才会进入 NapCat 出站队列。发送前先持久化本地消息，NapCat 用 `echo` 返回明确成功后才标记送达；响应丢失会进入 `failed_uncertain` 且不自动重发。协议见 [`docs/autonomous-speech.md`](docs/autonomous-speech.md)。

## 常用命令

```bash
make dev          # Web + gateway + control API + 持续 worker
make frontend     # 仅 Web
make backend      # 仅三个后端进程
make worker       # 手动处理一批入站消息
make db-generate  # 生成 migration，必须审阅 SQL
make db-migrate   # 应用已审阅 migration
make check        # ESLint + typecheck + workspace 边界 + 单元测试
make test         # 构建 + 完整测试
```

## 主要目录

```text
apps/web/                    Vinext 控制台 UI
apps/control-api/            PostgreSQL 控制面 API
apps/napcat-gateway/         NapCat OneBot WebSocket adapter
apps/agent-worker/           入站投影与后续调度 Worker
packages/agent-core/         无运行时依赖的 Agent 领域策略
packages/db/                 PostgreSQL schema、migration 与数据库脚本
packages/im/                 IM/OneBot 消息标准化
packages/config|llm|shared/  配置、模型 adapter 与稳定通用代码
docs/                        核心需求、设计与接入文档
```

仓库使用单一根 `package-lock.json`。Workspace 间只能通过 `@asuka-agent/*` 的公开 `exports` 导入；`npm run check:boundaries` 会拒绝跨包相对导入、未声明依赖、私有子路径和循环依赖。

核心参考是 [`docs/requirements-and-development.md`](docs/requirements-and-development.md)，NapCat 配置和排错见 [`docs/qq-ingress.md`](docs/qq-ingress.md)。

## 安全边界

QQ 通道只接收白名单群和联系人消息；主动外发同样受白名单约束，且默认关闭并处于影子模式。图片、语音和文件保留在接收箱原始 payload 中，但暂不投影到 Agent 会话。记忆沉淀只生成带说话人归因和消息证据的待审候选；在正式记忆库与召回策略实现前，不会自动激活这些候选。
