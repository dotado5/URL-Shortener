/**
 * Boots apps under a custom environment. ConfigModule reads and validates the environment once
 * per module registry, so each call sets the variables, loads a fresh CommonJS registry with
 * `jest.isolateModulesAsync`, builds whatever it needs inside it, then restores the environment.
 *
 * `load` must be used instead of top-level imports for anything that touches app modules;
 * `require` (not `import()`) is what the isolated registry covers.
 */
export async function bootIsolated<T>(
  env: Record<string, string>,
  build: (load: <M>(path: string) => M) => Promise<T>,
): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  let result!: T;
  try {
    await jest.isolateModulesAsync(async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const load = <M>(path: string): M => require(path) as M;
      result = await build(load);
    });
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  return result;
}
