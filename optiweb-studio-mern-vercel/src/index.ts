import "dotenv/config";
import { APP_NAME } from "@/server/config/env";
import app from "./app.js";

// This is the local/standalone Express entry point. Serverless adapters import
// src/app.ts directly, so an invocation never starts a nested listener.
if (process.env.NETLIFY !== "true") {
  const port = Number(process.env.PORT ?? 5000);
  app.listen(port, () => console.log(`${APP_NAME} API and static app listening on port ${port}`));
}

export default app;
