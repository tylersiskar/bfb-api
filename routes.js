import express from "express";
import * as playerController from "./controllers/playerController.js";
import * as statsController from "./controllers/statsController.js";
import * as mockController from "./controllers/mockController.js";
import * as leagueController from "./controllers/leagueController.js";
import * as tradeController from "./controllers/tradeController.js";
import * as keeperController from "./controllers/keeperController.js";

const router = express.Router();

// Players
router.get("/playersAll/:year", playerController.getAllPlayers);
router.get("/players", playerController.getPlayers);
router.get("/players/:id", playerController.getPlayerById);
router.get("/search", playerController.searchPlayers);

// Stats & Rankings
router.post(
  "/updatePlayerRankings/:year",
  statsController.updatePlayerRankings,
);
router.get("/stats/:year", statsController.getStats);

// Mocks
router.post(
  "/league/:leagueId/mocks",
  mockController.createMockInsert,
  mockController.createMockUpload,
);
router.get("/league/:leagueId/mocks", mockController.getMocks);
router.get("/league/:leagueId/mocks/:id", mockController.getMockById);

// League
router.get("/league/:leagueId/rosters", leagueController.getRosters);
router.get("/league/:leagueId/standings", leagueController.getStandings);
router.get("/league/:leagueId/draft-picks", leagueController.getDraftPicks);
router.get("/league/:leagueId/keeper-scores", leagueController.getKeeperScores);

// Keeper Value Model
router.post("/keeper-model/run", keeperController.runModel);
router.get("/keeper-model/status", keeperController.getStatus);

// Trade
router.post("/trade/calculate", tradeController.calculateTrade);
router.post("/trade/find-deals", tradeController.findDeals);
router.post("/trade/recommended", tradeController.getRecommendedTrades);
router.get(
  "/league/:leagueId/trade-targets/:rosterId",
  tradeController.getTradeTargets,
);

export default router;
