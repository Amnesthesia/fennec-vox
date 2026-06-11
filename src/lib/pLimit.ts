export async function pLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;
  let activeCount = 0;
  let rejected = false;
  return new Promise((resolve, reject) => {
    function tryDispatch(): void {
      while (activeCount < limit && nextIdx < tasks.length && !rejected) {
        const idx = nextIdx++;
        activeCount++;
        tasks[idx]!()
          .then(result => {
            results[idx] = result;
            activeCount--;
            if (nextIdx >= tasks.length && activeCount === 0) resolve(results);
            else tryDispatch();
          })
          .catch(err => { if (!rejected) { rejected = true; reject(err as Error); } });
      }
    }
    tryDispatch();
    if (tasks.length === 0) resolve(results);
  });
}
