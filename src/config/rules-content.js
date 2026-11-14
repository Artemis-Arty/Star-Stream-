"use strict";

/**
 * Official Star Stream rules content for #rules and /rules.
 *
 * This is plain data so staff can update wording without touching bot code.
 * Every fact below is taken from the approved specification; edit freely.
 *
 * Structure: sections[{ id, title, lines: ["...", ...] }]
 */

const RULES_SECTIONS = [
  {
    id: "overview",
    title: "📜 Section 1 - What is Star Stream?",
    lines: [
      "Star Stream is the competitive arena of this server, inspired by Omniscient Reader's Viewpoint.",
      "Unranked members are Challengers. The holders of the seven Constellation thrones are the Constellations.",
      "Challenge, fight, win - and take a throne for yourself.",
      "All matches are supervised and verified by staff.",
    ],
  },
  {
    id: "arena_days",
    title: "🗓️ Section 2 - Arena Days",
    lines: [
      "Challenges can only be issued on Arena Days: Monday, Wednesday and Saturday.",
      "The Arena Day is determined by the server's configured timezone.",
      "A Constellation who loses their throne must wait until the next Arena Day before challenging another throne.",
    ],
  },
  {
    id: "challenges",
    title: "⚔️ Section 3 - Challenges",
    lines: [
      "Use /challenge @Constellation to challenge a throne.",
      "The Constellation has 4 hours to Accept or Refuse. This is a response window, not a cooldown.",
      "You can challenge each unique Constellation only once per Arena Day.",
      "If a Constellation refuses, your chance against that Constellation is consumed for the day - but you may still challenge others.",
      "Every refusal adds to the Constellation's refusal counter (displayed as Refusals: x/3).",
      "After three refusals, the fourth challenge MUST be accepted: refusing or ignoring it costs the Constellation its role.",
      "A Constellation can only be challenged by one Challenger at a time.",
    ],
  },
  {
    id: "matches",
    title: "🎮 Section 4 - Matches",
    lines: [
      "Players have 15 minutes to agree on any mutually accepted 1v1 game or bot",
      "(examples: Free Fire, PUBG, Chess, OwO Battle, Rock-Paper-Scissors).",
      "If no game is agreed in time, the neutral default applies:",
      "3 rounds of OwO Battle, or 3 rounds of Rock-Paper-Scissors. No stalling.",
      "Every match has at least 3 rounds. A standard multi-round format (e.g. a 7-round Free Fire match) counts as one match.",
      "Both players submit screenshot evidence. Staff verify the evidence before any result is recorded.",
      "The bot never declares a winner from an unverified claim.",
      "If the Challenger abandons the match, the Challenger automatically loses and the Constellation gains a defense.",
    ],
  },
  {
    id: "thrones",
    title: "👑 Section 5 - Thrones and outcomes",
    lines: [
      "Challenger defeats Constellation - the Challenger chooses:",
      "  • Accept throne: become the new Constellation (your Kill streak resets).",
      "  • Kill: gain +1 Kill, the defeated Constellation loses the role and the seat becomes vacant.",
      "Constellation defeats Constellation - the winner chooses:",
      "  • Swap: take the defeated Constellation's throne.",
      "  • Subdue: keep your throne and gain +1 Subdued.",
      "In every case the winner receives the defeated Constellation's bounty, which then resets to zero.",
    ],
  },
  {
    id: "role_collection",
    title: "🌟 Section 6 - Role Collection",
    lines: [
      "When a throne becomes vacant, a Role Collection opens in #alerts for 4 hours.",
      "Only unranked members may join, using the Join Role Collection button - never by typing a command.",
      "The first two eligible members enter. They compete in a staff-supervised match for the seat.",
      "If only one member joins, they receive the role automatically. If nobody joins, the collection reopens on the next Arena Day.",
    ],
  },
  {
    id: "rewards",
    title: "💰 Section 7 - Rewards",
    lines: [
      "Bounty: a throne's bounty grows by 10,000 EXP every 14 days of reign (14d = 10,000, 28d = 20,000, 42d = 30,000...).",
      "The bounty goes to whoever defeats that Constellation.",
      "Defense rewards: every 3 successful throne defenses grant 2,500 Tatsu EXP.",
      "Only one defense against the same player every 3 days counts toward the reward streak.",
      "Losing your throne resets the active reward streak (your permanent Subdued total remains).",
      "Rewards are recorded by the bot; staff grant the Tatsu EXP.",
    ],
  },
  {
    id: "records",
    title: "📚 Section 8 - Records",
    lines: [
      "Battle history, achievements and titles are permanent - they never disappear.",
      "Lifetime statistics (Kills, Subdued, matches) are kept forever.",
      "Leaderboards rank lifetime Kills and Subdued.",
      "Staff audit logs record every administrative action with reason and previous/new values.",
    ],
  },
];

module.exports = { RULES_SECTIONS };
