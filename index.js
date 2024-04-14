import express from "express";
import cron from "node-cron";
import cors from "cors";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import { updateNflPlayers, updatePlayerStats } from "./tasks.js";
dotenv.config({ path: "./.env" });

import routes from "./routes.js";

const app = express();
app.use(cors());
// Parse JSON bodies
app.use(bodyParser.json());
const port = 5000;

app.use("/api", routes);

app.get("/", (req, res) => {
  res.send("BFB APP API! Go to /players to view nfl player endpoint.");
});

if (process.argv.length === 2) {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
} else {
  const task = process.argv[2];

  switch (task) {
    case "updateNflPlayers":
      updateNflPlayers()
        .then(() => console.log("Updated NFL players successfully!"))
        .catch(console.error);
      break;
    case "updatePlayerStats":
      updatePlayerStats()
        .then(() => console.log("Updated player stats successfully!"))
        .catch(console.error);
      break;
    default:
      console.log("No valid task provided.");
      break;
  }
}
