"use client";

import { useActionState, useMemo, useState } from "react";
import {
  createSemanticFieldAction,
  removeSemanticFieldAction,
  updateSemanticFieldAction,
  type SemanticFieldActionState,
} from "@/app/data/datasets/[datasetId]/semantic/field-actions";
import { Button } from "@/components/ui/action";
import {
  semanticTypeCompatibility,
  technicalNameSuggestion,
  type SemanticFieldReview,
  type SemanticFieldReviewColumn,
} from "@/modules/semantic/domain/semantic-field-review";
import type { SemanticType } from "@/modules/semantic/domain/semantic-field";
import styles from "./semantic-field-review.module.css";

const initialState: SemanticFieldActionState = { outcome: "IDLE" };
const typeKinds = [
  "STRING",
  "BOOLEAN",
  "INTEGER",
  "DECIMAL",
  "NUMBER",
  "DATE",
  "DATETIME",
  "INSTANT",
] as const;

function valuesFromColumn(column: SemanticFieldReviewColumn) {
  const type = column.field?.semanticType ?? column.proposedSemanticType;
  return {
    name: column.field?.name ?? technicalNameSuggestion(column.physicalName),
    label:
      column.field?.label ??
      (column.physicalName.trim() === column.physicalName &&
      column.physicalName.length <= 200
        ? column.physicalName
        : ""),
    description: column.field?.description ?? "",
    kind: type?.kind ?? "",
    precision: type?.kind === "DECIMAL" ? String(type.precision) : "",
    scale: type?.kind === "DECIMAL" ? String(type.scale) : "",
  };
}

function selectedType(
  kind: string,
  precision: string,
  scale: string,
): SemanticType | null {
  if (!kind) return null;
  if (kind !== "DECIMAL") return { kind } as SemanticType;
  if (!/^\d{1,2}$/.test(precision) || !/^\d{1,2}$/.test(scale)) return null;
  const p = Number(precision);
  const s = Number(scale);
  return p >= 1 && p <= 38 && s >= 0 && s <= p
    ? { kind: "DECIMAL", precision: p, scale: s }
    : null;
}

function semanticTypeLabel(type: SemanticType): string {
  return type.kind === "DECIMAL"
    ? `DECIMAL(${type.precision},${type.scale})`
    : type.kind;
}

export function semanticFieldEditorView(
  column: SemanticFieldReviewColumn,
  semanticType: SemanticType | null,
  explicitConfirmed: boolean,
) {
  const compatibility = semanticTypeCompatibility(
    column.physicalType,
    semanticType,
  );
  return {
    compatibility,
    canSave:
      compatibility !== null &&
      compatibility.compatibility !== "INVALID" &&
      (compatibility.compatibility !== "EXPLICIT" || explicitConfirmed),
    requiresExplicitConfirmation: compatibility?.compatibility === "EXPLICIT",
  };
}

export function SemanticFieldReviewEditor({
  review,
}: {
  review: SemanticFieldReview;
}) {
  const included = review.columns.filter((column) => column.field).length;
  return (
    <section aria-labelledby="field-review-title" className={styles.review}>
      <div className={styles.reviewHeader}>
        <div>
          <h2 id="field-review-title">Revisar campos</h2>
          <p>
            Escolha somente os campos relevantes e confirme sua interpretação
            semântica.
          </p>
        </div>
        <p className={styles.progress} aria-live="polite">
          {included} de {review.columns.length} incluídos
        </p>
      </div>
      <div className={styles.columnList}>
        {review.columns.map((column) => (
          <SemanticFieldEditor
            key={column.datasetColumnId}
            datasetId={review.dataset.id}
            column={column}
          />
        ))}
      </div>
    </section>
  );
}

function SemanticFieldEditor({
  datasetId,
  column,
}: {
  datasetId: string;
  column: SemanticFieldReviewColumn;
}) {
  const initial = valuesFromColumn(column);
  const [name, setName] = useState(initial.name);
  const [label, setLabel] = useState(initial.label);
  const [description, setDescription] = useState(initial.description);
  const [kind, setKind] = useState(initial.kind);
  const [precision, setPrecision] = useState(initial.precision);
  const [scale, setScale] = useState(initial.scale);
  const existingExplicit =
    column.field?.compatibility.compatibility === "EXPLICIT";
  const [explicitConfirmed, setExplicitConfirmed] = useState(existingExplicit);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [createState, createAction, createPending] = useActionState(
    createSemanticFieldAction,
    initialState,
  );
  const [updateState, updateAction, updatePending] = useActionState(
    updateSemanticFieldAction,
    initialState,
  );
  const [removeState, removeAction, removePending] = useActionState(
    removeSemanticFieldAction,
    initialState,
  );

  const semanticType = useMemo(
    () => selectedType(kind, precision, scale),
    [kind, precision, scale],
  );
  const view = semanticFieldEditorView(column, semanticType, explicitConfirmed);
  const fieldState = column.field ? updateState : createState;
  const pending = column.field ? updatePending : createPending;
  const feedback =
    removeState.outcome !== "IDLE"
      ? removeState.message
      : fieldState.outcome !== "IDLE"
        ? fieldState.message
        : "";
  const controlId = `semantic-field-${column.datasetColumnId}`;
  const validText =
    /^[a-z][a-z0-9_]{0,62}$/.test(name) &&
    label.trim() === label &&
    label.length >= 1 &&
    label.length <= 200 &&
    description.trim() === description &&
    description.length <= 2000;

  function changeType(next: string) {
    setKind(next);
    setExplicitConfirmed(false);
    if (next !== "DECIMAL") {
      setPrecision("");
      setScale("");
    }
  }

  return (
    <article
      className={styles.columnCard}
      aria-labelledby={`${controlId}-title`}
    >
      <header className={styles.columnHeader}>
        <div>
          <h3 id={`${controlId}-title`}>{column.physicalName}</h3>
          <p>
            {column.physicalType} · posição {column.ordinalPosition} · nulos:{" "}
            {column.nullable === true
              ? (column.nullCount ?? "observados")
              : "não observados/desconhecido"}
          </p>
        </div>
        <strong>{column.field ? "Incluído" : "Não incluído"}</strong>
      </header>

      <form
        action={column.field ? updateAction : createAction}
        className={styles.form}
      >
        <input type="hidden" name="datasetId" value={datasetId} />
        <input
          type="hidden"
          name="datasetColumnId"
          value={column.datasetColumnId}
        />
        <label>
          Nome técnico
          <input
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            pattern="[a-z][a-z0-9_]{0,62}"
            maxLength={63}
            aria-describedby={`${controlId}-name-help`}
          />
        </label>
        <small id={`${controlId}-name-help`}>
          Letras minúsculas, números e underscore; comece por uma letra.
        </small>
        <label>
          Label
          <input
            name="label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            required
            maxLength={200}
          />
        </label>
        <label>
          Descrição opcional
          <textarea
            name="description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={2000}
          />
        </label>
        <div className={styles.typeRow}>
          <label>
            Tipo semântico
            <select
              name="semanticType"
              value={kind}
              onChange={(event) => changeType(event.target.value)}
              required
            >
              <option value="">Selecione</option>
              {typeKinds.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          {kind === "DECIMAL" ? (
            <>
              <label>
                Precision
                <input
                  name="decimalPrecision"
                  type="number"
                  min="1"
                  max="38"
                  value={precision}
                  onChange={(event) => {
                    setPrecision(event.target.value);
                    setExplicitConfirmed(false);
                  }}
                  required
                />
              </label>
              <label>
                Scale
                <input
                  name="decimalScale"
                  type="number"
                  min="0"
                  max="38"
                  value={scale}
                  onChange={(event) => {
                    setScale(event.target.value);
                    setExplicitConfirmed(false);
                  }}
                  required
                />
              </label>
            </>
          ) : (
            <>
              <input type="hidden" name="decimalPrecision" value="" />
              <input type="hidden" name="decimalScale" value="" />
            </>
          )}
        </div>

        <CompatibilityMessage
          column={column}
          semanticType={semanticType}
          compatibility={view.compatibility}
        />
        {view.requiresExplicitConfirmation ? (
          <label className={styles.confirmation}>
            <input
              type="checkbox"
              checked={explicitConfirmed}
              onChange={(event) => setExplicitConfirmed(event.target.checked)}
            />
            Confirmo a interpretação de {column.physicalType} como{" "}
            {semanticType ? semanticTypeLabel(semanticType) : kind}. Isso não
            garante uma conversão física nem recupera precisão original.
          </label>
        ) : null}
        <input
          type="hidden"
          name="acceptExplicitConversion"
          value={explicitConfirmed ? "true" : "false"}
        />
        <div className={styles.actions}>
          <Button
            type="submit"
            variant="primary"
            disabled={pending || !validText || !view.canSave}
          >
            {pending
              ? "Salvando…"
              : column.field
                ? "Salvar alterações"
                : "Incluir campo"}
          </Button>
        </div>
      </form>

      {column.field ? (
        <div className={styles.removeArea}>
          {column.field.referencedByMetric ? (
            <p>Uma métrica usa este campo; a remoção está bloqueada.</p>
          ) : removeArmed ? (
            <form action={removeAction} className={styles.actions}>
              <input type="hidden" name="datasetId" value={datasetId} />
              <input
                type="hidden"
                name="datasetColumnId"
                value={column.datasetColumnId}
              />
              <p>
                Confirme a remoção. Se o campo for incluído novamente, receberá
                uma nova identidade.
              </p>
              <Button
                type="submit"
                name="confirmRemoval"
                value="true"
                disabled={removePending}
              >
                {removePending ? "Removendo…" : "Confirmar remoção"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setRemoveArmed(false)}
              >
                Cancelar
              </Button>
            </form>
          ) : (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRemoveArmed(true)}
            >
              Remover campo
            </Button>
          )}
        </div>
      ) : null}
      <p className={styles.feedback} aria-live="polite">
        {feedback}
      </p>
    </article>
  );
}

function CompatibilityMessage({
  column,
  semanticType,
  compatibility,
}: {
  column: SemanticFieldReviewColumn;
  semanticType: SemanticType | null;
  compatibility: ReturnType<typeof semanticTypeCompatibility>;
}) {
  if (!semanticType || !compatibility)
    return (
      <p className={styles.compatibility}>
        Selecione um tipo semântico válido.
      </p>
    );
  if (compatibility.compatibility === "SAFE")
    return (
      <p className={styles.compatibility}>Compatibilidade direta (SAFE).</p>
    );
  if (compatibility.compatibility === "EXPLICIT")
    return (
      <p className={styles.compatibility}>
        Conversão explícita: {column.physicalType} →{" "}
        {semanticTypeLabel(semanticType)}.
      </p>
    );
  return (
    <p className={styles.invalid} role="alert">
      Essa interpretação é incompatível com {column.physicalType}.
    </p>
  );
}
