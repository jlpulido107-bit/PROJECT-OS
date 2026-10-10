export const BUILD_SA_NAME: string
export const RUNTIME_SA_NAME: string
export const DEFAULT_CONFIG_OUT: string
export function dedicatedBuildAccount(projectId: string): string
export function defaultSourceBucket(projectId: string): string
export function renderBuildConfig(template: string, env: Record<string, string | undefined>): string
export function buildCommand(env: Record<string, string | undefined>, configPath?: string): string
export function validateConfigPath(configPath: string): string
