-- Up Migration
CREATE TABLE app.dashboard_widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dashboard_id uuid NOT NULL,
  semantic_model_id uuid NOT NULL,
  semantic_query jsonb NOT NULL,
  visualization_spec jsonb NOT NULL,
  layout_x integer NOT NULL,
  layout_y integer NOT NULL,
  layout_width integer NOT NULL,
  layout_height integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT dashboard_widgets_dashboard_fk FOREIGN KEY (dashboard_id)
    REFERENCES app.dashboards(id) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT dashboard_widgets_semantic_model_fk FOREIGN KEY (semantic_model_id)
    REFERENCES app.semantic_models(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT dashboard_widgets_query_object CHECK (jsonb_typeof(semantic_query) = 'object'),
  CONSTRAINT dashboard_widgets_visualization_object CHECK (jsonb_typeof(visualization_spec) = 'object'),
  CONSTRAINT dashboard_widgets_layout_x_check CHECK (layout_x BETWEEN 0 AND 11),
  CONSTRAINT dashboard_widgets_layout_y_check CHECK (layout_y >= 0),
  CONSTRAINT dashboard_widgets_layout_width_check CHECK (layout_width BETWEEN 1 AND 12),
  CONSTRAINT dashboard_widgets_layout_height_check CHECK (layout_height >= 1),
  CONSTRAINT dashboard_widgets_layout_horizontal_check CHECK (layout_x + layout_width <= 12),
  CONSTRAINT dashboard_widgets_layout_vertical_check CHECK (
    layout_y::bigint + layout_height::bigint <= 2147483647
  )
);

CREATE INDEX dashboard_widgets_dashboard_layout_idx
  ON app.dashboard_widgets(dashboard_id, layout_y, layout_x, id);
CREATE INDEX dashboard_widgets_semantic_model_idx
  ON app.dashboard_widgets(semantic_model_id);

CREATE TRIGGER dashboard_widgets_updated_at
BEFORE UPDATE ON app.dashboard_widgets
FOR EACH ROW EXECUTE FUNCTION app.set_updated_at();

COMMENT ON TABLE app.dashboard_widgets IS
  'Dashboard-owned widget configuration and 12-column grid placement.';

-- Down Migration
DROP TABLE app.dashboard_widgets RESTRICT;
