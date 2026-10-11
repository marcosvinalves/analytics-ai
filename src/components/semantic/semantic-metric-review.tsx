"use client";

import { useActionState, useMemo, useState } from "react";
import {
  createSemanticMetricAction,
  removeSemanticMetricAction,
  updateSemanticMetricAction,
  type SemanticMetricActionState,
} from "@/app/data/datasets/[datasetId]/semantic/metric-actions";
import { Button } from "@/components/ui/action";
import {
  buildGovernedMetricExpression,
  type GovernedMetricTemplate,
} from "@/modules/semantic/domain/governed-metric-template";
import type {
  SemanticMetricReview,
  SemanticMetricReviewField,
  SemanticMetricReviewMetric,
} from "@/modules/semantic/domain/semantic-metric-review";
import type { SemanticType } from "@/modules/semantic/domain/semantic-field";
import styles from "./semantic-metric-review.module.css";

const initialState: SemanticMetricActionState = { outcome: "IDLE" };
const templateLabels: Record<GovernedMetricTemplate, string> = {
  SUM_FIELD: "Somar um campo",
  COUNT_FIELD: "Contar valores não nulos",
  COUNT_DISTINCT_FIELD: "Contar valores distintos não nulos",
  SUM_MULTIPLY_FIELDS: "Somar a multiplicação de dois campos",
};

function typeLabel(type: SemanticType) {
  return type.kind === "DECIMAL"
    ? `DECIMAL(${type.precision},${type.scale})`
    : type.kind;
}

function compatible(
  template: GovernedMetricTemplate,
  firstFieldKey: string,
  secondFieldKey: string,
  fields: SemanticMetricReviewField[],
) {
  const types = new Map(
    fields.map((field) => [field.fieldKey, field.semanticType]),
  );
  return buildGovernedMetricExpression(
    {
      template,
      firstFieldKey,
      secondFieldKey:
        template === "SUM_MULTIPLY_FIELDS" ? secondFieldKey : undefined,
    },
    types,
  );
}

export function SemanticMetricReviewEditor({
  review,
}: {
  review: SemanticMetricReview;
}) {
  return (
    <section aria-labelledby="metric-review-title" className={styles.review}>
      <div className={styles.header}>
        <div>
          <h2 id="metric-review-title">Métricas governadas</h2>
          <p>
            Defina cálculos rastreáveis usando somente templates controlados.
          </p>
        </div>
        <p className={styles.count} aria-live="polite">
          {review.metrics.length}{" "}
          {review.metrics.length === 1 ? "métrica" : "métricas"}
        </p>
      </div>
      {!review.fields.length ? (
        <p className={styles.empty}>
          Inclua ao menos um campo semântico antes de criar métricas.
        </p>
      ) : (
        <MetricForm datasetId={review.dataset.id} fields={review.fields} />
      )}
      <div className={styles.list}>
        {review.metrics.map((metric) => (
          <MetricCard
            key={metric.metricKey}
            datasetId={review.dataset.id}
            fields={review.fields}
            metric={metric}
          />
        ))}
      </div>
    </section>
  );
}

function MetricForm({
  datasetId,
  fields,
  metric,
}: {
  datasetId: string;
  fields: SemanticMetricReviewField[];
  metric?: SemanticMetricReviewMetric;
}) {
  const classification = metric?.classification;
  const initialTemplate =
    classification?.kind === "SUPPORTED"
      ? classification.template
      : "SUM_FIELD";
  const initialFirst =
    classification?.kind === "SUPPORTED"
      ? classification.firstFieldKey
      : (fields[0]?.fieldKey ?? "");
  const initialSecond =
    classification?.kind === "SUPPORTED"
      ? (classification.secondFieldKey ?? fields[0]?.fieldKey ?? "")
      : (fields[0]?.fieldKey ?? "");
  const [template, setTemplate] =
    useState<GovernedMetricTemplate>(initialTemplate);
  const [firstFieldKey, setFirstFieldKey] = useState(initialFirst);
  const [secondFieldKey, setSecondFieldKey] = useState(initialSecond);
  const [name, setName] = useState(metric?.name ?? "");
  const [label, setLabel] = useState(metric?.label ?? "");
  const [description, setDescription] = useState(metric?.description ?? "");
  const [state, action, pending] = useActionState(
    metric ? updateSemanticMetricAction : createSemanticMetricAction,
    initialState,
  );
  const built = useMemo(
    () => compatible(template, firstFieldKey, secondFieldKey, fields),
    [fields, firstFieldKey, secondFieldKey, template],
  );
  const first = fields.find((field) => field.fieldKey === firstFieldKey);
  const second = fields.find((field) => field.fieldKey === secondFieldKey);
  const validText =
    /^[a-z][a-z0-9_]{0,62}$/.test(name) &&
    label.trim() === label &&
    label.length >= 1 &&
    label.length <= 200 &&
    description.trim() === description &&
    description.length <= 2000;
  const prefix = metric ? `metric-${metric.metricKey}` : "metric-new";

  return (
    <form
      action={action}
      className={styles.form}
      aria-label={metric ? `Editar ${metric.label}` : "Criar métrica"}
    >
      <input type="hidden" name="datasetId" value={datasetId} />
      {metric ? (
        <input type="hidden" name="metricKey" value={metric.metricKey} />
      ) : null}
      <label>
        Template
        <select
          name="template"
          value={template}
          onChange={(event) =>
            setTemplate(event.target.value as GovernedMetricTemplate)
          }
        >
          {Object.entries(templateLabels).map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      </label>
      <label>
        Campo
        <select
          name="firstDatasetColumnId"
          value={first?.datasetColumnId ?? ""}
          onChange={(event) => {
            const selected = fields.find(
              (field) => field.datasetColumnId === event.target.value,
            );
            setFirstFieldKey(selected?.fieldKey ?? "");
          }}
        >
          {fields.map((field) => (
            <option key={field.fieldKey} value={field.datasetColumnId}>
              {field.label} ({typeLabel(field.semanticType)})
            </option>
          ))}
        </select>
      </label>
      {template === "SUM_MULTIPLY_FIELDS" ? (
        <label>
          Segundo campo
          <select
            name="secondDatasetColumnId"
            value={second?.datasetColumnId ?? ""}
            onChange={(event) => {
              const selected = fields.find(
                (field) => field.datasetColumnId === event.target.value,
              );
              setSecondFieldKey(selected?.fieldKey ?? "");
            }}
          >
            {fields.map((field) => (
              <option key={field.fieldKey} value={field.datasetColumnId}>
                {field.label} ({typeLabel(field.semanticType)})
              </option>
            ))}
          </select>
        </label>
      ) : (
        <input type="hidden" name="secondDatasetColumnId" value="" />
      )}
      <label>
        Nome técnico
        <input
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          pattern="[a-z][a-z0-9_]{0,62}"
          maxLength={63}
          aria-describedby={`${prefix}-name-help`}
        />
      </label>
      <small id={`${prefix}-name-help`}>
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
      <MetricSemantics
        template={template}
        resultType={built.valid ? built.value.resultType : null}
      />
      {!built.valid ? (
        <p className={styles.invalid} role="alert">
          Os campos selecionados são incompatíveis com este template.
        </p>
      ) : null}
      <Button
        type="submit"
        variant="primary"
        disabled={pending || !validText || !built.valid}
      >
        {pending ? "Salvando…" : metric ? "Salvar métrica" : "Criar métrica"}
      </Button>
      <p className={styles.feedback} aria-live="polite">
        {state.outcome === "IDLE" ? "" : state.message}
      </p>
    </form>
  );
}

function MetricCard({
  datasetId,
  fields,
  metric,
}: {
  datasetId: string;
  fields: SemanticMetricReviewField[];
  metric: SemanticMetricReviewMetric;
}) {
  const [editing, setEditing] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);
  const [removeState, removeAction, removePending] = useActionState(
    removeSemanticMetricAction,
    initialState,
  );
  return (
    <article
      className={styles.card}
      aria-labelledby={`metric-title-${metric.metricKey}`}
    >
      <header className={styles.cardHeader}>
        <div>
          <h3 id={`metric-title-${metric.metricKey}`}>{metric.label}</h3>
          <p>
            {metric.name} · {typeLabel(metric.resultType)}
          </p>
        </div>
        <strong>
          {metric.classification.kind === "SUPPORTED"
            ? templateLabels[metric.classification.template]
            : "Template não suportado"}
        </strong>
      </header>
      {metric.description ? <p>{metric.description}</p> : null}
      <p>
        Campos: {metric.dependencies.map((field) => field.label).join(", ")}
      </p>
      <MetricSemantics
        template={
          metric.classification.kind === "SUPPORTED"
            ? metric.classification.template
            : null
        }
        resultType={metric.resultType}
      />
      {metric.classification.kind === "UNSUPPORTED_TEMPLATE" ? (
        <p className={styles.notice}>
          Esta métrica usa um AST válido fora dos templates guiados. Ela
          permanece somente leitura.
        </p>
      ) : editing ? (
        <MetricForm datasetId={datasetId} fields={fields} metric={metric} />
      ) : (
        <Button type="button" variant="ghost" onClick={() => setEditing(true)}>
          Editar métrica
        </Button>
      )}
      {removeArmed ? (
        <form action={removeAction} className={styles.actions}>
          <input type="hidden" name="datasetId" value={datasetId} />
          <input type="hidden" name="metricKey" value={metric.metricKey} />
          <p>A remoção é permanente para este draft.</p>
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
          Remover métrica
        </Button>
      )}
      <p className={styles.feedback} aria-live="polite">
        {removeState.outcome === "IDLE" ? "" : removeState.message}
      </p>
    </article>
  );
}

function MetricSemantics({
  template,
  resultType,
}: {
  template: GovernedMetricTemplate | null;
  resultType: SemanticType | null;
}) {
  const messages = metricSemanticMessages(template, resultType);
  return (
    <div className={styles.semantics}>
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  );
}

export function metricSemanticMessages(
  template: GovernedMetricTemplate | null,
  resultType: SemanticType | null,
): string[] {
  const messages = resultType
    ? [`Tipo resultante: ${typeLabel(resultType)}`]
    : [];
  if (resultType?.kind === "NUMBER")
    messages.push("NUMBER representa cálculo aproximado.");
  if (template === "SUM_FIELD" || template === "SUM_MULTIPLY_FIELDS")
    messages.push(
      "SUM ignora NULL e retorna NULL quando não há valores não nulos.",
    );
  if (template === "COUNT_FIELD")
    messages.push("COUNT conta somente valores não nulos.");
  if (template === "COUNT_DISTINCT_FIELD")
    messages.push("COUNT_DISTINCT conta valores distintos não nulos.");
  return messages;
}
