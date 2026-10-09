-- Custom expression index: drizzle-kit 0.31 splits expression commas into columns.
CREATE INDEX operation_sync_revision ON operations(project_id,json_extract(response,'$.revisionAfter'))
WHERE json_type(response,'$.upserted')='array' AND json_extract(response,'$.revisionAfter')>json_extract(response,'$.revisionBefore');
