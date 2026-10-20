/**
 * Browser copy of the install-folder rule in `operations/matching.ts`. The host
 * serves only `dist/browser`, so browser code cannot import the operations
 * module at runtime; `test/matching.test.ts` keeps the two copies equal.
 */
export function sanitizeName(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return sanitized.substring(0, 255) || "unnamed-skill";
}
