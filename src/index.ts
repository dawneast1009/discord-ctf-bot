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
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import {
  addProblem,
  getAnnounceChannel,
  getProblem,
  getTierChannel,
  markSolved,
  setAnnounceChannel,
  setTierChannel,
  type ProblemRecord,
} from "./store";

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("환경변수 DISCORD_TOKEN 이 설정되지 않았습니다. .env 파일을 확인하세요.");
  process.exit(1);
}
const GUILD_IDS = (process.env.GUILD_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** 문제 생성 진행 중인 사용자별 임시 상태 (제출 전까지만 보관) */
interface DraftState {
  name?: string;
  flag?: string;
  tier?: string;
}
const drafts = new Map<string, DraftState>();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ── 슬래시 명령어 정의 ────────────────────────────────────────────────
const commandData = new SlashCommandBuilder()
  .setName("문제")
  .setDescription("CTF 문제 관리")
  .addSubcommand((s) => s.setName("생성").setDescription("새 문제를 생성합니다"))
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
  const ready = Boolean(state.name && state.flag && state.tier);
  const embed = new EmbedBuilder()
    .setTitle("🛠️ 문제 생성")
    .setColor(ready ? 0x57f287 : 0x5865f2)
    .setDescription("아래 버튼을 눌러 항목을 채운 뒤 **제출**하세요.")
    .addFields(
      { name: "📝 문제 이름", value: state.name ?? "`(미설정)`" },
      { name: "🏴 정답(플래그)", value: state.flag ? "`✅ 설정됨`" : "`(미설정)`" },
      { name: "🏅 티어", value: state.tier ?? "`(미설정)`" },
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("c_name").setLabel("문제 이름").setEmoji("📝").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("c_flag").setLabel("문제의 답").setEmoji("🏴").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("c_tier").setLabel("티어").setEmoji("🏅").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("c_submit").setLabel("제출").setEmoji("✅").setStyle(ButtonStyle.Success).setDisabled(!ready),
    new ButtonBuilder().setCustomId("c_cancel").setLabel("취소").setStyle(ButtonStyle.Danger),
  );
  return { embeds: [embed], components: [row] };
}

// ── 티어 채널(숨김) 확보 ──────────────────────────────────────────────
async function ensureTierChannel(guild: Guild, tier: string): Promise<TextChannel> {
  const existingId = getTierChannel(guild.id, tier);
  if (existingId) {
    const ch =
      guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
    if (ch && ch.type === ChannelType.GuildText) return ch as TextChannel;
  }
  const ch = await guild.channels.create({
    name: `${tier}-문제`,
    type: ChannelType.GuildText,
    topic: `${tier} 티어 문제 모음 — 정답자만 각 문제 스레드에 입장할 수 있습니다.`,
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }],
  });
  setTierChannel(guild.id, tier, ch.id);
  return ch;
}

// ── 알림 채널(공개) 확보 ──────────────────────────────────────────────
async function ensureAnnounceChannel(guild: Guild): Promise<TextChannel> {
  const existingId = getAnnounceChannel(guild.id);
  if (existingId) {
    const ch =
      guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
    if (ch && ch.type === ChannelType.GuildText) return ch as TextChannel;
  }
  const ch = await guild.channels.create({
    name: "🚩-문제-알림",
    type: ChannelType.GuildText,
    topic: "새로 등록된 문제 알림 — 버튼으로 플래그를 제출해 입장 권한을 받으세요.",
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] },
    ],
  });
  setAnnounceChannel(guild.id, ch.id);
  return ch;
}

// ── 모달 빌더 ─────────────────────────────────────────────────────────
function textModal(customId: string, title: string, label: string, style = TextInputStyle.Short) {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("value").setLabel(label).setStyle(style).setRequired(true).setMaxLength(100),
    ),
  );
}

// ── 인터랙션 라우팅 ───────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return void (await handleCommand(interaction));
    if (interaction.isButton()) return void (await handleButton(interaction));
    if (interaction.isModalSubmit()) return void (await handleModal(interaction));
  } catch (err) {
    console.error("인터랙션 처리 오류:", err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "⚠️ 처리 중 오류가 발생했습니다.", ephemeral: true }).catch(() => {});
    }
  }
});

async function handleCommand(interaction: ChatInputCommandInteraction) {
  if (interaction.commandName === "문제" && interaction.options.getSubcommand() === "생성") {
    drafts.set(interaction.user.id, {});
    await interaction.reply({ ...buildPanel({}), ephemeral: true });
  }
}

async function handleButton(interaction: ButtonInteraction) {
  const id = interaction.customId;

  // 생성 패널 버튼 → 모달 띄우기
  if (id === "c_name") return interaction.showModal(textModal("m_name", "문제 이름", "문제 이름을 입력하세요"));
  if (id === "c_flag") return interaction.showModal(textModal("m_flag", "정답(플래그)", "플래그를 입력하세요"));
  if (id === "c_tier") return interaction.showModal(textModal("m_tier", "티어", "예: 브론즈, 실버, 골드"));

  if (id === "c_cancel") {
    drafts.delete(interaction.user.id);
    return interaction.update({ content: "❌ 문제 생성을 취소했습니다.", embeds: [], components: [] });
  }

  if (id === "c_submit") return finalize(interaction);

  // 알림 채널의 "문제의 답" 버튼
  if (id.startsWith("flag:")) {
    const problemId = id.slice("flag:".length);
    if (!getProblem(problemId)) {
      return interaction.reply({ content: "이미 삭제된 문제입니다.", ephemeral: true });
    }
    return interaction.showModal(textModal(`fm:${problemId}`, "플래그 제출", "정답 플래그를 입력하세요"));
  }
}

async function handleModal(interaction: ModalSubmitInteraction) {
  const id = interaction.customId;
  const value = interaction.fields.getTextInputValue("value").trim();

  // 생성 패널 입력값 반영
  if (id === "m_name" || id === "m_flag" || id === "m_tier") {
    const state = drafts.get(interaction.user.id) ?? {};
    if (id === "m_name") state.name = value;
    if (id === "m_flag") state.flag = value;
    if (id === "m_tier") state.tier = value;
    drafts.set(interaction.user.id, state);
    if (interaction.isFromMessage()) await interaction.update(buildPanel(state));
    return;
  }

  // 플래그 제출 (입장 권한 부여)
  if (id.startsWith("fm:")) {
    const problemId = id.slice("fm:".length);
    const problem = getProblem(problemId);
    if (!problem) return interaction.reply({ content: "이미 삭제된 문제입니다.", ephemeral: true });

    if (value !== problem.flag.trim()) {
      return interaction.reply({ content: "❌ 플래그가 틀렸습니다. 다시 시도하세요.", ephemeral: true });
    }

    // 정답 → 비공개 스레드에 입장시키기
    const thread = await client.channels.fetch(problem.threadId).catch(() => null);
    if (thread && thread.isThread()) {
      if (thread.archived) await thread.setArchived(false).catch(() => {});
      await thread.members.add(interaction.user.id).catch(() => {});
    }
    const already = problem.solvers.includes(interaction.user.id);
    markSolved(problemId, interaction.user.id);
    return interaction.reply({
      content: already
        ? `✅ 이미 정답 처리된 문제입니다. <#${problem.threadId}> 에서 확인하세요.`
        : `✅ 정답입니다! <#${problem.threadId}> 에 입장 권한이 부여되었습니다.`,
      ephemeral: true,
    });
  }
}

// ── 제출: 채널/스레드/알림 생성 ───────────────────────────────────────
async function finalize(interaction: ButtonInteraction) {
  const state = drafts.get(interaction.user.id);
  if (!state?.name || !state.flag || !state.tier) {
    return interaction.reply({ content: "이름·정답·티어를 모두 입력해야 합니다.", ephemeral: true });
  }
  if (!interaction.guild) {
    return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
  }

  await interaction.update({
    content: "⏳ 문제를 생성하는 중...",
    embeds: [],
    components: [],
  });

  const guild = interaction.guild;
  const tierChannel = await ensureTierChannel(guild, state.tier);
  const announceChannel = await ensureAnnounceChannel(guild);
  const problemId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // 문제 비공개 스레드(포스트) 생성 — 티어 채널 안에 쌓임
  const thread = await tierChannel.threads.create({
    name: state.name,
    type: ChannelType.PrivateThread,
    invitable: false,
    reason: `문제 생성: ${state.name}`,
  });
  await thread.members.add(interaction.user.id).catch(() => {});
  await thread.send(
    `🏴 **${state.name}**  ·  ${state.tier}\n출제자: <@${interaction.user.id}>\n\n정답자만 입장할 수 있는 풀이 공간입니다. 자유롭게 이야기하세요!`,
  );

  // 알림 메시지 + "문제의 답" 버튼
  const embed = new EmbedBuilder()
    .setTitle("🚩 새로운 문제가 등록되었습니다!")
    .setColor(0x5865f2)
    .addFields(
      { name: "문제", value: `**${state.name}**`, inline: true },
      { name: "티어", value: state.tier, inline: true },
    )
    .setFooter({ text: "아래 버튼으로 플래그를 제출하면 문제 채널에 입장할 수 있습니다." });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`flag:${problemId}`).setLabel("문제의 답").setEmoji("🏴").setStyle(ButtonStyle.Success),
  );
  const announceMsg = await announceChannel.send({ embeds: [embed], components: [row] });

  const record: ProblemRecord = {
    id: problemId,
    name: state.name,
    flag: state.flag,
    tier: state.tier,
    guildId: guild.id,
    tierChannelId: tierChannel.id,
    threadId: thread.id,
    announceChannelId: announceChannel.id,
    announceMessageId: announceMsg.id,
    authorId: interaction.user.id,
    solvers: [],
    createdAt: Date.now(),
  };
  addProblem(record);
  drafts.delete(interaction.user.id);

  await interaction.editReply({
    content: `✅ **${state.name}** (${state.tier}) 문제를 생성했습니다!\n· 풀이 스레드: <#${thread.id}>\n· 알림: <#${announceChannel.id}>`,
  });
}

// ── 헬스체크용 최소 HTTP 서버 (Koyeb/Render 처럼 "포트 열림"을 요구할 때만) ──
// PORT 환경변수가 있을 때만 켜짐. 디스호스트/Pterodactyl 처럼 불필요한 곳에선 자동으로 꺼짐.
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
