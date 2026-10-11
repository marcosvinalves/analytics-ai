import { notFound } from "next/navigation";
import { ActionLink } from "@/components/ui/action";
import { InlineNotice } from "@/components/ui/inline-notice";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/layout/page-container";
import { SemanticDraftControl } from "@/components/semantic/semantic-draft-control";
import { SemanticFieldReviewEditor } from "@/components/semantic/semantic-field-review";
import { SemanticMetricReviewEditor } from "@/components/semantic/semantic-metric-review";
import { SemanticPublicationControl } from "@/components/semantic/semantic-publication-control";
import { getMetadataPool } from "@/lib/db";
import { localUploadContext } from "@/lib/local-upload-context";
import { readDatasetMetadata } from "@/modules/dataset/infrastructure/read-dataset-metadata";
import { readSemanticOnboardingReadiness } from "@/modules/semantic/infrastructure/read-semantic-onboarding";
import { readSemanticFieldReview } from "@/modules/semantic/infrastructure/read-semantic-field-review";
import { readSemanticMetricReview } from "@/modules/semantic/infrastructure/read-semantic-metric-review";
import styles from "@/components/data/data.module.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SemanticOnboardingPage({
  params,
  searchParams,
}: {
  params: Promise<{ datasetId: string }>;
  searchParams: Promise<{ version?: string | string[] }>;
}) {
  const context = localUploadContext();
  if (!context) notFound();
  const { datasetId } = await params;
  const { version } = await searchParams;
  if (Array.isArray(version)) notFound();
  const pool = getMetadataPool();
  const metadata = await readDatasetMetadata(pool, {
    workspaceId: context.workspaceId,
    datasetId,
    versionId: version,
  });
  if (!metadata) notFound();
  const readiness = await readSemanticOnboardingReadiness(pool, {
    workspaceId: context.workspaceId,
    datasetId,
    datasetVersionId: metadata.detail.version.id,
  });
  if (readiness.outcome === "NOT_FOUND") notFound();
  const fieldReview =
    readiness.outcome === "DRAFT_AVAILABLE"
      ? await readSemanticFieldReview(pool, {
          workspaceId: context.workspaceId,
          datasetId,
        })
      : null;
  const metricReview =
    readiness.outcome === "DRAFT_AVAILABLE"
      ? await readSemanticMetricReview(pool, {
          workspaceId: context.workspaceId,
          datasetId,
        })
      : null;

  const backHref = `/data/datasets/${datasetId}?version=${metadata.detail.version.id}`;
  return (
    <PageContainer>
      <PageHeader
        title="Preparação da análise"
        description={metadata.detail.dataset.name}
        breadcrumbs={[
          { label: "Dados", href: "/data" },
          { label: metadata.detail.dataset.name, href: backHref },
          { label: "Preparação" },
        ]}
      />
      <section
        className={styles.section}
        aria-labelledby="semantic-state-title"
      >
        <h2 id="semantic-state-title">Estado semântico</h2>
        <SemanticState
          readiness={readiness}
          fieldReview={fieldReview}
          metricReview={metricReview}
        />
      </section>
      <ActionLink href={backHref}>Voltar ao Dataset</ActionLink>
    </PageContainer>
  );
}

function SemanticState({
  readiness,
  fieldReview,
  metricReview,
}: {
  readiness: Exclude<
    Awaited<ReturnType<typeof readSemanticOnboardingReadiness>>,
    { outcome: "NOT_FOUND" }
  >;
  fieldReview: Awaited<ReturnType<typeof readSemanticFieldReview>> | null;
  metricReview: Awaited<ReturnType<typeof readSemanticMetricReview>> | null;
}) {
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
  if (readiness.outcome === "DATASET_NOT_READY")
    return (
      <InlineNotice tone="attention">
        A versão {readiness.dataset.selectedVersion.versionNumber} está{" "}
        {readiness.status}. A preparação exige dados READY.
      </InlineNotice>
    );
  if (readiness.outcome === "CAN_CREATE_DRAFT")
    return (
      <>
        <p>
          A versão {readiness.dataset.selectedVersion.versionNumber} está
          pronta.
        </p>
        <SemanticDraftControl
          datasetId={readiness.dataset.id}
          datasetVersionId={readiness.dataset.selectedVersion.id}
        />
      </>
    );
  const current =
    readiness.outcome === "DRAFT_AVAILABLE"
      ? readiness.draft
      : readiness.published;
  return (
    <>
      <dl className={styles.facts}>
        <div>
          <dt>Estado</dt>
          <dd>{current.status}</dd>
        </div>
        <div>
          <dt>Revisão</dt>
          <dd>{current.revisionNumber}</dd>
        </div>
        <div>
          <dt>DatasetVersion associada</dt>
          <dd>Versão {current.datasetVersion.versionNumber}</dd>
        </div>
      </dl>
      {readiness.outcome === "DRAFT_AVAILABLE" ? (
        <>
          {readiness.draft.datasetVersion.id !==
          readiness.dataset.selectedVersion.id ? (
            <InlineNotice tone="attention">
              A navegação selecionou a versão{" "}
              {readiness.dataset.selectedVersion.versionNumber}, mas este draft
              permanece vinculado à versão{" "}
              {readiness.draft.datasetVersion.versionNumber}.
            </InlineNotice>
          ) : null}
          <div id="semantic-fields">
            <FieldReviewState result={fieldReview} />
          </div>
          <div id="semantic-metrics">
            <MetricReviewState result={metricReview} />
          </div>
          <PublicationState
            readiness={readiness}
            fieldReview={fieldReview}
            metricReview={metricReview}
          />
        </>
      ) : (
        <>
          <InlineNotice tone="success" role="status">
            Modelo semântico publicado. Esta revisão é um snapshot imutável.
          </InlineNotice>
          <p>
            O Ask ainda não está disponível nesta etapa. Nenhum novo draft foi
            criado.
          </p>
        </>
      )}
    </>
  );
}

function PublicationState({
  readiness,
  fieldReview,
  metricReview,
}: {
  readiness: Extract<
    Awaited<ReturnType<typeof readSemanticOnboardingReadiness>>,
    { outcome: "DRAFT_AVAILABLE" }
  >;
  fieldReview: Awaited<ReturnType<typeof readSemanticFieldReview>> | null;
  metricReview: Awaited<ReturnType<typeof readSemanticMetricReview>> | null;
}) {
  if (
    fieldReview?.outcome !== "EDITABLE" ||
    metricReview?.outcome !== "EDITABLE"
  )
    return null;
  if (
    fieldReview.review.revision.id !== readiness.draft.id ||
    metricReview.review.revision.id !== readiness.draft.id
  )
    return (
      <InlineNotice tone="attention">
        O draft mudou. Atualize a página antes de validar.
      </InlineNotice>
    );
  return (
    <SemanticPublicationControl
      datasetId={readiness.dataset.id}
      semanticModelRevisionId={readiness.draft.id}
      hasPublishedRevision={readiness.published !== null}
    />
  );
}

function MetricReviewState({
  result,
}: {
  result: Awaited<ReturnType<typeof readSemanticMetricReview>> | null;
}) {
  if (!result || result.outcome === "NO_DRAFT")
    return (
      <InlineNotice tone="attention">
        O draft mudou. Atualize a página antes de editar métricas.
      </InlineNotice>
    );
  if (result.outcome === "NOT_FOUND") notFound();
  if (result.outcome === "OPERATIONAL_FAILURE")
    return (
      <InlineNotice tone="danger" role="alert">
        A revisão de métricas está temporariamente indisponível.
      </InlineNotice>
    );
  if (result.outcome === "BROKEN")
    return (
      <InlineNotice tone="danger" role="alert">
        {result.message}
      </InlineNotice>
    );
  return <SemanticMetricReviewEditor review={result.review} />;
}

function FieldReviewState({
  result,
}: {
  result: Awaited<ReturnType<typeof readSemanticFieldReview>> | null;
}) {
  if (!result || result.outcome === "NO_DRAFT")
    return (
      <InlineNotice tone="attention">
        O draft mudou. Atualize a página para continuar com segurança.
      </InlineNotice>
    );
  if (result.outcome === "NOT_FOUND") notFound();
  if (result.outcome === "OPERATIONAL_FAILURE")
    return (
      <InlineNotice tone="danger" role="alert">
        A revisão de campos está temporariamente indisponível.
      </InlineNotice>
    );
  if (result.outcome === "BROKEN")
    return (
      <InlineNotice tone="danger" role="alert">
        {result.message}
      </InlineNotice>
    );
  return <SemanticFieldReviewEditor review={result.review} />;
}
