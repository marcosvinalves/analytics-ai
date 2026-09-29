import type { Pool } from "pg";
import { expect, test } from "vitest";
import {
  assembleSemanticModelInspection,
  validateInspectPublishedSemanticModelInput,
  validateInspectSemanticModelRevisionInput,
  type SemanticInspectionCandidate,
} from "../../src/modules/semantic/domain/semantic-inspection.ts";
import {
  inspectPublishedSemanticModel,
  inspectSemanticModelRevision,
} from "../../src/modules/semantic/infrastructure/semantic-inspection.ts";

const quantityKey = "10000000-0000-4000-8000-000000000002";
const priceKey = "10000000-0000-4000-8000-000000000001";

function candidate(): SemanticInspectionCandidate {
  return {
    model: {
      id: "20000000-0000-4000-8000-000000000001",
      name: "sales",
    },
    revision: {
      id: "30000000-0000-4000-8000-000000000001",
      revisionNumber: 1,
      status: "PUBLISHED",
      label: "Sales",
      description: null,
      createdAt: new Date("2026-09-28T12:00:00Z"),
      publishedAt: new Date("2026-09-28T13:00:00Z"),
    },
    dataset: {
      id: "40000000-0000-4000-8000-000000000001",
      name: "Sales",
    },
    datasetVersion: {
      id: "50000000-0000-4000-8000-000000000001",
      versionNumber: 1,
      status: "READY",
    },
    sameDataset: true,
    fields: [
      {
        fieldKey: quantityKey,
        name: "quantity",
        label: "Quantity",
        description: null,
        semanticType: { kind: "INTEGER" },
        physicalName: "quantity",
        physicalType: "BIGINT",
        ordinalPosition: 1,
        lineageValid: true,
      },
      {
        fieldKey: priceKey,
        name: "unit_price",
        label: "Unit price",
        description: null,
        semanticType: { kind: "DECIMAL", precision: 18, scale: 2 },
        physicalName: "unit_price",
        physicalType: "DECIMAL(18,2)",
        ordinalPosition: 1,
        lineageValid: true,
      },
    ],
    metrics: [
      {
        metricKey: "60000000-0000-4000-8000-000000000002",
        name: "revenue",
        label: "Revenue",
        description: null,
        expression: {
          version: 1,
          kind: "aggregate",
          op: "SUM",
          expression: {
            kind: "binary",
            op: "MULTIPLY",
            left: { kind: "field", fieldKey: quantityKey },
            right: { kind: "field", fieldKey: priceKey },
          },
        },
        projectedFieldKeys: [quantityKey, priceKey],
      },
      {
        metricKey: "60000000-0000-4000-8000-000000000001",
        name: "count_rows",
        label: "Count",
        description: null,
        expression: {
          version: 1,
          kind: "aggregate",
          op: "COUNT",
          expression: { kind: "field", fieldKey: quantityKey },
        },
        projectedFieldKeys: [quantityKey],
      },
    ],
  };
}

test("monta inspection sem IDs internos, com ordering, AST, resultType e dependencies", () => {
  const result = assembleSemanticModelInspection(candidate());
  expect(result.consistent).toBe(true);
  if (!result.consistent) throw new Error("Expected consistent inspection");
  expect(result.inspection.fields.map((field) => field.fieldKey)).toEqual([
    priceKey,
    quantityKey,
  ]);
  expect(result.inspection.fields[0]).not.toHaveProperty("id");
  expect(result.inspection.fields[0].lineage).toEqual({
    physicalName: "unit_price",
    physicalType: "DECIMAL(18,2)",
    ordinalPosition: 1,
  });
  expect(result.inspection.metrics.map((metric) => metric.name)).toEqual([
    "count_rows",
    "revenue",
  ]);
  expect(result.inspection.metrics[1]).toMatchObject({
    resultType: { kind: "DECIMAL", precision: 38, scale: 2 },
    dependencies: [priceKey, quantityKey],
  });
  expect(result.inspection.metrics[1]).not.toHaveProperty("id");
});

test("snapshot inconsistente retorna issues sem objeto parcial", () => {
  const value = candidate();
  value.metrics[0].projectedFieldKeys = [quantityKey];
  const result = assembleSemanticModelInspection(value);
  expect(result).toMatchObject({
    consistent: false,
    issues: [{ code: "METRIC_REFERENCE_PROJECTION_MISMATCH" }],
  });
  expect(result).not.toHaveProperty("inspection");
});

test("lineage incompleto falha de forma segura", () => {
  const value = candidate();
  value.fields[0].physicalName = null;
  const result = assembleSemanticModelInspection(value);
  expect(result).toMatchObject({
    consistent: false,
    issues: expect.arrayContaining([
      expect.objectContaining({ code: "FIELD_LINEAGE_INVALID" }),
    ]),
  });
  expect(result).not.toHaveProperty("inspection");
});

test("inputs são workspace-scoped, estritos e validados em runtime", () => {
  expect(() =>
    validateInspectPublishedSemanticModelInput({
      workspaceId: "a0000000-0000-4000-8000-000000000000",
      semanticModelId: "b0000000-0000-4000-8000-000000000000",
    }),
  ).not.toThrow();
  expect(() =>
    validateInspectSemanticModelRevisionInput({
      workspaceId: "a0000000-0000-4000-8000-000000000000",
      semanticModelRevisionId: "invalid",
    }),
  ).toThrow(TypeError);
  expect(() =>
    validateInspectPublishedSemanticModelInput({
      workspaceId: "a0000000-0000-4000-8000-000000000000",
      semanticModelId: "b0000000-0000-4000-8000-000000000000",
      extra: true,
    } as never),
  ).toThrow(TypeError);
});

test("falha de conexão retorna OPERATIONAL_FAILURE", async () => {
  const pool = {
    connect: async () => {
      throw new Error("unavailable");
    },
  } as unknown as Pool;
  await expect(
    inspectPublishedSemanticModel(pool, {
      workspaceId: "a0000000-0000-4000-8000-000000000000",
      semanticModelId: "b0000000-0000-4000-8000-000000000000",
    }),
  ).resolves.toEqual({ outcome: "OPERATIONAL_FAILURE" });
  await expect(
    inspectSemanticModelRevision(pool, {
      workspaceId: "a0000000-0000-4000-8000-000000000000",
      semanticModelRevisionId: "b0000000-0000-4000-8000-000000000000",
    }),
  ).resolves.toEqual({ outcome: "OPERATIONAL_FAILURE" });
});
