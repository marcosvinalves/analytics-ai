import { expect, test } from "vitest";
import {
  validateSemanticPublicationScope,
  validateSemanticRevisionContent,
  type SemanticRevisionContent,
} from "../../src/modules/semantic/domain/semantic-publication.ts";

const fieldKey = "10000000-0000-4000-8000-000000000001";
const metricKey = "20000000-0000-4000-8000-000000000001";

function validContent(): SemanticRevisionContent {
  return {
    sameDataset: true,
    datasetVersionStatus: "READY",
    fields: [
      {
        fieldKey,
        physicalType: "BIGINT",
        semanticType: { kind: "INTEGER" },
        lineageValid: true,
      },
    ],
    metrics: [
      {
        metricKey,
        expression: {
          version: 1,
          kind: "aggregate",
          op: "SUM",
          expression: { kind: "field", fieldKey },
        },
        projectedFieldKeys: [fieldKey],
      },
    ],
  };
}

test("validação de conteúdo é independente do lifecycle e aceita snapshot consistente", () => {
  expect(validateSemanticRevisionContent(validContent())).toEqual({
    issues: [],
    fieldCount: 1,
    metricCount: 1,
  });
});

test("issues são seguras, fechadas e determinísticas", () => {
  const content = validContent();
  content.sameDataset = false;
  content.datasetVersionStatus = "PROCESSING";
  content.fields[0] = {
    ...content.fields[0],
    physicalType: "VARCHAR",
    semanticType: { kind: "DATE" },
  };
  content.metrics[0] = {
    ...content.metrics[0],
    projectedFieldKeys: [],
  };
  const first = validateSemanticRevisionContent(content);
  const second = validateSemanticRevisionContent(content);
  expect(second).toEqual(first);
  expect(first.issues.map((item) => item.code)).toEqual([
    "FIELD_PHYSICAL_COMPATIBILITY_INVALID",
    "METRIC_FIELD_REFERENCE_INVALID",
    "DATASET_VERSION_NOT_READY",
    "REVISION_DATASET_VERSION_MISMATCH",
  ]);
  expect(first.issues.every((item) => !item.message.includes("VARCHAR"))).toBe(
    true,
  );
});

test("revision vazia exige ao menos um field e uma metric", () => {
  const result = validateSemanticRevisionContent({
    ...validContent(),
    fields: [],
    metrics: [],
  });
  expect(result.issues.map((item) => item.code)).toEqual([
    "NO_FIELDS",
    "NO_METRICS",
  ]);
});

test("detecta AST, tipo e projeção de referências inválidos", () => {
  const content = validContent();
  content.metrics = [
    {
      metricKey: "20000000-0000-4000-8000-000000000001",
      expression: { kind: "field", fieldKey },
      projectedFieldKeys: [fieldKey],
    },
    {
      metricKey: "20000000-0000-4000-8000-000000000002",
      expression: {
        version: 1,
        kind: "aggregate",
        op: "SUM",
        expression: {
          kind: "binary",
          op: "ADD",
          left: { kind: "field", fieldKey },
          right: { kind: "literal", type: "DECIMAL", value: "1.00" },
        },
      },
      projectedFieldKeys: [fieldKey, fieldKey],
    },
    {
      metricKey: "20000000-0000-4000-8000-000000000003",
      expression: {
        version: 1,
        kind: "aggregate",
        op: "SUM",
        expression: { kind: "literal", type: "DECIMAL", value: "1.00" },
      },
      projectedFieldKeys: [fieldKey],
    },
  ];
  const codes = validateSemanticRevisionContent(content).issues.map(
    (item) => item.code,
  );
  expect(codes).toEqual([
    "METRIC_AST_INVALID",
    "METRIC_REFERENCE_PROJECTION_MISMATCH",
    "METRIC_REFERENCE_PROJECTION_MISMATCH",
  ]);
});

test("scope rejeita payload extra e UUID inválido", () => {
  expect(() =>
    validateSemanticPublicationScope({
      workspaceId: "a0000000-0000-4000-8000-000000000000",
      semanticModelRevisionId: "b0000000-0000-4000-8000-000000000000",
    }),
  ).not.toThrow();
  expect(() =>
    validateSemanticPublicationScope({
      workspaceId: "invalid",
      semanticModelRevisionId: "b0000000-0000-4000-8000-000000000000",
    }),
  ).toThrow(TypeError);
});
