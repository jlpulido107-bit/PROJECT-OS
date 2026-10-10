/**
 * Límite de frecuencia por actor (token bucket en memoria). Por instancia: no coordina entre instancias
 * (con maxScale 1 en Cloud Run equivale a un límite global). Contrato §5.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>()

  constructor(
    private readonly capacity = 10,
    private readonly refillMs = 20_000,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  take(key: string): boolean {
    const now = this.clock()
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updated: now }
    const refill = Math.floor((now - bucket.updated) / this.refillMs)
    if (refill > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refill)
      bucket.updated += refill * this.refillMs
    }
    if (bucket.tokens <= 0) {
      this.buckets.set(key, bucket)
      return false
    }
    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    if (this.buckets.size > 1000) this.buckets.delete(this.buckets.keys().next().value as string)
    return true
  }
}
