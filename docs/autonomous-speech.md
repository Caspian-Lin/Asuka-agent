# 自主发言运行协议

自主发言是 Thought Stream 的受限副作用出口。LLM 只做语义决策和草稿生成，服务端拥有最终发送权限；第一版不训练小分类器。

## 数据流

```text
白名单 QQ 新消息
  → conversation-isolated primary 自然思绪 / 只读工具循环
  → fast action compiler（reply | no_action）
  → speech_decisions 硬策略评估
  → shadow_speak：只记录
  → speak：本地 message + outbound_delivery 原子入队
  → NapCat send_group_msg / send_private_msg
  → 同 echo 的响应确认 sent / failed
```

`reply` 的正文必须是 primary 输出中的连续原文，fast 模型不能偷偷改写。proposal 必须引用本轮可见证据，目标 conversation 必须与触发会话一致。`no_action` 是正常的 `silent` 结果，不是失败。

## 硬策略顺序

服务端依次检查：全局总开关、Channel 状态、QQ 白名单、目标一致性、非空草稿、证据、发言时效、近期重复、静默时段、每日额度、单会话冷却、Agent 模式。结果包括：

- `blocked`：权限或数据边界不满足，不再执行；
- `silent`：模型不说、内容重复或机会过期；
- `defer`：静默时段、额度或冷却暂不允许，保留下一评估时间；
- `shadow_speak`：所有检查通过，但只记录“本来会发送”；
- `speak`：所有检查通过，并进入唯一出站队列。

迁移会为 `agent-asuka` 创建 `enabled=false` 的安全默认策略；Agent 默认仍是 `shadow`。只有操作员在“自主发言”页面同时打开总开关并选择真实发送，才可能产生外部消息。

## 幂等与失败语义

每个 proposal 只能拥有一条 speech decision 和一条 outbound delivery。delivery 使用稳定 `echo=outbound:<decision-id>`，发送前本地消息已经存在。NapCat 明确返回 `status=ok, retcode=0` 后记录平台 `message_id`；明确拒绝记为 `failed`。

WebSocket 在发送后断开或响应超时属于结果不确定：状态进入 `failed_uncertain`，不会自动重试。这个选择优先避免对群成员重复发言；操作员可以从审计页查看错误，但反馈按钮不会补发。

保存任意策略变更时，仍处于 `queued/retry_wait` 的旧 delivery 会被取消；gateway 领取时还会重新检查当前总开关、active 模式、Channel、策略版本、freshness 和进程当前 QQ 白名单。因此关闭总开关或移除白名单后，尚未交给 WebSocket 的消息不会在以后重新启用时补发。已经处于 `sending/awaiting_response` 的消息可能已经到达 QQ，只能继续等待明确响应或进入 `failed_uncertain`。

## 示例

群 `808607473` 的新消息触发一次 thought。primary 写下自然观察并给出草稿“周六下午我可以一起整理，要先列个清单吗？”，fast 编译为：

```json
{
  "type": "reply",
  "targetConversationId": "conversation-id",
  "content": "周六下午我可以一起整理，要先列个清单吗？",
  "evidenceReferences": [{ "type": "message", "id": "qq-message-id" }]
}
```

若当前为 shadow，决策保存为 `shadow_speak`，QQ 不会收到消息。切换 active 后，同类新 proposal 还要通过额度、冷却、去重等检查；通过时 gateway 发送：

```json
{
  "action": "send_group_msg",
  "params": { "group_id": "808607473", "message": "周六下午我可以一起整理，要先列个清单吗？" },
  "echo": "outbound:speech-decision-id"
}
```

控制台的“应该发送 / 应该延后 / 应该沉默”只积累人工评估标签。未来数据足够时可以训练校准后的分类器，但分类器仍不能绕过硬策略。
