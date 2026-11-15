import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type InboxMessage, type Job, JobStore, isAlive, jobElapsed, jobState, lastLines } from "./store.ts";

type Wake =
  | { kind: "exit"; key: string; job: Job; tail: string[] }
  | { kind: "match"; key: string; job: Job; line: string }
  | { kind: "message"; key: string; message: InboxMessage };

const POLL_MS = 1000;
const FLUSH_MS = 400;
const INLINE_WINDOW_MS = 1500;
const TAIL_LINES = 15;

const agentBin = () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "bin");
const cliPath = join(dirname(fileURLToPath(import.meta.url)), "bin", "pi-wake.mjs");
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function installShim(target: string, content: string) {
  if (existsSync(target) && readFileSync(target, "utf8") === content) return;
  writeFileSync(target, content);
  if (process.platform !== "win32") chmodSync(target, 0o755);
}

function installCli() {
  const bin = agentBin();
  try {
    mkdirSync(bin, { recursive: true });
    // Bash needs the extensionless shim; cmd and PowerShell find the .cmd through PATHEXT.
    installShim(join(bin, "pi-wake"), `#!/bin/sh\nexec "${process.execPath}" "${cliPath}" "$@"\n`);
    if (process.platform === "win32") installShim(join(bin, "pi-wake.cmd"), `@echo off\r\n"${process.execPath}" "${cliPath}" %*\r\n`);
  } catch {}
}

function header(job: Job): string {
  return `job ${job.id} "${job.name}"`;
}

function describeJob(job: Job, tail: string[]): string {
  const lines = [`${header(job)}: ${jobState(job)} after ${jobElapsed(job)}`, `command: ${job.command.trim().split("\n")[0]}`];
  lines.push(tail.length ? `log ${job.log} (last ${tail.length} lines):` : `log ${job.log} (empty)`);
  return [...lines, ...tail.map((line) => `  ${line}`)].join("\n");
}

function renderWake(wake: Wake): string {
  if (wake.kind === "exit") return describeJob(wake.job, wake.tail);
  if (wake.kind === "match") {
    return `${header(wake.job)} printed a line matching /${wake.job.wakeOn}/ and is still running:\n  ${wake.line}\nlog ${wake.job.log}`;
  }
  return `message${wake.message.from ? ` from ${wake.message.from}` : ""}:\n${wake.message.text}`;
}

const JobOut = Type.Object({
  id: Type.String(),
  name: Type.String(),
  state: Type.String(),
  running: Type.Boolean(),
  exit_code: Type.Union([Type.Integer(), Type.Null()]),
  elapsed: Type.String(),
  log: Type.String(),
  tail: Type.Optional(Type.Array(Type.String())),
});

function jobOut(job: Job, tail?: string[]) {
  return {
    id: job.id,
    name: job.name,
    state: jobState(job),
    running: !job.exit,
    exit_code: job.exit?.code ?? null,
    elapsed: jobElapsed(job),
    log: job.log,
    ...(tail ? { tail } : {}),
  };
}

export default function (pi: ExtensionAPI) {
  let store: JobStore | undefined;
  let ctx: ExtensionContext | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: Wake[] = [];
  const queued = new Set<string>();
  const scans = new Map<string, { offset: number; rest: string }>();
  const vanished = new Set<string>();
  const busy = new Set<string>();

  const active = () => {
    if (!store) throw new Error("pi-wake has no active session");
    return store;
  };

  const enqueue = (wake: Wake) => {
    if (queued.has(wake.key)) return;
    queued.add(wake.key);
    queue.push(wake);
    flushTimer ??= setTimeout(() => guarded(flush), FLUSH_MS);
  };

  function guarded(fn: () => void) {
    try {
      fn();
    } catch (error) {
      if (error instanceof Error && error.message.includes("ctx is stale")) shutdown();
      else throw error;
    }
  }

  function flush() {
    flushTimer = undefined;
    const s = store;
    const items = queue.splice(0);
    if (!s || !items.length) return;
    const fresh = items.filter((item) => item.kind !== "exit" || !s.get(item.job.id)?.delivered);
    for (const item of items) queued.delete(item.key);
    if (!fresh.length) return;
    const body = fresh.map(renderWake).join("\n\n");
    const title = fresh.length > 1 ? `[pi-wake] ${fresh.length} background events` : "[pi-wake]";
    pi.sendMessage(
      {
        customType: "pi-wake",
        content: `${title}\n${body}`,
        display: true,
        details: { events: fresh.map((item) => item.key) },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    for (const item of fresh) {
      if (item.kind === "exit") s.markDelivered(item.job.id);
      if (item.kind === "message") s.consume(item.message.file);
    }
  }

  function scan(s: JobStore, job: Job) {
    const state = scans.get(job.id) ?? { offset: 0, rest: "" };
    const chunk = s.readFrom(job.id, state.offset);
    state.offset = chunk.offset;
    const lines = (state.rest + chunk.text).split("\n");
    state.rest = (lines.pop() ?? "").slice(-4096);
    scans.set(job.id, state);
    const pattern = new RegExp(job.wakeOn!);
    const hit = lines.find((line) => pattern.test(line));
    if (hit === undefined) return;
    const line = lastLines(hit, 1)[0] ?? hit;
    s.markMatched(job.id, line);
    scans.delete(job.id);
    enqueue({ kind: "match", key: `match:${job.id}`, job, line });
  }

  function settle(s: JobStore, job: Job, reason: "timeout" | "lost") {
    busy.add(job.id);
    const done = reason === "timeout" ? s.stop(job.id, "timeout") : Promise.resolve(s.finish(job.id, "lost"));
    void done.finally(() => busy.delete(job.id));
  }

  function tick() {
    const s = store;
    if (!s) return;
    let running = 0;
    for (const job of s.list()) {
      if (job.exit) {
        if (!job.delivered && !busy.has(job.id)) enqueue({ kind: "exit", key: `exit:${job.id}`, job, tail: s.tail(job.id, TAIL_LINES) });
        continue;
      }
      running++;
      if (busy.has(job.id)) continue;
      if (job.timeoutSec && Date.now() - job.startedAt > job.timeoutSec * 1000) {
        settle(s, job, "timeout");
        continue;
      }
      if (!isAlive(job.pid)) {
        if (vanished.has(job.id)) settle(s, job, "lost");
        vanished.add(job.id);
        continue;
      }
      if (job.wakeOn && !job.matched) scan(s, job);
    }
    for (const message of s.inbox()) enqueue({ kind: "message", key: `message:${message.file}`, message });
    if (ctx?.hasUI) ctx.ui.setStatus("pi-wake", running ? `⏵ ${running} job${running > 1 ? "s" : ""}` : undefined);
  }

  function shutdown() {
    if (pollTimer) clearInterval(pollTimer);
    if (flushTimer) clearTimeout(flushTimer);
    pollTimer = flushTimer = undefined;
    queue.length = 0;
    queued.clear();
    scans.clear();
    vanished.clear();
    store = undefined;
    ctx = undefined;
  }

  pi.on("session_start", (_event, context) => {
    shutdown();
    ctx = context;
    store = new JobStore(context.sessionManager.getSessionId());
    store.ensure();
    JobStore.prune();
    installCli();
    pollTimer = setInterval(() => guarded(tick), POLL_MS);
    pollTimer.unref?.();
    tick();
  });

  pi.on("session_shutdown", () => shutdown());

  async function waitForExit(s: JobStore, id: string, ms: number, signal?: AbortSignal): Promise<Job | undefined> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !signal?.aborted) {
      const job = s.get(id);
      if (job?.exit) return job;
      await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
    }
    return s.get(id)?.exit ? s.get(id) : undefined;
  }

  function finishedResult(s: JobStore, job: Job, lines = TAIL_LINES) {
    s.markDelivered(job.id);
    const tail = s.tail(job.id, lines);
    return {
      content: [{ type: "text" as const, text: describeJob(job, tail) }],
      structuredContent: jobOut(job, tail),
      details: undefined,
    };
  }

  pi.registerTool({
    name: "job_start",
    label: "Job start",
    description:
      "Run a bash script in the background and return immediately. When it exits you are woken automatically with its exit code and log tail. Jobs survive /reload and pi restarts; output goes to a log file, not your context.",
    promptSnippet: "Run long shell work (installs, builds, downloads, waits) in the background; you are woken when it ends",
    promptGuidelines: [
      "Use job_start instead of bash for anything that may take longer than ~30 seconds: installs, builds, long tests, downloads, deploys, remote setup over ssh. After starting, continue other work or end your turn; the job's exit wakes you. Never poll jobs, sleep, or loop waiting.",
      "To wait for something, start a job whose script blocks until it happens, e.g. `herdr agent wait <agent>`, `herdr pane wait-output <pane> --match <text>`, `until curl -sf <url>; do sleep 5; done`. Use wake_on to be woken by an output line while a long-lived process (dev server, watcher) keeps running.",
      "Anything can wake you with `pi-wake -s <session> \"message\"`, where <session> is $PI_SESSION_ID from your bash. Give that command to other agents or scripts that should report back. Inside a job script, plain `pi-wake \"message\"` sends a progress event.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Bash script, may be multi-line" }),
      name: Type.Optional(Type.String({ description: "Short label" })),
      cwd: Type.Optional(Type.String({ description: "Working directory, default: session cwd" })),
      timeout_sec: Type.Optional(Type.Integer({ minimum: 1, description: "Kill the job after this many seconds" })),
      wake_on: Type.Optional(Type.String({ description: "Regex; wake once when an output line matches, job keeps running" })),
    }),
    outputSchema: JobOut,
    async execute(_id, params, signal, _update, context) {
      const s = active();
      const job = s.start({
        command: params.command,
        name: params.name,
        cwd: resolve(context.cwd, params.cwd ?? "."),
        timeoutSec: params.timeout_sec,
        wakeOn: params.wake_on,
        env: {
          PI_SESSION_ID: s.sessionId,
          [pathKey]: [agentBin(), process.env[pathKey] ?? ""].join(delimiter),
        },
      });
      busy.add(job.id);
      try {
        const early = await waitForExit(s, job.id, INLINE_WINDOW_MS, signal);
        if (early) return finishedResult(s, early);
      } finally {
        busy.delete(job.id);
      }
      tick();
      const text = [
        `Started ${header(job)} in the background (pid ${job.pid}).`,
        `log: ${job.log}`,
        `You will be woken automatically when it exits${job.wakeOn ? ` or prints a line matching /${job.wakeOn}/` : ""}. Do not poll or sleep; continue other work or end your turn.`,
      ].join("\n");
      return { content: [{ type: "text", text }], structuredContent: jobOut(job), details: undefined };
    },
  });

  pi.registerTool({
    name: "jobs",
    label: "Jobs",
    description: "List background jobs, or show one job with the tail of its log. Not needed for waiting: exits wake you on their own.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Job id like j3" })),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Log lines to show, default 30" })),
    }),
    outputSchema: Type.Object({ jobs: Type.Array(JobOut) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, params) {
      const s = active();
      if (params.id) {
        const job = s.get(params.id);
        if (!job) throw new Error(`Unknown job: ${params.id}`);
        const tail = s.tail(job.id, params.lines ?? 30);
        return { content: [{ type: "text", text: describeJob(job, tail) }], structuredContent: { jobs: [jobOut(job, tail)] }, details: undefined };
      }
      const jobs = s.list();
      const text = jobs.length
        ? jobs.map((job) => `${job.id}  ${jobState(job)}  ${jobElapsed(job)}  ${job.name}`).join("\n")
        : "No background jobs in this session.";
      return { content: [{ type: "text", text }], structuredContent: { jobs: jobs.map((job) => jobOut(job)) }, details: undefined };
    },
  });

  pi.registerTool({
    name: "job_stop",
    label: "Job stop",
    description: "Stop a background job and its whole process group. No wake is sent for a job you stop.",
    parameters: Type.Object({ id: Type.String({ description: "Job id like j3" }) }),
    outputSchema: JobOut,
    async execute(_id, params) {
      const s = active();
      busy.add(params.id);
      try {
        const job = await s.stop(params.id);
        return finishedResult(s, job, 10);
      } finally {
        busy.delete(params.id);
        tick();
      }
    },
  });

  pi.registerTool({
    name: "job_wait",
    label: "Job wait",
    description:
      "Block until a job exits or the timeout passes, then return its result. Only for non-interactive runs (pi -p, subagents) where nothing can wake you, or when the very next step needs the result; otherwise end your turn and let the wake arrive.",
    parameters: Type.Object({
      id: Type.String({ description: "Job id like j3" }),
      timeout_sec: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "Default 600" })),
    }),
    outputSchema: JobOut,
    async execute(_id, params, signal) {
      const s = active();
      if (!s.get(params.id)) throw new Error(`Unknown job: ${params.id}`);
      const job = await waitForExit(s, params.id, (params.timeout_sec ?? 600) * 1000, signal);
      if (job) return finishedResult(s, job);
      const current = s.get(params.id)!;
      const tail = s.tail(params.id, 10);
      return {
        content: [{ type: "text", text: `${describeJob(current, tail)}\nStill running; the wake will arrive when it exits.` }],
        structuredContent: jobOut(current, tail),
        details: undefined,
      };
    },
  });

  pi.registerCommand("jobs", {
    description: "Background jobs: /jobs, /jobs log <id>, /jobs stop <id>",
    handler: async (args, context) => {
      const s = active();
      const [action, id] = args.trim().split(/\s+/);
      if (action === "stop" && id) {
        busy.add(id);
        try {
          const job = await s.stop(id);
          s.markDelivered(id);
          context.ui.notify(`${header(job)}: ${jobState(job)}`, "info");
        } finally {
          busy.delete(id);
        }
        return;
      }
      if (action === "log" && id) {
        const job = s.get(id);
        context.ui.notify(job ? describeJob(job, s.tail(id, 40)) : `Unknown job: ${id}`, job ? "info" : "error");
        return;
      }
      const jobs = s.list();
      context.ui.notify(
        jobs.length ? jobs.map((job) => `${job.id}  ${jobState(job)}  ${jobElapsed(job)}  ${job.name}`).join("\n") : "No background jobs in this session.",
        "info",
      );
    },
  });
}
