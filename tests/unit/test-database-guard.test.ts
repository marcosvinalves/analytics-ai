import { afterEach, expect, test, vi } from "vitest";
import { testDatabaseUrl } from "../integration/helpers/database.ts";

afterEach(() => vi.unstubAllEnvs());

test("rejeita TEST_DATABASE_URL remota antes de qualquer conexão", () => {
  vi.stubEnv(
    "TEST_DATABASE_URL",
    "postgresql://user:secret@database.example:5433/analytics_remote_test",
  );
  vi.stubEnv("DATABASE_URL", "");

  expect(() => testDatabaseUrl()).toThrow(
    "PostgreSQL de teste deve usar exclusivamente loopback.",
  );
});
