"use client";

import { useActionState } from "react";
import {
  createSemanticDraftAction,
  type CreateSemanticDraftActionState,
} from "@/app/data/datasets/[datasetId]/semantic/actions";
import { Button } from "@/components/ui/action";
import styles from "@/components/data/data.module.css";

export function semanticDraftControlView(
  pending: boolean,
  state: CreateSemanticDraftActionState,
) {
  return {
    disabled: pending,
    label: pending ? "Preparando análise…" : "Preparar análise",
    message: pending
      ? "Criando a preparação semântica."
      : state.outcome === "IDLE"
        ? ""
        : state.message,
  };
}

export function SemanticDraftControl({
  datasetId,
  datasetVersionId,
}: {
  datasetId: string;
  datasetVersionId: string;
}) {
  const [state, formAction, pending] = useActionState(
    createSemanticDraftAction,
    { outcome: "IDLE" },
  );
  const view = semanticDraftControlView(pending, state);
  return (
    <form action={formAction} className={styles.processingControl}>
      <input type="hidden" name="datasetId" value={datasetId} />
      <input type="hidden" name="datasetVersionId" value={datasetVersionId} />
      <Button type="submit" variant="primary" disabled={view.disabled}>
        {view.label}
      </Button>
      <span aria-live="polite">{view.message}</span>
    </form>
  );
}
