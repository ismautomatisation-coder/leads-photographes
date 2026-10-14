import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  // Référence du projet : cloud.trigger.dev → ton projet → Project settings (commence par "proj_")
  project: "proj_arnkwwexnthjexaeefdx",
  dirs: ["./src/trigger"],
  // macOS crée des fichiers "._xxx.ts" sur les disques externes : ce ne sont pas des tâches
  ignorePatterns: ["**/._*"],
  // Les recherches web peuvent prendre plusieurs minutes par ville
  maxDuration: 1800,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 5000,
      maxTimeoutInMs: 30_000,
      factor: 2,
    },
  },
});
