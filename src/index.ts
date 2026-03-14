import { createRequire } from "module";

// Load .env for local development (no-op if dotenv not installed or file missing)
try {
  const require = createRequire(import.meta.url);
  const dotenv = require("dotenv");
  dotenv.config();
} catch {
  // dotenv not available, rely on system environment variables
}

import app from "./app";

const rawPort = process.env["PORT"] || "8080";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
