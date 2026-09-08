import assert from "node:assert/strict";
import test from "node:test";
import { INTEGRATION_TOOLS, integrationApproval } from "../src/integrations.ts";

test("Google integration exposes the requested surface and gates every mutation", () => {
  assert.deepEqual(INTEGRATION_TOOLS.map((tool) => tool.type === "function" && tool.name), [
    "gmail_search", "gmail_read", "gmail_create_draft", "gmail_send_draft",
    "calendar_list", "calendar_create", "calendar_update", "calendar_delete",
    "tasks_list", "tasks_create", "tasks_update", "tasks_delete",
  ]);
  for (const [tool, input] of [
    ["gmail_send_draft", { draftId: "draft" }], ["calendar_create", { summary: "Event" }],
    ["calendar_update", { eventId: "event" }], ["calendar_delete", { eventId: "event" }],
    ["tasks_create", { title: "Task" }], ["tasks_update", { taskId: "task" }], ["tasks_delete", { taskId: "task" }],
  ] as const) assert.ok(integrationApproval(tool, input), tool);
  for (const tool of ["gmail_search", "gmail_read", "gmail_create_draft", "calendar_list", "tasks_list"]) {
    assert.equal(integrationApproval(tool, {}), null, tool);
  }
  assert.match(integrationApproval("calendar_delete", { eventId: "event" })!.risk, /HADES-class/);
  assert.equal(integrationApproval("calendar_delete", { eventId: "event" })!.agent, "HADES");
  assert.equal(integrationApproval("tasks_delete", { taskId: "task" })!.agent, "HADES");
});
