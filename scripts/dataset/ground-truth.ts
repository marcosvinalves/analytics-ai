import { getMetadataPool, closeMetadataPool } from "../../src/lib/db/index.ts";
import { runGroundTruthAggregation } from "../../src/modules/dataset/application/run-ground-truth-aggregation.ts";

try {
  // Temporary Technical Alpha context: not authentication/authorization/tenant security.
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
  const result = await runGroundTruthAggregation(getMetadataPool(), {
    workspaceId,
    datasetVersionId: args[1],
  });
  console.log(JSON.stringify(result));
  if (result.outcome !== "SUCCESS") process.exitCode = 1;
} catch {
  console.error(
    "GROUND_TRUTH_FAILED: verifique o contexto local, argumentos, dados e infraestrutura.",
  );
  process.exitCode = 1;
} finally {
  await closeMetadataPool();
}
