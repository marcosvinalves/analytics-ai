-- Up Migration
-- Semantic fields only. Metrics, AST, publication and analytical execution are future tickets.

ALTER TABLE app.semantic_model_revisions
  ADD CONSTRAINT semantic_model_revisions_id_version_unique
  UNIQUE (id, dataset_version_id);

ALTER TABLE app.dataset_columns
  ADD CONSTRAINT dataset_columns_id_version_unique
  UNIQUE (id, dataset_version_id);

CREATE TABLE app.semantic_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  field_key uuid NOT NULL DEFAULT gen_random_uuid(),
  semantic_model_revision_id uuid NOT NULL,
  dataset_version_id uuid NOT NULL,
  dataset_column_id uuid NOT NULL,
  name varchar(63) NOT NULL,
  label varchar(200) NOT NULL,
  description varchar(2000),
  semantic_type text NOT NULL,
  decimal_precision smallint,
  decimal_scale smallint,
  CONSTRAINT semantic_fields_revision_version_fk
    FOREIGN KEY (semantic_model_revision_id, dataset_version_id)
    REFERENCES app.semantic_model_revisions(id, dataset_version_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT semantic_fields_column_version_fk
    FOREIGN KEY (dataset_column_id, dataset_version_id)
    REFERENCES app.dataset_columns(id, dataset_version_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT semantic_fields_key_unique
    UNIQUE (semantic_model_revision_id, field_key),
  CONSTRAINT semantic_fields_name_unique
    UNIQUE (semantic_model_revision_id, name),
  CONSTRAINT semantic_fields_column_unique
    UNIQUE (semantic_model_revision_id, dataset_column_id),
  CONSTRAINT semantic_fields_name_valid
    CHECK (name ~ '^[a-z][a-z0-9_]{0,62}$'),
  CONSTRAINT semantic_fields_label_nonempty
    CHECK (btrim(label) <> ''),
  CONSTRAINT semantic_fields_description_nonempty
    CHECK (description IS NULL OR btrim(description) <> ''),
  CONSTRAINT semantic_fields_type_valid
    CHECK (semantic_type IN ('STRING', 'BOOLEAN', 'INTEGER', 'DECIMAL', 'NUMBER', 'DATE', 'DATETIME', 'INSTANT')),
  CONSTRAINT semantic_fields_decimal_consistent CHECK (
    (
      semantic_type = 'DECIMAL'
      AND decimal_precision IS NOT NULL
      AND decimal_scale IS NOT NULL
      AND decimal_precision BETWEEN 1 AND 38
      AND decimal_scale BETWEEN 0 AND decimal_precision
    )
    OR
    (
      semantic_type <> 'DECIMAL'
      AND decimal_precision IS NULL
      AND decimal_scale IS NULL
    )
  )
);

CREATE INDEX semantic_fields_column_version_idx
  ON app.semantic_fields (dataset_column_id, dataset_version_id);

COMMENT ON COLUMN app.semantic_fields.id IS
  'Identity of this field snapshot row in one semantic model revision.';
COMMENT ON COLUMN app.semantic_fields.field_key IS
  'Stable logical field identity; reuse across future revisions must be explicit.';
COMMENT ON COLUMN app.semantic_fields.dataset_version_id IS
  'Controlled redundancy used by composite foreign keys to preserve physical lineage.';
COMMENT ON COLUMN app.semantic_fields.semantic_type IS
  'Semantic interpretation only; it does not imply that an analytical conversion is implemented.';

CREATE TRIGGER semantic_fields_updated_at
BEFORE UPDATE ON app.semantic_fields
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Down Migration
-- Destructive, explicit rollback only. Do not execute against data to preserve.
DROP TABLE app.semantic_fields RESTRICT;

ALTER TABLE app.dataset_columns
  DROP CONSTRAINT dataset_columns_id_version_unique RESTRICT;

ALTER TABLE app.semantic_model_revisions
  DROP CONSTRAINT semantic_model_revisions_id_version_unique RESTRICT;
