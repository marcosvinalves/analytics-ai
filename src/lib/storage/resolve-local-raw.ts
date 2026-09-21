import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { validRawKey } from "./key.ts";
import {
  ProcessingDataError,
  ProcessingOperationalError,
} from "../../modules/dataset/domain/dataset-profile.ts";

/** Local operator-owned storage only. Does not create directories or accept a client path. */
export async function resolveLocalRaw(
  root: string,
  object: { namespace: string; key: string; sizeBytes: string | null },
  maxBytes: number,
): Promise<string> {
  if (object.namespace !== "raw" || !validRawKey(object.key))
    throw new ProcessingDataError("RAW_OBJECT_UNAVAILABLE");
  const directory = path.resolve(root);
  // Missing/misconfigured root is operational, not evidence that an individual raw is lost.
  try {
    let ancestor = path.parse(directory).root;
    for (const segment of directory.slice(ancestor.length).split(path.sep)) {
      ancestor = path.join(ancestor, segment);
      const stat = await lstat(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ProcessingOperationalError();
    }
  } catch {
    throw new ProcessingOperationalError();
  }
  const filename = path.resolve(directory, ...object.key.split("/"));
  const relative = path.relative(directory, filename);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new ProcessingDataError("RAW_OBJECT_UNAVAILABLE");
  try {
    let current = directory;
    for (const segment of object.key.split("/")) {
      current = path.join(current, segment);
      const stat = await lstat(current);
      if (
        stat.isSymbolicLink() ||
        (current !== filename && !stat.isDirectory())
      )
        throw new ProcessingDataError("RAW_OBJECT_UNAVAILABLE");
    }
    const stat = await lstat(filename);
    if (!stat.isFile()) throw new ProcessingDataError("RAW_OBJECT_UNAVAILABLE");
    if (!Number.isSafeInteger(stat.size) || stat.size > maxBytes)
      throw new ProcessingOperationalError();
    if (
      object.sizeBytes !== null &&
      BigInt(stat.size) !== BigInt(object.sizeBytes)
    )
      throw new ProcessingDataError("RAW_OBJECT_UNAVAILABLE");
    if ((await realpath(filename)) !== filename)
      throw new ProcessingDataError("RAW_OBJECT_UNAVAILABLE");
    return filename;
  } catch (error) {
    if (
      error instanceof ProcessingDataError ||
      error instanceof ProcessingOperationalError
    )
      throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ProcessingDataError("RAW_OBJECT_UNAVAILABLE");
    throw new ProcessingOperationalError();
  }
}
