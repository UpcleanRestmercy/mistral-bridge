// One serialized scheduler for credential changes, discovery recovery and refresh.
export function createAutoSync({ signature, sync, now = Date.now, refreshMs = 300000, retryMs = 2000, maxRetryMs = 60000 }) {
  let previous, due = 0, failures = 0, active;
  const run = async ({ force = false, args = {} } = {}) => {
    if (active) {
      if (!force) return active;
      await active.catch(() => {});
      return run({ force, args });
    }
    active = (async () => {
      const current = signature();
      if (!force && current === previous && now() < due) return;
      if (current !== previous) failures = 0;
      try {
        const result = await sync(args);
        previous = signature();
        failures = result.discoveryFailed ? failures + 1 : 0;
        due = now() + (failures ? Math.min(maxRetryMs, retryMs * 2 ** Math.min(failures - 1, 20)) : refreshMs);
        return result;
      } catch (error) {
        previous = current;
        failures++;
        due = now() + Math.min(maxRetryMs, retryMs * 2 ** Math.min(failures - 1, 20));
        throw error;
      }
    })();
    try { return await active; } finally { active = undefined; }
  };
  return { run };
}
