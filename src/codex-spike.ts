import assert from "node:assert/strict";
import { spawn, execFileSync, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

import type { InitializeParams } from "./protocol/InitializeParams.ts";
import type { InitializeResponse } from "./protocol/InitializeResponse.ts";
import type { RequestId } from "./protocol/RequestId.ts";
import type { ServerNotification } from "./protocol/ServerNotification.ts";
import type { ServerRequest } from "./protocol/ServerRequest.ts";
import type { ThreadResumeParams } from "./protocol/v2/ThreadResumeParams.ts";
import type { ThreadResumeResponse } from "./protocol/v2/ThreadResumeResponse.ts";
import type { ThreadReadResponse } from "./protocol/v2/ThreadReadResponse.ts";
import type { ThreadStartParams } from "./protocol/v2/ThreadStartParams.ts";
import type { ThreadStartResponse } from "./protocol/v2/ThreadStartResponse.ts";
import type { TurnStartParams } from "./protocol/v2/TurnStartParams.ts";
import type { TurnStartResponse } from "./protocol/v2/TurnStartResponse.ts";
import type { TurnStatus } from "./protocol/v2/TurnStatus.ts";

const CODEX_VERSION = "codex-cli 0.153.4";
const TURN_TIMEOUT_MS = 5 * 60_000;

type EventState = "text" | "activity" | "completion" | "interruption" | "approval" | "error";
type RpcMessage = {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};
type TurnResult = {
  text: string;
  status: TurnStatus;
  states: Set<EventState>;
  spawnedAgentThreadIds: Set<string>;
};
type TurnCollector = TurnResult & {
  deltaText: string;
  finalText: string;
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
};

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds);
    }),
  ]);
}

function stateFor(message: { method?: string; params?: unknown }): EventState | null {
  if (message.method === "item/agentMessage/delta") return "text";
  if (message.method?.endsWith("/requestApproval") || message.method === "execCommandApproval") return "approval";
  if (message.method === "error") return "error";
  if (message.method === "turn/completed") {
    const status = (message.params as { turn: { status: TurnStatus } }).turn.status;
    return status === "interrupted" ? "interruption" : status === "failed" ? "error" : "completion";
  }
  if (message.method === "item/started" || message.method === "item/completed") return "activity";
  return null;
}

function verifyStateMapping(): void {
  assert.equal(stateFor({ method: "item/agentMessage/delta" }), "text");
  assert.equal(stateFor({ method: "item/started" }), "activity");
  assert.equal(stateFor({ method: "item/commandExecution/requestApproval" }), "approval");
  assert.equal(stateFor({ method: "error" }), "error");
  assert.equal(stateFor({ method: "turn/completed", params: { turn: { status: "completed" } } }), "completion");
  assert.equal(stateFor({ method: "turn/completed", params: { turn: { status: "interrupted" } } }), "interruption");
}

class AppServer {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly turns = new Map<string, TurnCollector>();
  private expectedApprovalCommand: string | null = null;
  approvalAccepted = false;

  constructor() {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    this.child = spawn(
      "codex",
      [
        "app-server",
        "--stdio",
        "-c",
        "notify=[]",
        "-c",
        "mcp_servers.semble.enabled=false",
        "-c",
        "mcp_servers.node_repl.enabled=false",
        "--disable",
        "apps",
        "--disable",
        "plugins",
      ],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.stderr.pipe(process.stderr);
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      if (this.pending.size || this.turns.size) {
        this.rejectAll(new Error(`codex app-server exited unexpectedly (${code ?? signal})`));
      }
    });
  }

  async initialize(): Promise<InitializeResponse> {
    const params: InitializeParams = {
      clientInfo: { name: "gaia_phase0_spike", title: "GAIA Phase 0 Spike", version: "0.1.0" },
      capabilities: null,
    };
    const response = await this.request<InitializeResponse>("initialize", params);
    this.send({ method: "initialized" });
    return response;
  }

  request<Result>(method: string, params?: unknown): Promise<Result> {
    const id = this.nextId++;
    const response = new Promise<Result>((resolve, reject) => {
      this.pending.set(id, { resolve: (result) => resolve(result as Result), reject });
    });
    this.send(params === undefined ? { id, method } : { id, method, params });
    return withTimeout(response, 30_000, method);
  }

  async runTurn(params: TurnStartParams): Promise<TurnResult> {
    let resolveTurn!: (result: TurnResult) => void;
    let rejectTurn!: (error: Error) => void;
    const completed = new Promise<TurnResult>((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const collector: TurnCollector = {
      text: "",
      deltaText: "",
      finalText: "",
      status: "inProgress",
      states: new Set(),
      spawnedAgentThreadIds: new Set(),
      resolve: resolveTurn,
      reject: rejectTurn,
    };
    this.turns.set(params.threadId, collector);
    try {
      await this.request<TurnStartResponse>("turn/start", params);
      return await withTimeout(completed, TURN_TIMEOUT_MS, "turn completion");
    } finally {
      this.turns.delete(params.threadId);
    }
  }

  expectApproval(command: string): void {
    this.expectedApprovalCommand = command;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    await withTimeout(once(this.child, "exit").then(() => undefined), 10_000, "app-server shutdown");
  }

  private send(message: RpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch (error) {
      this.rejectAll(new Error(`Invalid JSON from app-server: ${String(error)}`));
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.answerServerRequest(message as ServerRequest);
      return;
    }

    if (message.method) this.handleNotification(message as ServerNotification);
  }

  private answerServerRequest(request: ServerRequest): void {
    const state = stateFor(request);
    const params = request.params as { threadId?: string };
    if (state && params.threadId) this.turns.get(params.threadId)?.states.add(state);

    if (request.method === "item/commandExecution/requestApproval") {
      const actionCommands = request.params.commandActions?.map((action) => action.command) ?? [];
      const allowed = request.params.command === this.expectedApprovalCommand || (
        actionCommands.length === 1 && actionCommands[0] === this.expectedApprovalCommand
      );
      if (!allowed) console.error("Denied unexpected approval request", JSON.stringify({ command: request.params.command, actionCommands }));
      this.approvalAccepted ||= allowed;
      this.send({ id: request.id, result: { decision: allowed ? "accept" : "decline" } });
      return;
    }

    if (request.method === "execCommandApproval") {
      const command = request.params.command;
      const expected = this.expectedApprovalCommand;
      const allowed = expected !== null && (
        command.join(" ") === expected ||
        command.at(-1) === expected && ["/bin/zsh", "/bin/bash", "zsh", "bash"].includes(command[0] ?? "")
      );
      this.approvalAccepted ||= allowed;
      this.send({ id: request.id, result: { decision: allowed ? "approved" : { denied: { rejection: "Phase 0 allows only its exact marker command." } } } });
      return;
    }

    this.send({ id: request.id, error: { code: -32601, message: `Unsupported server request: ${request.method}` } });
  }

  private handleNotification(notification: ServerNotification): void {
    const params = notification.params as { threadId?: string; turnId?: string };
    const collector = params.threadId ? this.turns.get(params.threadId) : undefined;
    const state = stateFor(notification);
    if (collector && state) collector.states.add(state);

    if (!collector) return;
    if (notification.method === "item/agentMessage/delta") {
      collector.deltaText += notification.params.delta;
      return;
    }
    if ((notification.method === "item/started" || notification.method === "item/completed") && notification.params.item.type === "collabAgentToolCall" && notification.params.item.tool === "spawnAgent") {
      for (const id of notification.params.item.receiverThreadIds) collector.spawnedAgentThreadIds.add(id);
      return;
    }
    if (notification.method === "item/completed" && notification.params.item.type === "agentMessage") {
      if (notification.params.item.phase !== "commentary") collector.finalText = notification.params.item.text;
      return;
    }
    if (notification.method === "turn/completed") {
      collector.status = notification.params.turn.status;
      collector.text = collector.finalText || collector.deltaText;
      if (collector.status === "failed") {
        collector.reject(new Error(`Codex turn failed: ${JSON.stringify(notification.params.turn.error)}`));
      } else {
        collector.resolve(collector);
      }
      return;
    }
    if (notification.method === "error" && !notification.params.willRetry) {
      collector.reject(new Error(`Codex error: ${notification.params.error.message}`));
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    for (const turn of this.turns.values()) turn.reject(error);
    this.pending.clear();
    this.turns.clear();
  }
}

async function verifyCustomAgent(server: AppServer, turn: TurnResult): Promise<void> {
  assert(turn.spawnedAgentThreadIds.size > 0, "No spawned-agent event was observed");
  for (const childThreadId of turn.spawnedAgentThreadIds) {
    const child = await server.request<ThreadReadResponse>("thread/read", { threadId: childThreadId, includeTurns: false });
    assert.equal(child.thread.agentRole, "gaia_phase0_spike");
  }
}

async function main(): Promise<void> {
  verifyStateMapping();

  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  assert.equal(execFileSync("codex", ["--version"], { encoding: "utf8", env }).trim(), CODEX_VERSION);
  const login = spawnSync("codex", ["login", "status"], { encoding: "utf8", env });
  assert.equal(login.status, 0);
  assert.match(`${login.stdout}${login.stderr}`, /Logged in using ChatGPT/);

  const workspaceA = await mkdtemp(join(tmpdir(), "gaia-phase0-a-"));
  const workspaceB = await mkdtemp(join(tmpdir(), "gaia-phase0-b-"));
  const marker = join(workspaceA, "approval-ok");
  const approvalCommand = `/usr/bin/touch ${marker}`;
  const agentDirectory = join(homedir(), ".codex", "agents");
  const agentPath = join(agentDirectory, "gaia-phase0-spike.toml");
  let agentCreated = false;
  let firstServer: AppServer | null = null;
  let secondServer: AppServer | null = null;
  let threadId: string | null = null;
  let approvalAccepted = false;

  try {
    await mkdir(agentDirectory, { recursive: true });
    await writeFile(agentPath, `name = "gaia_phase0_spike"\ndescription = "Phase 0 agent-discovery verifier."\nsandbox_mode = "read-only"\ndeveloper_instructions = """\nFor a discovery check, return only the exact GAIA_SUBAGENT_OK token requested by the parent. Do not use tools or modify files.\n"""\n`, { flag: "wx", mode: 0o600 });
    agentCreated = true;

    firstServer = new AppServer();
    const firstInitialize = await firstServer.initialize();
    assert.equal(firstInitialize.platformOs, "macos");

    const startParams: ThreadStartParams = {
      model: "gpt-5.6-luna",
      cwd: workspaceA,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      serviceName: "gaia_phase0_spike",
    };
    const started = await firstServer.request<ThreadStartResponse>("thread/start", startParams);
    threadId = started.thread.id;
    assert.equal(started.cwd, workspaceA);

    const firstTurn = await firstServer.runTurn({
      threadId,
      effort: "low",
      input: [{ type: "text", text: "Complete three checks without modifying files: (1) give a correct strict-TypeScript clamp(value, min, max) function that rejects min > max, then write CODING_OK; (2) spawn the custom gaia_phase0_spike agent, ask it for exactly GAIA_SUBAGENT_OK:A, wait for it, and include that token; (3) as my personal assistant, make an at-most-five-bullet, time-boxed 90-minute evening plan to review tomorrow's agenda, pack a gym bag, and relax. Remember ORBIT and end with CHECKPOINT: ORBIT.", text_elements: [] }],
    });
    assert.equal(firstTurn.status, "completed");
    assert.match(firstTurn.text, /CODING_OK/);
    assert.match(firstTurn.text, /GAIA_SUBAGENT_OK:A/);
    assert.match(firstTurn.text, /CHECKPOINT: ORBIT/);
    await verifyCustomAgent(firstServer, firstTurn);

    firstServer.expectApproval(approvalCommand);
    const approval = await firstServer.runTurn({
      threadId,
      effort: "low",
      approvalPolicy: "untrusted",
      input: [{ type: "text", text: `Run exactly this harmless command under this turn's approval policy: ${approvalCommand}. Then report APPROVAL_OK.`, text_elements: [] }],
    });
    assert.match(approval.text, /APPROVAL_OK/);
    assert(firstServer.approvalAccepted);
    approvalAccepted = firstServer.approvalAccepted;
    await access(marker);

    await firstServer.stop();
    firstServer = null;

    secondServer = new AppServer();
    await secondServer.initialize();
    const resumeParams: ThreadResumeParams = {
      threadId,
      cwd: workspaceB,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    };
    const resumed = await secondServer.request<ThreadResumeResponse>("thread/resume", resumeParams);
    assert.equal(resumed.thread.id, threadId);
    assert.equal(resumed.cwd, workspaceB);

    const resumedTurn = await secondServer.runTurn({
      threadId,
      cwd: workspaceB,
      effort: "low",
      input: [{ type: "text", text: "State the checkpoint word I asked you to remember as RESUME_OK: <word>. Then, from this second working directory, spawn the custom gaia_phase0_spike agent, ask it for exactly GAIA_SUBAGENT_OK:B, wait for it, and include that token in your final response.", text_elements: [] }],
    });
    assert.match(resumedTurn.text, /RESUME_OK: ORBIT/);
    assert.match(resumedTurn.text, /GAIA_SUBAGENT_OK:B/);
    await verifyCustomAgent(secondServer, resumedTurn);

    const states = new Set([...firstTurn.states, ...approval.states, ...resumedTurn.states]);
    for (const state of ["text", "activity", "completion", "approval"] satisfies EventState[]) assert(states.has(state), `Missing live ${state} event`);

    console.log(JSON.stringify({
      codexVersion: CODEX_VERSION,
      nodeVersion: process.version,
      authentication: "ChatGPT OAuth via macOS Keychain; OPENAI_API_KEY removed from child environment",
      model: started.model,
      threadRestartedAndResumed: true,
      workingDirectories: [started.cwd, resumed.cwd],
      approvalAccepted,
      eventStatesObserved: [...states].sort(),
      interruptionMappingChecked: true,
      customAgentRuntimeLocation: agentDirectory,
      customAgentAvailableInBothWorkingDirectories: true,
      responses: {
        firstTurn: firstTurn.text,
        approval: approval.text,
        resumedTurn: resumedTurn.text,
      },
    }, null, 2));

    await secondServer.request("thread/delete", { threadId });
    threadId = null;
  } finally {
    await firstServer?.stop().catch(() => undefined);
    await secondServer?.stop().catch(() => undefined);
    if (agentCreated) await unlink(agentPath).catch(() => undefined);
    await rm(workspaceA, { recursive: true, force: true });
    await rm(workspaceB, { recursive: true, force: true });
  }
}

await main();
