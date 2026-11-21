export type Listener<T> = (payload: T) => void

/**
 * Emisor de eventos tipado. Un listener que lanza no impide que los demás
 * reciban el evento: el error se delega a `onListenerError`.
 */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>()

  constructor(
    private readonly onListenerError?: (error: unknown, event: keyof Events) => void,
  ) {}

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener as Listener<never>)
    return () => this.off(event, listener)
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off()
      listener(payload)
    })
    return off
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>)
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of [...set]) {
      try {
        ;(listener as Listener<Events[K]>)(payload)
      } catch (error) {
        if (this.onListenerError) this.onListenerError(error, event)
        else queueMicrotask(() => { throw error })
      }
    }
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.size ?? 0
  }

  removeAllListeners(event?: keyof Events): void {
    if (event === undefined) this.listeners.clear()
    else this.listeners.delete(event)
  }
}
