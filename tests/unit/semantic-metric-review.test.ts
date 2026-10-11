import { expect, test, vi } from "vitest";

vi.mock("@/components/semantic/semantic-metric-review.module.css", () => ({
  default: {},
}));
vi.mock("@/components/ui/action", () => ({ Button: () => null }));
vi.mock("@/app/data/datasets/[datasetId]/semantic/metric-actions", () => ({
  createSemanticMetricAction: vi.fn(),
  updateSemanticMetricAction: vi.fn(),
  removeSemanticMetricAction: vi.fn(),
}));
vi.mock(
  "@/modules/semantic/domain/governed-metric-template",
  async () =>
    import("../../src/modules/semantic/domain/governed-metric-template.ts"),
);

import { metricSemanticMessages } from "../../src/components/semantic/semantic-metric-review.tsx";

test("explica NULL de SUM e NUMBER aproximado sem inferir unidade", () => {
  expect(metricSemanticMessages("SUM_FIELD", { kind: "NUMBER" })).toEqual([
    "Tipo resultante: NUMBER",
    "NUMBER representa cálculo aproximado.",
    "SUM ignora NULL e retorna NULL quando não há valores não nulos.",
  ]);
});

test("distingue contagem não nula e contagem distinta", () => {
  expect(metricSemanticMessages("COUNT_FIELD", { kind: "INTEGER" })).toContain(
    "COUNT conta somente valores não nulos.",
  );
  expect(
    metricSemanticMessages("COUNT_DISTINCT_FIELD", { kind: "INTEGER" }),
  ).toContain("COUNT_DISTINCT conta valores distintos não nulos.");
});
