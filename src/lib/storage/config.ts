import path from "node:path";

export function storageConfig() {
  const maxBytes = Number(process.env.MAX_UPLOAD_BYTES ?? 10485760);
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    maxBytes > Number.MAX_SAFE_INTEGER - 65536
  ) {
    throw new Error("MAX_UPLOAD_BYTES deve ser um inteiro positivo seguro.");
  }
  // Runtime data must not be bundled into the Next.js server output.
  const root = path.resolve(
    /* turbopackIgnore: true */ process.env.LOCAL_STORAGE_ROOT ||
      ".local/raw-storage",
  );
  const publicDirectory = path.resolve("public");
  const relativeToPublic = path.relative(publicDirectory, root);
  if (
    relativeToPublic === "" ||
    (!relativeToPublic.startsWith(`..${path.sep}`) &&
      relativeToPublic !== ".." &&
      !path.isAbsolute(relativeToPublic))
  ) {
    throw new Error("LOCAL_STORAGE_ROOT deve ficar fora do diretório public.");
  }
  return {
    root,
    maxBytes,
  };
}
