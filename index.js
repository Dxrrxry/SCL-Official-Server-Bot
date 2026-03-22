const {
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
} = require("discord.js");

const fs = require("fs");
const path = require("path");

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

// Only leagues can be hosted in this channel
const LEAGUE_CHANNEL_ID = "1475298597028499606";

// Only members with this role can host leagues
const HOST_ROLE_ID = "1460146847912952090";

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

  const embed = new EmbedBuilder()
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
      { name: "Status", value: league.status === "open" ? "Active" : league.status === "started" ? "Started" : "Cancelled", inline: true },
      { name: "Created", value: `<t:${Math.floor(new Date(league.createdAt).getTime() / 1000)}:F>`, inline: false }
    )
    .setFooter({ text: "League Bot • Multi-Server" })
    .setTimestamp();

  return embed;
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

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("[bot] Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: [hostLeague.toJSON(), cancelLeague.toJSON(), listLeagues.toJSON()],
    });
    console.log("[bot] Slash commands registered.");
  } catch (err) {
    console.error("[bot] Failed to register commands:", err);
  }
}

// ─── /host-league ─────────────────────────────────────────────────────────────

async function handleHostLeague(interaction) {
  // Must be in the designated channel
  if (interaction.channelId !== LEAGUE_CHANNEL_ID) {
    return interaction.reply({
      content: `Leagues can only be hosted in <#${LEAGUE_CHANNEL_ID}>.`,
      ephemeral: true,
    });
  }

  // Must have the host role
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

  // Post the lobby embed
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

  // Open a private thread immediately
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

  // Collect join button presses
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

    // Add player to the private thread
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

    // Notify thread that league is full
    if (isFull && updated.threadId) {
      try {
        const t = await interaction.guild.channels.fetch(updated.threadId);
        if (t) {
          const mentions = updated.players.map((id) => `<@${id}>`).join(", ");
          await t.send({
            content: `${mentions}\n\n**The lobby is full! Get ready to play!**`,
          });
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

  // Remove the join button from the lobby message
  if (league.messageId) {
    try {
      const msg = await interaction.channel.messages.fetch(league.messageId);
      const cancelled = getLeague(leagueId);
      await msg.edit({
        embeds: [buildEmbed(cancelled)],
        components: [],
      });
    } catch (_) {}
  }

  // Delete the private thread
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

  if (open.length === 0) {
    return interaction.editReply({ content: "No open leagues right now. Use `/host-league` to start one!" });
  }

  const embed = new EmbedBuilder().setTitle(`Open Leagues (${open.length})`).setColor(0x5865f2).setTimestamp();

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

// ─── CLIENT & STARTUP ─────────────────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

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

