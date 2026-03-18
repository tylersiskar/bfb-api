import express from "express";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import routes from "./routes.js";
import {
  updateNflPlayers,
  updatePlayerStats,
  syncLeague,
  startCronJobs,
} from "./tasks.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
const port = 5001;

app.use("/api", routes);

app.get("/", (req, res) => {
  res.send("BFB APP API!");
});

app.get("/updatePlayers", async (req, res) => {
  try {
    await updateNflPlayers();
    res.send("Updated NFL players successfully!");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/updateStats", async (req, res) => {
  const year = req.query.year ?? new Date().getFullYear();
  try {
    await updatePlayerStats(year);
    res.send("Updated player stats successfully!");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get("/syncLeague", async (req, res) => {
  try {
    await syncLeague(process.env.LEAGUE_ID);
    res.send("League synced successfully!");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  startCronJobs();
});
