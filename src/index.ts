import "dotenv/config";
import { createServer } from "node:http";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AnyThreadChannel,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ForumChannel,
  type Guild,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
} from "discord.js";
import {
  addCtfProblem,
  addProblem,
  findCtfProblem,
  getCtfProblem,
  getCtfProblemByPost,
  getForumFor,
  getGuildCtfProblems,
  getGuildProblems,
  getProblem,
  getVault,
  keyOf,
  markCtfSolved,
  markSolved,
  removeCtfProblem,
  removeForumFor,
  removeProblem,
  setForumFor,
  setVault,
  updateCtfProblem,
  type CtfProblem,
  type ProblemRecord,
} from "./store";

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("환경변수 DISCORD_TOKEN 이 설정되지 않았습니다. .env 또는 패널 환경변수를 확인하세요.");
  process.exit(1);
}
const GUILD_IDS = (process.env.GUILD_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const genId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function parseTier(input: string): { label: string; base: string; level: number | null } {
  const trimmed = input.trim();
  const m = trimmed.match(/^(.+?)\s*(\d+)\s*$/);
  if (m) {
    const base = m[1].trim();
    const level = Number(m[2]);
    return { label: `${base}${level}`, base, level };
  }
  return { label: trimmed, base: trimmed, level: null };
}

// ── 생성 진행 상태 ────────────────────────────────────────────────────
interface DraftState {
  name?: string;
  flag?: string;
  tier?: string;
  genre?: string;
}
interface CtfDraftState {
  ctfName?: string;
  genre?: string;
  name?: string;
}
const drafts = new Map<string, DraftState>();
const ctfDrafts = new Map<string, CtfDraftState>();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── 슬래시 명령어 정의 ────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName("문제")
    .setDescription("드림핵식 CTF 문제 관리")
    .addSubcommand((s) => s.setName("생성").setDescription("새 문제를 생성합니다 (드림핵/CTF 선택)"))
    .addSubcommand((s) => s.setName("삭제").setDescription("드림핵 문제를 삭제합니다 (출제자/관리자)"))
    .addSubcommand((s) => s.setName("스코어보드").setDescription("드림핵 정답자 랭킹"))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("ctf")
    .setDescription("CTF/워게임 문제 관리")
    .addSubcommand((s) => s.setName("추가").setDescription("CTF 문제를 수동으로 추가"))
    .addSubcommand((s) => s.setName("solve").setDescription("이 문제 스레드에서 '풀었음'을 기록"))
    .addSubcommand((s) => s.setName("수정").setDescription("CTF 문제 이름/장르 수정 (출제자/관리자)"))
    .addSubcommand((s) => s.setName("삭제").setDescription("CTF 문제 1개 삭제 (출제자/관리자)"))
    .addSubcommand((s) => s.setName("대회삭제").setDescription("CTF 대회를 통째로 삭제 (관리자)"))
    .addSubcommand((s) =>
      s
        .setName("스코어보드")
        .setDescription("CTF 스코어보드")
        .addStringOption((o) => o.setName("ctf").setDescription("특정 CTF 이름만 보기").setRequired(false)),
    )
    .addSubcommand((s) =>
      s
        .setName("점수추가")
        .setDescription("수동으로 솔브 추가 (관리자)")
        .addUserOption((o) => o.setName("user").setDescription("대상 유저").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("pull").setDescription("CTFd 사이트에 로그인해 문제 가져오기 (관리자)"))
    .toJSON(),
];

client.once(Events.ClientReady, async (c) => {
  console.log(`로그인 완료: ${c.user.tag}`);
  try {
    if (GUILD_IDS.length > 0) {
      for (const gid of GUILD_IDS) {
        const guild = await c.guilds.fetch(gid).catch(() => null);
        if (guild) {
          await guild.commands.set(commands);
          console.log(`길드 명령어 등록: ${guild.name}`);
        }
      }
    } else {
      await c.application.commands.set(commands);
      console.log("전역 명령어 등록 완료 (반영까지 최대 1시간)");
    }
  } catch (err) {
    console.error("명령어 등록 실패:", err);
  }
});

// ── 패널 렌더링 ───────────────────────────────────────────────────────
function buildSourceSelect() {
  const menu = new StringSelectMenuBuilder().setCustomId("src_select").setPlaceholder("문제 출처를 고르세요").addOptions(
    { label: "Dreamhack (플래그형)", value: "dh", emoji: "🐲", description: "플래그를 맞히면 풀이방 입장" },
    { label: "CTF / 워게임", value: "ctf", emoji: "🚩", description: "CTF 이름을 적고 토론 + /ctf solve 로 기록" },
  );
  return {
    content: "어디 문제인가요? 출처를 골라주세요.",
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    ephemeral: true as const,
  };
}

function buildPanel(state: DraftState) {
  const ready = Boolean(state.name && state.flag && state.tier && state.genre);
  const embed = new EmbedBuilder()
    .setTitle("🐲 드림핵식 문제 생성")
    .setColor(ready ? 0x57f287 : 0x5865f2)
    .setDescription("아래 버튼을 눌러 항목을 채운 뒤 **제출**하세요.")
    .addFields(
      { name: "📝 문제 이름", value: state.name ?? "`(미설정)`" },
      { name: "🏴 정답(플래그)", value: state.flag ? "`✅ 설정됨`" : "`(미설정)`" },
      { name: "📂 장르(카테고리)", value: state.genre ? `\`${state.genre}\`` : "`(미설정)`  예: web, pwn, crypto" },
      { name: "🏅 티어", value: state.tier ? `\`${state.tier}\`  (예: 브론즈1 → 태그 브론즈)` : "`(미설정)`" },
    );
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("c_name").setLabel("문제 이름").setEmoji("📝").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("c_flag").setLabel("문제의 답").setEmoji("🏴").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("c_genre").setLabel("장르").setEmoji("📂").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("c_tier").setLabel("티어").setEmoji("🏅").setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("c_submit").setLabel("제출").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(!ready),
    new ButtonBuilder().setCustomId("c_cancel").setLabel("취소").setStyle(ButtonStyle.Danger),
  );
  return { content: "", embeds: [embed], components: [row1, row2] };
}

function buildCtfPanel(state: CtfDraftState) {
  const ready = Boolean(state.ctfName && state.genre && state.name);
  const embed = new EmbedBuilder()
    .setTitle("🚩 CTF 문제 추가")
    .setColor(ready ? 0x57f287 : 0xeb459e)
    .setDescription("CTF/워게임 이름, 장르, 문제 이름을 채운 뒤 **제출**하세요.")
    .addFields(
      { name: "🏟️ CTF 이름", value: state.ctfName ? `\`${state.ctfName}\`` : "`(미설정)`  예: Codegate, 드림핵 워게임" },
      { name: "📂 장르(카테고리)", value: state.genre ? `\`${state.genre}\`` : "`(미설정)`  예: web, pwn, crypto" },
      { name: "📝 문제 이름", value: state.name ?? "`(미설정)`" },
    );
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("cf_ctf").setLabel("CTF 이름").setEmoji("🏟️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("cf_genre").setLabel("장르").setEmoji("📂").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("cf_name").setLabel("문제 이름").setEmoji("📝").setStyle(ButtonStyle.Primary),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("cf_submit").setLabel("제출").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(!ready),
    new ButtonBuilder().setCustomId("cf_cancel").setLabel("취소").setStyle(ButtonStyle.Danger),
  );
  return { content: "", embeds: [embed], components: [row1, row2] };
}

// ── 채널/태그 확보 ────────────────────────────────────────────────────
async function ensureForum(guild: Guild, sourceKey: string, name: string): Promise<ForumChannel> {
  const existingId = getForumFor(guild.id, sourceKey);
  if (existingId) {
    const ch = guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
    if (ch && ch.type === ChannelType.GuildForum) return ch as ForumChannel;
  }
  const ch = await guild.channels.create({
    name: name.slice(0, 95),
    type: ChannelType.GuildForum,
    topic: "CTF 문제 모음 — 게시글에서 버튼/명령으로 참여하고 기록합니다.",
  });
  setForumFor(guild.id, sourceKey, ch.id);
  return ch as ForumChannel;
}

async function ensureVault(guild: Guild): Promise<TextChannel> {
  const existingId = getVault(guild.id);
  if (existingId) {
    const ch = guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
    if (ch && ch.type === ChannelType.GuildText) return ch as TextChannel;
  }
  const ch = await guild.channels.create({
    name: "🔒-풀이방-보관소",
    type: ChannelType.GuildText,
    topic: "정답자 전용 비공개 풀이방이 모이는 곳입니다.",
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
  });
  setVault(guild.id, ch.id);
  return ch;
}

async function ensureTags(forum: ForumChannel, names: string[]): Promise<string[]> {
  let tags = forum.availableTags;
  const missing = names.filter((n) => !tags.some((t) => t.name === n));
  if (missing.length > 0 && tags.length < 20) {
    const toAdd = missing.slice(0, 20 - tags.length).map((n) => ({ name: n.slice(0, 20) }));
    const updated = await forum.setAvailableTags([
      ...tags.map((t) => ({ id: t.id, name: t.name, moderated: t.moderated, emoji: t.emoji })),
      ...toAdd,
    ]);
    tags = updated.availableTags;
  }
  return names.map((n) => tags.find((t) => t.name === n.slice(0, 20))?.id).filter((x): x is string => Boolean(x));
}

function textModal(customId: string, title: string, label: string, value?: string) {
  const input = new TextInputBuilder().setCustomId("value").setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100);
  if (value) input.setValue(value);
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

function canManage(interaction: { user: { id: string }; memberPermissions: any }, authorId: string): boolean {
  if (interaction.user.id === authorId) return true;
  const perms = interaction.memberPermissions;
  return Boolean(perms?.has(PermissionFlagsBits.Administrator) || perms?.has(PermissionFlagsBits.ManageChannels));
}
function isAdmin(interaction: { memberPermissions: any }): boolean {
  const perms = interaction.memberPermissions;
  return Boolean(perms?.has(PermissionFlagsBits.Administrator) || perms?.has(PermissionFlagsBits.ManageChannels));
}

async function deleteChannelSafe(id: string) {
  const ch = await client.channels.fetch(id).catch(() => null);
  if (ch) await ch.delete().catch(() => {});
}

// ── CTF 카드 임베드 / 버튼 ────────────────────────────────────────────
function ctfCard(name: string, ctfName: string, genre: string, authorId: string) {
  return new EmbedBuilder()
    .setTitle(`🏴 ${name}`)
    .setColor(0xeb459e)
    .addFields(
      { name: "CTF", value: ctfName, inline: true },
      { name: "장르", value: genre, inline: true },
      { name: "등록자", value: `<@${authorId}>`, inline: true },
    )
    .setFooter({ text: "'이거 풀래요' 버튼으로 참여하고, 풀면 이 스레드에서 /ctf solve 를 입력하세요." });
}
function ctfButtonRow(id: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ctftry:${id}`).setLabel("이거 풀래요").setEmoji("🙋").setStyle(ButtonStyle.Success),
  );
}

async function createCtfPost(
  guild: Guild,
  forum: ForumChannel,
  ctfName: string,
  ctfKey: string,
  name: string,
  genre: string,
  authorId: string,
): Promise<CtfProblem> {
  const tagIds = await ensureTags(forum, [genre]);
  const id = genId();
  const post = await forum.threads.create({
    name: name.slice(0, 95),
    message: { embeds: [ctfCard(name, ctfName, genre, authorId)], components: [ctfButtonRow(id)] },
    appliedTags: tagIds,
    reason: `CTF 문제 추가: ${name}`,
  });
  const rec: CtfProblem = {
    id,
    guildId: guild.id,
    ctfName,
    ctfKey,
    name,
    nameKey: keyOf(name),
    genre,
    genreKey: keyOf(genre),
    forumId: forum.id,
    postId: post.id,
    authorId,
    solvers: [],
    createdAt: Date.now(),
  };
  addCtfProblem(rec);
  return rec;
}

// ── 인터랙션 라우팅 ───────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return void (await handleCommand(interaction));
    if (interaction.isButton()) return void (await handleButton(interaction));
    if (interaction.isModalSubmit()) return void (await handleModal(interaction));
    if (interaction.isStringSelectMenu()) return void (await handleSelect(interaction));
  } catch (err) {
    console.error("인터랙션 처리 오류:", err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "⚠️ 처리 중 오류가 발생했습니다.", ephemeral: true }).catch(() => {});
    }
  }
});

async function handleCommand(interaction: ChatInputCommandInteraction) {
  if (interaction.commandName === "문제") return handleProblemCommand(interaction);
  if (interaction.commandName === "ctf") return handleCtfCommand(interaction);
}

async function handleProblemCommand(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "생성") return interaction.reply(buildSourceSelect());

  if (!interaction.guild) return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });

  if (sub === "삭제") {
    const problems = getGuildProblems(interaction.guild.id);
    if (problems.length === 0) return interaction.reply({ content: "삭제할 문제가 없습니다.", ephemeral: true });
    const menu = new StringSelectMenuBuilder()
      .setCustomId("del_select")
      .setPlaceholder("삭제할 문제를 선택하세요")
      .addOptions(problems.slice(0, 25).map((p) => ({ label: `[${p.tier}] ${p.name} · ${p.genre}`.slice(0, 100), value: p.id })));
    return interaction.reply({
      content: "🗑️ 삭제할 문제를 고르세요. (출제자/관리자만 삭제)",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      ephemeral: true,
    });
  }

  if (sub === "스코어보드") return interaction.reply({ embeds: [buildScoreboard(interaction.guild.id)] });
}

async function handleCtfCommand(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  if (!interaction.guild) return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
  const guildId = interaction.guild.id;

  if (sub === "추가") {
    ctfDrafts.set(interaction.user.id, {});
    return interaction.reply({ ...buildCtfPanel({}), ephemeral: true });
  }

  if (sub === "solve") {
    const p = getCtfProblemByPost(interaction.channelId);
    if (!p) return interaction.reply({ content: "이 명령은 **CTF 문제 게시글(스레드) 안**에서 사용하세요.", ephemeral: true });
    const added = markCtfSolved(p.id, interaction.user.id);
    if (!added) return interaction.reply({ content: "이미 풀이로 기록돼 있어요.", ephemeral: true });
    return interaction.reply({ content: `✅ <@${interaction.user.id}> 님이 **${p.name}** (${p.ctfName}) 풀이 완료! 🎉` });
  }

  if (sub === "수정") {
    const problems = getGuildCtfProblems(guildId);
    if (problems.length === 0) return interaction.reply({ content: "수정할 CTF 문제가 없습니다.", ephemeral: true });
    const menu = new StringSelectMenuBuilder()
      .setCustomId("ctfedit_select")
      .setPlaceholder("수정할 문제를 선택하세요")
      .addOptions(problems.slice(0, 25).map((p) => ({ label: `[${p.ctfName}] ${p.name} · ${p.genre}`.slice(0, 100), value: p.id })));
    return interaction.reply({
      content: "✏️ 수정할 CTF 문제를 고르세요.",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      ephemeral: true,
    });
  }

  if (sub === "삭제") {
    const problems = getGuildCtfProblems(guildId);
    if (problems.length === 0) return interaction.reply({ content: "삭제할 CTF 문제가 없습니다.", ephemeral: true });
    const menu = new StringSelectMenuBuilder()
      .setCustomId("ctfdel_select")
      .setPlaceholder("삭제할 문제를 선택하세요")
      .addOptions(problems.slice(0, 25).map((p) => ({ label: `[${p.ctfName}] ${p.name} · ${p.genre}`.slice(0, 100), value: p.id })));
    return interaction.reply({
      content: "🗑️ 삭제할 CTF 문제를 고르세요. (출제자/관리자만 삭제)",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      ephemeral: true,
    });
  }

  if (sub === "대회삭제") {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    const problems = getGuildCtfProblems(guildId);
    if (problems.length === 0) return interaction.reply({ content: "삭제할 CTF가 없습니다.", ephemeral: true });
    const seen = new Map<string, { name: string; count: number }>();
    for (const p of problems) {
      const e = seen.get(p.ctfKey) ?? { name: p.ctfName, count: 0 };
      e.count++;
      seen.set(p.ctfKey, e);
    }
    const menu = new StringSelectMenuBuilder()
      .setCustomId("ctfwipe_select")
      .setPlaceholder("통째로 삭제할 CTF를 선택하세요")
      .addOptions([...seen.entries()].slice(0, 25).map(([key, v]) => ({ label: `${v.name} (${v.count}문제)`.slice(0, 100), value: key })));
    return interaction.reply({
      content: "🧨 **대회 전체 삭제** — 선택한 CTF의 포럼과 모든 문제가 삭제됩니다. (되돌릴 수 없음)",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      ephemeral: true,
    });
  }

  if (sub === "스코어보드") {
    const filter = interaction.options.getString("ctf") ?? undefined;
    return interaction.reply({ embeds: [buildCtfScoreboard(guildId, filter)] });
  }

  if (sub === "점수추가") {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    const target = interaction.options.getUser("user", true);
    const problems = getGuildCtfProblems(guildId);
    if (problems.length === 0) return interaction.reply({ content: "CTF 문제가 없습니다.", ephemeral: true });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`ctfadd:${target.id}`)
      .setPlaceholder(`${target.username} 에게 솔브를 추가할 문제`)
      .addOptions(problems.slice(0, 25).map((p) => ({ label: `[${p.ctfName}] ${p.name}`.slice(0, 100), value: p.id })));
    return interaction.reply({
      content: `➕ <@${target.id}> 에게 솔브를 추가할 문제를 고르세요.`,
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      ephemeral: true,
    });
  }

  if (sub === "pull") {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    const modal = new ModalBuilder().setCustomId("ctfpull").setTitle("CTFd 로그인 & 문제 가져오기").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("url").setLabel("사이트 URL (예: https://ctf.example.com)").setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("ctfname").setLabel("이 CTF 이름").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("username").setLabel("아이디").setStyle(TextInputStyle.Short).setRequired(true),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("password").setLabel("비밀번호 (이 창은 나만 보입니다)").setStyle(TextInputStyle.Short).setRequired(true),
      ),
    );
    return interaction.showModal(modal);
  }
}

async function handleButton(interaction: ButtonInteraction) {
  const id = interaction.customId;

  // 드림핵 생성 패널
  if (id === "c_name") return interaction.showModal(textModal("m_name", "문제 이름", "문제 이름을 입력하세요"));
  if (id === "c_flag") return interaction.showModal(textModal("m_flag", "정답(플래그)", "플래그를 입력하세요"));
  if (id === "c_genre") return interaction.showModal(textModal("m_genre", "장르(카테고리)", "예: web, pwn, crypto"));
  if (id === "c_tier") return interaction.showModal(textModal("m_tier", "티어", "예: 브론즈1, 실버3, 골드5"));
  if (id === "c_cancel") {
    drafts.delete(interaction.user.id);
    return interaction.update({ content: "❌ 취소했습니다.", embeds: [], components: [] });
  }
  if (id === "c_submit") return finalize(interaction);

  // CTF 추가 패널
  if (id === "cf_ctf") return interaction.showModal(textModal("mcf_ctf", "CTF 이름", "예: Codegate 2025"));
  if (id === "cf_genre") return interaction.showModal(textModal("mcf_genre", "장르(카테고리)", "예: web, pwn, crypto"));
  if (id === "cf_name") return interaction.showModal(textModal("mcf_name", "문제 이름", "문제 이름을 입력하세요"));
  if (id === "cf_cancel") {
    ctfDrafts.delete(interaction.user.id);
    return interaction.update({ content: "❌ 취소했습니다.", embeds: [], components: [] });
  }
  if (id === "cf_submit") return finalizeCtf(interaction);

  // 드림핵 플래그 제출
  if (id.startsWith("flag:")) {
    const pid = id.slice("flag:".length);
    if (!getProblem(pid)) return interaction.reply({ content: "이미 삭제된 문제입니다.", ephemeral: true });
    return interaction.showModal(textModal(`fm:${pid}`, "플래그 제출", "정답 플래그를 입력하세요"));
  }

  // CTF '이거 풀래요'
  if (id.startsWith("ctftry:")) {
    const pid = id.slice("ctftry:".length);
    const p = getCtfProblem(pid);
    if (!p) return interaction.reply({ content: "이미 삭제된 문제입니다.", ephemeral: true });
    const thread = await client.channels.fetch(p.postId).catch(() => null);
    if (thread && thread.isThread()) {
      if (thread.archived) await thread.setArchived(false).catch(() => {});
      await thread.members.add(interaction.user.id).catch(() => {});
      await thread.send(`🙋 <@${interaction.user.id}> 님이 도전합니다!`).catch(() => {});
    }
    return interaction.reply({
      content: `참여 완료! <#${p.postId}> 에서 상의하고, 풀면 그 스레드에서 \`/ctf solve\` 를 입력하세요.`,
      ephemeral: true,
    });
  }
}

async function handleModal(interaction: ModalSubmitInteraction) {
  const id = interaction.customId;

  if (id === "ctfpull") return handleCtfPullModal(interaction);

  // 드림핵 패널 입력
  if (id === "m_name" || id === "m_flag" || id === "m_tier" || id === "m_genre") {
    const value = interaction.fields.getTextInputValue("value").trim();
    const state = drafts.get(interaction.user.id) ?? {};
    if (id === "m_name") state.name = value;
    if (id === "m_flag") state.flag = value;
    if (id === "m_tier") state.tier = value;
    if (id === "m_genre") state.genre = value;
    drafts.set(interaction.user.id, state);
    if (interaction.isFromMessage()) await interaction.update(buildPanel(state));
    return;
  }

  // CTF 패널 입력
  if (id === "mcf_ctf" || id === "mcf_genre" || id === "mcf_name") {
    const value = interaction.fields.getTextInputValue("value").trim();
    const state = ctfDrafts.get(interaction.user.id) ?? {};
    if (id === "mcf_ctf") state.ctfName = value;
    if (id === "mcf_genre") state.genre = value;
    if (id === "mcf_name") state.name = value;
    ctfDrafts.set(interaction.user.id, state);
    if (interaction.isFromMessage()) await interaction.update(buildCtfPanel(state));
    return;
  }

  // 드림핵 플래그 제출
  if (id.startsWith("fm:")) {
    const pid = id.slice("fm:".length);
    const problem = getProblem(pid);
    if (!problem) return interaction.reply({ content: "이미 삭제된 문제입니다.", ephemeral: true });
    const value = interaction.fields.getTextInputValue("value").trim();
    if (value !== problem.flag.trim()) return interaction.reply({ content: "❌ 플래그가 틀렸습니다.", ephemeral: true });
    const thread = await client.channels.fetch(problem.vaultThreadId).catch(() => null);
    if (thread && thread.isThread()) {
      if (thread.archived) await thread.setArchived(false).catch(() => {});
      await thread.members.add(interaction.user.id).catch(() => {});
    }
    const already = problem.solvers.includes(interaction.user.id);
    markSolved(pid, interaction.user.id);
    const solved = getGuildProblems(problem.guildId).filter((p) => p.solvers.includes(interaction.user.id)).length;
    return interaction.reply({
      content: already
        ? `✅ 이미 정답 처리됨. <#${problem.vaultThreadId}> 에서 확인하세요.`
        : `✅ 정답! <#${problem.vaultThreadId}> 풀이방 입장 권한 부여 (현재 ${solved}솔브)`,
      ephemeral: true,
    });
  }

  // CTF 수정 저장
  if (id.startsWith("ctfedit:")) {
    const pid = id.slice("ctfedit:".length);
    const p = getCtfProblem(pid);
    if (!p) return interaction.reply({ content: "이미 삭제된 문제입니다.", ephemeral: true });
    if (!canManage(interaction, p.authorId)) return interaction.reply({ content: "⛔ 출제자/관리자만 수정할 수 있습니다.", ephemeral: true });
    const newName = interaction.fields.getTextInputValue("name").trim();
    const newGenre = interaction.fields.getTextInputValue("genre").trim();
    updateCtfProblem(pid, { name: newName, nameKey: keyOf(newName), genre: newGenre, genreKey: keyOf(newGenre) });
    const thread = (await client.channels.fetch(p.postId).catch(() => null)) as AnyThreadChannel | null;
    if (thread && thread.isThread()) {
      await thread.setName(newName.slice(0, 95)).catch(() => {});
      if (thread.parent && thread.parent.type === ChannelType.GuildForum) {
        const tagIds = await ensureTags(thread.parent as ForumChannel, [newGenre]).catch(() => [] as string[]);
        if (tagIds.length) await thread.setAppliedTags(tagIds).catch(() => {});
      }
      const starter = await thread.fetchStarterMessage().catch(() => null);
      if (starter) await starter.edit({ embeds: [ctfCard(newName, p.ctfName, newGenre, p.authorId)] }).catch(() => {});
    }
    return interaction.reply({ content: `✏️ **${newName}** (${newGenre}) 로 수정했습니다.`, ephemeral: true });
  }
}

async function handleSelect(interaction: StringSelectMenuInteraction) {
  const cid = interaction.customId;

  if (cid === "src_select") {
    if (interaction.values[0] === "dh") {
      drafts.set(interaction.user.id, {});
      return interaction.update(buildPanel({}));
    }
    ctfDrafts.set(interaction.user.id, {});
    return interaction.update(buildCtfPanel({}));
  }

  if (cid === "del_select") {
    const problem = getProblem(interaction.values[0]);
    if (!problem) return interaction.update({ content: "이미 삭제된 문제입니다.", components: [] });
    if (!canManage(interaction, problem.authorId)) return interaction.reply({ content: "⛔ 출제자/관리자만 삭제할 수 있습니다.", ephemeral: true });
    await interaction.update({ content: `🗑️ '${problem.name}' 삭제 중...`, components: [] });
    await deleteChannelSafe(problem.postId);
    await deleteChannelSafe(problem.vaultThreadId);
    removeProblem(problem.id);
    return interaction.editReply({ content: `🗑️ **[${problem.tier}] ${problem.name}** 삭제 완료.` });
  }

  if (cid === "ctfdel_select") {
    const p = getCtfProblem(interaction.values[0]);
    if (!p) return interaction.update({ content: "이미 삭제된 문제입니다.", components: [] });
    if (!canManage(interaction, p.authorId)) return interaction.reply({ content: "⛔ 출제자/관리자만 삭제할 수 있습니다.", ephemeral: true });
    await interaction.update({ content: `🗑️ '${p.name}' 삭제 중...`, components: [] });
    await deleteChannelSafe(p.postId);
    removeCtfProblem(p.id);
    return interaction.editReply({ content: `🗑️ **[${p.ctfName}] ${p.name}** 삭제 완료.` });
  }

  if (cid === "ctfedit_select") {
    const p = getCtfProblem(interaction.values[0]);
    if (!p) return interaction.update({ content: "이미 삭제된 문제입니다.", components: [] });
    if (!canManage(interaction, p.authorId)) return interaction.reply({ content: "⛔ 출제자/관리자만 수정할 수 있습니다.", ephemeral: true });
    const modal = new ModalBuilder().setCustomId(`ctfedit:${p.id}`).setTitle("CTF 문제 수정").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("name").setLabel("문제 이름").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(p.name),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("genre").setLabel("장르").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(p.genre),
      ),
    );
    return interaction.showModal(modal);
  }

  if (cid === "ctfwipe_select") {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    const key = interaction.values[0];
    const guildId = interaction.guildId!;
    const probs = getGuildCtfProblems(guildId).filter((p) => p.ctfKey === key);
    if (probs.length === 0) return interaction.update({ content: "이미 삭제된 CTF입니다.", components: [] });
    const ctfName = probs[0].ctfName;
    await interaction.update({ content: `🧨 **${ctfName}** 삭제 중...`, components: [] });
    const forumId = getForumFor(guildId, `ctf:${key}`);
    if (forumId) {
      await deleteChannelSafe(forumId);
      removeForumFor(guildId, `ctf:${key}`);
    }
    for (const p of probs) removeCtfProblem(p.id);
    return interaction.editReply({ content: `🧨 **${ctfName}** 대회(${probs.length}문제)를 통째로 삭제했습니다.` });
  }

  if (cid.startsWith("ctfadd:")) {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    const targetId = cid.slice("ctfadd:".length);
    const p = getCtfProblem(interaction.values[0]);
    if (!p) return interaction.update({ content: "이미 삭제된 문제입니다.", components: [] });
    const added = markCtfSolved(p.id, targetId);
    return interaction.update({
      content: added
        ? `➕ <@${targetId}> 에게 **${p.name}** (${p.ctfName}) 솔브를 추가했습니다.`
        : `<@${targetId}> 는 이미 **${p.name}** 를 푼 것으로 기록돼 있습니다.`,
      components: [],
    });
  }
}

// ── 스코어보드 ────────────────────────────────────────────────────────
function buildScoreboard(guildId: string): EmbedBuilder {
  const problems = getGuildProblems(guildId);
  type SbRow = { names: string[]; genreCount: Map<string, number> };
  const rows = new Map<string, SbRow>();
  for (const p of problems) {
    for (const uid of p.solvers) {
      const r: SbRow = rows.get(uid) ?? { names: [], genreCount: new Map() };
      r.names.push(`[${p.tier}] ${p.name} · ${p.genre}`);
      r.genreCount.set(keyOf(p.genre), (r.genreCount.get(keyOf(p.genre)) ?? 0) + 1);
      rows.set(uid, r);
    }
  }
  const embed = new EmbedBuilder().setTitle("🐲 드림핵 스코어보드").setColor(0xfee75c);
  if (rows.size === 0) {
    embed.setDescription("아직 정답자가 없습니다.");
    return embed;
  }
  const sorted = [...rows.entries()].sort((a, b) => b[1].names.length - a[1].names.length);
  const medals = ["🥇", "🥈", "🥉"];
  sorted.slice(0, 15).forEach(([uid, r], i) => {
    const best = [...r.genreCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-";
    embed.addFields({
      name: `${medals[i] ?? `#${i + 1}`}  ·  ${r.names.length}솔브`,
      value: `<@${uid}>  (주력: ${best})\n${r.names.map((n) => `• ${n}`).join("\n")}`.slice(0, 1024),
    });
  });
  embed.setFooter({ text: `총 ${problems.length}문제 · 정답자 ${rows.size}명` });
  return embed;
}

function buildCtfScoreboard(guildId: string, ctfFilter?: string): EmbedBuilder {
  let problems = getGuildCtfProblems(guildId);
  if (ctfFilter) problems = problems.filter((p) => p.ctfKey === keyOf(ctfFilter));
  const embed = new EmbedBuilder().setTitle("🚩 CTF 스코어보드").setColor(0xeb459e);
  if (problems.length === 0) {
    embed.setDescription(ctfFilter ? `'${ctfFilter}' 에 해당하는 CTF 문제가 없습니다.` : "아직 CTF 문제가 없습니다.");
    return embed;
  }
  // CTF별로 그룹
  const byCtf = new Map<string, { ctfName: string; probs: CtfProblem[] }>();
  for (const p of problems) {
    const g = byCtf.get(p.ctfKey) ?? { ctfName: p.ctfName, probs: [] };
    g.probs.push(p);
    byCtf.set(p.ctfKey, g);
  }
  for (const { ctfName, probs } of byCtf.values()) {
    const count = new Map<string, number>();
    for (const p of probs) for (const uid of p.solvers) count.set(uid, (count.get(uid) ?? 0) + 1);
    const ranking = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const medals = ["🥇", "🥈", "🥉"];
    const body = ranking.length
      ? ranking.map(([uid, n], i) => `${medals[i] ?? `#${i + 1}`} <@${uid}> — ${n}/${probs.length}문제`).join("\n")
      : "_아직 푼 사람이 없습니다._";
    embed.addFields({ name: `📌 ${ctfName} (총 ${probs.length}문제)`, value: body.slice(0, 1024) });
  }
  return embed;
}

// ── 제출 (드림핵) ─────────────────────────────────────────────────────
async function finalize(interaction: ButtonInteraction) {
  const state = drafts.get(interaction.user.id);
  if (!state?.name || !state.flag || !state.tier || !state.genre) {
    return interaction.reply({ content: "이름·정답·장르·티어를 모두 입력해야 합니다.", ephemeral: true });
  }
  if (!interaction.guild) return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
  await interaction.update({ content: "⏳ 문제를 생성하는 중...", embeds: [], components: [] });

  const guild = interaction.guild;
  const genre = state.genre.trim();
  const { label, base, level } = parseTier(state.tier);
  const title = `[${label}] ${state.name}`;
  const forum = await ensureForum(guild, "dreamhack", "🐲-Dreamhack");
  const vault = await ensureVault(guild);
  const tagIds = await ensureTags(forum, [genre, base]);
  const pid = genId();

  const vaultThread = await vault.threads.create({
    name: title.slice(0, 95),
    type: ChannelType.PrivateThread,
    invitable: false,
    reason: `문제 생성: ${state.name}`,
  });
  await vaultThread.members.add(interaction.user.id).catch(() => {});
  await vaultThread.send(`🏴 **${title}**  ·  장르 ${genre}\n출제자: <@${interaction.user.id}>\n\n정답자만 입장하는 풀이방입니다.`);

  const card = new EmbedBuilder()
    .setTitle(`🚩 ${title}`)
    .setColor(0x5865f2)
    .addFields(
      { name: "장르", value: genre, inline: true },
      { name: "티어", value: label, inline: true },
      { name: "출제자", value: `<@${interaction.user.id}>`, inline: true },
    )
    .setFooter({ text: "'문제의 답' 버튼으로 플래그를 제출하면 풀이방에 입장합니다." });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`flag:${pid}`).setLabel("문제의 답").setEmoji("🏴").setStyle(ButtonStyle.Success),
  );
  const post = await forum.threads.create({
    name: title.slice(0, 95),
    message: { embeds: [card], components: [row] },
    appliedTags: tagIds,
    reason: `문제 생성: ${state.name}`,
  });

  const record: ProblemRecord = {
    id: pid,
    name: state.name,
    flag: state.flag,
    genre,
    tier: label,
    tierBase: base,
    tierLevel: level,
    guildId: guild.id,
    forumId: forum.id,
    postId: post.id,
    vaultThreadId: vaultThread.id,
    authorId: interaction.user.id,
    solvers: [interaction.user.id],
    createdAt: Date.now(),
  };
  addProblem(record);
  drafts.delete(interaction.user.id);
  await interaction.editReply({
    content: `✅ **${title}** (${genre}) 생성! 출제자도 1솔브 기록.\n· 게시글: <#${post.id}>\n· 풀이방: <#${vaultThread.id}>`,
  });
}

// ── 제출 (CTF 수동 추가) ──────────────────────────────────────────────
async function finalizeCtf(interaction: ButtonInteraction) {
  const state = ctfDrafts.get(interaction.user.id);
  if (!state?.ctfName || !state.genre || !state.name) {
    return interaction.reply({ content: "CTF 이름·장르·문제 이름을 모두 입력해야 합니다.", ephemeral: true });
  }
  if (!interaction.guild) return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });

  const guild = interaction.guild;
  const ctfName = state.ctfName.trim();
  const ctfKey = keyOf(ctfName);
  const genre = state.genre.trim();
  const name = state.name.trim();
  if (findCtfProblem(guild.id, ctfKey, keyOf(name))) {
    return interaction.reply({ content: `이미 **${ctfName}** 에 같은 이름의 문제가 있습니다.`, ephemeral: true });
  }
  await interaction.update({ content: "⏳ CTF 문제를 추가하는 중...", embeds: [], components: [] });
  const forum = await ensureForum(guild, `ctf:${ctfKey}`, `🚩-${ctfName}`);
  const rec = await createCtfPost(guild, forum, ctfName, ctfKey, name, genre, interaction.user.id);
  ctfDrafts.delete(interaction.user.id);
  await interaction.editReply({ content: `✅ **${name}** (${ctfName} · ${genre}) 추가 완료!\n· 게시글: <#${rec.postId}>` });
}

// ── CTFd 로그인 후 문제 목록 가져오기 ─────────────────────────────────
async function ctfdLoginFetch(url: string, username: string, password: string): Promise<any[]> {
  const jar = new Map<string, string>();
  const applyCookies = (res: Response) => {
    const sc: string[] = (res.headers as any).getSetCookie?.() ?? [];
    for (const c of sc) {
      const pair = c.split(";")[0];
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1));
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");

  // 1) 로그인 페이지에서 CSRF nonce + 세션 쿠키 확보
  let res = await fetch(`${url}/login`, { headers: { Cookie: cookie() }, redirect: "manual" });
  applyCookies(res);
  const html = await res.text();
  const nonce =
    html.match(/['"]csrfNonce['"]\s*:\s*["']([^"']+)["']/)?.[1] ??
    html.match(/csrf_nonce\s*=\s*["']([^"']+)["']/)?.[1] ??
    html.match(/name=["']nonce["']\s+value=["']([^"']+)["']/)?.[1];
  if (!nonce) throw new Error("로그인 페이지를 해석하지 못했습니다. CTFd 사이트가 맞는지 URL을 확인하세요.");

  // 2) 로그인 POST
  const body = new URLSearchParams({ name: username, password, nonce, _submit: "Submit" }).toString();
  res = await fetch(`${url}/login`, {
    method: "POST",
    headers: { Cookie: cookie(), "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  applyCookies(res);

  // 3) 인증된 세션으로 문제 목록 요청
  res = await fetch(`${url}/api/v1/challenges`, {
    headers: { Cookie: cookie(), Accept: "application/json", "CSRF-Token": nonce },
  });
  const json: any = await res.json().catch(() => null);
  if (!json?.success || !Array.isArray(json?.data)) {
    throw new Error("로그인에 실패했거나 문제 목록을 볼 수 없습니다. 아이디/비밀번호를 확인하세요.");
  }
  return json.data;
}

async function handleCtfPullModal(interaction: ModalSubmitInteraction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
  if (!interaction.guild) return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
  const url = interaction.fields.getTextInputValue("url").trim().replace(/\/+$/, "");
  const ctfName = interaction.fields.getTextInputValue("ctfname").trim();
  const username = interaction.fields.getTextInputValue("username").trim();
  const password = interaction.fields.getTextInputValue("password");
  await interaction.deferReply({ ephemeral: true });

  let list: any[];
  try {
    list = await ctfdLoginFetch(url, username, password);
  } catch (e: any) {
    return interaction.editReply(`❌ ${e?.message ?? "가져오기 실패"}\n→ \`/ctf 추가\`로 수동 등록할 수도 있어요.`);
  }
  if (list.length === 0) return interaction.editReply("⚠️ 로그인은 됐지만 공개된 문제가 없습니다.");

  const guild = interaction.guild;
  const ctfKey = keyOf(ctfName);
  const forum = await ensureForum(guild, `ctf:${ctfKey}`, `🚩-${ctfName}`);
  let created = 0;
  let skipped = 0;
  for (const c of list.slice(0, 50)) {
    const name = String(c?.name ?? "").trim();
    if (!name) continue;
    const genre = String(c?.category ?? "misc").trim() || "misc";
    if (findCtfProblem(guild.id, ctfKey, keyOf(name))) {
      skipped++;
      continue;
    }
    await createCtfPost(guild, forum, ctfName, ctfKey, name, genre, interaction.user.id).catch(() => {});
    created++;
  }
  await interaction.editReply(`✅ **${ctfName}** 로그인 가져오기 완료: ${created}개 생성, ${skipped}개 중복 (최대 50개).`);
}

// ── 헬스체크 서버 (PORT 있을 때만) ────────────────────────────────────
if (process.env.PORT) {
  const PORT = Number(process.env.PORT);
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
  server.on("error", (e) => console.error("헬스체크 서버 오류(무시 가능):", e));
  server.listen(PORT, () => console.log(`헬스체크 서버 실행: :${PORT}`));
}

client.login(TOKEN);
