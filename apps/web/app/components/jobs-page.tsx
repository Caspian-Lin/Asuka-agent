"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  LuCalendarClock,
  LuCircle,
  LuEye,
  LuPlay,
} from "react-icons/lu";
import { controlRequest } from "./control-api";
import { canManuallyRunJob, formatJobMetrics } from "./jobs-view";

type RunMetrics = {
  deliveryCount?: number;
  conversationCount?: number;
  messageCount?: number;
  llmCallCount?: number;
  thoughtCount?: number;
  candidateCount?: number;
};

type Job = {
  id: string;
  job_type: string;
  name: string;
  description: string;
  schedule_type: string;
  schedule_expression: string;
  timezone: string;
  configurable: boolean;
  enabled: boolean;
  status: "active" | "planned" | "disabled";
  last_run_at: string | null;
  next_run_at: string | null;
  latest_run_id: string | null;
  latest_run_status: string | null;
  latest_run_trigger_type: string | null;
  latest_run_attempt_count: number | null;
  latest_run_max_attempts: number | null;
  latest_run_started_at: string | null;
  latest_run_completed_at: string | null;
  latest_run_error_code: string | null;
  latest_run_error_message: string | null;
  latest_run_metrics: RunMetrics | null;
};

type JobRun = {
  id: string;
  job_id: string;
  status: string;
  trigger_type: string;
  correlation_id: string;
  scheduled_for: string | null;
  available_at: string;
  attempt_count: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  metrics: RunMetrics;
  created_at: string;
};

type RunDetail = {
  run: JobRun & { job_name: string; job_type: string };
  llmCalls: Array<{
    id: string;
    conversation_id: string | null;
    profile: "primary" | "fast";
    provider: string;
    model: string | null;
    prompt_version: string;
    status: string;
    error_code: string | null;
    latency_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
  }>;
  thoughts: Array<{
    id: string;
    intent: string;
    basis: string;
    evidence_message_ids: string[];
    confidence_millis: number;
    risk: string;
    decision: string;
    expires_at: string;
  }>;
  candidates: Array<{
    id: string;
    operation: string;
    subject_id: string | null;
    source_speaker_id: string;
    claim: string;
    evidence_message_ids: string[];
    confidence_millis: number;
    attribution_status: string;
    status: string;
  }>;
  watermarks: Array<{
    conversation_id: string;
    last_message_at: string;
    last_message_id: string;
  }>;
};

function formatDateTime(value?: string | null, fallback = "尚未执行") {
  if (!value) return fallback;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

const scheduleTypeLabel: Record<string, string> = {
  event: "事件触发",
  interval: "固定间隔",
  cron: "Cron",
};

const runStatusLabel: Record<string, string> = {
  queued: "等待领取",
  running: "执行中",
  retry_wait: "等待重试",
  succeeded: "成功",
  failed: "失败",
  dead_letter: "Dead letter",
};

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [runsLoading, setRunsLoading] = useState(false);
  const [busyJobId, setBusyJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const payload = await controlRequest<{ jobs: Job[] }>("/api/jobs");
      setJobs(payload.jobs);
      setSelectedJobId((current) => current ??
        payload.jobs.find((job) => job.job_type === "thought_tick")?.id ??
        payload.jobs[0]?.id ?? null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务数据载入失败");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRuns = useCallback(async (jobId: string, preferredRunId?: string) => {
    setRunsLoading(true);
    try {
      const payload = await controlRequest<{ runs: JobRun[] }>(
        `/api/jobs/${encodeURIComponent(jobId)}/runs`,
      );
      setRuns(payload.runs);
      setSelectedRunId((current) => preferredRunId ??
        (current && payload.runs.some((run) => run.id === current) ? current : null) ??
        payload.runs[0]?.id ?? null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "运行记录载入失败");
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const loadRunDetail = useCallback(async (runId: string) => {
    try {
      setRunDetail(await controlRequest<RunDetail>(
        `/api/job-runs/${encodeURIComponent(runId)}`,
      ));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "运行详情载入失败");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadJobs(), 0);
    const timer = window.setInterval(() => void loadJobs(), 10_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [loadJobs]);

  useEffect(() => {
    if (!selectedJobId) return;
    const initial = window.setTimeout(() => void loadRuns(selectedJobId), 0);
    const timer = window.setInterval(() => void loadRuns(selectedJobId), 10_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [loadRuns, selectedJobId]);

  useEffect(() => {
    if (!selectedRunId) return;
    const timer = window.setTimeout(() => void loadRunDetail(selectedRunId), 0);
    return () => window.clearTimeout(timer);
  }, [loadRunDetail, selectedRunId, runs]);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? null,
    [jobs, selectedJobId],
  );
  const activeCount = jobs.filter((job) => job.status === "active").length;

  async function trigger(job: Job) {
    setBusyJobId(job.id);
    setNotice(null);
    try {
      const payload = await controlRequest<{ run: JobRun }>(
        `/api/jobs/${encodeURIComponent(job.id)}/run`,
        { method: "POST" },
      );
      setSelectedJobId(job.id);
      await loadRuns(job.id, payload.run.id);
      setNotice(`${job.name}已进入队列，worker 会按租约安全领取。`);
      await loadJobs();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "手动触发失败");
    } finally {
      setBusyJobId(null);
    }
  }

  return (
    <section className="page-panel jobs-page">
      <div className="page-hero">
        <div><span className="page-context">Scheduler control plane</span><h1>定时触发任务</h1><p>认知任务从 PostgreSQL 增量证据开始，经租约、结构化模型输出和确定性归因校验后推进 watermark。失败不会阻塞 QQ 入站。</p></div>
        <div className="dual-stat"><span><strong>{activeCount}</strong>已启用</span><i /><span><strong>{jobs.length - activeCount}</strong>规划或停用</span></div>
      </div>

      <div aria-live="polite">
        {error && <div className="inline-error">{error} <button onClick={() => void loadJobs()}>重试</button></div>}
        {notice && <div className="inline-success">{notice}</div>}
      </div>

      {loading ? (
        <div className="jobs-skeleton" aria-label="正在载入任务">
          <i /><i /><i />
        </div>
      ) : jobs.length === 0 ? (
        <div className="jobs-empty"><LuCalendarClock className="empty-icon" aria-hidden /><h2>还没有登记任务</h2><p>先应用 PostgreSQL migration，再刷新此页面。</p></div>
      ) : (
        <div className="jobs-workspace">
          <div className="job-list" aria-label="任务列表">
            {jobs.map((job) => {
              const selected = job.id === selectedJobId;
              return (
                <article className={`job-row status-${job.status}${selected ? " selected" : ""}`} key={job.id}>
                  <button
                    className="job-row-main"
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelectedJobId(job.id)}
                  >
                    <span className={`job-status ${job.status}`}><LuCircle aria-hidden />{job.status === "active" ? "已启用" : job.status === "disabled" ? "已停用" : "规划中"}</span>
                    <span className="job-row-copy"><strong>{job.name}</strong><small>{job.description}</small></span>
                    <span className="job-schedule"><code>{job.schedule_expression}</code><small>{scheduleTypeLabel[job.schedule_type] ?? job.schedule_type}</small></span>
                  </button>
                  <dl>
                    <div><dt>下次执行</dt><dd>{formatDateTime(job.next_run_at, "等待调度")}</dd></div>
                    <div><dt>最近结果</dt><dd>{job.latest_run_status ? runStatusLabel[job.latest_run_status] ?? job.latest_run_status : "暂无记录"}</dd></div>
                    <div><dt>处理范围</dt><dd>{formatJobMetrics(job.latest_run_metrics)}</dd></div>
                    <div><dt>失败原因</dt><dd className={job.latest_run_error_code ? "error-copy" : ""}>{job.latest_run_error_code ?? "—"}</dd></div>
                  </dl>
                  <footer>
                    <span>{job.configurable ? "配置入口尚未开放" : "系统托管计划"} · {job.timezone}</span>
                    <div>
                      <button className="ghost-button" type="button" onClick={() => setSelectedJobId(job.id)}><LuEye aria-hidden />查看 runs</button>
                      {canManuallyRunJob(job) && (
                        <button className="primary-button" type="button" disabled={busyJobId === job.id} onClick={() => void trigger(job)}>
                          <LuPlay aria-hidden />{busyJobId === job.id ? "入队中…" : "立即运行"}
                        </button>
                      )}
                    </div>
                  </footer>
                </article>
              );
            })}
          </div>

          <aside className="run-inspector" aria-label="任务运行详情">
            <header>
              <div><span>运行审计</span><h2>{selectedJob?.name ?? "选择一个任务"}</h2></div>
              {selectedJob?.latest_run_status && <span className={`run-state state-${selectedJob.latest_run_status}`}>{runStatusLabel[selectedJob.latest_run_status] ?? selectedJob.latest_run_status}</span>}
            </header>

            {runsLoading && runs.length === 0 ? (
              <div className="run-loading"><i /><i /></div>
            ) : runs.length === 0 ? (
              <div className="run-empty"><strong>尚无运行记录</strong><p>认知任务可点击“立即运行”；系统任务会在实际处理后留下记录。</p></div>
            ) : (
              <>
                <div className="run-tabs" role="list" aria-label="最近运行">
                  {runs.slice(0, 8).map((run) => (
                    <button type="button" role="listitem" className={run.id === selectedRunId ? "selected" : ""} key={run.id} onClick={() => setSelectedRunId(run.id)}>
                      <LuCircle className={`run-dot state-${run.status}`} aria-hidden />
                      <span><strong>{runStatusLabel[run.status] ?? run.status}</strong><small>{formatDateTime(run.created_at)}</small></span>
                      <code>#{run.id.slice(0, 6)}</code>
                    </button>
                  ))}
                </div>

                {runDetail && runDetail.run.id === selectedRunId && (
                  <div className="run-detail">
                    <dl className="run-facts">
                      <div><dt>触发</dt><dd>{runDetail.run.trigger_type === "manual" ? "手动" : "定时"}</dd></div>
                      <div><dt>尝试</dt><dd>{runDetail.run.attempt_count} / {runDetail.run.max_attempts}</dd></div>
                      <div><dt>开始</dt><dd>{formatDateTime(runDetail.run.started_at, "等待 worker")}</dd></div>
                      <div><dt>结束</dt><dd>{formatDateTime(runDetail.run.completed_at, "尚未结束")}</dd></div>
                    </dl>
                    <div className="correlation-line"><span>Correlation</span><code>{runDetail.run.correlation_id}</code></div>
                    {runDetail.run.error_code && (
                      <div className="run-error"><strong>{runDetail.run.error_code}</strong><p>{runDetail.run.error_message}</p></div>
                    )}
                    <section>
                      <h3>处理结果</h3>
                      <p>{formatJobMetrics(runDetail.run.metrics)}</p>
                      {runDetail.thoughts.map((thought) => (
                        <div className="structured-output" key={thought.id}>
                          <strong>{thought.intent}</strong><p>{thought.basis}</p>
                          <small>依据 {thought.evidence_message_ids.length} 条 · 置信度 {thought.confidence_millis / 10}% · {thought.decision}</small>
                        </div>
                      ))}
                      {runDetail.candidates.map((candidate) => (
                        <div className="structured-output" key={candidate.id}>
                          <strong>{candidate.claim}</strong>
                          <p>说话人 {candidate.source_speaker_id} · 对象 {candidate.subject_id ?? "未解析"}</p>
                          <small>{candidate.operation} · {candidate.attribution_status} · 依据 {candidate.evidence_message_ids.length} 条</small>
                        </div>
                      ))}
                    </section>
                    <section>
                      <h3>模型调用</h3>
                      {runDetail.llmCalls.length === 0 ? <p>本轮没有调用模型。</p> : runDetail.llmCalls.map((call) => (
                        <div className="llm-audit-line" key={call.id}>
                          <span><strong>{call.profile}</strong><small>{call.model ?? call.provider}</small></span>
                          <span>{call.latency_ms ?? "—"} ms · {call.input_tokens ?? "—"}/{call.output_tokens ?? "—"} tokens</span>
                        </div>
                      ))}
                    </section>
                    <section>
                      <h3>Watermark</h3>
                      {runDetail.watermarks.length === 0 ? <p>没有会话游标推进。</p> : runDetail.watermarks.map((watermark) => (
                        <div className="watermark-line" key={watermark.conversation_id}>
                          <code>{watermark.conversation_id}</code><span>{formatDateTime(watermark.last_message_at)} · #{watermark.last_message_id.slice(0, 6)}</span>
                        </div>
                      ))}
                    </section>
                  </div>
                )}
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
