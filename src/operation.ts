export interface Limits {
  timeoutMs: number;
  authTimeoutMs: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxConcurrent: number;
}
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({ timeoutMs:30_000, authTimeoutMs:10_000, maxRequestBytes:1_048_576, maxResponseBytes:2_097_152, maxConcurrent:4 });
export interface Operation { signal: AbortSignal; limits: Limits; markSent(): void }
