import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalManager,
  PermissionDeniedError,
  approvalDescription,
} from "../src/approval.js";

test("read-only allows reads but blocks edits", async () => {
  const approvals = new ApprovalManager("read-only");
  await approvals.authorize({
    name: "read_file",
    risk: "read",
    summary: "read",
  });
  await assert.rejects(
    approvals.authorize({
      name: "write_file",
      risk: "edit",
      summary: "write",
    }),
    PermissionDeniedError,
  );
});

test("allow-all and auto-edit authorize their documented operations", async () => {
  const all = new ApprovalManager("allow-all");
  await all.authorize({ name: "run_command", risk: "shell", summary: "test" });

  const autoEdit = new ApprovalManager("auto-edit");
  await autoEdit.authorize({ name: "write_file", risk: "edit", summary: "test" });
  assert.match(approvalDescription("auto-edit"), /Dateiänderungen automatisch/);
});

test("ask mode can delegate its decision to the terminal UI", async () => {
  const approvals = new ApprovalManager("ask");
  let received = "";
  approvals.setPromptHandler(async (preview) => {
    received = preview.summary;
    return true;
  });

  await approvals.authorize({
    name: "run_command",
    risk: "shell",
    summary: "npm test ausführen",
  });
  assert.equal(received, "npm test ausführen");
});
