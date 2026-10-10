import { runGitHubBridge } from "./github-bridge.js";
process.once("message", async config => {
  try {
    const server = await runGitHubBridge(config as { socket: string; url: string; token: string });
    const parent = process.ppid;
    const timer = setInterval(() => { if (process.ppid !== parent) { server.close(); process.exit(); } }, 5000);
    const stop = () => { clearInterval(timer); server.close(() => process.exit()); };
    process.on("SIGTERM", stop); process.on("SIGINT", stop);
    process.send?.("ready");
  } catch { process.send?.("failed"); process.exitCode = 1; }
});
