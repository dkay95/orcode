// Account-free native launcher fixture. No authentication, vendor CLI or model request.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const [mode, root, ...args] = process.argv.slice(2);
if (mode === "record-args") {
  writeFileSync(join(root, "arguments.json"), JSON.stringify({ args, value: process.env.ORCODE_TEST_UNICODE }));
} else if (mode === "hold-inherited-stdio") {
  setInterval(() => {}, 1000);
} else if (mode === "crash") {
  process.exit(23);
} else {
  throw new Error("Unknown native fixture mode");
}
