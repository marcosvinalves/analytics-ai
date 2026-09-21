import { getMetadataPool, closeMetadataPool } from "../../src/lib/db/index.ts";
import { processDatasetVersion } from "../../src/modules/dataset/application/process-dataset-version.ts";

try {
  // Explicit local opt-in. Never authentication, authorization or tenant security.
  if (process.env.NODE_ENV && process.env.NODE_ENV !== "development")
    throw new Error("Disabled");
  const workspaceId = process.env.DEV_UPLOAD_WORKSPACE_ID;
  const args = process.argv.slice(2);
  if (
    process.env.ENABLE_LOCAL_UPLOAD !== "true" ||
    !workspaceId ||
    args.length !== 2 ||
    args[0] !== "--version-id"
  )
    throw new Error("Invalid local context/arguments");
  const result = await processDatasetVersion(getMetadataPool(), {
    workspaceId,
    datasetVersionId: args[1],
  });
  console.log(
    JSON.stringify(result, (_, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
  if (
    result.outcome === "OPERATIONAL_FAILURE" ||
    result.outcome === "NOT_FOUND" ||
    (result.outcome === "TRANSITIONED" && result.version.status === "FAILED")
  )
    process.exitCode = 1;
} catch {
  console.error(
    "DATASET_PROCESS_FAILED: verifique o contexto local, argumentos e infraestrutura.",
  );
  process.exitCode = 1;
} finally {
  await closeMetadataPool();
}
