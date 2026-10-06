"use client";

import { useId, useRef } from "react";
import type {
  QueryExplanation,
  QueryExplanationFilter,
  QueryExplanationLiteral,
  QueryExplanationScalarExpression,
} from "../../modules/query/domain/query-explanation";
import styles from "./dashboard.module.css";

function scalar(expression: QueryExplanationScalarExpression): string {
  if (expression.kind === "FIELD") return expression.label;
  if (expression.kind === "LITERAL") return expression.value;
  const operator = { ADD: "+", SUBTRACT: "−", MULTIPLY: "×" }[
    expression.operator
  ];
  return `(${scalar(expression.left)} ${operator} ${scalar(expression.right)})`;
}

function calculation(metric: QueryExplanation["metrics"][number]): string {
  const operation = {
    SUM: "Soma",
    COUNT: "Contagem",
    COUNT_DISTINCT: "Contagem distinta",
  }[metric.expression.operator];
  return `${operation} de ${scalar(metric.expression.expression)}`;
}

function literal(value: QueryExplanationLiteral): string {
  if (value.semanticType === "BOOLEAN")
    return value.value ? "Verdadeiro" : "Falso";
  return value.value;
}

function filterText(filter: QueryExplanationFilter): string {
  const operators = {
    EQ: "igual a",
    NEQ: "diferente de",
    GT: "maior que",
    GTE: "maior ou igual a",
    LT: "menor que",
    LTE: "menor ou igual a",
    IS_NULL: "sem valor",
    IS_NOT_NULL: "com valor",
  } as const;
  if (filter.operator === "IN")
    return `${filter.field.label} em ${filter.values.map(literal).join(", ")}`;
  if (filter.operator === "IS_NULL" || filter.operator === "IS_NOT_NULL")
    return `${filter.field.label} ${operators[filter.operator]}`;
  if ("value" in filter)
    return `${filter.field.label} ${operators[filter.operator]} ${literal(filter.value)}`;
  return `${filter.field.label}: filtro aplicado`;
}

export function ExplanationDrawer({
  explanation,
}: Readonly<{ explanation: QueryExplanation }>) {
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  function close() {
    dialog.current?.close();
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={styles.explanationTrigger}
        onClick={() => dialog.current?.showModal()}
      >
        Como foi calculado?
      </button>
      <dialog
        ref={dialog}
        className={styles.drawer}
        aria-labelledby={titleId}
        onClose={() => trigger.current?.focus()}
      >
        <div className={styles.drawerHeader}>
          <h2 id={titleId}>Como foi calculado?</h2>
          <button type="button" onClick={close} aria-label="Fechar explicação">
            Fechar
          </button>
        </div>

        <section>
          <h3>Métricas</h3>
          {explanation.metrics.map((metric) => (
            <div key={metric.metricKey} className={styles.explanationBlock}>
              <strong>{metric.label}</strong>
              <p>{calculation(metric)}</p>
              <p>
                Precisão:{" "}
                {metric.numericSemantics === "EXACT" ? "exata" : "aproximada"}
              </p>
            </div>
          ))}
        </section>

        <section>
          <h3>Dimensões</h3>
          <p>
            {explanation.dimensions.length
              ? explanation.dimensions.map((field) => field.label).join(", ")
              : "Nenhuma dimensão."}
          </p>
        </section>

        <section>
          <h3>Filtros</h3>
          <ul>
            {explanation.filters.items.length ? (
              explanation.filters.items.map((filter, index) => (
                <li key={index}>{filterText(filter)}</li>
              ))
            ) : (
              <li>Nenhum filtro.</li>
            )}
          </ul>
        </section>

        <section>
          <h3>Ordenação e limite</h3>
          <ul>
            {explanation.orderBy.length ? (
              explanation.orderBy.map((order, index) => (
                <li key={index}>
                  {order.target.label}:{" "}
                  {order.direction === "ASC" ? "crescente" : "decrescente"}
                </li>
              ))
            ) : (
              <li>Sem ordenação explícita.</li>
            )}
          </ul>
          <p>
            Limite:{" "}
            {explanation.semanticLimit ?? "sem limite semântico explícito"}
          </p>
        </section>

        <section>
          <h3>Saída</h3>
          <p>{explanation.outputs.map((output) => output.label).join(", ")}</p>
          <p>
            {explanation.resultShape.rowCount} linhas e{" "}
            {explanation.resultShape.columnCount} colunas.
          </p>
        </section>

        <section>
          <h3>Contexto dos dados</h3>
          <dl className={styles.contextList}>
            <div>
              <dt>Modelo</dt>
              <dd>{explanation.model.name}</dd>
            </div>
            <div>
              <dt>Revisão</dt>
              <dd>{explanation.revision.label}</dd>
            </div>
            <div>
              <dt>Dataset</dt>
              <dd>{explanation.dataset.name}</dd>
            </div>
            <div>
              <dt>Versão</dt>
              <dd>{explanation.datasetVersion.versionNumber}</dd>
            </div>
          </dl>
        </section>
      </dialog>
    </>
  );
}
