import { ActionLink } from "@/components/ui/action";
import { InlineNotice } from "@/components/ui/inline-notice";
import type { SemanticOnboardingReadiness } from "@/modules/semantic/domain/semantic-onboarding";
import { SemanticDraftControl } from "./semantic-draft-control";

export function SemanticReadinessControl({
  readiness,
}: {
  readiness: SemanticOnboardingReadiness;
}) {
  if (
    readiness.outcome === "NOT_FOUND" ||
    readiness.outcome === "DATASET_NOT_READY"
  )
    return null;
  if (readiness.outcome === "OPERATIONAL_FAILURE")
    return (
      <InlineNotice tone="danger" role="alert">
        A preparação semântica está temporariamente indisponível.
      </InlineNotice>
    );
  if (readiness.outcome === "BROKEN")
    return (
      <InlineNotice tone="danger" role="alert">
        {readiness.message}
      </InlineNotice>
    );
  const href = `/data/datasets/${readiness.dataset.id}/semantic?version=${readiness.dataset.selectedVersion.id}`;
  if (readiness.outcome === "CAN_CREATE_DRAFT")
    return (
      <InlineNotice tone="info">
        <p>Defina o significado dos dados para preparar métricas confiáveis.</p>
        <SemanticDraftControl
          datasetId={readiness.dataset.id}
          datasetVersionId={readiness.dataset.selectedVersion.id}
        />
      </InlineNotice>
    );
  if (readiness.outcome === "DRAFT_AVAILABLE")
    return (
      <InlineNotice tone="info">
        <p>
          A preparação em andamento usa a versão{" "}
          {readiness.draft.datasetVersion.versionNumber}
          {readiness.draft.datasetVersion.id ===
          readiness.dataset.selectedVersion.id
            ? "."
            : `, diferente da versão ${readiness.dataset.selectedVersion.versionNumber} selecionada.`}
        </p>
        <ActionLink href={href} variant="primary">
          Continuar preparação
        </ActionLink>
      </InlineNotice>
    );
  return (
    <InlineNotice tone="success">
      <p>Este Dataset possui um modelo semântico publicado.</p>
      <ActionLink href={href}>Ver preparação</ActionLink>
    </InlineNotice>
  );
}
