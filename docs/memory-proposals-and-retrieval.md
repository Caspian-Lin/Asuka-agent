# Agent 全局记忆提案与召回边界

本文定义 issue #11 的可修改、可审计基线。核心语义由 `packages/agent-core` 和 PostgreSQL 自己拥有，不依赖托管记忆服务、不可检查的自动更新算法或外部专用数据库。

## 边界

本阶段实现：

- Thought Turn 产生带 source conversation/speaker、subject、message evidence、prompt version 的 memory proposal；
- `create/duplicate/update/conflict` 都新增 proposal；update/conflict 保存 target 和 before/after diff，不改写旧行；
- consolidation 以 `(agent_id, stable subject_id)` 为比较空间，conversation 只是来源，不是知识分区；
- active memory 的全局 retrieval port、确定性披露过滤、词法阈值拒绝和逐条 audit；
- passive context injection 与 `recall_memories` 使用同一个端口；
- health 等敏感事实由服务端最低分类强制升级为 `restricted`。

本阶段不实现：

- proposal 的审核、自动激活、驳回、归档或 supersede 状态机；
- embedding、向量库、图数据库或 LLM reranker；
- 自动接受模型给出的更新或冲突判断；
- 用 conversation ID 代替 subject、参与者和授权判断。

普通 worker 只创建 `pending_review`。retrieval loader 只读取显式 `active`，因此待审内容不会因为相关性高而进入模型。

## Proposal 契约

`memory_candidates` 当前作为待审 proposal 记录，保存：

```text
agent_id
source conversation_id / source_speaker_id / subject_id
thought_run_id / evidence_message_ids / prompt_version
operation / target_candidate_id / diff
memory_type / claim / confidence_millis / attribution_status
sensitivity / disclosure_policy
valid_from / valid_to
status
```

主体不可靠时必须是 `subject_id = null + attribution_status = unresolved`。unresolved proposal 只能是 `create`，不能更新、冲突或合并到其他主体。

`update/conflict/duplicate` 必须引用当前模型可见的 Agent 全局 target，且 target 与新 proposal 的 `subject_id` 完全相同。服务端从 target 和新内容生成 diff；模型不能直接改写 target。

## 敏感度与披露

敏感度为 `public | normal | sensitive | restricted`。模型可以选择更严格的级别，不能把服务端识别出的 health 内容降级。当前服务端最低分类覆盖过敏、病史、诊断、症状、用药、手术、怀孕、残疾和心理健康等中英文表达。

披露 scope 为：

| scope | 条件 |
|---|---|
| `public` | subject 是当前参与者或 Agent 自身 |
| `subject` | subject 必须是当前参与者 |
| `private` | subject 必须是当前参与者，且当前为私聊 |
| `allowlist` | subject 必须是当前参与者，并命中 conversation/participant allowlist |

`normal/sensitive/restricted` 还分别要求对应 read permission。restricted 默认 `private`；群聊只有显式 allowlist 加 `memory:restricted:read` 才能读取。

确定性过滤顺序：

```text
agent
  -> active status
  -> resolved subject
  -> valid_from / valid_to
  -> sensitivity permission
  -> current participants
  -> disclosure policy
  -> lexical relevance threshold
  -> rank / limit
```

任何 hard filter 失败都不会进入相关性排序。零匹配或低于阈值时返回空，不用低相关记录补满 limit。

## 可替换 Retrieval Port

`createGlobalMemoryRetrievalPort` 只要求两个由宿主提供的函数：

```js
createGlobalMemoryRetrievalPort({
  loadActiveMemories,
  recordAudit,
  clock,
});
```

当前 loader 使用 PostgreSQL，排序器使用可复现的中文 bigram/拉丁 token 重合分数。后续可以替换 loader 或增加 BM25/vector/graph candidate source，但 hard filter、拒绝阈值、返回契约与 audit 仍由本仓库控制。

每次 passive/tool retrieval 都写一条 `memory_retrieval_audits`；每个候选在 `memory_retrieval_items` 保存 `returned/filtered/below_threshold`、reason、score 和 rank。空结果同样写 audit。Thought context projector 只接受 `disclosureDecision=allowed && meetsThreshold=true`，形成第二道注入边界。

## 开源方案取舍

- [Graphiti](https://github.com/getzep/graphiti) 的 episode provenance、事实有效期和“失效而非删除”适合本项目，因此保留 source Thought/message、`valid_from/valid_to` 和不可变 update/conflict proposal；当前不引入其图数据库运行时。
- [Mem0](https://github.com/mem0ai/mem0) 的原子记忆与 ADD/UPDATE/DELETE/NOOP 思路说明 consolidation 应显式表达变更；本项目改为 create/duplicate/update/conflict proposal，删除和覆盖不会由模型直接执行。
- [LangGraph memory](https://docs.langchain.com/oss/python/concepts/memory) 区分 thread 短期状态与跨 thread store；本项目对应 Thought Stream 与 Agent 全局 memory port，但 namespace 之外还增加 stable subject 和披露硬策略。
- [Letta memory](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy) 区分常驻 core block 与按需 archival memory；本项目保留“少量高价值上下文 + 按需召回”，但不采用可并发 last-write-wins 的自编辑 block 作为个人事实源。

这些项目仅作为设计参考，没有成为运行时依赖。领域契约、SQL migration、策略和测试均在仓库内可直接修改。
