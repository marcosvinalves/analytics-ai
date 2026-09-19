export type StagedRaw = { token: string; sizeBytes: number };
export type RawObject = { namespace: string; key: string };

/** Only isolates raw upload storage. No provider registry or analytical API. */
export interface RawStorage {
  stage(
    source: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<StagedRaw>;
  publishOnce(staged: StagedRaw, key: string): Promise<RawObject>;
  discard(staged: StagedRaw): Promise<void>;
  remove(object: RawObject): Promise<void>;
}
