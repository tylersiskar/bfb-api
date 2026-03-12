import { spawn } from "child_process";
import { sendGroupMe, pollForApproval } from "./groupme.js";

const CLAUDE_TIMEOUT_MS = 120_000; // 2 minutes
const APP_DIR = process.env.APP_DIR || "/home/ec2-user/app";
const GROUPME_BOT_ID = process.env.GROUPME_BOT_ID;

let isHealing = false;

function buildPrompt(failures) {
  const errorList = failures
    .map((f) => `- ${f.step}: ${f.error}`)
    .join("\n");

  return `The BFB daily cron job failed with the following errors:

${errorList}

Relevant files:
- tasks.js (cron orchestration, DB updates)
- scripts/ktc_scraper.py (KTC web scraper - known bot detection issues)
- scripts/keeper_value_model.py (keeper value calculations)
- utils/pythonBridge.js (Python subprocess runner)

Analyze the error(s) and make minimal, targeted fixes. Do NOT refactor unrelated code.
Output a one-paragraph summary of what you changed and why.`;
}

function invokeClaudeCLI(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", prompt, "--output-format", "text", "--allowedTools", "Edit,Read,Glob,Grep,Bash"],
      { cwd: APP_DIR, stdio: ["pipe", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Claude CLI timed out after 2 minutes"));
    }, CLAUDE_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          new Error(
            `Claude CLI exited with code ${code}: ${stderr.slice(-300)}`,
          ),
        );
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start Claude CLI: ${err.message}`));
    });
  });
}

function deployWithPm2() {
  // Spawn a detached process that restarts pm2 after a short delay.
  // This is necessary because pm2 restart kills the current Node process,
  // so we detach and let it run independently.
  const botId = GROUPME_BOT_ID || "";
  const script = [
    "sleep 2",
    "pm2 restart all 2>&1",
    `EXIT_CODE=$?`,
    `if [ $EXIT_CODE -eq 0 ]; then`,
    `  curl -s -X POST https://api.groupme.com/v3/bots/post -H "Content-Type: application/json" -d '{"bot_id":"${botId}","text":"Fix deployed. Changes will take effect on next cron run."}'`,
    `else`,
    `  curl -s -X POST https://api.groupme.com/v3/bots/post -H "Content-Type: application/json" -d '{"bot_id":"${botId}","text":"pm2 restart failed (exit code '$EXIT_CODE'). Manual intervention needed."}'`,
    `fi`,
  ].join(" && ");

  const child = spawn("bash", ["-c", script], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

export async function attemptSelfHeal(failures) {
  if (isHealing) {
    console.log("[self-heal] Already in progress, skipping.");
    return;
  }

  isHealing = true;
  try {
    // Step 1: Notify
    await sendGroupMe(
      `Debugging ${failures.length} failure(s)...`,
    );

    // Step 2: Invoke Claude CLI
    let summary;
    try {
      summary = await invokeClaudeCLI(buildPrompt(failures));
    } catch (err) {
      console.error("[self-heal] Claude CLI failed:", err.message);
      await sendGroupMe(
        `Auto-debug failed: ${err.message}\nManual intervention needed.`,
      );
      return;
    }

    if (!summary) {
      await sendGroupMe("Auto-debug returned empty output. Manual intervention needed.");
      return;
    }

    // Step 3: Send proposed fix and request approval
    const sinceTimestamp = Math.floor(Date.now() / 1000);
    await sendGroupMe(
      `Proposed fix:\n${summary}\n\nReply 'approve' to deploy.`,
    );

    // Step 4: Poll for approval
    const result = await pollForApproval(sinceTimestamp);

    if (!result.approved) {
      await sendGroupMe(
        "No approval received within 10 minutes. Fix NOT deployed.",
      );
      return;
    }

    // Step 5: Deploy (detached pm2 restart)
    await sendGroupMe(
      `Deploying fix (approved by ${result.approver})...`,
    );
    deployWithPm2();
  } finally {
    isHealing = false;
  }
}
