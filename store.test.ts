import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JobStore, isAlive, lastLines } from "./store.ts";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until<T>(read: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(50);
  }
  throw new Error("timed out");
}

const freshStore = () => {
  const store = new JobStore("s1", mkdtempSync(join(tmpdir(), "pi-awaken-")));
  store.ensure();
  return store;
};

test("a finished job records its exit code and output", async () => {
  const store = freshStore();
  const job = store.start({ command: "echo hello\necho oops >&2\nexit 3", cwd: tmpdir() });
  const exit = await until(() => store.get(job.id)?.exit);
  assert.deepEqual([exit.code, exit.reason], [3, "exit"]);
  assert.deepEqual(store.tail(job.id), ["hello", "oops"]);
  assert.equal(store.start({ command: "true", cwd: tmpdir() }).id, "j2");
  await until(() => (isAlive(job.pid) ? undefined : true));
});

test("stop kills the whole process group and marks the job stopped", async () => {
  const store = freshStore();
  const job = store.start({ command: "sleep 30 & sleep 30; wait", cwd: tmpdir() });
  await sleep(200);
  const stopped = await store.stop(job.id);
  assert.equal(stopped.exit?.reason, "stopped");
  assert.equal(isAlive(job.pid), false);
});

test("log tails keep only the final state of carriage-return progress lines", () => {
  assert.deepEqual(lastLines("start\n 10%\r 50%\r100%\n\x1b[32mdone\x1b[0m\n\n", 5), ["start", "100%", "done"]);
});

test("the CLI drops messages into a known session inbox and rejects unknown sessions", () => {
  const store = freshStore();
  const env = { ...process.env, PI_WAKE_DIR: join(store.jobsDir, "..", "..") };
  const cli = join(import.meta.dirname, "bin", "pi-wake.mjs");
  execFileSync(process.execPath, [cli, "-s", "s1", "-f", "reviewer", "review", "done"], { env });
  assert.deepEqual(store.inbox().map(({ from, text }) => ({ from, text })), [{ from: "reviewer", text: "review done" }]);
  assert.throws(() => execFileSync(process.execPath, [cli, "-s", "nope", "hi"], { env, stdio: "pipe" }));
});
