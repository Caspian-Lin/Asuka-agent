CREATE TABLE `agent_settings` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`shadow_mode` integer DEFAULT true NOT NULL,
	`quiet_hours_start` text DEFAULT '23:00' NOT NULL,
	`quiet_hours_end` text DEFAULT '08:00' NOT NULL,
	`daily_proactive_budget` integer DEFAULT 3 NOT NULL,
	`model_mode` text DEFAULT 'deterministic_mvp' NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`mode` text DEFAULT 'shadow' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`channel` text DEFAULT 'web' NOT NULL,
	`external_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_agent_idx` ON `conversations` (`agent_id`);--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_name` text NOT NULL,
	`entity_type` text NOT NULL,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entities_name_type_uidx` ON `entities` (`canonical_name`,`entity_type`);--> statement-breakpoint
CREATE TABLE `evaluation_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`suite` text NOT NULL,
	`category` text NOT NULL,
	`prompt` text NOT NULL,
	`expected_json` text NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evaluation_cases_suite_idx` ON `evaluation_cases` (`suite`);--> statement-breakpoint
CREATE TABLE `evaluation_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`predicted_json` text NOT NULL,
	`metrics_json` text NOT NULL,
	`score` real NOT NULL,
	`passed` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `evaluation_results_run_idx` ON `evaluation_results` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `evaluation_results_run_case_uidx` ON `evaluation_results` (`run_id`,`case_id`);--> statement-breakpoint
CREATE TABLE `evaluation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`suite` text NOT NULL,
	`status` text NOT NULL,
	`summary_json` text DEFAULT '{}' NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `evaluation_runs_time_idx` ON `evaluation_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `event_entities` (
	`event_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`relation` text DEFAULT 'mentions' NOT NULL,
	PRIMARY KEY(`event_id`, `entity_id`, `relation`)
);
--> statement-breakpoint
CREATE INDEX `event_entities_entity_idx` ON `event_entities` (`entity_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`event_type` text NOT NULL,
	`source_type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`correlation_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_conversation_time_idx` ON `events` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`event_type`);--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`memory_type` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'candidate' NOT NULL,
	`source_type` text NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`importance` real DEFAULT 0.5 NOT NULL,
	`access_scope` text DEFAULT 'private' NOT NULL,
	`sensitivity` text DEFAULT 'normal' NOT NULL,
	`valid_from` text,
	`valid_to` text,
	`recorded_at` text NOT NULL,
	`superseded_at` text,
	`retrieve_count` integer DEFAULT 0 NOT NULL,
	`helpful_use_count` integer DEFAULT 0 NOT NULL,
	`last_retrieved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memories_agent_status_idx` ON `memories` (`agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `memories_type_idx` ON `memories` (`memory_type`);--> statement-breakpoint
CREATE TABLE `memory_evidence` (
	`memory_id` text NOT NULL,
	`event_id` text NOT NULL,
	`evidence_role` text DEFAULT 'supports' NOT NULL,
	PRIMARY KEY(`memory_id`, `event_id`)
);
--> statement-breakpoint
CREATE INDEX `memory_evidence_event_idx` ON `memory_evidence` (`event_id`);--> statement-breakpoint
CREATE TABLE `memory_links` (
	`source_memory_id` text NOT NULL,
	`target_memory_id` text NOT NULL,
	`link_type` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`source_memory_id`, `target_memory_id`, `link_type`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`citations_json` text DEFAULT '[]' NOT NULL,
	`correlation_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_time_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `thoughts` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`confidence` real NOT NULL,
	`novelty` real NOT NULL,
	`urgency` real NOT NULL,
	`expected_value` real NOT NULL,
	`risk` real NOT NULL,
	`decision` text DEFAULT 'shadow' NOT NULL,
	`human_label` text,
	`label_note` text,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `thoughts_conversation_time_idx` ON `thoughts` (`conversation_id`,`created_at`);