CREATE TABLE `entities` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`version` integer NOT NULL,
	`version_id` text NOT NULL,
	`content_version_id` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	PRIMARY KEY(`project_id`, `id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `entity_kind` ON `entities` (`project_id`,`kind`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`input` text NOT NULL,
	`output` text,
	`error` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`run_token` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`usage` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_dedupe` ON `jobs` (`project_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `job_queue` ON `jobs` (`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `judgments` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`refs` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `layouts` (
	`project_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`data` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `links` (
	`project_id` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`project_id`, `from_id`, `to_id`, `role`),
	FOREIGN KEY (`project_id`,`from_id`) REFERENCES `entities`(`project_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`to_id`) REFERENCES `entities`(`project_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `incoming_links` ON `links` (`project_id`,`to_id`);--> statement-breakpoint
CREATE TABLE `materials` (
	`project_id` text NOT NULL,
	`source_version_id` text NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`project_id`, `source_version_id`),
	FOREIGN KEY (`project_id`,`source_version_id`) REFERENCES `entities`(`project_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`actor_id` text NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`hash` text NOT NULL,
	`response` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`actor_id`, `project_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`question` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`deleted_at` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`type` text NOT NULL,
	`projects` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `versions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`version` integer NOT NULL,
	`content_version_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`,`entity_id`) REFERENCES `entities`(`project_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entity_version` ON `versions` (`project_id`,`entity_id`,`version`);--> statement-breakpoint
CREATE INDEX `version_asof` ON `versions` (`project_id`,`created_at`);