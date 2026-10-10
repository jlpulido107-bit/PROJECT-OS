export const BUILD_SA_NAME: string
export const RUNTIME_SA_NAME: string
export function dedicatedBuildAccount(projectId: string): string
export function defaultSourceBucket(projectId: string): string
export function buildCommand(env: Record<string, string | undefined>): string
