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
import { getPickValue, applyConsolidationDiscount, getPackageTax } from "../utils/calculations.js";
import { getPickSlotMap } from "../utils/pickSlots.js";
import { enrichPlayers, getKeeperWorthyIds, fetchSleeperKeepers } from "../utils/league.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "output");
const REPORT_PATH = path.join(OUTPUT_DIR, "trade_report.txt");

const LEAGUE_ID = process.env.LEAGUE_ID || "1312089696964202496";
const KEEPER_SLOTS = 8;
const STARTER_COUNTS = { QB: 1, RB: 2, WR: 3, TE: 1 };

// ── Helpers ──

function shortName(fullName) {
  if (!fullName) return "???";
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return fullName;
  const last = parts.slice(1).join(" ");
  return `${parts[0][0]}. ${last}`;
}

function computeRawFairness(aValues, aPickVal, bValues, bPickVal, aPickCount = 0, bPickCount = 0) {
  let aTotal = aValues.reduce((s, v) => s + v, 0) + aPickVal;
  let bTotal = bValues.reduce((s, v) => s + v, 0) + bPickVal;
  const aAssets = aValues.length + aPickCount;
  const bAssets = bValues.length + bPickCount;
  const taxRate = getPackageTax(aAssets - bAssets);
  if (aAssets > bAssets) aTotal *= 1 - taxRate;
  else if (bAssets > aAssets) bTotal *= 1 - taxRate;
  const total = aTotal + bTotal || 1;
  return Math.round((aTotal / total) * 100);
}

// Pick value required to bridge a value gap after package tax is applied to
// the heavier side. Tax depends on asset-count difference between sides.
//   (myVal + picks) * (1 - tax) = targetVal  →  picks = targetVal / (1 - tax) - myVal
function taxedGapForPickCount(myVal, targetVal, givePickCount, receivePickCount = 0) {
  const aAssets = 1 + givePickCount;        // myTeam: 1 player + N picks
  const bAssets = 1 + receivePickCount;     // targetTeam: 1 player + M picks
  const tax = getPackageTax(aAssets - bAssets);
  return targetVal / (1 - tax) - myVal;
}

function formatPlayer(p) {
  return {
    id: p.id,
    full_name: p.full_name || p.player_name || "Unknown",
    position: p.position,
    bfbValue: p.bfbValue ?? 0,
    age: p.age ?? null,
  };
}

function buildTeamAnalysis(rosters, playerMap, keeperWorthyIds, sleeperKeepers = {}, surplusPoolIds = keeperWorthyIds) {
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
        .filter((p) => !keeperIdSet.has(p.id) && surplusPoolIds.has(p.id) && (p.bfbValue ?? 0) < worstKeeperVal * 0.95);
    } else {
      const allKW = rosterPlayers.filter((p) => keeperWorthyIds.has(p.id));
      keeperWorthy = allKW.slice(0, KEEPER_SLOTS);
      const projIds = new Set(keeperWorthy.map((p) => p.id));
      const worstKeeperVal = keeperWorthy[keeperWorthy.length - 1]?.bfbValue ?? 0;
      surplus = rosterPlayers
        .filter((p) => !projIds.has(p.id) && surplusPoolIds.has(p.id) && (p.bfbValue ?? 0) < worstKeeperVal * 0.95);
    }

    const byPos = {};
    for (const pos of Object.keys(STARTER_COUNTS)) {
      byPos[pos] = keeperWorthy.filter((p) => p.position === pos);
    }

    // Tiered needs: criticalNeeds (no starter), upgradeNeeds (below-average starters)
    const allKeeperWorthyForMedian = [...keeperWorthyIds].map((id) => playerMap[id]).filter(Boolean)
      .sort((a, b) => (b.bfbValue ?? 0) - (a.bfbValue ?? 0));
    const globalMedianVal = allKeeperWorthyForMedian.length > 0
      ? (allKeeperWorthyForMedian[Math.floor(allKeeperWorthyForMedian.length / 2)]?.bfbValue ?? 0)
      : 0;

    const criticalNeeds = [];
    const upgradeNeeds = [];
    for (const [pos, count] of Object.entries(STARTER_COUNTS)) {
      const posPlayers = byPos[pos] ?? [];
      if (posPlayers.length === 0 || posPlayers.length < count) {
        criticalNeeds.push(pos);
      } else {
        const posAvg = posPlayers.reduce((s, p) => s + (p.bfbValue ?? 0), 0) / posPlayers.length;
        if (posAvg < globalMedianVal * 0.85) upgradeNeeds.push(pos);
      }
    }
    const needs = [...new Set([...criticalNeeds, ...upgradeNeeds])];

    // Team mode from win record
    const wins = roster.wins ?? 0;
    const teamMode = wins >= 6 ? "contend" : wins < 4 ? "rebuild" : "neutral";

    return {
      roster_id: roster.roster_id,
      display_name: roster.display_name || `Team ${roster.roster_id}`,
      players: rosterPlayers,
      keeperWorthy,
      surplus,
      needs,
      criticalNeeds,
      upgradeNeeds,
      teamMode,
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
  const keeperWorthyIds = getKeeperWorthyIds(withValues);          // top 96 — keeper eligibility
  const surplusPoolIds = getKeeperWorthyIds(withValues, 120);      // top 120 — surplus candidates
  const teams = buildTeamAnalysis(rosters, playerMap, keeperWorthyIds, sleeperKeepers, surplusPoolIds);

  const [{ rosterToSlot }, draftPicks] = await Promise.all([
    getPickSlotMap(LEAGUE_ID),
    getDraftPicksByLeague(LEAGUE_ID),
  ]);

  const rawPickValue = (pick) =>
    getPickValue(pick.round, rosterToSlot[pick.original_roster_id] ?? 6, pick.season > year ? 1 : 0);

  const pickLabel = (pick) => {
    const slot = rosterToSlot[pick.original_roster_id] ?? 6;
    const yr = `'${String(pick.season).slice(2)}`;
    const slotStr = String(slot).padStart(2, "0");
    const tier =
      pick.round === 1 && slot <= 3 ? " [elite]" :
      pick.round === 1 && slot <= 6 ? " [top-half]" :
      pick.round === 2 && slot <= 4 ? " [early-2nd]" :
      pick.round === 2 ? " [2nd]" :
      pick.round === 3 ? " [3rd]" : "";
    return `${yr} ${pick.round}.${slotStr}${tier}`;
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
      .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
      .sort((a, b) => b.pick_value - a.pick_value);

    // ── Upgrades ──
    const usedUpgradePickKeys = new Set(
      allUpgrades.flatMap((d) => [...(d._pickKeys ?? [])]),
    );

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

          // Hard skip: never recommend acquiring a player 6+ years older.
          // Use real age from keeper_values.csv when available; fall back to years_exp.
          const myAge = myPlayer.age ?? (myPlayer.years_exp != null ? 22 + myPlayer.years_exp : 27);
          const targetAge = target.age ?? (target.years_exp != null ? 22 + target.years_exp : 27);
          const ageDiff = targetAge - myAge;  // positive = target is older
          if (ageDiff >= 6) break;

          // Tiered age penalty: acquiring an older player reduces their effective value;
          // acquiring a younger one increases it.
          let ageFactor = 1.0;
          if (ageDiff >= 5)       ageFactor = 0.75;
          else if (ageDiff >= 3)  ageFactor = 0.85;
          else if (ageDiff <= -2) ageFactor = 1.10;
          const adjustedTargetVal = Math.round(targetVal * ageFactor);

          // Hard floor: the sending player must be worth at least 58% of the
          // target's adjusted value.  Below this ratio the pick package needed
          // to bridge the gap is so large that the "upgrade" framing becomes
          // misleading — it's really a sell, not an upgrade trade.
          // 58% means: CeeDee (0.494) requires sender >= 0.287 (Breece Hall tier);
          //            Kyren  (0.473) requires sender >= 0.274 (Skattebo tier).
          // Egbuka (0.264) / CeeDee (0.494) = 0.53 → filtered out.
          // Chase Brown (0.370) / CeeDee (0.494) = 0.75 → passes, valid trade.
          const VALUE_GAP_FLOOR = 0.58;
          if (myVal < adjustedTargetVal * VALUE_GAP_FLOOR) continue;

          const gap = adjustedTargetVal - myVal;

          // Other team's late picks for "change back"
          const theirLatePicks = draftPicks
            .filter((p) => p.current_roster_id === team.roster_id && p.round >= 3)
            .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
            .sort((a, b) => a.pick_value - b.pick_value);

          // Pick quality gate: for large value gaps (target > 130% of sender),
          // require at least one Round 1 or Round 2 pick to be available.
          // Prevents depth-pick stacks (3rd + 4th + 5th) from closing elite gaps —
          // that's not a real trade, it's a loophole in the pick-strategy logic.
          const isLargeGap = adjustedTargetVal > myVal * 1.30;
          if (isLargeGap) {
            const hasQualityPick = myTradePicks.some(
              (p) =>
                !usedUpgradePickKeys.has(`${p.round}-${p.season}-${p.original_roster_id}`) &&
                p.round <= 2,
            );
            if (!hasQualityPick) continue;
          }

          // Strategy 1: single anchor pick (asset_diff = +1 for myTeam → 10% tax).
          // Anchor must bridge the tax-grossed gap, widened to 70%-140%.
          const available = myTradePicks.filter(
            (p) => !usedUpgradePickKeys.has(`${p.round}-${p.season}-${p.original_roster_id}`),
          );
          let givePicks = [];
          let receivePicks = [];

          const gap1 = taxedGapForPickCount(myVal, adjustedTargetVal, 1, 0);
          const anchor = available.find((p) => p.pick_value >= gap1 * 0.7 && p.pick_value <= gap1 * 1.4);
          if (anchor) {
            givePicks = [anchor];
          } else {
            // Strategy 2: overshooter + change back (1+1 vs 1+1 → asset_diff = 0, no tax)
            const overshooter = available.find((p) => p.pick_value > gap * 1.4 && p.pick_value <= gap * 2.5);
            if (overshooter && theirLatePicks.length > 0) {
              const overshoot = overshooter.pick_value - gap;
              const changePick = theirLatePicks.find(
                (p) => p.pick_value >= overshoot * 0.4 && p.pick_value <= overshoot * 1.5,
              );
              if (changePick) {
                givePicks = [overshooter];
                receivePicks = [changePick];
              }
            }
            // Strategy 3: greedy fill with consolidation penalty + per-count tax (up to 3 picks)
            if (givePicks.length === 0) {
              let pickTotal = 0;
              const trial = [];
              for (const pick of available) {
                trial.push(pick);
                pickTotal += pick.pick_value;
                const count = trial.length;
                const gapTaxed = taxedGapForPickCount(myVal, adjustedTargetVal, count, 0);
                const discounted = applyConsolidationDiscount(pickTotal, count);
                if (discounted >= gapTaxed * 0.5 && discounted <= gapTaxed * 1.4) {
                  givePicks = [...trial];
                  break;
                }
                if (count >= 3) break;
              }
            }
          }

          if (givePicks.length > 0) {
            const givePickTotal = givePicks.reduce((s, p) => s + p.pick_value, 0);
            const receivePickTotal = receivePicks.reduce((s, p) => s + p.pick_value, 0);

            const fairness = computeRawFairness(
              [myVal], givePickTotal,
              [adjustedTargetVal], receivePickTotal,
              givePicks.length, receivePicks.length,
            );
            const pickKeys = new Set(givePicks.map((p) => `${p.round}-${p.season}-${p.original_roster_id}`));
            for (const k of pickKeys) usedUpgradePickKeys.add(k);
            allUpgrades.push({
              from: myTeam.display_name,
              to: team.display_name,
              give: { player: formatPlayer(myPlayer), picks: givePicks },
              receive: { player: formatPlayer(target), picks: receivePicks },
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

      for (const team of teams) {
        if (team.roster_id === rosterId) continue;

        const isScarcityPos = surplusPlayer.position === "QB" || surplusPlayer.position === "TE";
        const teamNeedsPos = team.needs.includes(surplusPlayer.position);
        if (isScarcityPos && !teamNeedsPos) continue;

        const teamFloor = team.keeperWorthy.length >= KEEPER_SLOTS
          ? team.keeperWorthy[KEEPER_SLOTS - 1].bfbValue ?? 0
          : 0;
        if (surplusVal <= teamFloor && team.keeperWorthy.length >= KEEPER_SLOTS) continue;

        // effectiveVal = net gain for the buyer: player value minus who they'd have to drop.
        // Floor at 25% of the player's raw value so that a stacked buying team
        // can't reduce a real starter's price to near-zero. Even if both teams
        // are deep (small marginal gap), a starter-caliber player should command
        // at minimum a late 3rd round pick rather than late-round picks.
        const effectiveVal = Math.max(surplusVal - teamFloor, surplusVal * 0.25);
        if (effectiveVal <= 0) continue;

        const teamPicks = draftPicks.filter((p) => p.current_roster_id === team.roster_id);
        // Surplus deals are paid in R3-R5 picks only — 2nd rounders are too valuable to
        // spend on a borderline surplus player. Teams without R3-R5 picks are skipped.
        const teamAnchorPicks = teamPicks
          .filter((p) => p.round >= 3 && p.round <= 5)
          .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
          .sort((a, b) => a.pick_value - b.pick_value);

        if (teamAnchorPicks.length === 0) continue;

        // Apply a seller's discount: surplus players trade at a haircut because the
        // seller is motivated and the buyer is taking on marginal roster risk.
        // 15% discount (was 25%) — prior haircut produced steals for buyers.
        const pickTargetVal = Math.round(effectiveVal * 0.85);

        // Find the highest-valued pick that doesn't exceed the discounted target.
        const belowPicks = teamAnchorPicks.filter((p) => p.pick_value <= pickTargetVal);
        const anchor = belowPicks.length > 0
          ? belowPicks[belowPicks.length - 1]
          : teamAnchorPicks[0];

        let givePicks = [];
        if (anchor.pick_value > pickTargetVal * 1.3) {
          const myLatePicks = myPicks
            .filter((p) => p.round >= 4)
            .map((p) => ({ ...p, pick_value: rawPickValue(p) }))
            .sort((a, b) => a.pick_value - b.pick_value);
          const overshoot = anchor.pick_value - pickTargetVal;
          const balancePick = myLatePicks.find((p) => p.pick_value >= overshoot * 0.5 && p.pick_value <= overshoot * 1.5);
          if (balancePick) givePicks.push(balancePick);
        }

        if (anchor.pick_value > 0) {
          const fairness = computeRawFairness(
            [effectiveVal], givePicks.reduce((s, p) => s + rawPickValue(p), 0),
            [], anchor.pick_value,
            givePicks.length, 1,
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

  // Dedup surplus: best deal per selling team (shows breadth of who has surplus, not just best player)
  const usedSellers = new Set();
  const topSurplus = [];
  for (const deal of allSurplus) {
    if (usedSellers.has(deal.from)) continue;
    usedSellers.add(deal.from);
    topSurplus.push(deal);
    if (topSurplus.length >= 5) break;
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
      for (const pick of deal.receive.picks ?? []) w(`  ${pickLabel(pick)}`);
      w("----------");
    }
  } else {
    w("  No upgrade trades found.");
    w("");
  }

  // SURPLUS DEALS section hidden — surplus-for-late-pick deals weren't generating
  // interesting weekly content. Logic still runs above so it's easy to re-enable.

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
