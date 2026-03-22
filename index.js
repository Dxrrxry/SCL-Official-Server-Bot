import {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ComponentType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  AuditLogEvent,
} from "discord.js";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

const LEAGUE_CHANNEL_ID = "1475298597028499606";
const HOST_ROLE_ID = "1460146847912952090";

// Anti-nuke thresholds — actions within WINDOW_MS trigger a lockdown
const NUKE_THRESHOLD = 3;
const NUKE_WINDOW_MS = 8000;

if (!TOKEN || !CLIENT_ID) {
  console.error("[ERROR] Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID.");
  process.exit(1);
}

// ─── DATABASE ─────────────────────────────────────────────────────────────────

const DB_PATH = path.join(__dirname, "database.json");

function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  } catch {
    return { leagues: {} };
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

function getLeague(id) {
  return loadDB().leagues[id] || null;
}

function setLeague(id, data) {
  const db = loadDB();
  db.leagues[id] = data;
  saveDB(db);
}

function updateLeague(id, updates) {
  const db = loadDB();
  if (!db.leagues[id]) return null;
  db.leagues[id] = { ...db.leagues[id], ...updates };
  saveDB(db);
  return db.leagues[id];
}

function getLeaguesByGuild(guildId) {
  return Object.values(loadDB().leagues).filter((l) => l.guildId === guildId);
}

// ─── ANTI-NUKE ────────────────────────────────────────────────────────────────
// Tracks recent destructive actions per user per guild.
// Structure: nukeTracker[guildId][userId][action] = [timestamp, ...]

const nukeTracker = {};

function trackNukeAction(guildId, userId, action) {
  if (!nukeTracker[guildId]) nukeTracker[guildId] = {};
  if (!nukeTracker[guildId][userId]) nukeTracker[guildId][userId] = {};
  if (!nukeTracker[guildId][userId][action]) nukeTracker[guildId][userId][action] = [];

  const now = Date.now();
  // Remove stale entries outside the window
  nukeTracker[guildId][userId][action] = nukeTracker[guildId][userId][action].filter(
    (t) => now - t < NUKE_WINDOW_MS
  );
  nukeTracker[guildId][userId][action].push(now);

  return nukeTracker[guildId][userId][action].length;
}

function clearNukeTracker(guildId, userId) {
  if (nukeTracker[guildId]) delete nukeTracker[guildId][userId];
}

async function handleNukeDetected(guild, userId, action) {
  console.log(`[anti-nuke] Triggered for user ${userId} in guild ${guild.id} — action: ${action}`);

  // Attempt to ban the perpetrator
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member && member.bannable) {
      await guild.members.ban(userId, {
        reason: `[Anti-Nuke] Detected mass ${action} (auto-ban)`,
        deleteMessageSeconds: 0,
      });
      console.log(`[anti-nuke] Banned ${userId} from ${guild.id}`);
    }
  } catch (err) {
    console.error("[anti-nuke] Could not ban perpetrator:", err.message);
  }

  // DM the guild owner
  try {
    const owner = await guild.fetchOwner();
    await owner.user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚠️ Anti-Nuke Triggered")
          .setColor(0xed4245)
          .setDescription(
            `A potential nuke attack was detected in **${guild.name}**.\n\n` +
            `**Action:** ${action}\n` +
            `**Perpetrator:** <@${userId}> (\`${userId}\`)\n\n` +
            `The user has been automatically banned.`
          )
          .setTimestamp(),
      ],
    });
  } catch (_) {}

  clearNukeTracker(guild.id, userId);
}

async function getAuditExecutor(guild, auditLogEvent, targetId) {
  try {
    await new Promise((r) => setTimeout(r, 1000)); // brief delay for audit log propagation
    const logs = await guild.fetchAuditLogs({ type: auditLogEvent, limit: 5 });
    const entry = logs.entries.find((e) => {
      const matchTarget = targetId ? e.target?.id === targetId : true;
      return matchTarget && Date.now() - e.createdTimestamp < 5000;
    });
    return entry?.executor?.id || null;
  } catch {
    return null;
  }
}

// ─── UTILS ────────────────────────────────────────────────────────────────────

function generateLeagueId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function getMaxPlayers(format) {
  if (format === "2v2") return 4;
  if (format === "4v4") return 8;
  if (format === "6v6") return 12;
  return 4;
}

function formatRegion(region) {
  const map = { eu: "EU", na: "NA", sa: "SA", asia: "Asia", ocean: "Ocean" };
  return map[region] || region;
}

function formatMatchType(type) {
  return type === "swift" ? "Swift Game" : "War Game";
}

function formatPerks(perks) {
  return perks === "perks" ? "Perks" : "No Perks";
}

function buildEmbed(league) {
  const spotsLeft = league.maxPlayers - league.players.length;
  const regionDisplay = formatRegion(league.region);
  const typeDisplay = formatMatchType(league.matchType);
  const perksDisplay = formatPerks(league.perks);

  const title = `${league.matchFormat} ${typeDisplay} - ${regionDisplay} - ${perksDisplay}`;

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription("A new league has been created! Join below.")
    .setColor(0x5865f2)
    .addFields(
      { name: "Match Format", value: league.matchFormat, inline: true },
      { name: "Match Type", value: typeDisplay, inline: true },
      { name: "Perks", value: perksDisplay, inline: true },
      { name: "Region", value: regionDisplay, inline: true },
      { name: "Players", value: `${league.players.length}/${league.maxPlayers}`, inline: true },
      { name: "Spots Left", value: `${spotsLeft}`, inline: true },
      { name: "Hosted By", value: `<@${league.hostId}>`, inline: true },
      { name: "League ID", value: `\`${league.id}\``, inline: true },
      {
        name: "Status",
        value:
          league.status === "open"
            ? "Active"
            : league.status === "started"
            ? "Started"
            : "Cancelled",
        inline: true,
      },
      {
        name: "Created",
        value: `<t:${Math.floor(new Date(league.createdAt).getTime() / 1000)}:F>`,
        inline: false,
      }
    )
    .setFooter({ text: "League Bot • Multi-Server" })
    .setTimestamp();
}

// ─── REGISTER SLASH COMMANDS ──────────────────────────────────────────────────

async function registerCommands() {
  const hostLeague = new SlashCommandBuilder()
    .setName("host-league")
    .setDescription("Host a new league")
    .addStringOption((opt) =>
      opt
        .setName("match_format")
        .setDescription("Select the match format.")
        .setRequired(true)
        .addChoices(
          { name: "2v2", value: "2v2" },
          { name: "4v4", value: "4v4" },
          { name: "6v6", value: "6v6" }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("match_type")
        .setDescription("Select the match type.")
        .setRequired(true)
        .addChoices(
          { name: "Swift Game", value: "swift" },
          { name: "War Game", value: "war" }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("match_perks")
        .setDescription("Select match perks.")
        .setRequired(true)
        .addChoices(
          { name: "Perks", value: "perks" },
          { name: "No Perks", value: "no-perks" }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("region")
        .setDescription("Select your region.")
        .setRequired(true)
        .addChoices(
          { name: "EU", value: "eu" },
          { name: "NA", value: "na" },
          { name: "SA", value: "sa" },
          { name: "Asia", value: "asia" },
          { name: "Ocean", value: "ocean" }
        )
    );

  const cancelLeague = new SlashCommandBuilder()
    .setName("cancel-league")
    .setDescription("Cancel your hosted league")
    .addStringOption((opt) =>
      opt.setName("id").setDescription("The League ID to cancel").setRequired(true)
    );

  const listLeagues = new SlashCommandBuilder()
    .setName("list-leagues")
    .setDescription("List all open leagues in this server");

  const banCmd = new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a member from the server")
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption((opt) =>
      opt.setName("user").setDescription("The member to ban").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("reason").setDescription("Reason for the ban").setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName("delete_days")
        .setDescription("Days of messages to delete (0–7)")
        .setRequired(false)
        .addChoices(
          { name: "None", value: 0 },
          { name: "1 day", value: 1 },
          { name: "3 days", value: 3 },
          { name: "7 days", value: 7 }
        )
    );

  const kickCmd = new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member from the server")
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption((opt) =>
      opt.setName("user").setDescription("The member to kick").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("reason").setDescription("Reason for the kick").setRequired(false)
    );

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("[bot] Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: [
        hostLeague.toJSON(),
        cancelLeague.toJSON(),
        listLeagues.toJSON(),
        banCmd.toJSON(),
        kickCmd.toJSON(),
      ],
    });
    console.log("[bot] Slash commands registered.");
  } catch (err) {
    console.error("[bot] Failed to register commands:", err);
  }
}

// ─── /host-league ─────────────────────────────────────────────────────────────

async function handleHostLeague(interaction) {
  if (interaction.channelId !== LEAGUE_CHANNEL_ID) {
    return interaction.reply({
      content: `Leagues can only be hosted in <#${LEAGUE_CHANNEL_ID}>.`,
      ephemeral: true,
    });
  }

  const member = interaction.member;
  if (!member.roles.cache.has(HOST_ROLE_ID)) {
    return interaction.reply({
      content: `You need the required role to host a league.`,
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const matchFormat = interaction.options.getString("match_format");
  const matchType = interaction.options.getString("match_type");
  const perks = interaction.options.getString("match_perks");
  const region = interaction.options.getString("region");

  const leagueId = generateLeagueId();
  const maxPlayers = getMaxPlayers(matchFormat);

  const league = {
    id: leagueId,
    hostId: interaction.user.id,
    hostUsername: interaction.user.username,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: null,
    threadId: null,
    matchFormat,
    matchType,
    perks,
    region,
    maxPlayers,
    players: [interaction.user.id],
    status: "open",
    createdAt: new Date().toISOString(),
  };

  setLeague(leagueId, league);

  const lobbyMsg = await interaction.channel.send({
    embeds: [buildEmbed(league)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`join_${leagueId}`)
          .setLabel("Join League")
          .setStyle(ButtonStyle.Primary)
      ),
    ],
  });

  updateLeague(leagueId, { messageId: lobbyMsg.id });

  let thread = null;
  try {
    thread = await interaction.channel.threads.create({
      name: `League ${leagueId} — ${matchFormat} ${formatMatchType(matchType)}`,
      type: ChannelType.PrivateThread,
      reason: `League ${leagueId} created`,
    });
    await thread.members.add(interaction.user.id);
    await thread.send({
      content:
        `<@${interaction.user.id}> Welcome to your league thread!\n\n` +
        `**League ID:** \`${leagueId}\`\n` +
        `**Format:** ${matchFormat} — ${formatMatchType(matchType)}\n` +
        `**Perks:** ${formatPerks(perks)}\n` +
        `**Region:** ${formatRegion(region)}\n\n` +
        `Players who join will be added here automatically. Good luck!`,
    });
    updateLeague(leagueId, { threadId: thread.id });
  } catch (err) {
    console.error("[bot] Could not create private thread:", err.message);
  }

  await interaction.editReply({
    content: `League \`${leagueId}\` has been created!${thread ? ` Check <#${thread.id}> for your private thread.` : ""}`,
  });

  const joinCol = lobbyMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.customId === `join_${leagueId}`,
  });

  joinCol.on("collect", async (btnInt) => {
    const fresh = getLeague(leagueId);
    if (!fresh || fresh.status !== "open") {
      return btnInt.reply({ content: "This league is no longer open.", ephemeral: true });
    }
    if (fresh.players.includes(btnInt.user.id)) {
      return btnInt.reply({ content: "You are already in this league!", ephemeral: true });
    }
    if (fresh.players.length >= fresh.maxPlayers) {
      return btnInt.reply({ content: "This league is full!", ephemeral: true });
    }

    const updated = updateLeague(leagueId, { players: [...fresh.players, btnInt.user.id] });

    if (updated.threadId) {
      try {
        const t = await interaction.guild.channels.fetch(updated.threadId);
        if (t) await t.members.add(btnInt.user.id);
      } catch (_) {}
    }

    await btnInt.reply({
      content: `You joined league **\`${leagueId}\`**! Good luck!`,
      ephemeral: true,
    });

    const isFull = updated.players.length >= updated.maxPlayers;

    await lobbyMsg.edit({
      embeds: [buildEmbed(updated)],
      components: isFull
        ? []
        : [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`join_${leagueId}`)
                .setLabel("Join League")
                .setStyle(ButtonStyle.Primary)
            ),
          ],
    });

    if (isFull && updated.threadId) {
      try {
        const t = await interaction.guild.channels.fetch(updated.threadId);
        if (t) {
          const mentions = updated.players.map((id) => `<@${id}>`).join(", ");
          await t.send({ content: `${mentions}\n\n**The lobby is full! Get ready to play!**` });
        }
      } catch (_) {}
      joinCol.stop("full");
    }
  });
}

// ─── /cancel-league ───────────────────────────────────────────────────────────

async function handleCancelLeague(interaction) {
  const leagueId = interaction.options.getString("id").toUpperCase();
  await interaction.deferReply({ ephemeral: true });

  const league = getLeague(leagueId);
  if (!league) return interaction.editReply({ content: `No league found with ID \`${leagueId}\`.` });
  if (league.hostId !== interaction.user.id)
    return interaction.editReply({ content: `Only the host can cancel this league.` });
  if (league.status === "cancelled")
    return interaction.editReply({ content: `League \`${leagueId}\` is already cancelled.` });

  updateLeague(leagueId, { status: "cancelled" });

  if (league.messageId) {
    try {
      const msg = await interaction.channel.messages.fetch(league.messageId);
      const cancelled = getLeague(leagueId);
      await msg.edit({ embeds: [buildEmbed(cancelled)], components: [] });
    } catch (_) {}
  }

  if (league.threadId) {
    try {
      const t = await interaction.guild.channels.fetch(league.threadId);
      if (t) await t.delete(`League ${leagueId} cancelled by host`);
    } catch (_) {}
  }

  await interaction.editReply({
    content: `League \`${leagueId}\` has been cancelled and the thread has been deleted.`,
  });

  await interaction.channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("League Cancelled")
        .setColor(0xed4245)
        .setDescription(`<@${league.hostId}> has cancelled league \`${leagueId}\`.`)
        .setTimestamp(),
    ],
  });
}

// ─── /list-leagues ────────────────────────────────────────────────────────────

async function handleListLeagues(interaction) {
  await interaction.deferReply();

  const open = getLeaguesByGuild(interaction.guildId).filter((l) => l.status === "open");

  if (open.length === 0) {
    return interaction.editReply({
      content: "No open leagues right now. Use `/host-league` to start one!",
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`Open Leagues (${open.length})`)
    .setColor(0x5865f2)
    .setTimestamp();

  for (const l of open.slice(0, 10)) {
    embed.addFields({
      name: `\`${l.id}\` — ${l.matchFormat} ${formatMatchType(l.matchType)}`,
      value:
        `**Perks:** ${formatPerks(l.perks)} | **Region:** ${formatRegion(l.region)} | ` +
        `**Host:** <@${l.hostId}> | **Spots:** ${l.maxPlayers - l.players.length}/${l.maxPlayers}`,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ─── /ban ─────────────────────────────────────────────────────────────────────

async function handleBan(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser("user");
  const reason = interaction.options.getString("reason") || "No reason provided";
  const deleteDays = interaction.options.getInteger("delete_days") ?? 0;

  if (targetUser.id === interaction.user.id) {
    return interaction.editReply({ content: "You cannot ban yourself." });
  }

  const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

  if (targetMember) {
    if (!targetMember.bannable) {
      return interaction.editReply({
        content: "I don't have permission to ban that member (they may have a higher role).",
      });
    }
    if (
      interaction.member.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0 &&
      interaction.user.id !== interaction.guild.ownerId
    ) {
      return interaction.editReply({
        content: "You cannot ban someone with an equal or higher role than you.",
      });
    }

    // DM the user before banning
    try {
      await targetUser.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`You have been banned from ${interaction.guild.name}`)
            .setColor(0xed4245)
            .addFields(
              { name: "Reason", value: reason },
              { name: "Banned by", value: interaction.user.tag }
            )
            .setTimestamp(),
        ],
      });
    } catch (_) {}
  }

  try {
    await interaction.guild.members.ban(targetUser.id, {
      reason: `${reason} | Banned by ${interaction.user.tag}`,
      deleteMessageSeconds: deleteDays * 86400,
    });

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Member Banned")
          .setColor(0xed4245)
          .addFields(
            { name: "User", value: `${targetUser.tag} (\`${targetUser.id}\`)` },
            { name: "Reason", value: reason },
            { name: "Banned by", value: interaction.user.tag }
          )
          .setTimestamp(),
      ],
    });
  } catch (err) {
    await interaction.editReply({ content: `Failed to ban: ${err.message}` });
  }
}

// ─── /kick ────────────────────────────────────────────────────────────────────

async function handleKick(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const targetUser = interaction.options.getUser("user");
  const reason = interaction.options.getString("reason") || "No reason provided";

  if (targetUser.id === interaction.user.id) {
    return interaction.editReply({ content: "You cannot kick yourself." });
  }

  const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

  if (!targetMember) {
    return interaction.editReply({ content: "That user is not in this server." });
  }

  if (!targetMember.kickable) {
    return interaction.editReply({
      content: "I don't have permission to kick that member (they may have a higher role).",
    });
  }

  if (
    interaction.member.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0 &&
    interaction.user.id !== interaction.guild.ownerId
  ) {
    return interaction.editReply({
      content: "You cannot kick someone with an equal or higher role than you.",
    });
  }

  // DM the user before kicking
  try {
    await targetUser.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`You have been kicked from ${interaction.guild.name}`)
          .setColor(0xffa500)
          .addFields(
            { name: "Reason", value: reason },
            { name: "Kicked by", value: interaction.user.tag }
          )
          .setTimestamp(),
      ],
    });
  } catch (_) {}

  try {
    await targetMember.kick(`${reason} | Kicked by ${interaction.user.tag}`);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Member Kicked")
          .setColor(0xffa500)
          .addFields(
            { name: "User", value: `${targetUser.tag} (\`${targetUser.id}\`)` },
            { name: "Reason", value: reason },
            { name: "Kicked by", value: interaction.user.tag }
          )
          .setTimestamp(),
      ],
    });
  } catch (err) {
    await interaction.editReply({ content: `Failed to kick: ${err.message}` });
  }
}

// ─── CLIENT & STARTUP ─────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildMembers,
  ],
});

// ─── ANTI-NUKE LISTENERS ──────────────────────────────────────────────────────

client.on(Events.GuildBanAdd, async (ban) => {
  const guild = ban.guild;
  const executorId = await getAuditExecutor(guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  if (!executorId || executorId === client.user.id) return;

  // Skip the guild owner
  if (executorId === guild.ownerId) return;

  const count = trackNukeAction(guild.id, executorId, "ban");
  if (count >= NUKE_THRESHOLD) {
    await handleNukeDetected(guild, executorId, "banning");
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  const guild = member.guild;
  const executorId = await getAuditExecutor(guild, AuditLogEvent.MemberKick, member.id);
  if (!executorId || executorId === client.user.id) return;
  if (executorId === guild.ownerId) return;

  const count = trackNukeAction(guild.id, executorId, "kick");
  if (count >= NUKE_THRESHOLD) {
    await handleNukeDetected(guild, executorId, "kicking");
  }
});

client.on(Events.ChannelDelete, async (channel) => {
  if (!channel.guild) return;
  const guild = channel.guild;
  const executorId = await getAuditExecutor(guild, AuditLogEvent.ChannelDelete, channel.id);
  if (!executorId || executorId === client.user.id) return;
  if (executorId === guild.ownerId) return;

  const count = trackNukeAction(guild.id, executorId, "channel_delete");
  if (count >= NUKE_THRESHOLD) {
    await handleNukeDetected(guild, executorId, "deleting channels");
  }
});

client.on(Events.GuildRoleDelete, async (role) => {
  const guild = role.guild;
  const executorId = await getAuditExecutor(guild, AuditLogEvent.RoleDelete, role.id);
  if (!executorId || executorId === client.user.id) return;
  if (executorId === guild.ownerId) return;

  const count = trackNukeAction(guild.id, executorId, "role_delete");
  if (count >= NUKE_THRESHOLD) {
    await handleNukeDetected(guild, executorId, "deleting roles");
  }
});

// ─── COMMAND HANDLER ──────────────────────────────────────────────────────────

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] Online as ${c.user.tag}`);
  console.log(
    `[bot] Invite: https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&permissions=397284550672&scope=bot+applications.commands`
  );
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    if (interaction.commandName === "host-league") await handleHostLeague(interaction);
    else if (interaction.commandName === "cancel-league") await handleCancelLeague(interaction);
    else if (interaction.commandName === "list-leagues") await handleListLeagues(interaction);
    else if (interaction.commandName === "ban") await handleBan(interaction);
    else if (interaction.commandName === "kick") await handleKick(interaction);
  } catch (err) {
    console.error(`[bot] Error in /${interaction.commandName}:`, err);
    try {
      const msg = { content: "Something went wrong. Please try again.", ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.editReply(msg);
      else await interaction.reply(msg);
    } catch (_) {}
  }
});

process.on("unhandledRejection", (err) => console.error("[bot] Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("[bot] Uncaught exception:", err));

(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
