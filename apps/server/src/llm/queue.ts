/** Concurrency-1 job queue: jobs run strictly one after another, in submission order. */
export class JobQueue {
  private tail: Promise<void> = Promise.resolve();
  private active = 0;

  /** number of jobs waiting or running */
  get size(): number {
    return this.active;
  }

  get busy(): boolean {
    return this.active > 0;
  }

  enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.active += 1;
    const result = this.tail.then(job);
    this.tail = result.then(
      () => {
        this.active -= 1;
      },
      () => {
        this.active -= 1;
      },
    );
    return result;
  }

  /** Resolves when every job submitted so far has settled. */
  async onIdle(): Promise<void> {
    let seen: Promise<void> | null = null;
    while (seen !== this.tail) {
      seen = this.tail;
      await seen;
    }
  }
}
