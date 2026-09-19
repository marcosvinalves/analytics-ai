import { describe, expect, test } from "vitest";
import { getDatabaseConfig } from "../../src/lib/db/config.ts";

describe("configuração PostgreSQL de metadados", () => {
  test.each(["", "   "])("rejeita configuração vazia", (value) => {
    expect(() => getDatabaseConfig(value)).toThrow(
      "DATABASE_URL é obrigatória",
    );
  });

  test.each([
    "invalid-url",
    "https://user:secret@localhost/metadata",
    "postgresql://user:secret@localhost/",
    "postgresql://localhost/metadata",
    "postgresql://user:secret@localhost/metadata#fragment",
  ])("rejeita URL inválida sem revelar seu valor", (value) => {
    let message = "";
    try {
      getDatabaseConfig(value);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain(value);
    expect(message).not.toContain("secret");
  });

  test.each(["postgres", "postgresql"])(
    "aceita %s e preserva opções de conexão/TLS",
    (protocol) => {
      const url = `${protocol}://metadata_user@db.example/metadata?sslmode=verify-full`;
      expect(getDatabaseConfig(url)).toEqual({
        connectionString: url,
        application_name: "analytics_metadata",
        connectionTimeoutMillis: 5000,
      });
    },
  );
});
