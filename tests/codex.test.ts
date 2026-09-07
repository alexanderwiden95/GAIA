import assert from "node:assert/strict";
import test from "node:test";

import { CodexClient, type CodexActivity, type CodexAgentActivity, type CodexApproval, type TurnResult } from "../src/codex.ts";

type Internals = {
  turns: CodexClient["turns"];
  specialists: CodexClient["specialists"];
  rawRequest: CodexClient["rawRequest"];
  send: CodexClient["send"];
  receive: CodexClient["receive"];
  resolveApproval: CodexClient["resolveApproval"];
};
type Collector = NonNullable<ReturnType<Internals["turns"]["get"]>>;
type ApprovalRequest = Parameters<Internals["resolveApproval"]>[0];

function harness() {
  const client = new CodexClient();
  const internal = client as unknown as Internals;
  const sent: Parameters<Internals["send"]>[0][] = [];
  const calls: { method: string; params: unknown }[] = [];
  const threads = new Map<string, object>();
  // No startup, subprocess, agent installation, or real transport is permitted.
  client.start = async () => { throw new Error("Unexpected Codex startup"); };
  client.stop = async () => { throw new Error("Unexpected Codex shutdown"); };
  internal.send = (message) => { sent.push(message); };
  internal.rawRequest = async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (method === "thread/read") {
      const thread = threads.get((params as { threadId: string }).threadId);
      if (!thread) throw new Error("Unknown thread");
      return { thread } as T;
    }
    assert.ok(["turn/interrupt", "turn/steer"].includes(method), `Unexpected RPC: ${method}`);
    if (method === "turn/interrupt") {
      const { threadId, turnId } = params as { threadId: string; turnId: string };
      if (threads.has(threadId)) threads.set(threadId, { turns: [{ id: turnId, status: "interrupted" }], status: { type: "idle" } });
    }
    return {} as T;
  };
  function root(id: string) {
    const approvals: CodexApproval[] = [];
    const agents: CodexAgentActivity[] = [];
    const activities: CodexActivity[] = [];
    const texts: string[] = [];
    const results: TurnResult[] = [];
    const collector: Collector = {
      turnId: `${id}-turn`, deltaText: "", finalText: "", done: false,
      interruptRequested: false, fileChanges: new Map(), agentEvents: Promise.resolve(),
      resolve: (result) => { results.push(result); },
      reject: (error) => { assert.fail(error.message); },
      onText: (text) => { texts.push(text); },
      onApproval: async (approval) => { approvals.push(approval); return "approve"; },
      onAgent: (activity) => { agents.push(activity); },
      onActivity: (activity) => { activities.push(activity); },
    };
    internal.turns.set(id, collector);
    return { collector, approvals, agents, activities, texts, results };
  }
  function notify(method: string, params: object) {
    internal.receive(JSON.stringify({ method, params }));
  }
  function child(id: string, parentThreadId: string, agentRole = "APOLLO") {
    const thread = { id, parentThreadId, agentRole, source: "cli", turns: [] };
    threads.set(id, thread);
    notify("thread/started", { thread });
  }
  function approve(method: ApprovalRequest["method"], threadId: string, extra = {}) {
    return internal.resolveApproval({ id: 1, method, params: {
      threadId, conversationId: threadId, turnId: `${threadId}-turn`, itemId: "patch",
      command: "pwd", ...extra,
    } } as unknown as ApprovalRequest);
  }
  return { client, internal, sent, calls, threads, root, notify, child, approve };
}

test("child approvals resolve ancestry and reach only the correct root with specialist identity", async () => {
  const h = harness();
  const other = h.root("other");
  const parent = h.root("parent");
  h.threads.set("worker", { id: "worker", parentThreadId: "parent", agentRole: "MINERVA" });
  await h.approve("item/commandExecution/requestApproval", "worker");
  assert.equal(other.approvals.length, 0);
  assert.equal(parent.approvals.length, 1);
  assert.deepEqual(parent.approvals[0], {
    kind: "command", agent: "MINERVA", action: "Run a local command", target: "pwd",
    reason: "Codex requested permission before execution.", risk: "The command may change local files or processes.",
  });
  assert.deepEqual(h.calls, [{ method: "thread/read", params: { threadId: "worker", includeTurns: false } }]);
  assert.deepEqual(h.sent, [{ id: 1, result: { decision: "accept" } }]);
  await h.approve("item/permissions/requestApproval", "worker", { permissions: { network: { enabled: true } } });
  assert.equal(parent.approvals[1]?.agent, "MINERVA");
  assert.deepEqual(h.sent[1], { id: 1, result: { permissions: { network: { enabled: true } }, scope: "turn" } });
  assert.equal(h.calls.length, 1, "known specialists do not need another ancestry lookup");
});

test("unknown ancestry and failed lookup fail closed for every approval protocol", async () => {
  for (const lookupFails of [false, true]) {
    for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "execCommandApproval", "applyPatchApproval"] as const) {
      const h = harness();
      const parent = h.root("parent");
      if (!lookupFails) h.threads.set("unknown", { id: "unknown", parentThreadId: "unrelated", source: "cli" });
      const response = Promise.withResolvers<Parameters<Internals["send"]>[0]>();
      h.internal.send = response.resolve;
      h.internal.receive(JSON.stringify({ id: 7, method, params: {
        threadId: "unknown", conversationId: "unknown", itemId: "patch", command: ["pwd"],
        permissions: { network: { enabled: true } }, fileChanges: {},
      } }));
      const message = await response.promise;
      assert.equal(message.id, 7);
      if (method === "item/permissions/requestApproval") {
        assert.deepEqual(message.result, { permissions: {}, scope: "turn" });
      } else if (method.startsWith("item/")) {
        assert.deepEqual(message.result, { decision: "decline" });
      } else {
        assert.ok((message.result as { decision: { denied?: unknown } }).decision.denied);
      }
      assert.equal(parent.approvals.length, 0);
      assert.equal(h.internal.specialists.size, 0);
      assert.equal(h.calls.length, 1, "unknown requests must not steer an arbitrary root");
    }
  }
});

test("approval received after root cancellation is denied without asking the owner", async () => {
  const h = harness();
  const parent = h.root("parent");
  h.child("worker", "parent");
  await h.client.interrupt("parent");
  await h.approve("item/commandExecution/requestApproval", "worker");
  assert.equal(parent.approvals.length, 0);
  assert.deepEqual(h.sent, [{ id: 1, result: { decision: "decline" } }]);
});

test("pending owner approval cannot outlive cancellation, completion, removal, or root replacement", async () => {
  for (const change of ["cancel", "complete", "remove", "replace"]) {
    const h = harness();
    const parent = h.root("parent");
    h.child("worker", "parent");
    const asked = Promise.withResolvers<void>();
    const decision = Promise.withResolvers<"approve" | "deny">();
    parent.collector.onApproval = () => { asked.resolve(); return decision.promise; };
    const approval = h.approve("item/permissions/requestApproval", "worker", { permissions: { network: { enabled: true } } });
    await asked.promise;
    if (change === "cancel") await h.client.interrupt("parent");
    if (change === "complete") parent.collector.done = true;
    if (change === "remove") h.internal.turns.delete("parent");
    if (change === "replace") h.root("parent");
    decision.resolve("approve");
    await approval;
    assert.deepEqual(h.sent, [{ id: 1, result: { permissions: {}, scope: "turn" } }], change);
  }
});

test("child text and completion never become parent text or resolve its turn", () => {
  const h = harness();
  const parent = h.root("parent");
  h.child("worker", "parent");
  h.notify("turn/started", { threadId: "worker", turn: { id: "worker-turn" } });
  h.notify("item/agentMessage/delta", { threadId: "worker", turnId: "worker-turn", delta: "private child delta" });
  h.notify("item/completed", { threadId: "worker", turnId: "worker-turn", item: { type: "agentMessage", text: "child answer", phase: "final_answer" } });
  h.notify("item/completed", { threadId: "worker", turnId: "worker-turn", item: { type: "agentMessage", text: "child commentary", phase: "commentary" } });
  h.notify("turn/completed", { threadId: "worker", turn: { id: "worker-turn", status: "completed" } });
  assert.deepEqual(parent.texts, []);
  assert.deepEqual(parent.results, []);
  assert.equal(parent.collector.done, false);
  assert.equal(parent.collector.finalText, "");
  assert.equal(parent.collector.deltaText, "");
  assert.deepEqual(parent.agents.at(-1), { threadId: "worker", agent: "APOLLO", status: "completed", summary: "child answer" });
  h.notify("item/agentMessage/delta", { threadId: "parent", turnId: "stale", delta: "stale" });
  h.notify("item/agentMessage/delta", { threadId: "parent", turnId: "parent-turn", delta: "parent delta" });
  h.notify("item/completed", { threadId: "parent", turnId: "parent-turn", item: { type: "agentMessage", text: "parent answer", phase: "final_answer" } });
  h.notify("turn/completed", { threadId: "parent", turn: { id: "parent-turn", status: "completed" } });
  assert.deepEqual(parent.texts, ["parent delta"]);
  assert.deepEqual(parent.results, [{ turnId: "parent-turn", status: "completed", text: "parent answer" }]);
});

test("collab final states keep stable identities, deduplicate, and ignore another root's worker", async () => {
  const h = harness();
  const parent = h.root("parent");
  const other = h.root("other");
  h.threads.set("worker", { id: "worker", agentRole: "custom", source: { subAgent: { thread_spawn: { parent_thread_id: "parent" } } } });
  h.threads.set("foreign", { id: "foreign", parentThreadId: "other", agentRole: "APOLLO" });
  const collab = async (status: string, message: string | null) => {
    for (const method of ["item/started", "item/completed"]) {
      h.notify(method, { threadId: "parent", turnId: "parent-turn", item: {
        type: "collabAgentToolCall", receiverThreadIds: ["worker", "foreign"],
        agentsStates: { worker: { status, message }, foreign: { status: "completed", message: "foreign result" } },
      } });
    }
    await parent.collector.agentEvents;
  };
  await collab("pendingInit", null);
  await collab("completed", "final result");
  await collab("shutdown", null);
  assert.deepEqual(parent.agents, [
    { threadId: "worker", agent: "HERMES-1", status: "running", summary: "" },
    { threadId: "worker", agent: "HERMES-1", status: "completed", summary: "final result" },
  ]);
  assert.equal(other.agents.length, 1, "ancestry discovery can register but not complete the foreign worker");
  assert.equal(other.agents[0]?.status, "running");
  assert.equal(h.calls.length, 2);
});

test("child patch updates map approvals and completed activity to the child agent", async () => {
  const h = harness();
  const parent = h.root("parent");
  h.child("worker", "parent", "HEPHAESTUS");
  const original = [{ path: "parent.txt", kind: { type: "add" as const }, diff: "" }];
  const changes = [
    { path: "old.txt", kind: { type: "delete" as const }, diff: "" },
    { path: "before.txt", kind: { type: "update" as const, move_path: "after.txt" }, diff: "" },
  ];
  parent.collector.fileChanges.set("patch", original);
  h.notify("item/started", { threadId: "worker", item: { type: "fileChange", id: "patch", changes: original } });
  h.notify("item/fileChange/patchUpdated", { threadId: "worker", itemId: "patch", changes });
  await h.approve("item/fileChange/requestApproval", "worker");
  assert.equal(parent.approvals[0]?.agent, "HEPHAESTUS");
  assert.equal(parent.approvals[0]?.target, "delete old.txt\nmove to after.txt before.txt");
  assert.match(parent.approvals[0]!.risk, /HADES-class/);
  assert.deepEqual(parent.collector.fileChanges.get("patch"), original);
  h.notify("item/completed", { threadId: "worker", item: { type: "fileChange", id: "patch", status: "completed", changes } });
  assert.deepEqual(parent.activities, [{ agent: "HEPHAESTUS", kind: "fileChange", status: "completed", summary: "delete old.txt\nmove to after.txt before.txt", count: 2 }]);
});

test("child final text arriving after an empty collab completion is still reported", async () => {
  const h = harness();
  const parent = h.root("parent");
  h.child("worker", "parent");
  h.notify("item/completed", { threadId: "parent", turnId: "parent-turn", item: {
    type: "collabAgentToolCall", receiverThreadIds: ["worker"],
    agentsStates: { worker: { status: "completed", message: null } },
  } });
  await parent.collector.agentEvents;
  h.notify("item/completed", { threadId: "worker", item: { type: "agentMessage", phase: "final_answer", text: "final child result" } });
  h.notify("turn/completed", { threadId: "worker", turn: { id: "worker-turn", status: "completed" } });
  assert.deepEqual(parent.agents.at(-1), { threadId: "worker", agent: "APOLLO", status: "completed", summary: "final child result" });
});

test("child file completion must not overwrite the root's same-ID approval target", async () => {
  const h = harness();
  const parent = h.root("parent");
  h.child("worker", "parent");
  parent.collector.fileChanges.set("patch", [{ path: "parent.txt", kind: { type: "add" }, diff: "" }]);
  h.notify("item/completed", { threadId: "worker", item: { type: "fileChange", id: "patch", status: "completed", changes: [{ path: "child.txt", kind: { type: "delete" }, diff: "" }] } });
  await h.approve("item/fileChange/requestApproval", "parent");
  assert.equal(parent.approvals[0]?.target, "add parent.txt");
});

test("interrupt stops the parent first, checks all its children, and leaves other roots alone", async () => {
  const h = harness();
  const parent = h.root("parent");
  h.root("other");
  h.child("live", "parent");
  h.child("finished", "parent");
  h.child("foreign", "other");
  h.notify("turn/completed", { threadId: "finished", turn: { id: "finished-turn", status: "completed" } });
  h.threads.set("live", { turns: [{ id: "old", status: "completed" }, { id: "current", status: "inProgress" }] });
  assert.equal(await h.client.interrupt("parent"), true);
  assert.equal(parent.collector.interruptRequested, true);
  assert.deepEqual(h.calls, [
    { method: "turn/interrupt", params: { threadId: "parent", turnId: "parent-turn" } },
    { method: "thread/read", params: { threadId: "live", includeTurns: true } },
    { method: "thread/read", params: { threadId: "finished", includeTurns: true } },
    { method: "turn/interrupt", params: { threadId: "live", turnId: "current" } },
    { method: "thread/read", params: { threadId: "live", includeTurns: true } },
  ]);
  assert.equal(parent.agents.at(-1)?.status, "interrupted");
  assert.equal(await h.client.interrupt("missing"), false);
});

test("failed child interruption kills the transport; cancellation before parent start interrupts on arrival", async () => {
  const h = harness();
  const parent = h.root("parent");
  parent.collector.turnId = null;
  h.child("worker", "parent");
  h.threads.delete("worker");
  let stops = 0;
  h.client.stop = async () => { stops++; };
  assert.equal(await h.client.interrupt("parent"), true);
  assert.equal(stops, 1);
  h.notify("turn/started", { threadId: "parent", turn: { id: "late-turn" } });
  assert.deepEqual(h.calls.at(-1), { method: "turn/interrupt", params: { threadId: "parent", turnId: "late-turn" } });
});

test("pending unknown ancestry cannot attach an approval to a new parent collector", async () => {
  for (const hadParent of [false, true]) {
    const h = harness();
    const old = hadParent ? h.root("parent") : undefined;
    const lookup = Promise.withResolvers<{ thread: object }>();
    h.internal.rawRequest = async <T>(method: string, params?: unknown): Promise<T> => {
      assert.equal(method, "thread/read");
      assert.deepEqual(params, { threadId: "worker", includeTurns: false });
      return await lookup.promise as T;
    };
    const approval = h.approve("item/commandExecution/requestApproval", "worker");
    const replacement = h.root("parent");
    lookup.resolve({ thread: { id: "worker", parentThreadId: "parent", agentRole: "APOLLO" } });
    await approval;
    assert.deepEqual(replacement.approvals, []);
    assert.deepEqual(replacement.agents, []);
    assert.deepEqual(old?.approvals ?? [], []);
    assert.equal(h.internal.specialists.size, 0);
    assert.deepEqual(h.sent, [{ id: 1, result: { decision: "decline" } }]);
  }
});

test("reused child resets turn state, ignores stale events, and cancels its running turn", { timeout: 2_000 }, async () => {
  const h = harness();
  const parent = h.root("parent");
  h.child("worker", "parent");
  h.notify("turn/started", { threadId: "worker", turn: { id: "old" } });
  h.notify("item/completed", { threadId: "worker", turnId: "old", item: { type: "agentMessage", phase: "final_answer", text: "old answer" } });
  h.notify("item/started", { threadId: "worker", turnId: "old", item: { type: "fileChange", id: "patch", changes: [{ path: "old.txt", kind: { type: "delete" }, diff: "" }] } });
  h.notify("turn/completed", { threadId: "worker", turn: { id: "old", status: "completed" } });
  h.notify("turn/started", { threadId: "worker", turn: { id: "current" } });
  const worker = h.internal.specialists.get("worker")!;
  assert.equal(worker.finalText, "");
  assert.equal(worker.fileChanges.size, 0);
  assert.deepEqual(parent.agents.at(-1), { threadId: "worker", agent: "APOLLO", status: "running", summary: "" });
  const events = parent.agents.length;
  h.notify("item/completed", { threadId: "worker", turnId: "old", item: { type: "agentMessage", phase: "final_answer", text: "stale answer" } });
  h.notify("item/fileChange/patchUpdated", { threadId: "worker", turnId: "old", itemId: "patch", changes: [{ path: "stale.txt", kind: { type: "delete" }, diff: "" }] });
  h.notify("turn/completed", { threadId: "worker", turn: { id: "old", status: "completed" } });
  assert.equal(worker.turnId, "current");
  assert.equal(worker.finalText, "");
  assert.equal(worker.fileChanges.size, 0);
  assert.equal(parent.agents.length, events);
  h.threads.set("worker", { turns: [{ id: "old", status: "completed" }, { id: "current", status: "inProgress" }], status: { type: "active" } });
  assert.equal(await h.client.interrupt("parent"), true);
  assert.deepEqual(h.calls, [
    { method: "turn/interrupt", params: { threadId: "parent", turnId: "parent-turn" } },
    { method: "thread/read", params: { threadId: "worker", includeTurns: true } },
    { method: "turn/interrupt", params: { threadId: "worker", turnId: "current" } },
    { method: "thread/read", params: { threadId: "worker", includeTurns: true } },
  ]);
  assert.deepEqual(parent.agents.at(-1), { threadId: "worker", agent: "APOLLO", status: "interrupted", summary: "Stopped with the parent turn." });
});

test("cancellation ACK waits for a terminal thread/read for every child", { timeout: 2_000 }, async () => {
  const h = harness();
  const parent = h.root("parent");
  const confirmations = ["first", "second"].map((id) => {
    h.child(id, "parent");
    return { id, requested: Promise.withResolvers<void>(), response: Promise.withResolvers<{ thread: object }>() };
  });
  const reads = new Map<string, number>();
  h.internal.rawRequest = async <T>(method: string, params?: unknown): Promise<T> => {
    h.calls.push({ method, params });
    if (method === "turn/interrupt") return {} as T;
    assert.equal(method, "thread/read");
    const { threadId, includeTurns } = params as { threadId: string; includeTurns: boolean };
    assert.equal(includeTurns, true);
    const count = (reads.get(threadId) ?? 0) + 1;
    reads.set(threadId, count);
    if (count === 1) return { thread: { turns: [{ id: `${threadId}-turn`, status: "inProgress" }] } } as T;
    const confirmation = confirmations.find(({ id }) => id === threadId)!;
    confirmation.requested.resolve();
    return await confirmation.response.promise as T;
  };
  let settled = false;
  const cancellation = h.client.interrupt("parent").then((result) => { settled = true; return result; });
  await Promise.all(confirmations.map(({ requested }) => requested.promise));
  assert.equal(settled, false, "successful interrupt RPCs are not terminal confirmation");
  assert.equal(parent.agents.some(({ status }) => status === "interrupted"), false);
  confirmations[0]!.response.resolve({ thread: { turns: [{ id: "first-turn", status: "interrupted" }], status: { type: "idle" } } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "one stopped child must not release cancellation");
  assert.equal(parent.agents.filter(({ status }) => status === "interrupted").length, 1);
  confirmations[1]!.response.resolve({ thread: { turns: [{ id: "second-turn", status: "interrupted" }], status: { type: "idle" } } });
  assert.equal(await cancellation, true);
  assert.equal(parent.agents.filter(({ status }) => status === "interrupted").length, 2);
  assert.deepEqual(h.calls.filter(({ method }) => method === "turn/interrupt"), [
    { method: "turn/interrupt", params: { threadId: "parent", turnId: "parent-turn" } },
    { method: "turn/interrupt", params: { threadId: "first", turnId: "first-turn" } },
    { method: "turn/interrupt", params: { threadId: "second", turnId: "second-turn" } },
  ]);
});

test("subAgentActivity started/completed recovers the child result through thread/read", async () => {
  const h = harness();
  const parent = h.root("parent");
  h.threads.set("worker", { id: "worker", agentRole: "MINERVA", source: { subAgent: { thread_spawn: { parent_thread_id: "parent" } } }, turns: [] });
  h.notify("item/started", { threadId: "parent", turnId: "parent-turn", item: {
    type: "subAgentActivity", id: "started", kind: "started", agentThreadId: "worker", agentPath: "MINERVA",
  } });
  await parent.collector.agentEvents;
  assert.deepEqual(h.calls, [], "a pending spawn must not read a child before it exists");
  h.notify("item/completed", { threadId: "parent", turnId: "parent-turn", item: {
    type: "subAgentActivity", id: "started", kind: "started", agentThreadId: "worker", agentPath: "MINERVA",
  } });
  await parent.collector.agentEvents;
  assert.deepEqual(parent.agents, [{ threadId: "worker", agent: "MINERVA", status: "running", summary: "" }]);
  h.threads.set("worker", { turns: [
    { id: "old", status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "old result" }] },
    { id: "current", status: "completed", items: [
      { type: "agentMessage", phase: "final_answer", text: "recovered result" },
      { type: "agentMessage", phase: "commentary", text: "not the result" },
    ] },
  ] });
  h.notify("item/completed", { threadId: "parent", turnId: "parent-turn", item: {
    type: "subAgentActivity", id: "completed", kind: "completed", agentThreadId: "worker", agentPath: "MINERVA",
  } });
  await parent.collector.agentEvents;
  assert.deepEqual(parent.agents, [
    { threadId: "worker", agent: "MINERVA", status: "running", summary: "" },
    { threadId: "worker", agent: "MINERVA", status: "completed", summary: "recovered result" },
  ]);
  assert.deepEqual(h.calls, [
    { method: "thread/read", params: { threadId: "worker", includeTurns: false } },
    { method: "thread/read", params: { threadId: "worker", includeTurns: true } },
  ]);
  assert.deepEqual(parent.texts, []);
  assert.deepEqual(parent.results, []);
  assert.equal(parent.collector.finalText, "");
  assert.equal(parent.collector.done, false);
});

test("spawn metadata lookup retries a not-yet-readable child without losing its parent generation", async () => {
  const h = harness();
  const parent = h.root("parent");
  h.threads.set("worker", { id: "worker", parentThreadId: "parent", agentRole: "APOLLO" });
  const request = h.internal.rawRequest;
  let attempts = 0;
  h.internal.rawRequest = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "thread/read" && ++attempts === 1) throw new Error("-32600: thread not found");
    return request<T>(method, params);
  };
  await h.approve("item/commandExecution/requestApproval", "worker");
  assert.equal(attempts, 2);
  assert.equal(parent.approvals[0]?.agent, "APOLLO");
});

test("a delayed stop acknowledgement cannot cancel the next turn's specialists", async () => {
  const h = harness();
  h.root("parent");
  const acknowledged = Promise.withResolvers<object>();
  const request = h.internal.rawRequest;
  h.internal.rawRequest = async <T>(method: string, params?: unknown): Promise<T> => {
    if (method === "turn/interrupt") return acknowledged.promise as Promise<T>;
    return request<T>(method, params);
  };
  const stopping = h.client.interrupt("parent");
  const next = h.root("parent");
  h.child("new-worker", "parent");
  acknowledged.resolve({});
  await stopping;
  assert.deepEqual(h.calls, [], "the old stop must not even inspect the new worker");
  assert.equal(next.collector.interruptRequested, false);
  assert.equal(next.agents.at(-1)?.status, "running");
});
