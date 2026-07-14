"use client";

import { useCallback, useEffect, useState } from "react";
import { controlRequest } from "./control-api";

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
  latest_run_status: string | null;
  latest_run_started_at: string | null;
  latest_run_error_code: string | null;
  latest_run_metrics: { deliveryCount?: number } | null;
};

function formatDateTime(value?: string | null) {
  if (!value) return "尚未执行";
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

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const payload = await controlRequest<{ jobs: Job[] }>("/api/jobs");
      setJobs(payload.jobs);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "任务数据载入失败");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), 10_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [load]);

  const activeCount = jobs.filter((job) => job.status === "active").length;

  return (
    <section className="page-panel jobs-page">
      <div className="page-hero">
        <div><span className="section-kicker">Scheduler control plane</span><h1>定时触发任务</h1><p>调度器只产生可审计的 job run。系统关键轮询不可配置；规划中的维护任务将在执行器和回滚策略完成后开放配置。</p></div>
        <div className="dual-stat"><span><strong>{activeCount}</strong>运行中</span><i /><span><strong>{jobs.length - activeCount}</strong>规划中</span></div>
      </div>
      {error && <div className="inline-error">{error} <button onClick={() => void load()}>重试</button></div>}
      <div className="job-grid">
        {jobs.map((job) => (
          <article className={`job-card status-${job.status}`} key={job.id}>
            <div className="item-topline">
              <span className={`job-status ${job.status}`}><i />{job.status === "active" ? "运行中" : "规划中"}</span>
              <span>{job.configurable ? "后续可配置" : "系统托管"}</span>
            </div>
            <h2>{job.name}</h2>
            <p>{job.description}</p>
            <dl>
              <div><dt>触发方式</dt><dd>{scheduleTypeLabel[job.schedule_type] ?? job.schedule_type}</dd></div>
              <div><dt>表达式</dt><dd><code>{job.schedule_expression}</code></dd></div>
              <div><dt>时区</dt><dd>{job.timezone}</dd></div>
              <div><dt>最近运行</dt><dd>{formatDateTime(job.latest_run_started_at ?? job.last_run_at)}</dd></div>
            </dl>
            <footer>
              <span>{job.latest_run_status ? `最近结果：${job.latest_run_status}` : "暂无运行记录"}{typeof job.latest_run_metrics?.deliveryCount === "number" ? ` · ${job.latest_run_metrics.deliveryCount} 条` : ""}</span>
              <button disabled>{job.configurable ? "配置后续开放" : "由系统管理"}</button>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}
