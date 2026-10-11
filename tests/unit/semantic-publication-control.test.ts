import { expect, test, vi } from "vitest";

vi.mock("@/app/data/datasets/[datasetId]/semantic/publication-actions", () => ({
  publishSemanticDraftAction: vi.fn(),
  validateSemanticDraftAction: vi.fn(),
}));
vi.mock("@/components/ui/action", () => ({ Button: vi.fn() }));
vi.mock(
  "@/components/semantic/semantic-publication-control.module.css",
  () => ({ default: {} }),
);

import { semanticValidationView } from "../../src/components/semantic/semantic-publication-control.tsx";

test("pending desabilita validação e fornece feedback acessível", () => {
  expect(semanticValidationView(true, { outcome: "IDLE" })).toEqual({
    disabled: true,
    label: "Validando configuração…",
    message: "Verificando a configuração semântica atual.",
  });
});

test("resultado válido comunica que a verificação é temporal", () => {
  expect(
    semanticValidationView(false, {
      outcome: "VALID",
      fieldCount: 3,
      metricCount: 2,
      message: "Válido nesta verificação",
    }),
  ).toEqual({
    disabled: false,
    label: "Validar configuração",
    message: "Válido nesta verificação",
  });
});
