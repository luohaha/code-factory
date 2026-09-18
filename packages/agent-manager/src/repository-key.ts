/** GitHub repository identity is case-insensitive, including Enterprise hostnames. */
export function normalizeRepositoryKey(repository: string): string {
  return repository.toLowerCase();
}
