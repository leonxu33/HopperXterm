// runWithConcurrency runs `worker` for every item in `items`, with at
// most `limit` invocations in flight at once. Resolves once every
// task finishes — even if some throw, those are the worker's problem
// to handle (it should not propagate, or the pool will short-circuit).
export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  });
  await Promise.all(workers);
}
