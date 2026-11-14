"use strict";

/**
 * /help - clean help interface with button navigation between categories:
 * Member Commands | Constellation Information | Staff Commands.
 * Only commands the user is authorized to use are listed.
 */

const { SlashCommandBuilder } = require("discord.js");
const { baseEmbed, COLORS } = require("../../utils/embeds");
const { paginate } = require("../../utils/pagination");
const { getAuthorizedKeys } = require("../../systems/permissions");

function usageFor(command) {
  const json = command.data.toJSON();
  const options = json.options || [];
  if (options.length === 0) return `/${json.name}`;
  const parts = options.map((opt) => (opt.required ? `<${opt.name}>` : `[${opt.name}]`));
  return `/${json.name} ${parts.join(" ")}`;
}

function memberPage(commands) {
  const embed = baseEmbed({ color: COLORS.gold }).setTitle("📖 Member Commands");
  const lines = [...commands.values()]
    .sort((a, b) => a.data.name.localeCompare(b.data.name))
    .map((cmd) => `**${usageFor(cmd)}**\n${cmd.data.description}`);
  embed.setDescription(
    lines.length ? lines.join("\n\n") : "*No member commands are registered yet.*"
  );
  return embed;
}

function constellationInfoPage() {
  return baseEmbed({ color: COLORS.gold })
    .setTitle("🌌 Constellation Information")
    .addFields(
      {
        name: "What is a Constellation?",
        value:
          "Constellations are the seven original thrones (plus future custom seats). " +
          "Each seat has an official modifier role name that the bot never renames.",
      },
      {
        name: "How to take a throne",
        value:
          "Challenge a holder with `/challenge` on an Arena Day (Mon/Wed/Sat). Win the " +
          "staff-supervised match, then choose **Accept throne** (become the Constellation) " +
          "or **Kill** (+1 Kill, seat becomes vacant).",
      },
      {
        name: "Vacant thrones",
        value:
          "A Role Collection opens in `#alerts` for 4 hours — the first two unranked members " +
          "to press the button compete in a staff-supervised match for the seat. A single " +
          "entrant receives the role automatically; if nobody joins, it reopens on the next " +
          "Arena Day.",
      },
      {
        name: "Bounties",
        value:
          "A throne's bounty grows by 10,000 EXP every 14 days of reign and goes to whoever " +
          "defeats that Constellation. See `/bounty`.",
      },
      {
        name: "Refusals",
        value:
          "Each refusal or timeout adds to the holder's counter (`x/3`). After three, the " +
          "fourth challenge must be accepted or the role is lost.",
      },
      {
        name: "Useful commands",
        value: "`/thrones` • `/bounty` • `/challenge` • `/profile` • `/stats` • `/history`",
      }
    );
}

async function staffPage(commands, member) {
  const embed = baseEmbed({ color: COLORS.dim }).setTitle("🛠️ Staff Commands");
  const authorized = await getAuthorizedKeys(member);

  const visible = [...commands.values()]
    .filter((cmd) => !cmd.permission || authorized.has(cmd.permission))
    .sort((a, b) => a.data.name.localeCompare(b.data.name));

  if (visible.length === 0) {
    embed.setDescription(
      authorized.size === 0
        ? "*You do not have staff access. Server administrators grant roles through `/starstream-config`.*"
        : "*No staff commands are registered yet.*"
    );
    return embed;
  }

  const lines = visible.map(
    (cmd) => `**${usageFor(cmd)}**\n${cmd.data.description}`
  );
  embed.setDescription(lines.join("\n\n"));
  return embed;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show the Star Stream command help (authorized commands only)"),

  async execute(interaction, ctx) {
    const { client } = ctx;
    const member = interaction.member;

    const staffEmbed = await staffPage(
      new Map([...client.commands].filter(([, cmd]) => cmd.category === "staff")),
      member
    );

    const pages = [
      () =>
        memberPage(
          new Map([...client.commands].filter(([, cmd]) => cmd.category === "member"))
        ),
      () => constellationInfoPage(),
      () => staffEmbed,
    ];

    await paginate(interaction, pages, { prefix: `help:${interaction.id}` });
  },
};
