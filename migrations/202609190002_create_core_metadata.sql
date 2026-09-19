-- Up Migration
-- Application metadata only. No source bytes, credentials or signed URLs.

CREATE TABLE app.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  name text NOT NULL CONSTRAINT organizations_name_nonempty CHECK (btrim(name) <> '')
);

CREATE TABLE app.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  organization_id uuid NOT NULL,
  name text NOT NULL CONSTRAINT workspaces_name_nonempty CHECK (btrim(name) <> ''),
  CONSTRAINT workspaces_organization_fk FOREIGN KEY (organization_id)
    REFERENCES app.organizations(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE app.datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  workspace_id uuid NOT NULL,
  name text NOT NULL CONSTRAINT datasets_name_nonempty CHECK (btrim(name) <> ''),
  description text,
  CONSTRAINT datasets_workspace_fk FOREIGN KEY (workspace_id)
    REFERENCES app.workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE app.dataset_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dataset_id uuid NOT NULL,
  version_number integer NOT NULL CONSTRAINT dataset_versions_number_positive CHECK (version_number > 0),
  source_type text NOT NULL CONSTRAINT dataset_versions_source_nonempty CHECK (btrim(source_type) <> ''),
  storage_namespace text NOT NULL CONSTRAINT dataset_versions_namespace_nonempty CHECK (btrim(storage_namespace) <> ''),
  storage_key text NOT NULL CONSTRAINT dataset_versions_key_nonempty CHECK (btrim(storage_key) <> ''),
  status text NOT NULL DEFAULT 'PROCESSING',
  row_count bigint CONSTRAINT dataset_versions_rows_nonnegative CHECK (row_count >= 0),
  column_count integer CONSTRAINT dataset_versions_columns_nonnegative CHECK (column_count >= 0),
  processing_error_code varchar(64) CONSTRAINT dataset_versions_error_code_nonempty CHECK (btrim(processing_error_code) <> ''),
  processing_error_message varchar(2000),
  processed_at timestamptz,
  CONSTRAINT dataset_versions_dataset_fk FOREIGN KEY (dataset_id)
    REFERENCES app.datasets(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT dataset_versions_number_unique UNIQUE (dataset_id, version_number),
  CONSTRAINT dataset_versions_storage_unique UNIQUE (storage_namespace, storage_key),
  CONSTRAINT dataset_versions_status_valid CHECK (status IN ('PROCESSING', 'READY', 'FAILED')),
  CONSTRAINT dataset_versions_processed_after_creation CHECK (processed_at >= created_at),
  CONSTRAINT dataset_versions_processing_consistent CHECK (
    (status = 'PROCESSING' AND processed_at IS NULL
      AND processing_error_code IS NULL AND processing_error_message IS NULL)
    OR
    (status = 'READY' AND processed_at IS NOT NULL
      AND row_count IS NOT NULL AND column_count IS NOT NULL AND column_count > 0
      AND processing_error_code IS NULL AND processing_error_message IS NULL)
    OR
    (status = 'FAILED' AND processed_at IS NOT NULL AND processing_error_code IS NOT NULL)
  )
);

CREATE TABLE app.dataset_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  dataset_version_id uuid NOT NULL,
  physical_name text NOT NULL CONSTRAINT dataset_columns_name_nonempty CHECK (btrim(physical_name) <> ''),
  inferred_type text NOT NULL CONSTRAINT dataset_columns_type_nonempty CHECK (btrim(inferred_type) <> ''),
  ordinal_position integer NOT NULL CONSTRAINT dataset_columns_ordinal_positive CHECK (ordinal_position >= 1),
  nullable boolean,
  null_count bigint CONSTRAINT dataset_columns_null_count_nonnegative CHECK (null_count >= 0),
  profile_metadata jsonb CONSTRAINT dataset_columns_profile_object CHECK (
    profile_metadata IS NULL OR jsonb_typeof(profile_metadata) = 'object'
  ),
  CONSTRAINT dataset_columns_version_fk FOREIGN KEY (dataset_version_id)
    REFERENCES app.dataset_versions(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT dataset_columns_ordinal_unique UNIQUE (dataset_version_id, ordinal_position),
  CONSTRAINT dataset_columns_name_unique UNIQUE (dataset_version_id, physical_name)
);

CREATE INDEX workspaces_organization_idx ON app.workspaces (organization_id);
CREATE INDEX datasets_workspace_idx ON app.datasets (workspace_id);

-- Timestamp maintenance only: not versioning, authorization or immutability.
CREATE FUNCTION app.set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION app.set_updated_at() IS
  'Timestamp maintenance only; does not enforce versioning, authorization or immutability.';

COMMENT ON COLUMN app.dataset_versions.source_type IS
  'Nonempty source identifier; supported vocabulary is controlled by the application.';
COMMENT ON COLUMN app.dataset_versions.storage_namespace IS
  'Logical storage namespace; never file bytes, credentials or signed URLs.';
COMMENT ON COLUMN app.dataset_versions.storage_key IS
  'Opaque source artifact key; never file bytes, credentials or signed URLs.';
COMMENT ON COLUMN app.dataset_columns.profile_metadata IS
  'Optional profile object; do not store raw sensitive samples by default.';

CREATE TRIGGER organizations_updated_at
BEFORE UPDATE ON app.organizations
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TRIGGER workspaces_updated_at
BEFORE UPDATE ON app.workspaces
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TRIGGER datasets_updated_at
BEFORE UPDATE ON app.datasets
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TRIGGER dataset_versions_updated_at
BEFORE UPDATE ON app.dataset_versions
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

CREATE TRIGGER dataset_columns_updated_at
BEFORE UPDATE ON app.dataset_columns
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

-- Down Migration
-- Destructive, explicit rollback only. Do not execute against data to preserve.
DROP TABLE app.dataset_columns RESTRICT;
DROP TABLE app.dataset_versions RESTRICT;
DROP TABLE app.datasets RESTRICT;
DROP TABLE app.workspaces RESTRICT;
DROP TABLE app.organizations RESTRICT;
DROP FUNCTION app.set_updated_at() RESTRICT;

