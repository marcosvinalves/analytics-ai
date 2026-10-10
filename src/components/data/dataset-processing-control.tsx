"use client";

import { useActionState } from "react";
import {
  processDatasetAction,
  type ProcessDatasetActionState,
} from "@/app/data/datasets/[datasetId]/actions";
import { Button } from "@/components/ui/action";
import styles from "./data.module.css";

export function processingControlView(
  pending: boolean,
  state: ProcessDatasetActionState,
) {
  return {
    disabled: pending,
    label: pending ? "Processando dados…" : "Processar dados",
    message: pending
      ? "Processamento em andamento. Você pode continuar navegando."
      : state.outcome === "IDLE"
        ? ""
        : state.message,
  };
}

export function DatasetProcessingControl({
  datasetId,
  datasetVersionId,
}: {
  datasetId: string;
  datasetVersionId: string;
}) {
  const [state, formAction, pending] = useActionState(processDatasetAction, {
    outcome: "IDLE",
  });
  const view = processingControlView(pending, state);
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
