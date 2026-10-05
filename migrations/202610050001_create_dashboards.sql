-- Up Migration
-- Dashboard metadata only. Widgets, semantic queries and visualization are future tickets.

CREATE TABLE app.dashboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  name varchar(200) NOT NULL,
  description varchar(2000),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT dashboards_workspace_fk FOREIGN KEY (workspace_id)
    REFERENCES app.workspaces(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT dashboards_name_nonempty CHECK (
    char_length(name) > 0 AND name = btrim(name)
  ),
  CONSTRAINT dashboards_description_nonempty CHECK (
    description IS NULL
    OR (char_length(description) > 0 AND description = btrim(description))
  ),
  CONSTRAINT dashboards_workspace_name_unique UNIQUE (workspace_id, name)
);

CREATE TRIGGER dashboards_updated_at
BEFORE UPDATE ON app.dashboards
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

COMMENT ON TABLE app.dashboards IS
  'Workspace-owned dashboard metadata. Widgets are outside T-022.';
COMMENT ON COLUMN app.dashboards.updated_at IS
  'Last accepted metadata write; not a version or optimistic concurrency token.';

-- Down Migration
-- Destructive, explicit rollback only. Do not execute against data to preserve.
DROP TABLE app.dashboards RESTRICT;
