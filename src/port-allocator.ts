// ── Lich frontend-port allocation ───────────────────────────────────────────────
// The desktop app hard-codes Lich's frontend listen port at 11024, so only one
// Lich can run at a time. To let multiple users each run their own Lich, we assign
// a unique port per active Lich session from a pool and release it on disconnect.
//
// NOTE (scaling): each Lich is a separate Ruby process (~50-100 MB). A single
// Railway container can't host hundreds of them — direct-connect (no Lich) is the
// scalable default and works for unlimited concurrent users; Lich is a heavier
// opt-in. At large scale, shard Lich users onto dedicated worker containers.

export class PortAllocator {
  private readonly used = new Set<number>()

  constructor(private readonly start = 11100, private readonly end = 11999) {}

  /** Reserve the lowest free port in the pool. Throws when exhausted. */
  acquire(): number {
    for (let p = this.start; p <= this.end; p++) {
      if (!this.used.has(p)) { this.used.add(p); return p }
    }
    throw new Error(`No free Lich ports in pool ${this.start}-${this.end}`)
  }

  release(port: number): void { this.used.delete(port) }

  get inUse(): number { return this.used.size }
}
