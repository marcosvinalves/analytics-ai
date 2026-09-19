import type { PoolConfig } from "pg";

/** Somente metadados da aplicação. Não configura o motor de consultas analíticas. */
export function getDatabaseConfig(
  databaseUrl: string | undefined = process.env.DATABASE_URL,
): PoolConfig {
  if (!databaseUrl?.trim()) {
    throw new Error("DATABASE_URL é obrigatória para operações de metadados.");
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL deve ser uma URL PostgreSQL válida.");
  }

  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    url.pathname.length <= 1 ||
    url.hash
  ) {
    throw new Error(
      "DATABASE_URL deve informar protocolo PostgreSQL, usuário, host e database.",
    );
  }

  return {
    connectionString: databaseUrl,
    application_name: "analytics_metadata",
    connectionTimeoutMillis: 5000,
  };
}
