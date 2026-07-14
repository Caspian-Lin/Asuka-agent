# Purr Memory Lab

一个可运行、可追溯、可评测的持续型聊天 Agent 第一阶段 MVP。

它优先验证长期 Agent 最容易被忽略的闭环：原始事件 → 记忆召回 → 候选记忆 → Shadow 思绪 → 人工标签 → 回归评测。第一阶段不会自主向外部通道发消息，也不依赖任何模型 API key。

## 已实现

- 单用户 Web 对话与持久化历史；
- correlation id 串联的事件日志；
- 偏好、目标、明确记忆和未来事项候选抽取；
- 候选接受/拒绝、有效记忆归档；
- 带低相关拒绝的可解释记忆检索；
- 结构化 Shadow 思绪及 `应发送/稍后/静默` 标签；
- 固定的偏好召回、目标召回、未知信息拒答评测；
- Shadow Mode、安静时段、每日主动预算设置；
- Cloudflare D1 + Drizzle 持久化；
- 响应式中文研究看板。

## 快速开始

要求 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

浏览器打开终端显示的本地地址。首次请求会创建 D1 表并注入可复现的演示数据。

推荐演示路径：

1. 在对话输入“我喜欢浅色、可视化的界面”；
2. 到“记忆”接受刚生成的候选；
3. 到“思绪”标注这轮主动意图；
4. 到“评测”运行 `phase1-memory-smoke`；
5. 刷新页面确认消息、标签与评测结果仍然存在。

## 质量检查

```bash
npm run lint
npm run test:unit
npm run db:generate
npm test
```

`npm test` 会先构建站点，再运行领域单测与产物渲染测试。

## 主要目录

```text
app/api/                  HTTP command/query routes
app/components/           Agent 控制台
db/schema.ts              14 张领域表
db/runtime.ts             D1 运行时建表
drizzle/                  版本化 SQL migration
lib/agent-core.ts         检索、抽取、思绪和回复纯函数
lib/server/agent-service.ts 领域编排与持久化
docs/                     需求、开发设计和机器可读评测 schema
tests/                    单元与渲染测试
```

## 文档

- [完整需求与开发设计](docs/requirements-and-development.md)
- [评测 JSON Schema](docs/schemas/phase1-evaluation.schema.json)
- [第一阶段评测 seed](docs/schemas/phase1-evaluation-seed.json)

## API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/bootstrap` | 获取完整实验快照 |
| POST | `/api/messages` | 执行一轮对话/记忆/思绪流水线 |
| PATCH | `/api/memories` | 接受、拒绝或归档记忆 |
| PATCH | `/api/thoughts` | 标注主动思绪 |
| POST | `/api/evaluations` | 运行固定回归集 |
| PATCH | `/api/settings` | 保存策略设置 |
| POST | `/api/reset` | 恢复演示数据 |

## MVP 边界

当前回复与抽取由确定性 adapter 生成，目的是把系统接口、数据质量和模型能力分开测量。生产演进建议使用 PostgreSQL/pgvector、正式 migration、事件 outbox、混合检索、IM gateway、job worker 和受能力令牌约束的 tool runner；具体阶段和进入条件见完整设计文档。

