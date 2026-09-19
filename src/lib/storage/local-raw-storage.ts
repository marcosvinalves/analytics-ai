import { randomUUID } from "node:crypto";
import { mkdir, lstat, open, link, unlink } from "node:fs/promises";
import path from "node:path";
import type { RawStorage, StagedRaw, RawObject } from "./raw-storage.ts";
import { validRawKey } from "./key.ts";

/** Private, operator-controlled root; do not share its write permissions with untrusted users. */
export class LocalRawStorage implements RawStorage {
  private readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private async directory(directory: string): Promise<void> {
    const parsed = path.parse(directory);
    let current = parsed.root;
    for (const segment of directory
      .slice(parsed.root.length)
      .split(path.sep)
      .filter(Boolean)) {
      current = path.join(current, segment);
      await mkdir(current, { mode: 0o700 }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Unsafe storage directory");
    }
  }

  private async objectPath(key: string): Promise<string> {
    if (!validRawKey(key)) throw new Error("Invalid raw storage key");
    const resolved = path.resolve(this.root, ...key.split("/"));
    const relative = path.relative(this.root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Unsafe storage path");
    await this.directory(path.dirname(resolved));
    return resolved;
  }

  private async stagedPath(staged: StagedRaw): Promise<string> {
    if (!/^[0-9a-f-]{36}$/.test(staged.token))
      throw new Error("Invalid staging token");
    const directory = path.join(this.root, ".staging");
    await this.directory(directory);
    return path.join(directory, staged.token);
  }

  async stage(
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<StagedRaw> {
    const staged = { token: randomUUID(), sizeBytes: 0 };
    const filename = await this.stagedPath(staged);
    const file = await open(filename, "wx", 0o600);
    try {
      for await (const chunk of source) {
        signal.throwIfAborted();
        await file.writeFile(chunk);
        staged.sizeBytes += chunk.byteLength;
      }
      signal.throwIfAborted();
      await file.sync();
    } catch (error) {
      await file.close();
      await unlink(filename).catch(() =>
        console.error("RAW_STAGE_CLEANUP_FAILED"),
      );
      throw error;
    }
    await file.close();
    return staged;
  }

  async publishOnce(staged: StagedRaw, key: string): Promise<RawObject> {
    const source = await this.stagedPath(staged);
    if (
      !(await lstat(source)).isFile() ||
      (await lstat(source)).isSymbolicLink()
    )
      throw new Error("Unsafe staged file");
    const target = await this.objectPath(key);
    // Hard link is atomic and fails with EEXIST: never rename over an existing object.
    await link(source, target);
    await unlink(source).catch(() => console.error("RAW_STAGE_CLEANUP_FAILED"));
    return { namespace: "raw", key };
  }

  async discard(staged: StagedRaw): Promise<void> {
    await unlink(await this.stagedPath(staged)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }

  async remove(object: RawObject): Promise<void> {
    if (object.namespace !== "raw")
      throw new Error("Invalid storage namespace");
    const filename = await this.objectPath(object.key);
    try {
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("Unsafe raw file");
      await unlink(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
