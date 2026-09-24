-- Up Migration
-- Semantic model identity and revisions only. Fields, metrics and publication commands are future tickets.

CREATE TABLE app.semantic_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dataset_id uuid NOT NULL,
  name varchar(63) NOT NULL,
  CONSTRAINT semantic_models_dataset_fk FOREIGN KEY (dataset_id)
    REFERENCES app.datasets(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT semantic_models_dataset_unique UNIQUE (dataset_id),
  CONSTRAINT semantic_models_name_valid CHECK (name ~ '^[a-z][a-z0-9_]{0,62}$')
);

CREATE TABLE app.semantic_model_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  semantic_model_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  revision_number integer NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  label varchar(200) NOT NULL,
  description varchar(2000),
  published_at timestamptz,
  CONSTRAINT semantic_model_revisions_model_fk FOREIGN KEY (semantic_model_id)
    REFERENCES app.semantic_models(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT semantic_model_revisions_version_fk FOREIGN KEY (dataset_version_id)
    REFERENCES app.dataset_versions(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT semantic_model_revisions_number_positive CHECK (revision_number > 0),
  CONSTRAINT semantic_model_revisions_number_unique UNIQUE (semantic_model_id, revision_number),
  CONSTRAINT semantic_model_revisions_status_valid CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  CONSTRAINT semantic_model_revisions_label_nonempty CHECK (btrim(label) <> ''),
  CONSTRAINT semantic_model_revisions_description_nonempty CHECK (
    description IS NULL OR btrim(description) <> ''
  ),
  CONSTRAINT semantic_model_revisions_publication_consistent CHECK (
    (status = 'DRAFT' AND published_at IS NULL)
    OR
    (status IN ('PUBLISHED', 'ARCHIVED') AND published_at IS NOT NULL)
  ),
  CONSTRAINT semantic_model_revisions_publication_after_creation CHECK (
    published_at IS NULL OR published_at >= created_at
  )
);

CREATE UNIQUE INDEX semantic_model_revisions_one_draft_idx
  ON app.semantic_model_revisions (semantic_model_id)
  WHERE status = 'DRAFT';

CREATE UNIQUE INDEX semantic_model_revisions_one_published_idx
  ON app.semantic_model_revisions (semantic_model_id)
  WHERE status = 'PUBLISHED';

CREATE INDEX semantic_model_revisions_version_idx
  ON app.semantic_model_revisions (dataset_version_id);

COMMENT ON TABLE app.semantic_models IS
  'Stable semantic identity for one Dataset during the Technical Alpha.';
COMMENT ON TABLE app.semantic_model_revisions IS
  'Version-bound semantic snapshots. T-010 creates DRAFT only; publication belongs to T-013.';
COMMENT ON COLUMN app.semantic_model_revisions.published_at IS
  'Original publication instant. A future PUBLISHED to ARCHIVED transition must preserve this value.';

CREATE TRIGGER semantic_models_updated_at
BEFORE UPDATE ON app.semantic_models
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TRIGGER semantic_model_revisions_updated_at
BEFORE UPDATE ON app.semantic_model_revisions
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Down Migration
-- Destructive, explicit rollback only. Do not execute against data to preserve.
DROP TABLE app.semantic_model_revisions RESTRICT;
DROP TABLE app.semantic_models RESTRICT;
