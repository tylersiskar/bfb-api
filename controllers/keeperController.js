import { runKeeperModel } from "../utils/pythonBridge.js";
import { getKeeperValuesStatus } from "../utils/keeperValues.js";

let modelRunning = false;

/**
 * POST /api/keeper-model/run
 * Triggers the Python keeper value model to regenerate output/keeper_values.csv.
 * Long-running — responds when complete.
 */
export const runModel = async (req, res) => {
  if (modelRunning) {
    return res.status(409).json({ message: "Keeper model is already running" });
  }

  modelRunning = true;
  try {
    const result = await runKeeperModel();
    res.json({
      success: true,
      message: "Keeper value model completed",
      status: getKeeperValuesStatus(),
    });
  } catch (error) {
    console.error("Error running keeper model:", error);
    res.status(500).json({
      error: error.message,
      message: "Keeper model failed",
    });
  } finally {
    modelRunning = false;
  }
};

/**
 * GET /api/keeper-model/status
 * Returns whether the keeper values CSV exists and when it was last generated.
 */
export const getStatus = (req, res) => {
  res.json({
    ...getKeeperValuesStatus(),
    modelRunning,
  });
};
