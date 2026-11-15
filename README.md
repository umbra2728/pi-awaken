# pi-awaken

Background jobs for [pi](https://pi.dev) that wake the agent.

The agent starts a long shell script with `job_start` and keeps working or ends its turn. When the script exits, pi opens a new turn with the exit code and the tail of the log. Other agents and scripts can wake the session with a single `pi-wake "message"` command.

```
pi install npm:pi-awaken
```

## One idea

A background job is a bash script. Its exit wakes the agent. Waiting on anything means starting a script that blocks until that thing happens:

| Want | The agent runs |
|---|---|
| A build | `job_start "make -j8"` |
| A dataset | `job_start "curl -L $URL -o data.tar && tar xf data.tar"` |
| A server install | `job_start "ssh host 'bash -s' < setup.sh"` |
| A herdr agent to finish | `job_start "herdr agent wait reviewer"` |
| A line in a herdr pane | `job_start "herdr pane wait-output $PANE --match 'tests passed'"` |
| A service to come up | `job_start "until curl -sf localhost:3000/health; do sleep 2; done"` |
| A dev server's ready line | `job_start "npm run dev" wake_on="ready in"` |

## Tools

| Tool | What it does |
|---|---|
| `job_start(command, name?, cwd?, timeout_sec?, wake_on?)` | Starts the script and returns the id and log path. If the script finishes within 1.5 s, the result comes back inline and no wake is sent. |
| `jobs(id?, lines?)` | Lists jobs, or shows one job with the tail of its log. |
| `job_stop(id)` | Kills the job's whole process group. No wake is sent. |
| `job_wait(id, timeout_sec?)` | Blocks until the job exits. Use it in `pi -p` and subagents, where nothing can be woken. |

All four tools return structured results, so codemode scripts can use them directly: `const { id } = await tools.job_start({ command: "make" })`.

`/jobs`, `/jobs log <id>` and `/jobs stop <id>` do the same from the editor. The footer shows `⏵ N jobs` while jobs are running.

## Waking from outside

```
pi-wake -s <session-id> [-f <from>] "message"
echo "long message" | pi-wake -s <session-id> -
```

The agent reads its session id from `$PI_SESSION_ID` and can pass this command to other agents, for example in a herdr prompt: "when done, run `pi-wake -s 01a1… -f reviewer 'summary'`". Inside a job, `$PI_SESSION_ID` is already set, so `pi-wake "50% done"` sends a progress event. The extension installs the `pi-wake` shim into `~/.pi/agent/bin`, which pi puts on `PATH` for its bash. On Windows it also writes `pi-wake.cmd` there, for cmd and PowerShell. Run `npm i -g pi-awaken` to use it from shells that pi did not start.

## How it works

Everything is a file under `~/.pi/wake/<session-id>/` (override with `PI_WAKE_DIR`):

```
jobs/j3.sh         the script
jobs/j3.log        stdout and stderr
jobs/j3.json       metadata: pid, cwd, start time, timeout, wake_on
jobs/j3.exit       exit code, written by the job's wrapper when the script ends
jobs/j3.delivered  the agent was told
inbox/*.json       messages from pi-wake
```

Each job runs as `bash -c 'exec >> j3.log 2>&1; bash j3.sh; echo $? > j3.exit'` in its own detached process group. The extension polls the directory every second. New `.exit` files and inbox messages are batched for 400 ms and sent with `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`. An idle agent starts a new turn. A busy agent sees the message after its current tool batch.

Jobs do not depend on the pi process. They keep running through `/reload`, a closed terminal or a pi restart. When the session is resumed, any results it missed are delivered. Timeouts are enforced while the session is open. A job whose process group disappears without writing an exit code is reported as `lost`.

On Windows the job shell is a discovered Git Bash or MSYS2 `bash.exe` (Git install directories first, then `PATH`); the WSL launcher in `System32` is skipped, and `job_start` fails with `bash not found on Windows` if nothing is found. Each job is also placed in a Windows job object, so `job_stop` and timeouts kill the whole tree (including children that switch to another runtime) with one `Job.terminate()`, falling back to `taskkill /F /T` when the handle is gone after a restart.

Session directories older than 14 days with no running jobs are deleted at session start.

## Limits

- In `pi -p` the session ends with the prompt, so nothing gets woken. Use `job_wait` there. The job itself keeps running.
- Jobs have no stdin and no TTY. Use herdr or tmux for interactive programs.
- `ssh host cmd` dies with the connection. For multi-hour remote work, detach on the remote side (`nohup`, tmux) and watch for a marker file from a local job.
