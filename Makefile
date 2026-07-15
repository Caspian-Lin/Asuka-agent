SHELL := /bin/bash
.DEFAULT_GOAL := help

NPM ?= npm
ENV_FILE ?= .env
WEB_PORT ?= 3000

.PHONY: help install frontend web backend gateway control-api worker worker-watch dev dev-all \
	build start lint typecheck boundaries test test-unit check db-generate db-check db-migrate migrate \
	napcat-url check-env

help: ## 显示可用命令
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z0-9_.-]+:.*## / { printf "  %-14s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## 按 package-lock.json 安装依赖
	$(NPM) ci

frontend: web ## 启动 Web 前端及其 API 路由

web: ## 启动 Vinext/Vite 开发服务器（默认端口 3000）
	$(NPM) run dev:web -- --port $(WEB_PORT)

backend: ## 并行启动网关、控制 API 和持续入站 worker
	+$(MAKE) --no-print-directory -j3 gateway control-api worker-watch

gateway: check-env ## 连接 NapCat 正向 WebSocket 并持久化消息
	$(NPM) run dev:gateway

control-api: check-env ## 启动 PostgreSQL Channel/任务查询 API（默认 3002）
	$(NPM) run dev:control-api

worker: check-env ## 从数据库领取并处理一批新增 QQ 消息
	$(NPM) run worker

worker-watch: check-env ## 持续轮询并处理数据库中的新增 QQ 消息
	$(NPM) run dev:worker

dev: dev-all ## 启动完整本地栈（Web、网关、控制 API、worker）

dev-all: ## 并行启动 Web、NapCat 网关、控制 API 和入站 worker
	+$(MAKE) --no-print-directory -j4 web gateway control-api worker-watch

build: ## 构建并校验生产产物
	$(NPM) run build

start: ## 启动已构建的生产 Web 服务
	$(NPM) run start

lint: ## 运行 ESLint
	$(NPM) run lint

typecheck: ## 检查各 TypeScript workspace
	$(NPM) run typecheck

boundaries: ## 检查 workspace 私有导入和循环依赖
	$(NPM) run check:boundaries

test: ## 构建并运行完整测试
	$(NPM) test

test-unit: ## 运行快速单元测试
	$(NPM) run test:unit

check: lint typecheck boundaries test-unit ## 运行快速代码检查

db-generate: ## 根据 Drizzle schema 生成待审阅的迁移
	$(NPM) run db:generate

db-check: ## 检查 Drizzle migration 文件一致性
	$(NPM) run db:check

db-migrate: check-env ## 将已审阅的 PostgreSQL migration 应用到数据库
	$(NPM) run db:migrate

migrate: db-migrate ## db-migrate 的简写

napcat-url: check-env ## 显示 Agent 将连接的 NapCat WS 地址
	@node --env-file=$(ENV_FILE) -e 'console.log(process.env.NAPCAT_WS_URL || "NAPCAT_WS_URL is not set")'

check-env:
	@test -f "$(ENV_FILE)" || { echo "Missing $(ENV_FILE); copy .env.example and fill it first." >&2; exit 1; }
