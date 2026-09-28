-- Up Migration
-- Lifecycle and immutable semantic snapshot guards. Domain publication validation stays in TypeScript.

CREATE FUNCTION app.guard_semantic_revision_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.published_at IS NOT NULL THEN
      RAISE EXCEPTION 'semantic revisions must be created as DRAFT'
        USING ERRCODE = '55000', CONSTRAINT = 'semantic_revision_lifecycle_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'published or archived semantic revision is immutable'
        USING ERRCODE = '55000', CONSTRAINT = 'semantic_revision_lifecycle_guard';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'DRAFT' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status = 'PUBLISHED' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.semantic_model_id IS DISTINCT FROM OLD.semantic_model_id
      OR NEW.dataset_version_id IS DISTINCT FROM OLD.dataset_version_id
      OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
      OR NEW.label IS DISTINCT FROM OLD.label
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR OLD.published_at IS NOT NULL
      OR NEW.published_at IS NULL THEN
      RAISE EXCEPTION 'invalid DRAFT to PUBLISHED transition'
        USING ERRCODE = '55000', CONSTRAINT = 'semantic_revision_lifecycle_guard';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'PUBLISHED' AND NEW.status = 'ARCHIVED' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.semantic_model_id IS DISTINCT FROM OLD.semantic_model_id
      OR NEW.dataset_version_id IS DISTINCT FROM OLD.dataset_version_id
      OR NEW.revision_number IS DISTINCT FROM OLD.revision_number
      OR NEW.label IS DISTINCT FROM OLD.label
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'PUBLISHED to ARCHIVED may only change status'
        USING ERRCODE = '55000', CONSTRAINT = 'semantic_revision_lifecycle_guard';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid semantic revision lifecycle transition'
    USING ERRCODE = '55000', CONSTRAINT = 'semantic_revision_lifecycle_guard';
END;
$function$;

CREATE TRIGGER semantic_model_revisions_lifecycle_guard
BEFORE INSERT OR UPDATE OR DELETE ON app.semantic_model_revisions
FOR EACH ROW EXECUTE FUNCTION app.guard_semantic_revision_lifecycle();

CREATE FUNCTION app.require_draft_semantic_content()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  expected_count integer;
  locked_count integer := 0;
  revision record;
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.semantic_model_revision_id IS DISTINCT FROM NEW.semantic_model_revision_id THEN
    expected_count := 2;
  ELSE
    expected_count := 1;
  END IF;

  FOR revision IN
    SELECT id, status
    FROM app.semantic_model_revisions
    WHERE id IN (
      CASE WHEN TG_OP = 'INSERT' THEN NEW.semantic_model_revision_id ELSE OLD.semantic_model_revision_id END,
      CASE WHEN TG_OP = 'DELETE' THEN OLD.semantic_model_revision_id ELSE NEW.semantic_model_revision_id END
    )
    ORDER BY id
    FOR SHARE
  LOOP
    locked_count := locked_count + 1;
    IF revision.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'published or archived semantic content is immutable'
        USING ERRCODE = '55000', CONSTRAINT = 'semantic_revision_content_draft_guard';
    END IF;
  END LOOP;

  IF locked_count <> expected_count THEN
    RAISE EXCEPTION 'semantic revision does not exist'
      USING ERRCODE = '23503', CONSTRAINT = 'semantic_revision_content_draft_guard';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER semantic_fields_content_draft_guard
BEFORE INSERT OR UPDATE OR DELETE ON app.semantic_fields
FOR EACH ROW EXECUTE FUNCTION app.require_draft_semantic_content();

CREATE TRIGGER metrics_content_draft_guard
BEFORE INSERT OR UPDATE OR DELETE ON app.metrics
FOR EACH ROW EXECUTE FUNCTION app.require_draft_semantic_content();

CREATE TRIGGER metric_field_references_content_draft_guard
BEFORE INSERT OR UPDATE OR DELETE ON app.metric_field_references
FOR EACH ROW EXECUTE FUNCTION app.require_draft_semantic_content();

COMMENT ON FUNCTION app.guard_semantic_revision_lifecycle() IS
  'Allows only DRAFT creation, DRAFT to PUBLISHED and PUBLISHED to ARCHIVED; published_at is preserved.';
COMMENT ON FUNCTION app.require_draft_semantic_content() IS
  'Locks the owning revision FOR SHARE and permits semantic content DML only while DRAFT.';

-- Down Migration
DROP TRIGGER metric_field_references_content_draft_guard ON app.metric_field_references;
DROP TRIGGER metrics_content_draft_guard ON app.metrics;
DROP TRIGGER semantic_fields_content_draft_guard ON app.semantic_fields;
DROP FUNCTION app.require_draft_semantic_content();

DROP TRIGGER semantic_model_revisions_lifecycle_guard ON app.semantic_model_revisions;
DROP FUNCTION app.guard_semantic_revision_lifecycle();
