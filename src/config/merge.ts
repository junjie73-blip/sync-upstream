function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Merge config layers. Arrays and scalars are replaced wholesale; only nested
 * objects (retryConfig, conflictResolutionConfig, ...) are merged key by key.
 */
export function mergeConfigLayers<T extends Record<string, any>>(...layers: Array<Partial<T> | undefined>): T {
  const result: Record<string, unknown> = {}

  for (const layer of layers) {
    if (!layer)
      continue
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined)
        continue
      const existing = result[key]
      result[key] = isPlainObject(existing) && isPlainObject(value)
        ? mergeConfigLayers(existing as Record<string, unknown>, value as Record<string, unknown>)
        : value
    }
  }

  return result as T
}

export function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}
