import { expect, test, vi } from "vitest";

vi.mock("@/app/data/datasets/[datasetId]/semantic/actions", () => ({
  createSemanticDraftAction: vi.fn(),
}));
vi.mock("@/components/ui/action", () => ({ Button: vi.fn() }));
vi.mock("@/components/data/data.module.css", () => ({
  default: { processingControl: "processingControl" },
}));

import { semanticDraftControlView } from "../../src/components/semantic/semantic-draft-control.tsx";

test("pending desabilita criação e fornece feedback acessível", () => {
  expect(semanticDraftControlView(true, { outcome: "IDLE" })).toEqual({
    disabled: true,
    label: "Preparando análise…",
    message: "Criando a preparação semântica.",
  });
});

test("feedback usa somente a mensagem segura da action", () => {
  expect(
    semanticDraftControlView(false, {
      outcome: "OPERATIONAL_FAILURE",
      message: "Atualize a página.",
    }),
  ).toEqual({
    disabled: false,
    label: "Preparar análise",
    message: "Atualize a página.",
  });
});
