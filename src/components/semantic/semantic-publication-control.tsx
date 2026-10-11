"use client";

import { useActionState, useState } from "react";
import {
  publishSemanticDraftAction,
  validateSemanticDraftAction,
  type PublicationIssueView,
  type PublishSemanticDraftActionState,
  type ValidateSemanticDraftActionState,
} from "@/app/data/datasets/[datasetId]/semantic/publication-actions";
import { Button } from "@/components/ui/action";
import styles from "./semantic-publication-control.module.css";

export function semanticValidationView(
  pending: boolean,
  state: ValidateSemanticDraftActionState,
) {
  return {
    disabled: pending,
    label: pending ? "Validando configuração…" : "Validar configuração",
    message: pending
      ? "Verificando a configuração semântica atual."
      : state.outcome === "IDLE"
        ? ""
        : state.message,
  };
}

function IssueList({ issues }: { issues: PublicationIssueView[] }) {
  return (
    <ul className={styles.issueList}>
      {issues.map((issue) => (
        <li key={`${issue.area}:${issue.message}`}>
          {issue.message}{" "}
          {issue.recoveryHref ? <a href={issue.recoveryHref}>Revisar</a> : null}
        </li>
      ))}
    </ul>
  );
}

function PublishConfirmation({
  datasetId,
  semanticModelRevisionId,
  hasPublishedRevision,
}: {
  datasetId: string;
  semanticModelRevisionId: string;
  hasPublishedRevision: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [state, action, pending] = useActionState(publishSemanticDraftAction, {
    outcome: "IDLE",
  } as PublishSemanticDraftActionState);
  const uncertain = state.outcome === "PUBLICATION_OUTCOME_UNKNOWN";

  return (
    <div className={styles.confirmation}>
      {hasPublishedRevision ? (
        <p>
          A publicação atual será arquivada quando esta revisão for publicada.
        </p>
      ) : null}
      <p>
        Uma alteração concorrente válida pode integrar o conteúdo publicado.
      </p>
      {state.outcome === "VALIDATION_FAILED" ? (
        <IssueList issues={state.issues} />
      ) : null}
      {uncertain ? null : (
        <form action={action}>
          <input type="hidden" name="datasetId" value={datasetId} />
          <input
            type="hidden"
            name="semanticModelRevisionId"
            value={semanticModelRevisionId}
          />
          <label className={styles.check}>
            <input
              type="checkbox"
              name="confirmPublication"
              value="true"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={pending}
            />
            <span>
              Confirmo a publicação da configuração semântica atual. O sistema
              verificará novamente sua validade antes de publicar.
            </span>
          </label>
          <Button
            type="submit"
            variant="primary"
            disabled={!confirmed || pending}
          >
            {pending ? "Publicando revisão…" : "Publicar revisão"}
          </Button>
        </form>
      )}
      <p aria-live="polite" role={uncertain ? "alert" : undefined}>
        {pending
          ? "Validando e publicando a configuração atual."
          : state.outcome === "IDLE"
            ? ""
            : state.message}
      </p>
    </div>
  );
}

export function SemanticPublicationControl({
  datasetId,
  semanticModelRevisionId,
  hasPublishedRevision,
}: {
  datasetId: string;
  semanticModelRevisionId: string;
  hasPublishedRevision: boolean;
}) {
  const [state, action, pending] = useActionState(validateSemanticDraftAction, {
    outcome: "IDLE",
  } as ValidateSemanticDraftActionState);
  const view = semanticValidationView(pending, state);

  return (
    <section className={styles.review} aria-labelledby="publication-title">
      <div>
        <h2 id="publication-title">Validar e publicar</h2>
        <p>
          Verifique campos, métricas e vínculos antes de tornar esta revisão
          imutável.
        </p>
      </div>
      <form action={action} className={styles.validationForm}>
        <input type="hidden" name="datasetId" value={datasetId} />
        <input
          type="hidden"
          name="semanticModelRevisionId"
          value={semanticModelRevisionId}
        />
        <Button type="submit" disabled={view.disabled}>
          {view.label}
        </Button>
        <span aria-live="polite">{view.message}</span>
      </form>
      {state.outcome === "INVALID" ? (
        <div className={styles.result} role="alert">
          <p>
            {state.fieldCount} campos e {state.metricCount} métricas foram
            verificados.
          </p>
          <IssueList issues={state.issues} />
        </div>
      ) : null}
      {!pending && state.outcome === "VALID" ? (
        <div className={styles.result}>
          <p>
            {state.fieldCount} campos e {state.metricCount} métricas foram
            verificados.
          </p>
          <PublishConfirmation
            datasetId={datasetId}
            semanticModelRevisionId={semanticModelRevisionId}
            hasPublishedRevision={hasPublishedRevision}
          />
        </div>
      ) : null}
    </section>
  );
}
