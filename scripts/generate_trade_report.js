#!/usr/bin/env node
/**
 * Generate BFB Trade Report from recommended trades logic.
 * Reuses the same DB/utility functions as tradeController.js.
 * Output is formatted for GroupMe (short names, no KV, compact lines).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getRostersWithOwners, getSkillPlayersByIds, getDraftPicksByLeague } from "../db.js";
import { getPickValue, calculateTradeValue } from "../utils/calculations.js";
import { getPickSlotMap } from "../utils/pickSlots.js";
import { enrichPlayers, getKeeperWorthyIds, fetchSleeperKeepers } from "../utils/league.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "output");
const REPORT_PATH = path.join(OUTPUT_DIR, "trade_report.txt");

const LEAGUE_ID = process.env.LEAGUE_ID || "1312089696964202496";
const KEEPER_SLOTS = 8;
const KEEPER_PICK_DISCOUNT = 0.80;
const STARTER_COUNTS = { QB: 1, RB: 2, WR: 3, TE: 1 };

// ── Helpers ──

function shortName(fullName) {
  if (!fullName) return "???";
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return fullName;
  const last = parts.slice(1).join(" ");
  return `${parts[0][0]}. ${last}`;
}

function computeFairness(aValues, aPickVal, bAssetCount, bValues, bPickVal, aAssetCount) {
  const aSide = calculateTradeValue(aValues, aPickVal, bAssetCount);
  const bSide = calculateTradeValue(bValues, bPickVal, aAssetCount);
  const total = aSide.total + bSide.total || 1;
  return Math.round((aSide.total / total) * 100);
}

function formatPlayer(p) {
  return {
    id: p.id,
    full_name: p.full_name || p.player_name || "Unknown",
    position: p.position,
    bfbValue: p.bfbValue ?? 0,
  };
}

function buildTeamAnalysis(rosters, playerMap, keeperWorthyIds, sleeperKeepers = {}) {
  return rosters.map((roster) => {
    const rosterPlayers = (roster.player_ids ?? [])
      .map((id) => playerMap[id])
      .filter(Boolean)
      .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));

    const setKeeperIds = sleeperKeepers[roster.roster_id];
    let keeperWorthy, surplus;

    const resolvedKeepers = setKeeperIds
      ? setKeeperIds.map((id) => playerMap[id]).filter(Boolean)
      : [];

    if (resolvedKeepers.length >= KEEPER_SLOTS) {
      keeperWorthy = resolvedKeepers
        .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0))
        .slice(0, KEEPER_SLOTS);
      const keeperIdSet = new Set(keeperWorthy.map((p) => p.id));
      const worstKeeperVal = keeperWorthy[keeperWorthy.length - 1]?.bfbValue ?? 0;
      surplus = rosterPlayers
        .filter((p) => !keeperIdSet.has(p.id) && keeperWorthyIds.has(p.id) && (p.bfbValue ?? 0) < worstKeeperVal * 0.95);
    } else {
      const allKW = rosterPlayers.filter((p) => keeperWorthyIds.has(p.id));
      keeperWorthy = allKW.slice(0, KEEPER_SLOTS);
      const projIds = new Set(keeperWorthy.map((p) => p.id));
      const worstKeeperVal = keeperWorthy[keeperWorthy.length - 1]?.bfbValue ?? 0;
      surplus = rosterPlayers
        .filter((p) => !projIds.has(p.id) && keeperWorthyIds.has(p.id) && (p.bfbValue ?? 0) < worstKeeperVal * 0.95);
    }

    const byPos = {};
    for (const pos of Object.keys(STARTER_COUNTS)) {
      byPos[pos] = keeperWorthy.filter((p) => p.position === pos);
    }
    const needs = [];
    for (const [pos, count] of Object.entries(STARTER_COUNTS)) {
      if ((byPos[pos]?.length ?? 0) < count) needs.push(pos);
    }

    return {
      roster_id: roster.roster_id,
      display_name: roster.display_name || `Team ${roster.roster_id}`,
      players: rosterPlayers,
      keeperWorthy,
      surplus,
      needs,
      byPos,
    };
  });
}

function tradeImprovesTeam(team, give, incoming) {
  const giveArr = Array.isArray(give) ? give : [give];
  const incomingArr = Array.isArray(incoming) ? incoming : [incoming];
  const giveIds = new Set(giveArr.map((p) => p.id));
  const remaining = team.players
    .filter((p) => !giveIds.has(p.id))
    .concat(incomingArr)
    .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));
  const newTop8 = remaining.slice(0, KEEPER_SLOTS).reduce((s, p) => s + (p.bfbValue ?? 0), 0);
  const oldTop8 = [...team.players]
    .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0))
    .slice(0, KEEPER_SLOTS)
    .reduce((s, p) => s + (p.bfbValue ?? 0), 0);
  return newTop8 >= oldTop8;
}

// ── Main ──

export async function generateTradeReport() {
  const year = new Date().getFullYear();

  // 1. Load data
  const rosters = await getRostersWithOwners(LEAGUE_ID);
  const allPlayerIds = [...new Set(rosters.flatMap((r) => r.player_ids ?? []))];
  const players = await getSkillPlayersByIds(allPlayerIds, year);
  const { withValues, playerMap } = enrichPlayers(players);

  const sleeperKeepers = await fetchSleeperKeepers(LEAGUE_ID);
  const keeperWorthyIds = getKeeperWorthyIds(withValues);
  const teams = buildTeamAnalysis(rosters, playerMap, keeperWorthyIds, sleeperKeepers);

  const sorted = [...withValues].sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));
  const replacementCost = sorted[96]?.bfbValue ?? 0;

  const [{ rosterToSlot }, draftPicks] = await Promise.all([
    getPickSlotMap(LEAGUE_ID),
    getDraftPicksByLeague(LEAGUE_ID),
  ]);

  const rawPickValue = (pick) =>
    getPickValue(pick.round, rosterToSlot[pick.original_roster_id] ?? 6, pick.season > year ? 1 : 0);
  const dealPickValue = (pick) =>
    Math.round(rawPickValue(pick) * KEEPER_PICK_DISCOUNT);

  const pickLabel = (pick) => {
    const slot = rosterToSlot[pick.original_roster_id] ?? 6;
    const yr = `'${String(pick.season).slice(2)}`;
    const slotStr = String(slot).padStart(2, "0");
    return `${yr} ${pick.round}.${slotStr}`;
  };

  // 2. Generate recommended trades for every team
  const allUpgrades = [];
  const allSurplus = [];

  for (const myTeam of teams) {
    const rosterId = myTeam.roster_id;
    const myTop8 = myTeam.keeperWorthy.slice(0, KEEPER_SLOTS);
    const myPicks = draftPicks.filter((p) => p.current_roster_id === rosterId);
    const myTradePicks = myPicks
      .filter((p) => p.round <= 3)
      .map((p) => ({ ...p, pick_value: dealPickValue(p), raw_pick_value: rawPickValue(p) }))
      .sort((a, b) => b.pick_value - a.pick_value);

    // ── Upgrades ──
    for (const myPlayer of myTop8) {
      const pos = myPlayer.position;
      const myVal = myPlayer.bfbValue ?? 0;

      for (const team of teams) {
        if (team.roster_id === rosterId) continue;

        const betterPlayers = team.players
          .filter((p) => p.position === pos && keeperWorthyIds.has(p.id) && (p.bfbValue ?? 0) > myVal * 1.15)
          .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));

        for (const target of betterPlayers) {
          const targetVal = target.bfbValue ?? 0;
          const gap = targetVal - myVal;

          let picksToInclude = [];
          let pickTotal = 0;
          for (const pick of myTradePicks) {
            if (allUpgrades.some((d) => d._pickKeys?.has(`${pick.round}-${pick.season}-${pick.original_roster_id}`))) continue;
            if (pickTotal >= gap * 1.1) break;
            picksToInclude.push(pick);
            pickTotal += pick.pick_value;
            if (picksToInclude.length >= 2) break;
          }

          if (picksToInclude.length > 0 && pickTotal >= gap * 0.4) {
            const rawPickTotal = picksToInclude.reduce((s, p) => s + p.raw_pick_value, 0);
            const fairness = computeFairness(
              [myVal], rawPickTotal, 1,
              [targetVal], 0, 1 + picksToInclude.length,
            );
            const pickKeys = new Set(picksToInclude.map((p) => `${p.round}-${p.season}-${p.original_roster_id}`));
            allUpgrades.push({
              from: myTeam.display_name,
              to: team.display_name,
              give: { player: formatPlayer(myPlayer), picks: picksToInclude },
              receive: { player: formatPlayer(target) },
              fairness,
              category: "upgrade",
              _pickKeys: pickKeys,
            });
          }
          break;
        }
      }
    }

    // ── Sell Surplus ──
    for (const surplusPlayer of myTeam.surplus) {
      const surplusVal = surplusPlayer.bfbValue ?? 0;
      const effectiveVal = Math.max(surplusVal - replacementCost, 0);

      for (const team of teams) {
        if (team.roster_id === rosterId) continue;

        const isScarcityPos = surplusPlayer.position === "QB" || surplusPlayer.position === "TE";
        const teamNeedsPos = team.needs.includes(surplusPlayer.position);
        if (isScarcityPos && !teamNeedsPos) continue;

        const teamFloor = team.keeperWorthy.length >= KEEPER_SLOTS
          ? team.keeperWorthy[KEEPER_SLOTS - 1].bfbValue ?? 0
          : 0;
        if (surplusVal <= teamFloor && team.keeperWorthy.length >= KEEPER_SLOTS) continue;

        const teamPicks = draftPicks.filter((p) => p.current_roster_id === team.roster_id);
        const teamAnchorPicks = teamPicks
          .filter((p) => p.round <= 3)
          .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
          .sort((a, b) => a.pick_value - b.pick_value);

        if (teamAnchorPicks.length === 0) continue;

        const anchor = teamAnchorPicks.find((p) => p.pick_value >= effectiveVal * 0.5)
          || teamAnchorPicks[teamAnchorPicks.length - 1];

        let givePicks = [];
        if (anchor.pick_value > effectiveVal * 1.3) {
          const myLatePicks = myPicks
            .filter((p) => p.round >= 4)
            .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
            .sort((a, b) => a.pick_value - b.pick_value);
          const overshoot = anchor.pick_value - effectiveVal;
          const balancePick = myLatePicks.find((p) => p.pick_value >= overshoot * 0.5 && p.pick_value <= overshoot * 1.5);
          if (balancePick) givePicks.push(balancePick);
        }

        if (anchor.pick_value >= effectiveVal * 0.5) {
          const fairness = computeFairness(
            [surplusVal], givePicks.reduce((s, p) => s + rawPickValue(p), 0), 1,
            [], anchor.pick_value, 1 + givePicks.length,
          );

          allSurplus.push({
            from: myTeam.display_name,
            to: team.display_name,
            give: { player: formatPlayer(surplusPlayer), picks: givePicks },
            receive: { picks: [anchor] },
            fairness,
            needsPos: teamNeedsPos,
            category: "surplus",
          });
        }
      }
    }
  }

  // 3. Rank and deduplicate
  allUpgrades.sort((a, b) => Math.abs(a.fairness - 50) - Math.abs(b.fairness - 50));
  allSurplus.sort((a, b) => {
    if (a.needsPos !== b.needsPos) return a.needsPos ? -1 : 1;
    return Math.abs(a.fairness - 50) - Math.abs(b.fairness - 50);
  });

  // Dedup upgrades: unique player pairs
  const seenUpgrades = new Set();
  const topUpgrades = [];
  for (const deal of allUpgrades) {
    const key = `${deal.give.player.id}-${deal.receive.player.id}`;
    const reverseKey = `${deal.receive.player.id}-${deal.give.player.id}`;
    if (seenUpgrades.has(key) || seenUpgrades.has(reverseKey)) continue;
    seenUpgrades.add(key);
    topUpgrades.push(deal);
    if (topUpgrades.length >= 4) break;
  }

  // Dedup surplus: no repeated players
  const usedPlayers = new Set();
  const topSurplus = [];
  for (const deal of allSurplus) {
    if (usedPlayers.has(deal.give.player.id)) continue;
    usedPlayers.add(deal.give.player.id);
    topSurplus.push(deal);
    if (topSurplus.length >= 4) break;
  }

  // 4. Format report
  const lines = [];
  const w = (line) => lines.push(line);

  w("RECOMMENDED TRADES");
  w("");

  if (topUpgrades.length > 0) {
    for (const deal of topUpgrades) {
      w(`${deal.from} sends:`);
      w(`  ${shortName(deal.give.player.full_name)} (${deal.give.player.position})`);
      for (const pick of deal.give.picks) w(`  ${pickLabel(pick)}`);
      w(`${deal.to} sends:`);
      w(`  ${shortName(deal.receive.player.full_name)} (${deal.receive.player.position})`);
      w("----------");
    }
  } else {
    w("  No upgrade trades found.");
    w("");
  }

  w("");
  w("SURPLUS DEALS");
  w("");

  if (topSurplus.length > 0) {
    for (const deal of topSurplus) {
      w(`${deal.from} sends:`);
      w(`  ${shortName(deal.give.player.full_name)} (${deal.give.player.position})`);
      for (const pick of deal.give.picks) w(`  ${pickLabel(pick)}`);
      w(`${deal.to} sends:`);
      for (const pick of deal.receive.picks) w(`  ${pickLabel(pick)}`);
      w("----------");
    }
  } else {
    w("  No surplus deals found.");
    w("");
  }

  const report = lines.join("\n") + "\n";

  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, report);
  console.log(`Trade report saved to ${REPORT_PATH}`);
  return report;
}

// Allow running directly: node scripts/generate_trade_report.js
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  generateTradeReport()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
