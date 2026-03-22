const {
  Client,
  GatewayIntentBits,
  Events,
  SlashCommandBuilder,
  REST,
  Routes,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ComponentType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
} = require("discord.js");

const fs = require("fs");
const path = require("path");

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  console.error("[ERROR] Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID environment variables.");
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
  if (format === "3v3") return 6;
  if (format === "4v4") return 8;
  return 4;
}

function formatRegion(region) {
  const map = {
    europe: "Europe",
    asia: "Asia",
    "north-america": "North America",
    "south-america": "South America",
    oceania: "Oceania",
  };
  return map[region] || region;
}

function formatMatchType(type) {
  return type === "swift" ? "Swift Game" : "War Game";
}

function formatPerks(perks) {
  return perks === "perks" ? "Perks" : "No Perks";
}

function buildLeagueDescription(league) {
  const spotsLeft = league.maxPlayers - league.players.length;
  return [
    `**Game Type**   ${league.matchFormat.toUpperCase()} • ${formatMatchType(league.matchType)}`,
    `**Perks**       ${formatPerks(league.perks)}`,
    `**Region**      ${formatRegion(league.region)}`,
    `**Host**        <@${league.hostId}>`,
    `**Players**     ${league.players.length} / ${league.maxPlayers}`,
    `**Spots Left**  ${spotsLeft}`,
    `**League ID**   \`${league.id}\``,
    ``,
    spotsLeft > 0
      ? `> Use \`/league join id:${league.id}\` to join!`
      : `> **Lobby is full! Starting...**`,
  ].join("\n");
}

// ─── REGISTER SLASH COMMANDS ──────────────────────────────────────────────────

async function registerCommands() {
  const command = new SlashCommandBuilder()
    .setName("league")
    .setDescription("Manage leagues")
    .addSubcommand((sub) =>
      sub.setName("host").setDescription("Host a new league")
    )
    .addSubcommand((sub) =>
      sub
        .setName("join")
        .setDescription("Join a league by ID")
        .addStringOption((opt) =>
          opt.setName("id").setDescription("The League ID").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("cancel")
        .setDescription("Cancel your hosted league")
        .addStringOption((opt) =>
          opt.setName("id").setDescription("The League ID to cancel").setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List all open leagues in this server")
    );

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    console.log("[bot] Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [command.toJSON()] });
    console.log("[bot] Slash commands registered.");
  } catch (err) {
    console.error("[bot] Failed to register commands:", err);
  }
}

// ─── START LEAGUE ─────────────────────────────────────────────────────────────

async function startLeague(leagueId, channel) {
  const league = getLeague(leagueId);
  if (!league) return;

  const playerMentions = league.players.map((id) => `<@${id}>`).join(", ");

  try {
    const thread = await channel.threads.create({
      name: `League ${leagueId} — ${league.matchFormat.toUpperCase()} ${formatMatchType(league.matchType)}`,
      type: ChannelType.PrivateThread,
      reason: `League ${leagueId} started`,
    });

    updateLeague(leagueId, { status: "started", threadId: thread.id });

    await thread.send({
      content:
        `${playerMentions}\n\n` +
        `**Your league is starting!**\n\n` +
        `**League ID:** \`${leagueId}\`\n` +
        `**Format:** ${league.matchFormat.toUpperCase()} — ${formatMatchType(league.matchType)}\n` +
        `**Perks:** ${formatPerks(league.perks)}\n` +
        `**Region:** ${formatRegion(league.region)}\n` +
        `**Host:** <@${league.hostId}>\n\n` +
        `Good luck everyone!`,
    });

    for (const playerId of league.players) {
      try { await thread.members.add(playerId); } catch (_) {}
    }
  } catch (err) {
    console.error("[bot] Could not create private thread:", err.message);
    updateLeague(leagueId, { status: "started" });
  }

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("League Started!")
        .setColor(0x57f287)
        .setDescription(
          `The lobby is full and the league has started!\n\n` +
          `**Players:** ${playerMentions}\n` +
          `**League ID:** \`${leagueId}\`\n\n` +
          `Check the private thread for details.`
        )
        .setTimestamp(),
    ],
  });
}

// ─── /league host ─────────────────────────────────────────────────────────────

async function handleHost(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const state = {};

  // Step 1 – Format
  await interaction.editReply({
    content: "**Step 1 of 4** — Choose your **Match Format**:",
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("league_format")
          .setPlaceholder("Select Match Format")
          .addOptions([
            { label: "2v2", value: "2v2", description: "2 players per team" },
            { label: "3v3", value: "3v3", description: "3 players per team" },
            { label: "4v4", value: "4v4", description: "4 players per team" },
          ])
      ),
    ],
  });

  const msg1 = await interaction.fetchReply();
  const col1 = msg1.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    filter: (i) => i.user.id === interaction.user.id && i.customId === "league_format",
    time: 60000,
    max: 1,
  });

  col1.on("collect", async (i1) => {
    state.matchFormat = i1.values[0];
    await i1.deferUpdate();

    // Step 2 – Match Type
    await interaction.editReply({
      content: `**Step 2 of 4** — Choose your **Match Type** (Format: **${state.matchFormat.toUpperCase()}**):`,
      components: [
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("league_type")
            .setPlaceholder("Select Match Type")
            .addOptions([
              { label: "Swift Game", value: "swift", description: "Fast-paced swift game" },
              { label: "War Game", value: "war", description: "Full war game" },
            ])
        ),
      ],
    });

    const msg2 = await interaction.fetchReply();
    const col2 = msg2.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      filter: (i) => i.user.id === interaction.user.id && i.customId === "league_type",
      time: 60000,
      max: 1,
    });

    col2.on("collect", async (i2) => {
      state.matchType = i2.values[0];
      await i2.deferUpdate();

      // Step 3 – Perks
      await interaction.editReply({
        content: `**Step 3 of 4** — Choose **Perks** (${state.matchFormat.toUpperCase()} | ${formatMatchType(state.matchType)}):`,
        components: [
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("league_perks")
              .setPlaceholder("Select Match Perks")
              .addOptions([
                { label: "Perks", value: "perks", description: "Play with perks enabled" },
                { label: "No Perks", value: "no-perks", description: "Play without perks" },
              ])
          ),
        ],
      });

      const msg3 = await interaction.fetchReply();
      const col3 = msg3.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        filter: (i) => i.user.id === interaction.user.id && i.customId === "league_perks",
        time: 60000,
        max: 1,
      });

      col3.on("collect", async (i3) => {
        state.perks = i3.values[0];
        await i3.deferUpdate();

        // Step 4 – Region
        await interaction.editReply({
          content: `**Step 4 of 4** — Choose your **Region** (${state.matchFormat.toUpperCase()} | ${formatMatchType(state.matchType)} | ${formatPerks(state.perks)}):`,
          components: [
            new ActionRowBuilder().addComponents(
              new StringSelectMenuBuilder()
                .setCustomId("league_region")
                .setPlaceholder("Select Region")
                .addOptions([
                  { label: "Europe", value: "europe" },
                  { label: "Asia", value: "asia" },
                  { label: "North America", value: "north-america" },
                  { label: "South America", value: "south-america" },
                  { label: "Oceania", value: "oceania" },
                ])
            ),
          ],
        });

        const msg4 = await interaction.fetchReply();
        const col4 = msg4.createMessageComponentCollector({
          componentType: ComponentType.StringSelect,
          filter: (i) => i.user.id === interaction.user.id && i.customId === "league_region",
          time: 60000,
          max: 1,
        });

        col4.on("collect", async (i4) => {
          state.region = i4.values[0];
          await i4.deferUpdate();

          // Create the league
          const leagueId = generateLeagueId();
          const maxPlayers = getMaxPlayers(state.matchFormat);

          const league = {
            id: leagueId,
            hostId: interaction.user.id,
            hostUsername: interaction.user.username,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            messageId: null,
            threadId: null,
            matchFormat: state.matchFormat,
            matchType: state.matchType,
            perks: state.perks,
            region: state.region,
            maxPlayers,
            players: [interaction.user.id],
            status: "open",
            createdAt: new Date().toISOString(),
          };

          setLeague(leagueId, league);

          await interaction.editReply({
            content: `League \`${leagueId}\` created! Check the channel for your lobby.`,
            components: [],
          });

          // Post lobby embed
          const lobbyMsg = await interaction.channel.send({
            embeds: [
              new EmbedBuilder()
                .setTitle("League Lobby Open!")
                .setColor(0x5865f2)
                .setDescription(buildLeagueDescription(league))
                .setFooter({ text: `Use /league join id:${leagueId} to join • /league cancel id:${leagueId} to cancel` })
                .setTimestamp(),
            ],
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

          // Collect join button clicks
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

            await btnInt.reply({ content: `You joined league **\`${leagueId}\`**! Good luck!`, ephemeral: true });

            const isFull = updated.players.length >= updated.maxPlayers;

            await lobbyMsg.edit({
              embeds: [
                new EmbedBuilder()
                  .setTitle(isFull ? "League Lobby — FULL!" : "League Lobby Open!")
                  .setColor(isFull ? 0x57f287 : 0x5865f2)
                  .setDescription(buildLeagueDescription(updated))
                  .setFooter({ text: `Use /league join id:${leagueId} to join • /league cancel id:${leagueId} to cancel` })
                  .setTimestamp(),
              ],
              components: [
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`join_${leagueId}`)
                    .setLabel(isFull ? "Lobby Full" : "Join League")
                    .setStyle(isFull ? ButtonStyle.Secondary : ButtonStyle.Primary)
                    .setDisabled(isFull)
                ),
              ],
            });

            if (isFull) {
              joinCol.stop("full");
              await startLeague(leagueId, interaction.channel);
            }
          });
        });

        col4.on("end", (_, r) => {
          if (r === "time") interaction.editReply({ content: "Setup timed out. Please try again.", components: [] }).catch(() => {});
        });
      });

      col3.on("end", (_, r) => {
        if (r === "time") interaction.editReply({ content: "Setup timed out. Please try again.", components: [] }).catch(() => {});
      });
    });

    col2.on("end", (_, r) => {
      if (r === "time") interaction.editReply({ content: "Setup timed out. Please try again.", components: [] }).catch(() => {});
    });
  });

  col1.on("end", (_, r) => {
    if (r === "time") interaction.editReply({ content: "Setup timed out. Please try again.", components: [] }).catch(() => {});
  });
}

// ─── /league join ─────────────────────────────────────────────────────────────

async function handleJoin(interaction) {
  const leagueId = interaction.options.getString("id").toUpperCase();
  await interaction.deferReply({ ephemeral: true });

  const league = getLeague(leagueId);
  if (!league) return interaction.editReply({ content: `No league found with ID \`${leagueId}\`.` });
  if (league.status !== "open") return interaction.editReply({ content: `League \`${leagueId}\` is no longer open.` });
  if (league.players.includes(interaction.user.id)) return interaction.editReply({ content: `You are already in league \`${leagueId}\`!` });
  if (league.players.length >= league.maxPlayers) return interaction.editReply({ content: `League \`${leagueId}\` is full!` });

  const updated = updateLeague(leagueId, { players: [...league.players, interaction.user.id] });

  await interaction.editReply({
    content:
      `You joined league **\`${leagueId}\`**!\n` +
      `**Format:** ${updated.matchFormat.toUpperCase()} | **Type:** ${formatMatchType(updated.matchType)} | ` +
      `**Perks:** ${formatPerks(updated.perks)} | **Region:** ${formatRegion(updated.region)}\n` +
      `**Players:** ${updated.players.length}/${updated.maxPlayers}`,
  });

  if (updated.messageId) {
    try {
      const msg = await interaction.channel.messages.fetch(updated.messageId);
      const isFull = updated.players.length >= updated.maxPlayers;
      await msg.edit({
        embeds: [
          new EmbedBuilder()
            .setTitle(isFull ? "League Lobby — FULL!" : "League Lobby Open!")
            .setColor(isFull ? 0x57f287 : 0x5865f2)
            .setDescription(buildLeagueDescription(updated))
            .setFooter({ text: `Use /league join id:${leagueId} to join • /league cancel id:${leagueId} to cancel` })
            .setTimestamp(),
        ],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`join_${leagueId}`)
              .setLabel(isFull ? "Lobby Full" : "Join League")
              .setStyle(isFull ? ButtonStyle.Secondary : ButtonStyle.Primary)
              .setDisabled(isFull)
          ),
        ],
      });
      if (isFull) await startLeague(leagueId, interaction.channel);
    } catch (_) {}
  }
}

// ─── /league cancel ───────────────────────────────────────────────────────────

async function handleCancel(interaction) {
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
      await msg.edit({
        embeds: [
          new EmbedBuilder()
            .setTitle("League Cancelled")
            .setColor(0xed4245)
            .setDescription(`League \`${leagueId}\` was cancelled by the host.`)
            .setTimestamp(),
        ],
        components: [],
      });
    } catch (_) {}
  }

  await interaction.editReply({ content: `League \`${leagueId}\` has been cancelled.` });

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

// ─── /league list ─────────────────────────────────────────────────────────────

async function handleList(interaction) {
  await interaction.deferReply();

  const open = getLeaguesByGuild(interaction.guildId).filter((l) => l.status === "open");

  if (open.length === 0) {
    return interaction.editReply({ content: "No open leagues right now. Use `/league host` to start one!" });
  }

  const embed = new EmbedBuilder().setTitle(`Open Leagues (${open.length})`).setColor(0x5865f2).setTimestamp();

  for (const l of open.slice(0, 10)) {
    embed.addFields({
      name: `\`${l.id}\` — ${l.matchFormat.toUpperCase()} ${formatMatchType(l.matchType)}`,
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
  if (!interaction.isChatInputCommand() || interaction.commandName !== "league") return;

  const sub = interaction.options.getSubcommand();
  try {
    if (sub === "host") await handleHost(interaction);
    else if (sub === "join") await handleJoin(interaction);
    else if (sub === "cancel") await handleCancel(interaction);
    else if (sub === "list") await handleList(interaction);
  } catch (err) {
    console.error(`[bot] Error in /league ${sub}:`, err);
    try {
      const msg = { content: "Something went wrong. Please try again.", ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.editReply(msg);
      else await interaction.reply(msg);
    } catch (_) {}
  }
});

// Prevent crashes from killing the process
process.on("unhandledRejection", (err) => console.error("[bot] Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("[bot] Uncaught exception:", err));

// Start
(async () => {
  await registerCommands();
  await client.login(TOKEN);
})();
