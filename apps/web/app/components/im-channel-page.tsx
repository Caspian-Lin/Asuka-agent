"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LuCheckCheck,
  LuInbox,
  LuPlugZap,
  LuRefreshCw,
} from "react-icons/lu";
import { controlRequest } from "./control-api";

type ImConversation = {
  id: string;
  external_id: string;
  title: string;
  status: string;
  message_count: number;
  unread_count: number;
  last_message_at: string | null;
};

type ImChannel = {
  id: string;
  provider: string;
  account_id: string;
  enabled: boolean;
  last_seen_at: string | null;
  config: { groupWhitelist?: string[]; privateUserWhitelist?: string[] };
  unread_count: number;
  conversations: ImConversation[];
};

type ImMessage = {
  id: string;
  role: string;
  content: string;
  sender_id: string | null;
  sender_name: string;
  read_at: string | null;
  created_at: string;
};

type ImSnapshot = {
  channels: ImChannel[];
  selectedConversationId: string | null;
  messages: ImMessage[];
};

function formatDateTime(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function isOnline(value?: string | null) {
  return Boolean(value && Date.now() - new Date(value).getTime() < 90_000);
}

export default function ImChannelPage() {
  const [snapshot, setSnapshot] = useState<ImSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const selectedConversationRef = useRef<string | null>(null);

  const load = useCallback(async (conversationId?: string | null) => {
    setLoading(true);
    try {
      const query = conversationId
        ? `?conversationId=${encodeURIComponent(conversationId)}`
        : "";
      const payload = await controlRequest<ImSnapshot>(`/api/im${query}`);
      selectedConversationRef.current = payload.selectedConversationId;
      setSnapshot(payload);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Channel 数据载入失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => {
      void load(selectedConversationRef.current);
    }, 10_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  const selectedConversation = useMemo(
    () => snapshot?.channels
      .flatMap((channel) => channel.conversations)
      .find((conversation) => conversation.id === snapshot.selectedConversationId),
    [snapshot],
  );

  async function markRead() {
    if (!snapshot?.selectedConversationId) return;
    setLoading(true);
    try {
      await controlRequest<{ updated: number }>("/api/im/read", {
        method: "POST",
        body: JSON.stringify({ conversationId: snapshot.selectedConversationId }),
      });
      await load(snapshot.selectedConversationId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "标记已读失败");
      setLoading(false);
    }
  }

  if (error && !snapshot) {
    return (
      <section className="page-panel">
        <div className="service-error">
          <LuPlugZap className="state-illustration" aria-hidden />
          <span>连接中断</span>
          <h1>无法读取 IM Channel</h1>
          <p>{error}</p>
          <button className="primary-button" onClick={() => void load()}><LuRefreshCw aria-hidden />重新连接</button>
        </div>
      </section>
    );
  }

  const channels = snapshot?.channels ?? [];
  const totalUnread = channels.reduce((total, channel) => total + channel.unread_count, 0);

  return (
    <section className="page-panel im-page">
      <div className="page-hero">
        <div>
          <span className="page-context">PostgreSQL · NapCat OneBot 11</span>
          <h1>IM Channel</h1>
          <p>只保留白名单 QQ 群和私聊联系人消息。WebSocket 事件先进入不可变接收箱，再由 worker 投影为可读会话。</p>
        </div>
        <div className="hero-stat"><strong>{totalUnread}</strong><span>未读消息</span></div>
      </div>

      {channels.length === 0 ? (
        <div className="empty-state channel-empty">
          <LuPlugZap className="empty-icon" aria-hidden />
          <h3>尚未发现 Channel</h3>
          <p>启动 `make backend`；网关鉴权成功后会登记当前 NapCat 账号。</p>
        </div>
      ) : (
        <div className="im-workspace">
          <aside className="channel-browser">
            {channels.map((channel) => {
              const online = isOnline(channel.last_seen_at);
              const whitelist = channel.config?.groupWhitelist ?? [];
              const privateWhitelist = channel.config?.privateUserWhitelist ?? [];
              return (
                <section className="channel-block" key={channel.id}>
                  <div className="channel-summary">
                    <span className={`channel-provider ${online ? "online" : "offline"}`}>QQ</span>
                    <div><strong>NapCat · {channel.account_id}</strong><small>{online ? "网关在线" : "等待网关心跳"} · {whitelist.length} 群 · {privateWhitelist.length} 私聊</small></div>
                    {channel.unread_count > 0 && <em>{channel.unread_count}</em>}
                  </div>
                  <div className="conversation-list">
                    {channel.conversations.length === 0 ? (
                      <p>白名单会话尚无已投影消息。</p>
                    ) : channel.conversations.map((conversation) => (
                      <button
                        key={conversation.id}
                        className={snapshot?.selectedConversationId === conversation.id ? "active" : ""}
                        onClick={() => void load(conversation.id)}
                      >
                        <span><strong>{conversation.title}</strong><small>{conversation.message_count} 条 · {formatDateTime(conversation.last_message_at)}</small></span>
                        {conversation.unread_count > 0 && <em>{conversation.unread_count}</em>}
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </aside>

          <section className="im-history">
            <header>
              <div><span className="page-context">Message history</span><h2>{selectedConversation?.title ?? "选择一个群会话"}</h2></div>
              <button className="ghost-button" disabled={!selectedConversation || loading || !selectedConversation.unread_count} onClick={() => void markRead()}>
                <LuCheckCheck aria-hidden />全部标为已读
              </button>
            </header>
            {error && <p className="inline-error">{error}</p>}
            <div className="im-message-list">
              {(snapshot?.messages ?? []).length === 0 ? (
                <div className="empty-state"><LuInbox className="empty-icon" aria-hidden /><h3>暂无历史消息</h3><p>收到白名单群或私聊文本消息后会显示在这里。</p></div>
              ) : snapshot?.messages.map((message) => (
                <article className={`im-message ${message.read_at ? "read" : "unread"}`} key={message.id}>
                  <span className="im-avatar">{message.sender_name.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <header><strong>{message.sender_name}</strong><span>{formatDateTime(message.created_at)}</span>{!message.read_at && <em>未读</em>}</header>
                    <p>{message.content}</p>
                    {message.sender_id && <small>QQ {message.sender_id}</small>}
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
