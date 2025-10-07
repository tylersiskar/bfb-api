import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { updateNflPlayers, updatePlayerStats } from "./tasks.js";
dotenv.config({ path: "./.env" });

import routes from "./routes.js";

const app = express();
app.use(cors());
// Parse JSON bodies with a custom limit
app.use(express.json({ limit: "10mb" }));
const port = 5001;

app.use("/api", routes);

app.get("/", (req, res) => {
  res.send("BFB APP API! Go to /players to view nfl player endpoint.");
});

app.get("/updatePlayers", (req, res) => {
  updateNflPlayers()
    .then(() => res.send("Updated NFL players successfully!"))
    .catch((err) => res.send(err));
});

app.get("/updateStats", (req, res) => {
  updatePlayerStats()
    .then(() => res.send("Updated NFL players stats successfully!"))
    .catch((err) => res.send(err));
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
