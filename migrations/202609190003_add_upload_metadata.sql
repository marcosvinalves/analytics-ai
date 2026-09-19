-- Up Migration
ALTER TABLE app.dataset_versions
  ADD COLUMN original_filename text
    CONSTRAINT dataset_versions_filename_nonempty CHECK (btrim(original_filename) <> ''),
  ADD COLUMN size_bytes bigint
    CONSTRAINT dataset_versions_size_positive CHECK (size_bytes > 0);

COMMENT ON COLUMN app.dataset_versions.original_filename IS
  'Validated display metadata only; never used as a filesystem path or object identity.';
COMMENT ON COLUMN app.dataset_versions.size_bytes IS
  'Actual received raw artifact bytes, not a client-declared size.';

-- Down Migration
ALTER TABLE app.dataset_versions
  DROP COLUMN size_bytes RESTRICT,
  DROP COLUMN original_filename RESTRICT;
