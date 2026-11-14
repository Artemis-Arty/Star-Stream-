"use strict";

/**
 * The original seven Constellations.
 *
 * `modifierRoleName` is the OFFICIAL locked role name: the bot never renames
 * this role. Custom Constellations added later are recorded in the database
 * (seats table) with the same locking rule.
 *
 * This file is used to seed the database on first migration; after that the
 * `seats` table is the source of truth.
 */

const ORIGINAL_CONSTELLATIONS = [
  {
    seatId: "zeus",
    displayName: "King of Lightning",
    modifierRoleName: "Zeus",
    emoji: "⚡",
    description: "The storm-voiced ruler of the sky.",
    sortOrder: 1,
  },
  {
    seatId: "hades",
    displayName: "Father of the Rich Night",
    modifierRoleName: "Hades",
    emoji: "🌑",
    description: "Keeper of the underworld and its endless riches.",
    sortOrder: 2,
  },
  {
    seatId: "odin",
    displayName: "One-eyed Father",
    modifierRoleName: "Odin",
    emoji: "👁️",
    description: "The all-seeing wanderer who sacrificed an eye for wisdom.",
    sortOrder: 3,
  },
  {
    seatId: "sun-wukong",
    displayName: "Prisoner of the Golden Headband",
    modifierRoleName: "Sun Wukong",
    emoji: "🐵",
    description: "The bound king of monkeys, chained by heaven's decree.",
    sortOrder: 4,
  },
  {
    seatId: "surya",
    displayName: "Supreme God of Light",
    modifierRoleName: "Surya",
    emoji: "☀️",
    description: "The radiant chariot-rider who drags the sun across the sky.",
    sortOrder: 5,
  },
  {
    seatId: "abyssal-black-flame-dragon",
    displayName: "Abyssal Black Flame Dragon",
    modifierRoleName: "Abyssal Black Flame Dragon",
    emoji: "🐉",
    description: "An ancient dragon of black flame sleeping in the abyss.",
    sortOrder: 6,
  },
  {
    seatId: "uriel",
    displayName: "Demon-like Judge of Fire",
    modifierRoleName: "Uriel",
    emoji: "🔥",
    description: "The burning judge who punishes without mercy.",
    sortOrder: 7,
  },
];

module.exports = { ORIGINAL_CONSTELLATIONS };
