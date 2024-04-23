// in app.js or a separate script file
import {
  updateDynastyRankings,
  updateNflPlayers,
  updatePlayerStats,
} from "./tasks.js"; // Ensure these functions are exported from their modules

const arg = process.argv[2]; // Get command-line arguments
if (arg === "updateNflPlayers") {
  updateNflPlayers()
    .then(() => console.log("Updated NFL players successfully!"))
    .catch(console.error);
} else if (arg === "updatePlayerStats") {
  updatePlayerStats()
    .then(() => console.log("Updated player stats successfully!"))
    .catch(console.error);
} else if (arg === "updateDynastyRankings") {
  updateDynastyRankings()
    .then(() => console.log("Updated dynasty successfully!"))
    .catch(console.error);
}
