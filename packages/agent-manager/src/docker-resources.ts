import type { DockerResources } from './types.js';

/** Shared by transport and domain callers; never silently ignore an invalid limit. */
export function dockerResources(value: unknown): DockerResources | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('docker must be an object or null');
  const source = value as Record<string, unknown>;
  if (Object.keys(source).some((key) => !['image', 'cpus', 'memoryMb'].includes(key))) throw new TypeError('Unknown docker resource option');
  if (typeof source.image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(source.image)) {
    throw new TypeError('docker.image must be a Docker image reference');
  }
  if (typeof source.cpus !== 'number' || !Number.isFinite(source.cpus) || source.cpus < 0.01 || source.cpus > 1024) {
    throw new TypeError('docker.cpus must be between 0.01 and 1024');
  }
  if (typeof source.memoryMb !== 'number' || !Number.isSafeInteger(source.memoryMb) || source.memoryMb < 64 || source.memoryMb > 1048576) {
    throw new TypeError('docker.memoryMb must be an integer between 64 and 1048576');
  }
  return { image: source.image, cpus: source.cpus, memoryMb: source.memoryMb };
}
