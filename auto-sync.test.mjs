import test from "node:test";
import assert from "node:assert/strict";
import { createAutoSync } from "./auto-sync.mjs";

test("discovery failures back off, recover automatically, then refresh unchanged credentials", async () => {
  let now = 0, calls = 0, identity = "one";
  const scheduler = createAutoSync({ now: () => now, signature: () => identity,
    sync: async () => ({ discoveryFailed: ++calls < 3 }) });
  await scheduler.run();
  now = 1999; await scheduler.run(); assert.equal(calls, 1);
  now = 2000; await scheduler.run(); assert.equal(calls, 2);
  now = 5999; await scheduler.run(); assert.equal(calls, 2);
  now = 6000; await scheduler.run(); assert.equal(calls, 3);
  now = 305999; await scheduler.run(); assert.equal(calls, 3);
  now = 306000; await scheduler.run(); assert.equal(calls, 4);
  identity = "two"; await scheduler.run(); assert.equal(calls, 5);
});

test("thrown failures retry and manual sync serializes with automatic discovery", async () => {
  let now = 0, calls = 0, unblock;
  const scheduler = createAutoSync({ now: () => now, signature: () => "one", sync: async () => {
    calls++;
    if (calls === 1) throw new Error("outage");
    if (calls === 2) await new Promise(resolve => { unblock = resolve; });
    return {};
  } });
  await assert.rejects(scheduler.run(), /outage/);
  await scheduler.run(); assert.equal(calls, 1);
  now = 2000;
  const automatic = scheduler.run();
  const manual = scheduler.run({ force: true });
  assert.equal(calls, 2);
  unblock(); await Promise.all([automatic, manual]); assert.equal(calls, 3);
});
