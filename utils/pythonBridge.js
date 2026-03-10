import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = join(__dirname, "..", "scripts", "trade_bridge.py");

// Prefer the project venv python, then python3.11, then system python3
const VENV_PYTHON = join(__dirname, "..", "..", ".venv", "bin", "python3");
const PYTHON = existsSync(VENV_PYTHON)
  ? VENV_PYTHON
  : existsSync("/usr/bin/python3.11")
    ? "/usr/bin/python3.11"
    : "python3";

/**
 * Run the Python trade bridge with JSON input and return parsed JSON output.
 * Times out after 15 seconds.
 */
export function runTradeBridge(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON, [BRIDGE_SCRIPT], {
      cwd: join(__dirname, ".."),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Trade bridge timed out after 15s"));
    }, 15000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        return reject(
          new Error(`Trade bridge exited with code ${code}: ${stderr}`),
        );
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Failed to parse trade bridge output: ${stdout}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start trade bridge: ${err.message}`));
    });

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

/**
 * Run the keeper value model (keeper_value_model.py).
 * This pulls historical NFL data and generates output/keeper_values.csv.
 * Long-running — can take several minutes.
 */
export function runKeeperModel() {
  return new Promise((resolve, reject) => {
    const script = join(__dirname, "..", "scripts", "keeper_value_model.py");
    const proc = spawn(PYTHON, [script], {
      cwd: join(__dirname, ".."),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("Keeper model timed out after 5 minutes"));
    }, 300000);

    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        return reject(
          new Error(`Keeper model exited with code ${code}: ${stderr}`),
        );
      }
      resolve({ success: true, output: stdout });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start keeper model: ${err.message}`));
    });
  });
}
