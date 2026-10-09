-- 派生索引收录已校验的部分结果；原始任务及研究历史保持不变。
DROP TRIGGER research_results_insert;
--> statement-breakpoint
DROP VIEW research_check_source;
--> statement-breakpoint
DROP VIEW research_result_job_source;
--> statement-breakpoint
CREATE VIEW research_result_job_source AS
SELECT id AS job_id, project_id, json_extract(output,'$.stale') AS stale,
  (SELECT json_group_array(value) FROM (
    SELECT value FROM json_each(output,'$.gaps')
    UNION ALL
    SELECT value FROM json_each(output,'$.result.gaps')
  )) AS task_gaps,
  json_object('sourceVersionIds',json_extract(output,'$.coverage.sourceVersionIds'),
    'mode',json_extract(output,'$.coverage.mode'),
    'modelCalled',json_extract(output,'$.coverage.modelCalled'),
    'networkQueries',json_extract(output,'$.coverage.networkQueries')) AS coverage
FROM jobs WHERE kind='research.verify' AND state IN ('succeeded','partial')
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
  WHERE j.kind='research.verify' AND j.state IN ('succeeded','partial')
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
WHEN NEW.kind='research.verify' AND NEW.state IN ('succeeded','partial')
BEGIN
  INSERT INTO research_result_jobs SELECT * FROM research_result_job_source WHERE job_id=NEW.id;
  INSERT INTO research_checks SELECT * FROM research_check_source WHERE job_id=NEW.id;
END;
