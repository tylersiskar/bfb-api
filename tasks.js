import fetch from "node-fetch";
import pg from "pg";
import cron from "node-cron";
import { spawn } from "child_process";
import { runKeeperModel } from "./utils/pythonBridge.js";

const { Pool } = pg;

const GROUPME_BOT_ID = "e92a725c167cdf60e08d1b5a1c";

async function sendGroupMe(text) {
  try {
    const res = await fetch("https://api.groupme.com/v3/bots/post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_id: GROUPME_BOT_ID, text }),
    });
    if (!res.ok) console.error("GroupMe post failed:", res.status);
  } catch (err) {
    console.error("GroupMe post error:", err);
  }
}

const pool = new Pool({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DB,
  password: process.env.PG_PASSWORD,
  port: 5432,
});

async function updatePlayerStats(year = new Date().getFullYear()) {
  console.log("Start Update Player Stats.");
  const statsResponse = await fetch(
    `https://api.sleeper.app/v1/stats/nfl/regular/${year}`,
  );
  const stats = await statsResponse.json();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM player_stats WHERE year = $1", [year]);
    for (const playerId in stats) {
      const player = stats[playerId];
      await client.query(
        "INSERT INTO player_stats (player_id, pos_rank_half_ppr, gms_active, pts_half_ppr, year) VALUES ($1, $2, $3, $4, $5)",
        [
          playerId,
          player.pos_rank_half_ppr,
          player.gp ?? player.gs ?? player.gms_active,
          player.pts_half_ppr,
          year,
        ],
      );
    }
    await client.query("COMMIT");
    console.log("Update Player Stats Complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function updateNflPlayers() {
  console.log("Start Update NFL Players.");
  const response = await fetch("https://api.sleeper.app/v1/players/nfl");
  const players = await response.json();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM nfl_players");
    for (const playerId in players) {
      const player = players[playerId];
      await client.query(
        "INSERT INTO nfl_players (id, first_name, last_name, position, team, active, years_exp) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          playerId,
          player.first_name,
          player.last_name,
          player.position,
          player.team,
          player.active,
          player.years_exp,
        ],
      );
    }
    await client.query("COMMIT");
    console.log("Update NFL Players Complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function runKtcScraper() {
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["scripts/ktc_scraper.py"]);
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      console.error(`ktc_scraper stderr: ${d}`);
    });
    proc.on("close", (code) => {
      if (code === 0) {
        console.log("KTC scraper complete.");
        resolve();
      } else {
        reject(new Error(`KTC scraper exited with code ${code}: ${stderr.slice(-200)}`));
      }
    });
    proc.on("error", (err) => reject(new Error(`KTC scraper failed to start: ${err.message}`)));
  });
}

async function syncLeague(leagueId) {
  console.log(`Syncing league ${leagueId}...`);
  const client = await pool.connect();
  try {
    // 1. League info
    const leagueRes = await fetch(
      `https://api.sleeper.app/v1/league/${leagueId}`,
    );
    const league = await leagueRes.json();
    await client.query(
      `INSERT INTO leagues (id, name, season, total_rosters, synced_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET name = $2, season = $3, total_rosters = $4, synced_at = NOW()`,
      [
        league.league_id,
        league.name,
        parseInt(league.season),
        league.total_rosters,
      ],
    );

    // 2. Users
    const usersRes = await fetch(
      `https://api.sleeper.app/v1/league/${leagueId}/users`,
    );
    const users = await usersRes.json();
    for (const user of users) {
      await client.query(
        `INSERT INTO league_users (user_id, league_id, display_name, avatar, roster_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, league_id) DO UPDATE SET display_name = $3, avatar = $4, roster_id = $5`,
        [
          user.user_id,
          leagueId,
          user.display_name,
          user.avatar,
          user.roster_id ?? null,
        ],
      );
    }

    // 3. Draft order (offseason: real slot assignments; in-season: null)
    const draftsRes = await fetch(
      `https://api.sleeper.app/v1/league/${leagueId}/drafts`,
    );
    const drafts = await draftsRes.json();
    const upcomingDraft =
      drafts.find((d) => d.status === "pre_draft" || d.status === "drafting") ??
      drafts.find(
        (d) =>
          d.slot_to_roster_id && Object.keys(d.slot_to_roster_id).length > 0,
      );
    const draftOrder = upcomingDraft?.slot_to_roster_id ?? null;
    await client.query(`UPDATE leagues SET draft_order = $1 WHERE id = $2`, [
      draftOrder ? JSON.stringify(draftOrder) : null,
      leagueId,
    ]);

    // 4. Rosters + picks
    const rostersRes = await fetch(
      `https://api.sleeper.app/v1/league/${leagueId}/rosters`,
    );
    const rosters = await rostersRes.json();

    for (const roster of rosters) {
      await client.query(
        `INSERT INTO rosters (roster_id, league_id, owner_id, player_ids, wins, losses, ties, points_for, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (roster_id, league_id) DO UPDATE
           SET owner_id = $3, player_ids = $4, wins = $5, losses = $6, ties = $7, points_for = $8, synced_at = NOW()`,
        [
          roster.roster_id,
          leagueId,
          roster.owner_id,
          roster.players ?? [],
          roster.settings?.wins ?? 0,
          roster.settings?.losses ?? 0,
          roster.settings?.ties ?? 0,
          roster.settings?.fpts ?? 0,
        ],
      );
    }

    // Picks: fetch traded picks first so we know all seasons to generate base rows for
    const draftRounds = parseInt(process.env.DRAFT_ROUNDS ?? "8");
    const pickSeason = upcomingDraft
      ? parseInt(upcomingDraft.season)
      : parseInt(league.season) + 1;

    const tradedPicksRes = await fetch(
      `https://api.sleeper.app/v1/league/${leagueId}/traded_picks`,
    );
    const tradedPicks = await tradedPicksRes.json();
    console.log(`[sync] ${tradedPicks.length} traded picks found`);

    // Collect all seasons we need base rows for (upcoming draft + any future traded seasons)
    const seasons = new Set([
      pickSeason,
      ...tradedPicks.map((p) => parseInt(p.season)),
    ]);

    await client.query("DELETE FROM draft_picks WHERE league_id = $1", [
      leagueId,
    ]);

    // Generate all picks for every relevant season — every team owns their own by default
    for (const season of seasons) {
      for (const roster of rosters) {
        for (let round = 1; round <= draftRounds; round++) {
          await client.query(
            `INSERT INTO draft_picks (league_id, season, round, original_roster_id, current_roster_id)
             VALUES ($1, $2, $3, $4, $4)
             ON CONFLICT (league_id, season, round, original_roster_id) DO NOTHING`,
            [leagueId, season, round, roster.roster_id],
          );
        }
      }
    }

    // Apply trades — roster_id = original owner, owner_id = current owner
    for (const pick of tradedPicks) {
      await client.query(
        `INSERT INTO draft_picks (league_id, season, round, original_roster_id, current_roster_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (league_id, season, round, original_roster_id) DO UPDATE SET current_roster_id = $5`,
        [
          leagueId,
          parseInt(pick.season),
          pick.round,
          pick.roster_id,
          pick.owner_id,
        ],
      );
    }

    console.log(`League sync complete.`);
  } catch (err) {
    console.error("League sync failed:", err);
    throw err;
  } finally {
    client.release();
  }
}

function startCronJobs() {
  const leagueId = process.env.LEAGUE_ID;

  // Daily midnight — keep rosters/picks fresh
  // cron.schedule("0 0 * * *", async () => {
  //   console.log("[cron] Running nightly league sync...");
  //   try {
  //     await syncLeague(leagueId);
  //     await sendGroupMe("Nightly league sync complete.");
  //   } catch (err) {
  //     console.error("[cron] League sync error:", err);
  //     await sendGroupMe(`Nightly league sync FAILED: ${err.message}`);
  //   }
  // });

  // Daily 6am — update player stats, NFL players, and KTC values
  cron.schedule("0 6 * * *", async () => {
    console.log("[cron] Running daily player update...");
    const failures = [];
    try {
      await updatePlayerStats();
    } catch (err) {
      console.error("[cron] updatePlayerStats failed:", err);
      failures.push(`Stats: ${err.message}`);
    }
    try {
      await updateNflPlayers();
    } catch (err) {
      console.error("[cron] updateNflPlayers failed:", err);
      failures.push(`NFL Players: ${err.message}`);
    }
    try {
      await runKtcScraper();
    } catch (err) {
      console.error("[cron] KTC scraper failed:", err);
      failures.push(`KTC: ${err.message}`);
    }
    try {
      await runKeeperModel();
    } catch (err) {
      console.warn("[cron] Keeper model failed:", err.message);
      failures.push(`Keeper Model: ${err.message}`);
    }
    if (failures.length === 0) {
      await sendGroupMe("Daily player update complete (stats, players, KTC, keeper values).");
    } else {
      await sendGroupMe(`Daily update partial failure:\n${failures.join("\n")}`);
    }
  });

  console.log("Cron jobs scheduled.");
}

export { updateNflPlayers, updatePlayerStats, syncLeague, startCronJobs };
