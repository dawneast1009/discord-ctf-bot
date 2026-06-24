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
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ForumChannel,
  type Guild,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
} from "discord.js";
import {
  addProblem,
  getForum,
  getGuildProblems,
  getProblem,
  getVault,
  markSolved,
  removeProblem,
  setForum,
  setVault,
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

function parseTier(input: string): { label: string; base: string; level: number | null } {
  const trimmed = input.trim();
  const m = trimmed.match(/^(.+?)\s*(\d+)\s*$/); // 기본티어 + 끝의 숫자
  if (m) {
    const base = m[1].trim();
    const level = Number(m[2]);
    return { label: `${base}${level}`, base, level };
  }
  return { label: trimmed, base: trimmed, level: null };
}

/** 문제 생성 진행 중인 사용자별 임시 상태 (제출 전까지만 보관) */
interface DraftState {
  name?: string;
  flag?: string;
  tier?: string;
  genre?: string;
}
const drafts = new Map<string, DraftState>();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── 슬래시 명령어 정의 ────────────────────────────────────────────────
const commandData = new SlashCommandBuilder()
  .setName("문제")
  .setDescription("CTF 문제 관리")
  .addSubcommand((s) => s.setName("생성").setDescription("새 문제를 생성합니다"))
  .addSubcommand((s) => s.setName("삭제").setDescription("문제를 삭제합니다 (출제자/관리자)"))
  .addSubcommand((s) => s.setName("스코어보드").setDescription("정답자 랭킹과 푼 문제를 봅니다"))
  .toJSON();

client.once(Events.ClientReady, async (c) => {
  console.log(`로그인 완료: ${c.user.tag}`);
  try {
    if (GUILD_IDS.length > 0) {
      for (const gid of GUILD_IDS) {
        const guild = await c.guilds.fetch(gid).catch(() => null);
        if (guild) {
          await guild.commands.set([commandData]);
          console.log(`길드 명령어 등록: ${guild.name}`);
        }
      }
    } else {
      await c.application.commands.set([commandData]);
      console.log("전역 명령어 등록 완료 (반영까지 최대 1시간)");
    }
  } catch (err) {
    console.error("명령어 등록 실패:", err);
  }
});

// ── 생성 패널(임베드 + 버튼) 렌더링 ───────────────────────────────────
function buildPanel(state: DraftState) {
  const ready = Boolean(state.name && state.flag && state.tier && state.genre);
  const embed = new EmbedBuilder()
    .setTitle("🛠️ 문제 생성")
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
  return { embeds: [embed], components: [row1, row2] };
}

// ── 포럼(공개 게시판) 채널 확보 ───────────────────────────────────────
async function ensureForum(guild: Guild): Promise<ForumChannel> {
  const existingId = getForum(guild.id);
  if (existingId) {
    const ch =
      guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
    if (ch && ch.type === ChannelType.GuildForum) return ch as ForumChannel;
  }
  const ch = await guild.channels.create({
    name: "🚩-문제-게시판",
    type: ChannelType.GuildForum,
    topic: "CTF 문제 모음 — 게시글의 '문제의 답' 버튼으로 플래그를 제출하면 풀이방에 입장합니다.",
  });
  setForum(guild.id, ch.id);
  return ch as ForumChannel;
}

// ── 비공개 풀이방을 담는 숨김 컨테이너 채널 확보 ──────────────────────
async function ensureVault(guild: Guild): Promise<TextChannel> {
  const existingId = getVault(guild.id);
  if (existingId) {
    const ch =
      guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
    if (ch && ch.type === ChannelType.GuildText) return ch as TextChannel;
  }
  const ch = await guild.channels.create({
    name: "🔒-풀이방-보관소",
    type: ChannelType.GuildText,
    topic: "정답자 전용 비공개 풀이방이 모이는 곳입니다. 각 문제의 풀이방은 정답자만 보입니다.",
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
  });
  setVault(guild.id, ch.id);
  return ch;
}

// ── 포럼 태그 확보 (여러 개를 한 번에 추가) — 반환: 이름 순서대로 태그 ID ──
async function ensureTags(forum: ForumChannel, names: string[]): Promise<string[]> {
  let tags = forum.availableTags;
  const missing = names.filter((n) => !tags.some((t) => t.name === n));
  if (missing.length > 0 && tags.length < 20) {
    const toAdd = missing.slice(0, 20 - tags.length).map((n) => ({ name: n }));
    const updated = await forum.setAvailableTags([
      ...tags.map((t) => ({ id: t.id, name: t.name, moderated: t.moderated, emoji: t.emoji })),
      ...toAdd,
    ]);
    tags = updated.availableTags;
  }
  return names
    .map((n) => tags.find((t) => t.name === n)?.id)
    .filter((x): x is string => Boolean(x));
}

// ── 모달 빌더 ─────────────────────────────────────────────────────────
function textModal(customId: string, title: string, label: string) {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("value").setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100),
    ),
  );
}

function canManage(interaction: { user: { id: string }; memberPermissions: any }, problem: ProblemRecord): boolean {
  if (interaction.user.id === problem.authorId) return true;
  const perms = interaction.memberPermissions;
  return Boolean(perms?.has(PermissionFlagsBits.Administrator) || perms?.has(PermissionFlagsBits.ManageChannels));
}

async function deleteChannelSafe(id: string) {
  const ch = await client.channels.fetch(id).catch(() => null);
  if (ch) await ch.delete().catch(() => {});
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
  if (interaction.commandName !== "문제") return;
  const sub = interaction.options.getSubcommand();

  if (sub === "생성") {
    drafts.set(interaction.user.id, {});
    return interaction.reply({ ...buildPanel({}), ephemeral: true });
  }

  if (sub === "삭제") {
    if (!interaction.guild) return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
    const problems = getGuildProblems(interaction.guild.id);
    if (problems.length === 0) return interaction.reply({ content: "삭제할 문제가 없습니다.", ephemeral: true });
    const menu = new StringSelectMenuBuilder()
      .setCustomId("del_select")
      .setPlaceholder("삭제할 문제를 선택하세요")
      .addOptions(
        problems.slice(0, 25).map((p) => ({ label: `[${p.tier}] ${p.name} · ${p.genre}`.slice(0, 100), value: p.id })),
      );
    return interaction.reply({
      content: "🗑️ 삭제할 문제를 고르세요. (출제자 또는 관리자만 삭제됩니다)",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      ephemeral: true,
    });
  }

  if (sub === "스코어보드") {
    if (!interaction.guild) return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
    return interaction.reply({ embeds: [buildScoreboard(interaction.guild.id)] });
  }
}

async function handleButton(interaction: ButtonInteraction) {
  const id = interaction.customId;

  if (id === "c_name") return interaction.showModal(textModal("m_name", "문제 이름", "문제 이름을 입력하세요"));
  if (id === "c_flag") return interaction.showModal(textModal("m_flag", "정답(플래그)", "플래그를 입력하세요"));
  if (id === "c_genre") return interaction.showModal(textModal("m_genre", "장르(카테고리)", "예: web, pwn, crypto, reversing"));
  if (id === "c_tier") return interaction.showModal(textModal("m_tier", "티어", "예: 브론즈1, 실버3, 골드5"));

  if (id === "c_cancel") {
    drafts.delete(interaction.user.id);
    return interaction.update({ content: "❌ 문제 생성을 취소했습니다.", embeds: [], components: [] });
  }

  if (id === "c_submit") return finalize(interaction);

  if (id.startsWith("flag:")) {
    const problemId = id.slice("flag:".length);
    if (!getProblem(problemId)) return interaction.reply({ content: "이미 삭제된 문제입니다.", ephemeral: true });
    return interaction.showModal(textModal(`fm:${problemId}`, "플래그 제출", "정답 플래그를 입력하세요"));
  }
}

async function handleModal(interaction: ModalSubmitInteraction) {
  const id = interaction.customId;
  const value = interaction.fields.getTextInputValue("value").trim();

  if (id === "m_name" || id === "m_flag" || id === "m_tier" || id === "m_genre") {
    const state = drafts.get(interaction.user.id) ?? {};
    if (id === "m_name") state.name = value;
    if (id === "m_flag") state.flag = value;
    if (id === "m_tier") state.tier = value;
    if (id === "m_genre") state.genre = value;
    drafts.set(interaction.user.id, state);
    if (interaction.isFromMessage()) await interaction.update(buildPanel(state));
    return;
  }

  if (id.startsWith("fm:")) {
    const problemId = id.slice("fm:".length);
    const problem = getProblem(problemId);
    if (!problem) return interaction.reply({ content: "이미 삭제된 문제입니다.", ephemeral: true });

    if (value !== problem.flag.trim()) {
      return interaction.reply({ content: "❌ 플래그가 틀렸습니다. 다시 시도하세요.", ephemeral: true });
    }

    const thread = await client.channels.fetch(problem.vaultThreadId).catch(() => null);
    if (thread && thread.isThread()) {
      if (thread.archived) await thread.setArchived(false).catch(() => {});
      await thread.members.add(interaction.user.id).catch(() => {});
    }
    const already = problem.solvers.includes(interaction.user.id);
    markSolved(problemId, interaction.user.id);
    const solved = getGuildProblems(problem.guildId).filter((p) => p.solvers.includes(interaction.user.id)).length;
    return interaction.reply({
      content: already
        ? `✅ 이미 정답 처리된 문제입니다. <#${problem.vaultThreadId}> 에서 확인하세요.`
        : `✅ 정답입니다! <#${problem.vaultThreadId}> 풀이방 입장 권한이 부여되었습니다. (현재 ${solved}솔브)`,
      ephemeral: true,
    });
  }
}

async function handleSelect(interaction: StringSelectMenuInteraction) {
  if (interaction.customId !== "del_select") return;
  const problem = getProblem(interaction.values[0]);
  if (!problem) return interaction.update({ content: "이미 삭제된 문제입니다.", components: [] });
  if (!canManage(interaction, problem)) {
    return interaction.reply({ content: "⛔ 출제자 또는 관리자만 삭제할 수 있습니다.", ephemeral: true });
  }
  await interaction.update({ content: `🗑️ '${problem.name}' 삭제 중...`, components: [] });
  await deleteChannelSafe(problem.postId);
  await deleteChannelSafe(problem.vaultThreadId);
  removeProblem(problem.id);
  await interaction.editReply({ content: `🗑️ **[${problem.tier}] ${problem.name}** 문제를 삭제했습니다.` });
}

// ── 스코어보드 임베드 (솔브 수 기준, 주력=장르) ───────────────────────
function buildScoreboard(guildId: string): EmbedBuilder {
  const problems = getGuildProblems(guildId);
  interface Row {
    userId: string;
    names: string[];
    genreCount: Map<string, number>;
  }
  const rows = new Map<string, Row>();
  for (const p of problems) {
    for (const uid of p.solvers) {
      const r: Row = rows.get(uid) ?? { userId: uid, names: [], genreCount: new Map() };
      r.names.push(`[${p.tier}] ${p.name} · ${p.genre}`);
      r.genreCount.set(p.genre, (r.genreCount.get(p.genre) ?? 0) + 1);
      rows.set(uid, r);
    }
  }

  const embed = new EmbedBuilder().setTitle("🏆 스코어보드").setColor(0xfee75c);
  if (rows.size === 0) {
    embed.setDescription("아직 정답자가 없습니다. 문제를 풀어 첫 솔브를 기록하세요!");
    return embed;
  }

  const sorted = [...rows.values()].sort((a, b) => b.names.length - a.names.length);
  const medals = ["🥇", "🥈", "🥉"];
  sorted.slice(0, 15).forEach((r, i) => {
    const rank = medals[i] ?? `#${i + 1}`;
    const best = [...r.genreCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-";
    const list = r.names.map((n) => `• ${n}`).join("\n");
    embed.addFields({
      name: `${rank}  ·  ${r.names.length}솔브`,
      value: `<@${r.userId}>  (주력 카테고리: ${best})\n${list}`.slice(0, 1024),
    });
  });
  embed.setFooter({ text: `총 ${problems.length}문제 · 정답자 ${rows.size}명` });
  return embed;
}

// ── 제출: 포럼 글 + 비공개 풀이방 생성 ────────────────────────────────
async function finalize(interaction: ButtonInteraction) {
  const state = drafts.get(interaction.user.id);
  if (!state?.name || !state.flag || !state.tier || !state.genre) {
    return interaction.reply({ content: "이름·정답·장르·티어를 모두 입력해야 합니다.", ephemeral: true });
  }
  if (!interaction.guild) {
    return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
  }

  await interaction.update({ content: "⏳ 문제를 생성하는 중...", embeds: [], components: [] });

  const guild = interaction.guild;
  const genre = state.genre.trim();
  const { label, base, level } = parseTier(state.tier);
  const title = `[${label}] ${state.name}`;

  const forum = await ensureForum(guild);
  const vault = await ensureVault(guild);
  const tagIds = await ensureTags(forum, [genre, base]); // 장르 + 티어 태그
  const problemId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // 정답자 전용 비공개 풀이방 (숨김 채널 안의 비공개 스레드)
  const vaultThread = await vault.threads.create({
    name: title,
    type: ChannelType.PrivateThread,
    invitable: false,
    reason: `문제 생성: ${state.name}`,
  });
  await vaultThread.members.add(interaction.user.id).catch(() => {});
  await vaultThread.send(
    `🏴 **${title}**  ·  장르 ${genre}\n출제자: <@${interaction.user.id}>\n\n정답자만 입장할 수 있는 풀이방입니다. 자유롭게 풀이를 공유하세요!`,
  );

  // 공개 포럼 게시글(포스트)
  const card = new EmbedBuilder()
    .setTitle(`🚩 ${title}`)
    .setColor(0x5865f2)
    .addFields(
      { name: "장르", value: genre, inline: true },
      { name: "티어", value: label, inline: true },
      { name: "출제자", value: `<@${interaction.user.id}>`, inline: true },
    )
    .setFooter({ text: "아래 '문제의 답' 버튼으로 플래그를 제출하면 풀이방에 입장합니다." });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`flag:${problemId}`).setLabel("문제의 답").setEmoji("🏴").setStyle(ButtonStyle.Success),
  );
  const post = await forum.threads.create({
    name: title,
    message: { embeds: [card], components: [row] },
    appliedTags: tagIds,
    reason: `문제 생성: ${state.name}`,
  });

  const record: ProblemRecord = {
    id: problemId,
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
    solvers: [interaction.user.id], // 출제자도 1솔브로 기록
    createdAt: Date.now(),
  };
  addProblem(record);
  drafts.delete(interaction.user.id);

  await interaction.editReply({
    content: `✅ **${title}** (${genre}) 문제를 생성했습니다! 출제자도 1솔브로 기록됩니다.\n· 공개 게시글: <#${post.id}>\n· 비공개 풀이방: <#${vaultThread.id}>`,
  });
}

// ── 헬스체크용 최소 HTTP 서버 (Koyeb/Render 처럼 "포트 열림"을 요구할 때만) ──
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
