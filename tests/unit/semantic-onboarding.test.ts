import { expect, test } from "vitest";
import {
  initialSemanticModelName,
  validateSemanticOnboardingScope,
} from "../../src/modules/semantic/domain/semantic-onboarding.ts";

const scope = {
  workspaceId: "10000000-0000-4000-8000-000000000033",
  datasetId: "20000000-0000-4000-8000-000000000033",
  datasetVersionId: "30000000-0000-4000-8000-000000000033",
};

test("valida somente o escopo exato workspace/dataset/versão", () => {
  expect(() => validateSemanticOnboardingScope(scope)).not.toThrow();
  expect(() =>
    validateSemanticOnboardingScope({ ...scope, workspaceId: "invalid" }),
  ).toThrow(TypeError);
  expect(() =>
    validateSemanticOnboardingScope({ ...scope, extra: "x" } as never),
  ).toThrow(TypeError);
});

test("nome técnico inicial é determinístico, server-controlled e válido", () => {
  expect(initialSemanticModelName(scope.datasetId)).toBe(
    "dataset_20000000000040008000000000000033",
  );
  expect(() => initialSemanticModelName("invalid")).toThrow(TypeError);
});
