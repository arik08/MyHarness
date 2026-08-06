export function readLocalEnvValue(repoRoot: string, name: string): string;
export function configuredPort(repoRoot: string, fallback?: number): number;
export function configuredDevPort(repoRoot: string, backendPort: number): number;
