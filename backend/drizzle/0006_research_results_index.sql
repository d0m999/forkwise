CREATE TABLE `research_checks` (
	`job_id` text NOT NULL,
	`project_id` text NOT NULL,
	`check_index` integer NOT NULL,
	`finished_at` text NOT NULL,
	`target_id` text,
	`target_version_id` text,
	`scoped_version` text,
	`kind` text,
	`premise_ids` text,
	`conclusion_id` text,
	`context` text NOT NULL,
	`relation` text,
	`aspect` text,
	`explanation_preview` text,
	`check` text NOT NULL,
	PRIMARY KEY(`job_id`, `check_index`),
	FOREIGN KEY (`job_id`) REFERENCES `research_result_jobs`(`job_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `research_target_results` ON `research_checks` (`project_id`,`target_id`,`finished_at`,`job_id`,`check_index`);--> statement-breakpoint
CREATE INDEX `research_project_results` ON `research_checks` (`project_id`,`finished_at`,`job_id`,`check_index`);--> statement-breakpoint
CREATE TABLE `research_result_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`stale` integer,
	`task_gaps` text,
	`coverage` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Disposable projections: canonical jobs remain the only source of task results.
CREATE VIEW research_result_job_source AS
SELECT id AS job_id, project_id, json_extract(output,'$.stale') AS stale,
  json_extract(output,'$.result.gaps') AS task_gaps,
  json_object('sourceVersionIds',json_extract(output,'$.coverage.sourceVersionIds'),
    'mode',json_extract(output,'$.coverage.mode'),
    'modelCalled',json_extract(output,'$.coverage.modelCalled'),
    'networkQueries',json_extract(output,'$.coverage.networkQueries')) AS coverage
FROM jobs WHERE kind='research.verify' AND state='succeeded'
  AND json_type(output,'$.result.checks')='array';
--> statement-breakpoint
CREATE VIEW research_check_source AS
WITH entries AS (
  SELECT j.id AS job_id, j.project_id, CAST(c.key AS INTEGER) AS check_index,
    j.updated_at AS finished_at, c.value AS result,
    (SELECT CASE WHEN count(*)=1 THEN min(t.value) ELSE NULL END
      FROM json_each(j.input,'$.targets') t
      WHERE t.type='object' AND json_extract(t.value,'$.id')=json_extract(c.value,'$.target.id')) AS target,
    (SELECT json_group_array(json_object('id',json_extract(x.value,'$.id'),
      'versionId',json_extract(x.value,'$.contentVersionId')))
      FROM json_each(j.input,'$.context') x WHERE x.type='object') AS context
  FROM jobs j JOIN json_each(j.output,'$.result.checks') c
  WHERE j.kind='research.verify' AND j.state='succeeded'
    AND json_type(j.output,'$.result.checks')='array' AND c.type='object'
)
SELECT job_id, project_id, check_index, finished_at,
  json_extract(result,'$.target.id') AS target_id,
  json_extract(result,'$.target.versionId') AS target_version_id,
  json_extract(target,'$.contentVersionId') AS scoped_version,
  json_extract(target,'$.kind') AS kind,
  json_extract(target,'$.data.premiseIds') AS premise_ids,
  json_extract(target,'$.data.conclusionId') AS conclusion_id,
  context, json_extract(result,'$.relation') AS relation,
  json_extract(result,'$.aspect') AS aspect,
  substr(json_extract(result,'$.explanation'),1,120) AS explanation_preview,
  result AS "check"
FROM entries;
--> statement-breakpoint
CREATE TRIGGER research_results_insert AFTER INSERT ON jobs
WHEN NEW.kind='research.verify' AND NEW.state='succeeded'
BEGIN
  INSERT INTO research_result_jobs SELECT * FROM research_result_job_source WHERE job_id=NEW.id;
  INSERT INTO research_checks SELECT * FROM research_check_source WHERE job_id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER research_results_update AFTER UPDATE OF kind,state,input,output,updated_at ON jobs
BEGIN
  -- Explicit deletes also cover backup redaction connections with foreign keys off.
  DELETE FROM research_checks WHERE job_id=OLD.id;
  DELETE FROM research_result_jobs WHERE job_id=OLD.id;
  INSERT INTO research_result_jobs SELECT * FROM research_result_job_source WHERE job_id=NEW.id;
  INSERT INTO research_checks SELECT * FROM research_check_source WHERE job_id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER research_results_delete AFTER DELETE ON jobs
BEGIN
  DELETE FROM research_checks WHERE job_id=OLD.id;
  DELETE FROM research_result_jobs WHERE job_id=OLD.id;
END;
