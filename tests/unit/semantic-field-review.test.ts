import { expect, test, vi } from "vitest";

vi.mock("@/app/data/datasets/[datasetId]/semantic/field-actions", () => ({
  createSemanticFieldAction: vi.fn(),
  updateSemanticFieldAction: vi.fn(),
  removeSemanticFieldAction: vi.fn(),
}));
vi.mock("@/components/ui/action", () => ({ Button: vi.fn() }));
vi.mock("@/components/semantic/semantic-field-review.module.css", () => ({
  default: {},
}));
vi.mock(
  "@/modules/semantic/domain/semantic-field-review",
  async () =>
    import("../../src/modules/semantic/domain/semantic-field-review.ts"),
);

import { semanticFieldEditorView } from "../../src/components/semantic/semantic-field-review.tsx";
import {
  proposeSemanticType,
  technicalNameSuggestion,
  type SemanticFieldReviewColumn,
} from "../../src/modules/semantic/domain/semantic-field-review.ts";

const column: SemanticFieldReviewColumn = {
  datasetColumnId: "10000000-0000-4000-8000-000000000034",
  physicalName: "preco_unitario",
  physicalType: "DOUBLE",
  ordinalPosition: 2,
  nullable: null,
  nullCount: "0",
  proposedSemanticType: { kind: "NUMBER" },
  field: null,
};

test("propõe somente correspondências físicas diretas, sem semântica de negócio", () => {
  expect(proposeSemanticType("BIGINT")).toEqual({ kind: "INTEGER" });
  expect(proposeSemanticType("DOUBLE")).toEqual({ kind: "NUMBER" });
  expect(proposeSemanticType("DECIMAL(18,2)")).toEqual({
    kind: "DECIMAL",
    precision: 18,
    scale: 2,
  });
  expect(proposeSemanticType("UUID")).toBeNull();
  expect(proposeSemanticType("TIME")).toBeNull();
  expect(proposeSemanticType("MONEY")).toBeNull();
});

test("sugestão técnica não normaliza silenciosamente o nome físico", () => {
  expect(technicalNameSuggestion("preco_unitario")).toBe("preco_unitario");
  expect(technicalNameSuggestion("Preço Unitário")).toBe("");
  expect(technicalNameSuggestion(" quantity ")).toBe("");
});

test("SAFE salva diretamente, EXPLICIT exige confirmação e INVALID bloqueia", () => {
  expect(semanticFieldEditorView(column, { kind: "NUMBER" }, false)).toEqual({
    compatibility: { compatibility: "SAFE", reason: "DIRECT" },
    canSave: true,
    requiresExplicitConfirmation: false,
  });
  expect(
    semanticFieldEditorView(
      column,
      { kind: "DECIMAL", precision: 18, scale: 2 },
      false,
    ),
  ).toMatchObject({ canSave: false, requiresExplicitConfirmation: true });
  expect(
    semanticFieldEditorView(
      column,
      { kind: "DECIMAL", precision: 18, scale: 2 },
      true,
    ),
  ).toMatchObject({ canSave: true, requiresExplicitConfirmation: true });
  expect(semanticFieldEditorView(column, { kind: "DATE" }, true)).toMatchObject(
    {
      compatibility: { compatibility: "INVALID" },
      canSave: false,
    },
  );
});

test("tipo incompleto não pode ser salvo", () => {
  expect(semanticFieldEditorView(column, null, true)).toEqual({
    compatibility: null,
    canSave: false,
    requiresExplicitConfirmation: false,
  });
});
