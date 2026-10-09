CREATE TABLE `workflow_group_tasks` (
	`job_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`group_id` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`group_id`) REFERENCES `workflow_groups`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_tasks_group` ON `workflow_group_tasks` (`group_id`);--> statement-breakpoint
CREATE TABLE `workflow_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`root_job_id` text NOT NULL,
	`applied` integer DEFAULT true NOT NULL,
	`stopped` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`root_job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workflow_root` ON `workflow_groups` (`root_job_id`);--> statement-breakpoint
CREATE INDEX `workflow_project` ON `workflow_groups` (`project_id`);