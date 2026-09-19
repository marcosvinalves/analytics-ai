const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function rawStorageKey(workspaceId: string, versionId: string): string {
  // Workspace IDs may be any valid UUID; new version IDs are server-generated v4.
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(workspaceId) ||
    !uuid.test(versionId)
  ) {
    throw new Error("Invalid storage identifiers");
  }
  return `workspaces/${workspaceId.toLowerCase()}/versions/${versionId.toLowerCase()}/raw.csv`;
}

export function validRawKey(key: string): boolean {
  const parts = key.split("/");
  if (
    parts.length !== 5 ||
    parts[0] !== "workspaces" ||
    parts[2] !== "versions" ||
    parts[4] !== "raw.csv"
  )
    return false;
  try {
    return rawStorageKey(parts[1], parts[3]) === key;
  } catch {
    return false;
  }
}
