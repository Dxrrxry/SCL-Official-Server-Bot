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
const HICOM_ROLE_ID = "1474820927173689344";

// DM both of these users for anti-nuke alerts
const ALERT_USER_IDS = ["1180944141291634728", "1459790270370676798"];

// Anti-nuke thresholds
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

// ─── PROMOTIONS ───────────────────────────────────────────────────────────────

function getPromotion(id) {
  const db = loadDB();
  return (db.promotions || {})[id] || null;
}

function setPromotion(id, data) {
  const db = loadDB();
  if (!db.promotions) db.promotions = {};
  db.promotions[id] = data;
  saveDB(db);
}

function getPromotionsByGuild(guildId) {
  const db = loadDB();
  return Object.values(db.promotions || {}).filter((p) => p.guildId === guildId);
}

function generatePromotionId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "P";
  for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// ─── ANTI-NUKE ────────────────────────────────────────────────────────────────

const nukeTracker = {};
const nukeInProgress = new Set();

function trackNukeAction(guildId, userId, action) {
  if (!nukeTracker[guildId]) nukeTracker[guildId] = {};
  if (!nukeTracker[guildId][userId]) nukeTracker[guildId][userId] = {};
  if (!nukeTracker[guildId][userId][action]) nukeTracker[guildId][userId][action] = [];

  const now = Date.now();
  nukeTracker[guildId][userId][action] = nukeTracker[guildId][userId][action].filter(
    (t) => now - t < NUKE_WINDOW_MS
  );
  nukeTracker[guildId][userId][action].push(now);
  return nukeTracker[guildId][userId][action].length;
}

function clearNukeTracker(guildId, userId) {
  if (nukeTracker[guildId]) delete nukeTracker[guildId][userId];
  nukeInProgress.delete(`${guildId}:${userId}`);
}

async function dmAlertUsers(guild, userId, action) {
  const nukeKey = `${guild.id}:${userId}`;

  const embed = new EmbedBuilder()
    .setTitle("⚠️ Anti-Nuke Alert — Action Required")
    .setColor(0xffa500)
    .setDescription(
      `**Potential nuke attack detected in ${guild.name}!**\n\n` +
      `**Perpetrator:** <@${userId}> (\`${userId}\`)\n` +
      `**Action:** Mass ${action}\n\n` +
      `Should the bot **auto-ban** this user?\n` +
      `This will timeout in **60 seconds** and auto-ban if no response.`
    )
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`nuke_start_${nukeKey}`)
      .setLabel("Start Auto-Ban")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`nuke_decline_${nukeKey}`)
      .setLabel("Decline")
      .setStyle(ButtonStyle.Secondary)
  );

  const dmMessages = [];
  for (const alertId of ALERT_USER_IDS) {
    try {
      const user = await client.users.fetch(alertId);
      const dm = await user.send({ embeds: [embed], components: [row] });
      dmMessages.push(dm);
    } catch (err) {
      console.error(`[anti-nuke] Could not DM alert user ${alertId}:`, err.message);
    }
  }

  if (dmMessages.length === 0) return true;

  return new Promise((resolve) => {
    let resolved = false;

    const finish = (shouldBan) => {
      if (resolved) return;
      resolved = true;
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("done_start").setLabel("Start Auto-Ban").setStyle(ButtonStyle.Danger).setDisabled(true),
        new ButtonBuilder().setCustomId("done_decline").setLabel("Decline").setStyle(ButtonStyle.Secondary).setDisabled(true)
      );
      for (const dm of dmMessages) dm.edit({ components: [disabledRow] }).catch(() => {});
      resolve(shouldBan);
    };

    const timer = setTimeout(() => finish(true), 60_000);

    for (const dm of dmMessages) {
      const col = dm.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: 60_000,
        filter: (i) => ALERT_USER_IDS.includes(i.user.id),
      });
      col.on("collect", async (i) => {
        clearTimeout(timer);
        await i.deferUpdate().catch(() => {});
        finish(i.customId.startsWith("nuke_start_"));
        col.stop();
      });
    }
  });
}

async function executeBan(guild, userId, action) {
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

  for (const alertId of ALERT_USER_IDS) {
    try {
      const user = await client.users.fetch(alertId);
      await user.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ Anti-Nuke: User Banned")
            .setColor(0xed4245)
            .setDescription(
              `**${guild.name}** — Anti-nuke ban executed.\n\n` +
              `**Perpetrator:** <@${userId}> (\`${userId}\`)\n` +
              `**Action:** Mass ${action}`
            )
            .setTimestamp(),
        ],
      });
    } catch (_) {}
  }
}

async function handleNukeDetected(guild, userId, action) {
  const nukeKey = `${guild.id}:${userId}`;
  if (nukeInProgress.has(nukeKey)) return;
  nukeInProgress.add(nukeKey);

  console.log(`[anti-nuke] Triggered for user ${userId} in guild ${guild.id} — action: ${action}`);

  const shouldBan = await dmAlertUsers(guild, userId, action);

  if (shouldBan) {
    await executeBan(guild, userId, action);
  } else {
    console.log(`[anti-nuke] Ban declined for ${userId} in ${guild.id}`);
    for (const alertId of ALERT_USER_IDS) {
      try {
        const user = await client.users.fetch(alertId);
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setTitle("Anti-Nuke: Declined")
              .setColor(0x57f287)
              .setDescription(
                `Anti-nuke ban was **declined** for <@${userId}> in **${guild.name}**.\nNo action was taken.`
              )
              .setTimestamp(),
          ],
        });
      } catch (_) {}
    }
  }

  clearNukeTracker(guild.id, userId);
}

async function getAuditExecutor(guild, auditLogEvent, targetId) {
  try {
    await new Promise((r) => setTimeout(r, 1000));
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
  const title = `${league.matchFormat} ${formatMatchType(league.matchType)} - ${formatRegion(league.region)} - ${formatPerks(league.perks)}`;
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription("A new league has been created! Join below.")
    .setColor(0x5865f2)
    .addFields(
      { name: "Match Format", value: league.matchFormat, inline: true },
      { name: "Match Type", value: formatMatchType(league.matchType), inline: true },
      { name: "Perks", value: formatPerks(league.perks), inline: true },
      { name: "Region", value: formatRegion(league.region), inline: true },
      { name: "Players", value: `${league.players.length}/${league.maxPlayers}`, inline: true },
      { name: "Spots Left", value: `${spotsLeft}`, inline: true },
      { name: "Hosted By", value: `<@${league.hostId}>`, inline: true },
      { name: "League ID", value: `\`${league.id}\``, inline: true },
      { name: "Status", value: league.status === "open" ? "Active" : league.status === "started" ? "Started" : "Cancelled", inline: true },
      { name: "Created", value: `<t:${Math.floor(new Date(league.createdAt).getTime() / 1000)}:F>`, inline: false }
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
      opt.setName("match_format").setDescription("Select the match format.").setRequired(true)
        .addChoices({ name: "2v2", value: "2v2" }, { name: "4v4", value: "4v4" }, { name: "6v6", value: "6v6" })
    )
    .addStringOption((opt) =>
      opt.setName("match_type").setDescription("Select the match type.").setRequired(true)
        .addChoices({ name: "Swift Game", value: "swift" }, { name: "War Game", value: "war" })
    )
    .addStringOption((opt) =>
      opt.setName("match_perks").setDescription("Select match perks.").setRequired(true)
        .addChoices({ name: "Perks", value: "perks" }, { name: "No Perks", value: "no-perks" })
    )
    .addStringOption((opt) =>
      opt.setName("region").setDescription("Select your region.").setRequired(true)
        .addChoices({ name: "EU", value: "eu" }, { name: "NA", value: "na" }, { name: "SA", value: "sa" }, { name: "Asia", value: "asia" }, { name: "Ocean", value: "ocean" })
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

  const promotionTime = new SlashCommandBuilder()
    .setName("promotiontime")
    .setDescription("Post a server promotion timer")
    .addStringOption((opt) =>
      opt.setName("server").setDescription("Name of the server being promoted").setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("when").setDescription('When promotion starts (e.g: "1 hour")').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("date").setDescription('Start date in DD/MM/YY format (e.g: "22/3/26")').setRequired(true)
    )
    .addStringOption((opt) =>
      opt.setName("duration").setDescription('How long promotion lasts (e.g: "10 days")').setRequired(true)
    );

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("[bot] Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: [hostLeague.toJSON(), cancelLeague.toJSON(), listLeagues.toJSON(), promotionTime.toJSON()],
    });
    console.log("[bot] Slash commands registered.");
  } catch (err) {
    console.error("[bot] Failed to register commands:", err);
  }
}

// ─── /host-league ─────────────────────────────────────────────────────────────

async function handleHostLeague(interaction) {
  if (interaction.channelId !== LEAGUE_CHANNEL_ID) {
    return interaction.reply({ content: `Leagues can only be hosted in <#${LEAGUE_CHANNEL_ID}>.`, ephemeral: true });
  }
  if (!interaction.member.roles.cache.has(HOST_ROLE_ID)) {
    return interaction.reply({ content: `You need the required role to host a league.`, ephemeral: true });
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
    matchFormat, matchType, perks, region, maxPlayers,
    players: [interaction.user.id],
    status: "open",
    createdAt: new Date().toISOString(),
  };

  setLeague(leagueId, league);

  const lobbyMsg = await interaction.channel.send({
    embeds: [buildEmbed(league)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`join_${leagueId}`).setLabel("Join League").setStyle(ButtonStyle.Primary)
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
        `**League ID:** \`${leagueId}\`\n**Format:** ${matchFormat} — ${formatMatchType(matchType)}\n` +
        `**Perks:** ${formatPerks(perks)}\n**Region:** ${formatRegion(region)}\n\nPlayers who join will be added here automatically. Good luck!`,
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
    if (!fresh || fresh.status !== "open") return btnInt.reply({ content: "This league is no longer open.", ephemeral: true });
    if (fresh.players.includes(btnInt.user.id)) return btnInt.reply({ content: "You are already in this league!", ephemeral: true });
    if (fresh.players.length >= fresh.maxPlayers) return btnInt.reply({ content: "This league is full!", ephemeral: true });

    const updated = updateLeague(leagueId, { players: [...fresh.players, btnInt.user.id] });

    if (updated.threadId) {
      try {
        const t = await interaction.guild.channels.fetch(updated.threadId);
        if (t) await t.members.add(btnInt.user.id);
      } catch (_) {}
    }

    await btnInt.reply({ content: `You joined league **\`${leagueId}\`**! Good luck!`, ephemeral: true });

    const isFull = updated.players.length >= updated.maxPlayers;

    await lobbyMsg.edit({
      embeds: [buildEmbed(updated)],
      components: isFull ? [] : [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`join_${leagueId}`).setLabel("Join League").setStyle(ButtonStyle.Primary)
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
  if (league.hostId !== interaction.user.id) return interaction.editReply({ content: `Only the host can cancel this league.` });
  if (league.status === "cancelled") return interaction.editReply({ content: `League \`${leagueId}\` is already cancelled.` });

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

  await interaction.editReply({ content: `League \`${leagueId}\` has been cancelled and the thread has been deleted.` });

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
  if (open.length === 0) return interaction.editReply({ content: "No open leagues right now. Use `/host-league` to start one!" });

  const embed = new EmbedBuilder().setTitle(`Open Leagues (${open.length})`).setColor(0x5865f2).setTimestamp();
  for (const l of open.slice(0, 10)) {
    embed.addFields({
      name: `\`${l.id}\` — ${l.matchFormat} ${formatMatchType(l.matchType)}`,
      value: `**Perks:** ${formatPerks(l.perks)} | **Region:** ${formatRegion(l.region)} | **Host:** <@${l.hostId}> | **Spots:** ${l.maxPlayers - l.players.length}/${l.maxPlayers}`,
    });
  }
  await interaction.editReply({ embeds: [embed] });
}

// ─── PREFIX .ban ──────────────────────────────────────────────────────────────

async function handlePrefixBan(message) {
  const member = message.member;
  if (!member.roles.cache.has(HICOM_ROLE_ID)) {
    return message.reply({ content: "You need the **HiCom** role to use this command." });
  }

  const args = message.content.slice(".ban".length).trim().split(/\s+/);
  const targetId = message.mentions.users.first()?.id || args[0]?.replace(/[<@!>]/g, "");
  const reason = message.mentions.users.first() ? args.slice(1).join(" ") || "No reason provided" : args.slice(1).join(" ") || "No reason provided";

  if (!targetId) return message.reply({ content: "Usage: `.ban @user [reason]`" });
  if (targetId === message.author.id) return message.reply({ content: "You cannot ban yourself." });

  const guild = message.guild;
  const targetMember = await guild.members.fetch(targetId).catch(() => null);

  if (targetMember) {
    if (!targetMember.bannable) return message.reply({ content: "I don't have permission to ban that member." });
    if (member.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0 && message.author.id !== guild.ownerId) {
      return message.reply({ content: "You cannot ban someone with an equal or higher role than you." });
    }
    try {
      await targetMember.user.send({
        embeds: [
          new EmbedBuilder()
            .setTitle(`You have been banned from ${guild.name}`)
            .setColor(0xed4245)
            .addFields({ name: "Reason", value: reason }, { name: "Banned by", value: message.author.tag })
            .setTimestamp(),
        ],
      });
    } catch (_) {}
  }

  try {
    await guild.members.ban(targetId, { reason: `${reason} | Banned by ${message.author.tag}` });
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Member Banned")
          .setColor(0xed4245)
          .addFields(
            { name: "User", value: targetMember ? `${targetMember.user.tag} (\`${targetId}\`)` : `\`${targetId}\`` },
            { name: "Reason", value: reason },
            { name: "Banned by", value: message.author.tag }
          )
          .setTimestamp(),
      ],
    });
  } catch (err) {
    await message.reply({ content: `Failed to ban: ${err.message}` });
  }
}

// ─── PREFIX .kick ─────────────────────────────────────────────────────────────

async function handlePrefixKick(message) {
  const member = message.member;
  if (!member.roles.cache.has(HICOM_ROLE_ID)) {
    return message.reply({ content: "You need the **HiCom** role to use this command." });
  }

  const args = message.content.slice(".kick".length).trim().split(/\s+/);
  const targetId = message.mentions.users.first()?.id || args[0]?.replace(/[<@!>]/g, "");
  const reason = message.mentions.users.first() ? args.slice(1).join(" ") || "No reason provided" : args.slice(1).join(" ") || "No reason provided";

  if (!targetId) return message.reply({ content: "Usage: `.kick @user [reason]`" });
  if (targetId === message.author.id) return message.reply({ content: "You cannot kick yourself." });

  const guild = message.guild;
  const targetMember = await guild.members.fetch(targetId).catch(() => null);
  if (!targetMember) return message.reply({ content: "That user is not in this server." });
  if (!targetMember.kickable) return message.reply({ content: "I don't have permission to kick that member." });
  if (member.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0 && message.author.id !== guild.ownerId) {
    return message.reply({ content: "You cannot kick someone with an equal or higher role than you." });
  }

  try {
    await targetMember.user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`You have been kicked from ${guild.name}`)
          .setColor(0xffa500)
          .addFields({ name: "Reason", value: reason }, { name: "Kicked by", value: message.author.tag })
          .setTimestamp(),
      ],
    });
  } catch (_) {}

  try {
    await targetMember.kick(`${reason} | Kicked by ${message.author.tag}`);
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Member Kicked")
          .setColor(0xffa500)
          .addFields(
            { name: "User", value: `${targetMember.user.tag} (\`${targetId}\`)` },
            { name: "Reason", value: reason },
            { name: "Kicked by", value: message.author.tag }
          )
          .setTimestamp(),
      ],
    });
  } catch (err) {
    await message.reply({ content: `Failed to kick: ${err.message}` });
  }
}

// ─── /promotiontime ───────────────────────────────────────────────────────────

async function handlePromotionTime(interaction) {
  if (interaction.channelId !== LEAGUE_CHANNEL_ID) {
    return interaction.reply({ content: `Promotions can only be posted in <#${LEAGUE_CHANNEL_ID}>.`, ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const server = interaction.options.getString("server");
  const when = interaction.options.getString("when");
  const date = interaction.options.getString("date");
  const duration = interaction.options.getString("duration");

  const promotionId = generatePromotionId();

  const promotion = {
    id: promotionId,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    postedBy: interaction.user.id,
    postedByUsername: interaction.user.username,
    server,
    when,
    date,
    duration,
    createdAt: new Date().toISOString(),
  };

  setPromotion(promotionId, promotion);

  const embed = new EmbedBuilder()
    .setTitle(`📣 Server Promotion — ${server}`)
    .setColor(0x57f287)
    .addFields(
      { name: "Server", value: server, inline: true },
      { name: "Promotion ID", value: `\`${promotionId}\``, inline: true },
      { name: "Starts In", value: when, inline: true },
      { name: "Date", value: date, inline: true },
      { name: "Duration", value: duration, inline: true },
      { name: "Posted By", value: `<@${interaction.user.id}>`, inline: true }
    )
    .setFooter({ text: "League Bot • Server Promotions" })
    .setTimestamp();

  await interaction.channel.send({ embeds: [embed] });

  await interaction.editReply({
    content: `Your promotion for **${server}** has been posted! (ID: \`${promotionId}\`)`,
  });
}

// ─── CLIENT ───────────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildBans,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

client.once(Events.ClientReady, (c) => {
  console.log(`[bot] Online as ${c.user.tag}`);
});

// ─── PREFIX COMMANDS ──────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;
  const content = message.content.trim();
  if (content.startsWith(".ban")) await handlePrefixBan(message).catch((e) => console.error("[bot] .ban error:", e));
  else if (content.startsWith(".kick")) await handlePrefixKick(message).catch((e) => console.error("[bot] .kick error:", e));
});

// ─── ANTI-NUKE LISTENERS ──────────────────────────────────────────────────────

client.on(Events.GuildBanAdd, async (ban) => {
  const guild = ban.guild;
  const executorId = await getAuditExecutor(guild, AuditLogEvent.MemberBanAdd, ban.user.id);
  if (!executorId || executorId === client.user.id || executorId === guild.ownerId) return;
  const count = trackNukeAction(guild.id, executorId, "ban");
  if (count >= NUKE_THRESHOLD) await handleNukeDetected(guild, executorId, "banning");
});

client.on(Events.GuildMemberRemove, async (member) => {
  const guild = member.guild;
  const executorId = await getAuditExecutor(guild, AuditLogEvent.MemberKick, member.id);
  if (!executorId || executorId === client.user.id || executorId === guild.ownerId) return;
  const count = trackNukeAction(guild.id, executorId, "kick");
  if (count >= NUKE_THRESHOLD) await handleNukeDetected(guild, executorId, "kicking");
});

client.on(Events.ChannelDelete, async (channel) => {
  if (!channel.guild) return;
  const guild = channel.guild;
  const executorId = await getAuditExecutor(guild, AuditLogEvent.ChannelDelete, channel.id);
  if (!executorId || executorId === client.user.id || executorId === guild.ownerId) return;
  const count = trackNukeAction(guild.id, executorId, "channel_delete");
  if (count >= NUKE_THRESHOLD) await handleNukeDetected(guild, executorId, "deleting channels");
});

client.on(Events.GuildRoleDelete, async (role) => {
  const guild = role.guild;
  const executorId = await getAuditExecutor(guild, AuditLogEvent.RoleDelete, role.id);
  if (!executorId || executorId === client.user.id || executorId === guild.ownerId) return;
  const count = trackNukeAction(guild.id, executorId, "role_delete");
  if (count >= NUKE_THRESHOLD) await handleNukeDetected(guild, executorId, "deleting roles");
});

// ─── SLASH COMMAND HANDLER ────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === "host-league") await handleHostLeague(interaction);
    else if (interaction.commandName === "cancel-league") await handleCancelLeague(interaction);
    else if (interaction.commandName === "list-leagues") await handleListLeagues(interaction);
    else if (interaction.commandName === "promotiontime") await handlePromotionTime(interaction);
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