CREATE TABLE `file_assets` (
	`id` text NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`hash` text NOT NULL,
	`bytes` blob NOT NULL,
	`retrieved_at` text NOT NULL,
	`published_at` text,
	PRIMARY KEY(`project_id`, `id`),
	FOREIGN KEY (`project_id`,`source_id`) REFERENCES `entities`(`project_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `file_source_hash` ON `file_assets` (`project_id`,`source_id`,`hash`);--> statement-breakpoint
CREATE TABLE `parsed_artifacts` (
	`project_id` text NOT NULL,
	`source_version_id` text NOT NULL,
	`file_id` text NOT NULL,
	`data` text NOT NULL,
	PRIMARY KEY(`project_id`, `source_version_id`),
	FOREIGN KEY (`project_id`,`source_version_id`) REFERENCES `entities`(`project_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`file_id`) REFERENCES `file_assets`(`project_id`,`id`) ON UPDATE no action ON DELETE no action
);
