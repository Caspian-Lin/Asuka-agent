# Scheduled Cognition

本文定义 Asuka Agent 的定时认知运行协议。Issue #3 的单轮 MVP 已演进到会话隔离的 **Thought Stream v2**；各小节会明确已实现边界与仍待完成的执行阶段。

## 当前实现

当前 PostgreSQL 认知任务包括：

- `thought_tick`：每 15 分钟检查各白名单 QQ 会话 watermark 后的新消息，由 primary 模型生成自然 Markdown 思绪并进行有界只读 tool-call 循环；fast 随后把原文编译为严格 reply/memory/task/no_action proposals，必要时最多要求两次 primary revision；
- `memory_consolidation`：每天 03:00（Asia/Shanghai）由 primary 模型生成待审的 create/update/conflict 记忆候选。

每个会话拥有独立 Thought Stream、Epoch、追加式 Turn 和 watermark。accepted proposal、Turn 完成状态、watermark 与消息 thought-read 状态已原子提交，`no_action` 同样是成功结果。预计下一轮达到可用输入的 72% 时，worker 会先用无工具的 primary 调用压缩旧 Epoch，再原子切换到携带完整摘要的新 Epoch；本轮新增消息不会被提前吞入摘要。操作员仍可关闭当前 Epoch 并开启空的新段，已提交 watermark 不回退。reply proposal 已接入服务端硬策略和 NapCat 唯一出站队列；默认总开关关闭且为 Shadow。当前没有正式记忆召回；`recall_memories` 在 reviewed memory store 上线前明确返回空，不会把待审候选伪装成已召回记忆。

```text
scheduler -> queued job_run -> worker lease + heartbeat
          -> messages after per-conversation watermark
          -> one thought_run per conversation + Stream lease
          -> projected context chunks + primary natural LLM/tool loop
          -> immutable primary output + event
          -> fast strict compiler + bounded revision
          -> proposals + Turn + watermark + thought-read atomic commit
          -> speech hard policy -> shadow | defer | block | NapCat delivery
```

## Thought Stream v2

### 数据契约状态

Migration `0006_glorious_rictor` 已建立 `thought_streams`、`thought_stream_epochs`、带 Stream/Epoch/Turn 顺序的 `thought_runs`，以及与实际副作用分离的 `action_proposals`。后续迁移加入 primary/compiler 检查点和 `outbound_policies / speech_decisions / outbound_deliveries`；`0010_brief_hulk` 为模型调用和 Epoch 增加 cache token 审计，不迁移旧思绪数据。`llm_calls.purpose` 区分 primary、工具续轮、compiler、revision 和 compression；消息使用 `author_kind`、`direction`、平台消息 ID 与 receipt 表达用户、Asuka 和平台回显。

上下文 projector 已按 Stream 读取首次初始化历史并集、当前 Epoch 已提交 Turn、压缩输出和本轮新消息。它以模型配置的 `context_window` 计算预算，先裁剪可选历史/低相关记忆，再按时间将必选新消息分块；每块成功后才推进到该块末尾。每次供应商实际收到的无请求头 JSON 请求体、messages 和所引用的 context items 都写入 `llm_calls`，可由 inspector 原样重放；API Key 只存在于请求头，不进入审计载荷。当前正式 memory store 尚未实现，因此 recalled-memory 段保持为空，但顺序和预算接口已经固定。

本仓库仍处于内部开发测试期，`0006` 不为旧 Thought Run 生成兼容 Stream 或 Epoch。已有 0005 测试数据的本地环境应先停止后端进程，确认 `.env` 指向可丢弃的本机数据库，再执行 `make db-reset CONFIRM_DATABASE_RESET=<库名>`；不要手工补列或直接改表。若需要回退本项，实现层回滚提交后同样重建测试数据库至目标 migration，而不是尝试保留临时测试数据。

### 对象与隔离边界

```text
Thought Stream   一个 Agent 在一个 conversation 中持续存在的短期认知流
Thought Turn     一次 trigger 对该会话新增输入的处理
LLM Call         一个 Turn 内的主模型、工具续轮、fast 编译或压缩调用
Action Proposal  从自然思绪编译出的候选副作用，不等于已经执行
Memory           Agent 全局知识；保留来源与披露约束，不按会话拆库
```

Thought Stream 以 `(agent_id, conversation_id)` 唯一。群聊和私聊不能共享思绪窗口，同一会话的 Turn 必须串行提交。一个全局 scheduler 可以同时发现多个会话，但应分别领取 lease、组装上下文、推进 watermark，任何一个会话失败都不能阻塞其他会话。

记忆属于 Agent 全局知识空间，可以跨会话检索和合并；每条记忆仍必须保存 `source_conversation_id/source_speaker_id/subject_id/evidence`、敏感度和披露策略。跨会话可召回不等于可以向任何群成员披露。

### 身份与消息角色

每条输入必须包含稳定身份，而不是只传昵称：

```text
message_id / author_kind(user|agent|system)
sender_id / sender_display_name / reply_to
sent_at / conversation_type(group|private) / content
```

- `sender_id` 是身份；首次见到的群名片或昵称固定为主要展示名，后续变化只追加为 alias；
- 第一人称默认指向当前 `sender_id`，不得把不同用户的信息合并；
- `author_kind=agent` 或 `sender_id=agent-asuka` 表示 Asuka 自己此前说的话；
- 转述对象不明确时保持 unresolved，不猜测最近发言者；
- NapCat 自身回显不能作为唯一的 Agent 历史来源。当前发送链路会在调用 NapCat 前将 Asuka 的 outbound message 正式持久化，并用唯一 delivery/echo 对平台结果做幂等关联。

### 上下文顺序

每个主模型请求使用稳定前缀和追加式尾部：

1. **稳定 system prompt（必选）**：身份、行为原则、多人归因协议、安全边界和思绪目标；使用中文“你是 Asuka”，不使用“扮演 Asuka”。它要求自然思绪与修订始终输出简体中文，鼓励主动关注有价值的互动机会，但不强迫每轮发言。
2. **稳定 tools（按能力启用）**：通过 API `tools` 参数传递，名称、顺序和 schema 保持稳定。首版只开放消息搜索、记忆召回等只读工具。
3. **上一 epoch 的压缩输出（压缩后必选）**：正在继续的话题、承诺、未决问题、关系状态、关键 memory 引用与最后动作状态。
4. **初始化历史（可选）**：仅 Stream 的第一个 Epoch、第一轮 Thought 加入。选择“最近 N 条”和“最近 N 分钟”的并集，按 message ID 去重、时间升序排列，并受 token budget 限制；压缩或手动重置产生的后续 Epoch 都不会回填它。
5. **本 epoch 已提交的 Thought Turns（必选）**：保持原始顺序，包括新输入、每轮主模型工具调用、对应工具返回和最终自然输出。assistant/tool 消息先进入本段续轮，成功提交后继续进入同 epoch 的后续 Thought，直到被压缩摘要替代或被操作员重置。
6. **本轮召回记忆（可选）**：放在动态尾部，附 memory ID、subject/source、有效期、敏感度和证据；低置信或不可披露内容不注入。
7. **本轮新增来源（必选）**：watermark 后的 IM 消息；未来可增加外部 source event。新输入永远放在最后。

动态时间、参与者快照、召回结果和本轮消息不得写入稳定 system prompt。相同前缀应保持字节级稳定以提高 provider KV/context cache 命中率，但缓存只是性能优化，不能成为正确性依赖。

Chat completion 调用本身无状态，因此每次独立请求都必须重新携带该次调用需要的 system 指令一次；工具续轮复用原请求中的稳定指令，不得逐轮追加副本。DashScope 的 structured output 适配会为 compiler 额外加入一条 JSON 输出格式约束，它与动作编译行为指令职责不同，不代表 Agent system prompt 重复。

### 上下文预算

以设置页 `context_window` 和模型真实上限的较小值计算 soft limit，并预留主模型输出、工具结果与异常增长空间：

```text
soft_limit = min(configured_context_window, provider_model_limit)
             - reserved_output
             - reserved_tool_result
compress_at = 70% ~ 75% of soft_limit
```

当前默认 `compress_at=72%`。provider 未单独声明上限时使用模型设置中的 `context_window`；任务配置可用更小的 `providerContextWindow` 收紧真实上限，但不能放大设置值。cache 命中 token 只写入调用和 Epoch 指标，不参与恢复或正确性判断。

新消息是必选输入。超出预算时依次缩减初始化历史和低相关记忆；如果仅新消息已经超限，按时间顺序分 chunk 处理，watermark 只推进到实际成功处理的最后一条。

## 一轮思绪的执行协议

```text
trigger + conversation lease
  -> snapshot new messages after committed watermark
  -> build append-only context
  -> primary model natural cognition
       -> optional read-only tool call
       -> append tool result and continue primary model
       -> final inspectable cognition journal
  -> fast model action compiler (strict JSON)
       -> accepted | needs_revision
  -> deterministic evidence/policy validation
  -> persist Turn + proposals + watermark + thought-read atomically
```

### Primary：自然认知

主模型输出简体中文自然文本或 Markdown，不使用 JSON Schema。system prompt 要求它留下可检查的“认知工作记录”，包括对新消息的观察、相关记忆、不确定性、值得继续了解的内容、互动机会、建议表达和可能的记忆候选。工具名称、证据 ID、原消息引用等技术或原文内容可以保留原语言，但正文不得无故切换为英文。

该记录不是供应商隐藏 chain-of-thought，也不要求逐 token 展示私有推理。系统保存模型主动给出的结论、依据、联想和行动草稿，以便后续连续思考和用户审计。

控制台审计大纲使用统一的“进入后续上下文”语义：新消息、成功工具轮次的 assistant/tool 原文和最终自然输出都会继续发送给本段后续调用及同 epoch 的后续 Thought；“仅执行记录”表示失败、原始请求载荷或 fast 编译结果只用于审计。两类记录都保存在 PostgreSQL。每次调用的“完整调用载荷”直接展示实际发送给 Provider 的无请求头原始 JSON；移除“仅执行记录”后，固定 system/tools 加上绿色原文应能还原下一次主模型上下文。

主模型可以多轮调用只读工具。发送消息、写正式记忆、删除或修改外部状态等副作用不能作为工具直接执行，只能在最终文本中提出候选动作。

### Fast：动作编译

fast 模型接收：主模型完整输出、可引用 message/memory/source manifest、允许的 action schema 和策略摘要。它只负责编译，不重写主模型思想或替主模型补充事实。

概念协议：

```json
{
  "status": "accepted",
  "revisionReasons": [],
  "actions": [
    { "type": "reply_proposal", "targetConversationId": "...", "draft": "..." },
    { "type": "memory_proposal", "subjectId": "...", "evidenceMessageIds": ["..."] }
  ]
}
```

- `no_action` 是合法结果；没有发言或归档意图不算缺失；
- fast 返回非法 JSON 时只重试 compiler，不重复主模型自然生成；
- fast 返回 `needs_revision` 时，具体原因作为反馈追加给 primary，最多修订 1–2 次；
- reply draft 应复制主模型给出的自然表达，不由 fast 重新润色；
- fast 不能授权动作。服务端仍需校验证据、身份、权限、预算、重复发送和幂等键；
- accepted action 先落为 proposal。发送、记忆激活和其他副作用由独立执行器处理。

如果 primary 已成功而 compiler 暂时失败，应保存 primary 输出并从 compiler 阶段续跑，避免相同自然思绪被重复生成。只有 Turn 完整提交后才能推进消息 watermark 并把截至该 watermark 的入站消息同步为 thought-read；`no_action` 完成同样可以推进。

### Speech：硬策略与唯一 executor

`reply/no_action` proposal 完成后，worker 创建 `speech_decisions`。硬策略不调用模型，依次检查总开关、Channel、QQ 白名单、目标、证据、时效、重复、静默时段、每日额度、会话冷却和 `shadow|active` 模式。只有 `speak` 会先原子创建本地 outbound message 与 delivery；NapCat gateway 是唯一允许执行 OneBot send action 的进程。

每个 proposal 只能对应一个 decision 和 delivery，稳定 `echo` 关联 OneBot 响应。发送后没有收到明确响应时进入 `failed_uncertain` 且不自动重试，避免重复群消息。完整协议和示例见 [`autonomous-speech.md`](autonomous-speech.md)。

## 重置、压缩与新 Epoch

操作员可通过控制台对单个 conversation 执行 context reset。服务端持有 Stream 行锁，并在该 Stream 没有有效活动 lease 时：

- 关闭当前 Epoch，保留它的 Turn、LLM Call、context item、proposal 与 event；
- `current_epoch_ordinal + 1`，下一条 Thought 在新 Epoch 中运行；
- 不生成 compression output，也不向新 Epoch 注入初始化历史；
- 不回退 `committed_message_at/id`，因此重置前已消费消息不会被再次读取；
- 写入 `thought_context_reset` operator event，供审计追溯。

重置解决“主动从头开始”，压缩解决“有损延续长期对话”，两者不能混为同一种操作。

预计下一轮会超过阈值时，先创建特殊 compression call。调用结果先独立持久化；只有摘要校验通过后，worker 才在一个 PostgreSQL 事务中关闭旧 Epoch、创建新 Epoch、推进 Stream ordinal 并把当前 Turn 归入新 Epoch。调用后、事务前崩溃会继续使用旧 Epoch，并在重试时复用已保存的合格摘要；事务内不会暴露半切换状态。

压缩调用遵循：

- 使用 primary 模型；
- 请求中不提供 tools，并在支持时设置 `tool_choice=none`；
- 若输出伪造工具调用或缺少必要身份引用，则拒绝并有限重试；
- 复述仍在继续的话题、未兑现承诺、未决任务、参与者状态、Asuka 当前立场、最后动作状态和仍需保留的 memory ID；
- 已结束闲聊、无价值复读和已完成工具的原始 trace 不进入摘要；
- 与未完成事项有关的工具结论必须保留，已归档内容可以保存 memory 引用而不重复全文。

压缩成功后原始 Turn、LLM Call 和工具记录仍留在 PostgreSQL。Stream 只切换到新的 `epoch`，后续模型上下文不再发送旧 epoch 全文：

```text
stable system + stable tools
+ complete compression output
+ new Thought Turns
```

## 端到端示例

假设群聊 `group:808607473` 已有一条 Asuka 自己的承诺：

```text
[20:00][agent-asuka][Asuka] 好，等大家确认日期后我来整理露营清单。
```

本轮新增消息：

```text
[20:12][user-2849][小林] 周六想去露营，不过我对花生过敏，吃的要注意。
[20:13][user-513][阿遥] 我可以负责订营地，Asuka 帮我们列清单吧。
```

主模型看到的尾部会明确标记群聊、稳定用户 ID、Asuka 自身历史和两条新增消息。Primary 可以自然输出：

```markdown
小林明确表达了周六参加露营的意愿，也第一次提到花生过敏；这是小林自己的健康信息，不能错放到阿遥身上。阿遥承担的是预订营地，并直接请我整理清单。

我之前已经答应在日期确认后整理，现在周六基本形成了共同方向，适合接住这个请求，而不是继续旁观。回复时可以先确认分工，再把饮食安全单独列为一项，但不需要在群里反复强调小林的个人信息。

我想回复：“收到，阿遥负责营地，我来整理周六露营清单。饮食我会单列过敏原确认，大家也把交通和装备需求发一下。”

小林的花生过敏值得形成一条受限的记忆候选，用于以后涉及共同饮食时做安全提醒；证据只来自 message-101，不能扩大推断。
```

Fast compiler 不改写这段思绪，只生成机器动作：

```json
{
  "status": "accepted",
  "revisionReasons": [],
  "actions": [
    {
      "type": "reply_proposal",
      "targetConversationId": "group:808607473",
      "draft": "收到，阿遥负责营地，我来整理周六露营清单。饮食我会单列过敏原确认，大家也把交通和装备需求发一下。",
      "evidenceMessageIds": ["message-101", "message-102"]
    },
    {
      "type": "memory_proposal",
      "subjectId": "user-2849",
      "sourceSpeakerId": "user-2849",
      "claim": "小林对花生过敏",
      "sensitivity": "health",
      "disclosure": "restricted",
      "evidenceMessageIds": ["message-101"]
    }
  ]
}
```

下一次触发时，Primary 上下文保留上面的消息、自然思绪及 proposal 状态，再把 watermark 后的新消息追加到末尾。达到压缩阈值后，compression output 可能是：

```markdown
正在继续：群成员计划周六露营。阿遥负责预订营地，Asuka 已承诺整理清单，仍等待交通和装备需求。

参与者与边界：user-2849 是小林；其花生过敏已形成受限 memory proposal `memory-proposal-7`，不得归到 user-513，也不得在无关场景披露。

Asuka 当前状态：已提出群内回复，等待发送策略处理；如果群成员补充需求，应继续更新同一份清单。
```

新 epoch 以这段完整输出作为连续短期记忆，不再发送此前全部闲聊和原始工具 trace。

## 可观测性与验收

每个 Turn 至少可查看：trigger、conversation、epoch、watermark 范围、实际上下文项、每轮模型/profile、工具调用、primary 自然输出、fast 编译结果、revision、token、缓存 token、压缩来源和最终 proposal。

验收必须覆盖：

1. 两个群聊同时有消息时产生两个隔离 Stream；
2. 同一群内两个用户的相反事实不会串人；
3. Asuka 自己的历史消息以 agent role 出现；
4. primary 自然输出不受 JSON Schema 限制；
5. fast 非法 JSON 只重试 compiler，`needs_revision` 有界返回 primary；
6. `no_action` 正常提交并推进 watermark；
7. compiler 失败后可从已保存 primary 输出恢复；
8. 压缩前后未决任务和身份归因保持一致；
9. 全局记忆可跨会话召回，但敏感内容不能越过披露策略；
10. 重试、并发和 worker 重启不会重复 proposal 或发送。

## 本地 MVP 验收

当前实现仍可通过以下方式验证：

1. 执行 `make db-migrate`；
2. 在设置页分别保存并启用 fast 和 primary；
3. 运行 `make dev`；
4. 在“定时任务”中立即运行思绪或记忆整理；
5. 在 Thought Run inspector 查看触发、调用上下文、token 和来源。

```bash
curl -X POST http://127.0.0.1:3002/api/jobs/job-thought-tick/run
curl http://127.0.0.1:3002/api/jobs/job-thought-tick/runs
curl http://127.0.0.1:3002/api/job-runs/RUN_ID
```

默认 OpenAI-compatible structured output 使用 `json_schema`；DashScope compiler 自动使用 `json_object`、关闭 thinking 并注入 JSON 约束。Primary 的自然思绪调用不设置 `response_format`。配置页应分别验证普通自然文本能力和 compiler 结构化输出能力。
