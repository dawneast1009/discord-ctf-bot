import "dotenv/config";
import { createHash } from "node:crypto";
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
  UserSelectMenuBuilder,
  type AnyThreadChannel,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ForumChannel,
  type Guild,
  type GuildMember,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
  type UserSelectMenuInteraction,
  type SendableChannels,
} from "discord.js";
import {
  addCtfProblem,
  addEventItem,
  addProblem,
  clearGuildEvents,
  findCtfProblem,
  getCtfProblem,
  getCtfProblemByPost,
  getCtfRole,
  getCtfTime,
  getEventItem,
  getEventStatus,
  getFeatures,
  getForumKeysFor,
  getForumFor,
  getGuildEventItems,
  getGuildCtfProblems,
  getGuildProblems,
  getLogChannel,
  getProblem,
  getVault,
  hasEventItem,
  keyOf,
  markSolved,
  recordCtfSolve,
  removeEventItem,
  removeCtfProblem,
  removeCtfRole,
  removeCtfTime,
  removeForumFor,
  removeProblem,
  setCtfRole,
  setCtfSolve,
  setCtfTime,
  setEventStatus,
  setFeatures,
  setForumFor,
  setLogChannel,
  setVault,
  updateCtfProblem,
  type CtfProblem,
  type EventItem,
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

function envBool(name: string, defaultValue = false): boolean {
  const value = process.env[name];
  if (value == null || value === "") return defaultValue;
  return /^(1|true|yes|on)$/i.test(value);
}

/** "24h", "2d", "1d12h", "90m" → 밀리초. 인식 못하면 null */
function parseDuration(input: string): number | null {
  const str = input.trim().toLowerCase();
  if (!str) return null;
  let ms = 0;
  let matched = false;
  const re = /(\d+)\s*([dhm])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    matched = true;
    const n = Number(m[1]);
    if (m[2] === "d") ms += n * 86400000;
    else if (m[2] === "h") ms += n * 3600000;
    else ms += n * 60000;
  }
  return matched ? ms : null;
}

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
/** /ctf solve 진행 상태: userId -> { problemId, solver?, helpers? } */
const ctfSolveDrafts = new Map<string, { problemId: string; solver?: string; helpers?: string[] }>();

const intents = [GatewayIntentBits.Guilds];
if (process.env.ENABLE_LOGGING_INTENTS === "true") {
  intents.push(GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites);
}
const client = new Client({ intents });

// ── 슬래시 명령어 정의 (기능별) ───────────────────────────────────────
const ctfFeatureCommands = [
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
        .addUserOption((o) => o.setName("user").setDescription("대상 유저").setRequired(true))
        .addStringOption((o) =>
          o
            .setName("기여")
            .setDescription("기여도 (기본: 푼 사람)")
            .setRequired(false)
            .addChoices({ name: "푼 사람 (1솔브)", value: "1" }, { name: "도와준 사람 (0.5솔브)", value: "0.5" }),
        ),
    )
    .addSubcommand((s) => s.setName("pull").setDescription("CTFd 사이트에 로그인해 문제 가져오기 (관리자)"))
    .addSubcommand((s) => s.setName("import").setDescription("문제 목록을 붙여넣어 한 번에 등록 (관리자)"))
    .addSubcommand((s) =>
      s
        .setName("시간")
        .setDescription("대회 기간 설정 (관리자)")
        .addStringOption((o) => o.setName("ctf").setDescription("CTF 이름").setRequired(true))
        .addStringOption((o) => o.setName("기간").setDescription("지금부터 진행 시간. 예: 24h, 2d, 1d12h").setRequired(true)),
    )
    .toJSON(),
];

const loggingFeatureCommands = [
  new SlashCommandBuilder()
    .setName("로그채널")
    .setDescription("입장/퇴장 로그를 보낼 채널을 설정합니다")
    .addChannelOption((o) => o.setName("채널").setDescription("로그를 보낼 채널").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("로그채널확인")
    .setDescription("현재 설정된 로그 채널을 확인합니다")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
];

const eventFeatureCommands = [
  new SlashCommandBuilder()
    .setName("event_sync")
    .setDescription("보안뉴스/CTF/해커톤/컨퍼런스 소식을 즉시 수집해 게시합니다")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("event_status")
    .setDescription("보안뉴스/행사 수집 상태를 확인합니다")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("event_upcoming")
    .setDescription("최근 수집한 보안뉴스/행사 목록을 봅니다")
    .addIntegerOption((o) => o.setName("count").setDescription("표시할 개수 (기본 10)").setRequired(false).setMinValue(1).setMaxValue(20))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("event_add")
    .setDescription("보안뉴스/행사를 수동으로 추가합니다")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName("title").setDescription("제목").setRequired(true))
    .addStringOption((o) => o.setName("url").setDescription("링크").setRequired(true))
    .addStringOption((o) => o.setName("date").setDescription("행사 날짜. 예: 2026-07-10").setRequired(false))
    .addStringOption((o) =>
      o
        .setName("kind")
        .setDescription("분류")
        .setRequired(false)
        .addChoices(
          { name: "CTF 대회", value: "ctf" },
          { name: "AI 경진대회", value: "ai" },
          { name: "보안 컨퍼런스", value: "conference" },
          { name: "보안 해커톤", value: "hackathon" },
          { name: "기타 정보보안", value: "security" },
          { name: "정보보안 소식", value: "news" },
        ),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("event_remove")
    .setDescription("수집/등록된 보안뉴스·행사를 삭제합니다")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("event_import")
    .setDescription("보안뉴스/행사 목록을 붙여넣어 한 번에 등록합니다")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("event_import_url")
    .setDescription("사이트 상세 페이지 링크를 읽어 행사로 등록합니다")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName("url").setDescription("분석할 상세 페이지 URL").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("event_reset")
    .setDescription("보안뉴스/행사 수집 기록을 초기화합니다")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addBooleanOption((o) => o.setName("confirm").setDescription("true면 즉시 삭제합니다").setRequired(false))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("event_list_manual")
    .setDescription("수동 등록 행사 목록을 조회합니다")
    .toJSON(),
];

// 항상 등록되는 기능 관리 명령어
const botCommand = new SlashCommandBuilder()
  .setName("봇")
  .setDescription("봇 기능 켜기/끄기")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommandGroup((g) =>
    g
      .setName("기능")
      .setDescription("기능 관리")
      .addSubcommand((s) => s.setName("추가").setDescription("기능을 켭니다 (해당 명령어가 보이게 됩니다)"))
      .addSubcommand((s) => s.setName("삭제").setDescription("기능을 끕니다"))
      .addSubcommand((s) => s.setName("목록").setDescription("켜진 기능을 봅니다")),
  )
  .toJSON();

// 기능 레지스트리
const FEATURES: Record<string, { label: string; desc: string; commands: any[] }> = {
  ctf: { label: "CTF · 드림핵 문제 관리", desc: "/문제, /ctf 명령어", commands: ctfFeatureCommands },
  events: { label: "보안뉴스 · 행사 공지", desc: "/event_sync, /event_add, /event_import 등", commands: eventFeatureCommands },
  logging: { label: "입장/퇴장 로그", desc: "/로그채널 + 초대 추적·입퇴장 알림", commands: loggingFeatureCommands },
};
/** 각 명령어가 속한 기능 키 */
const COMMAND_FEATURE: Record<string, string> = {
  문제: "ctf",
  ctf: "ctf",
  event_sync: "events",
  event_status: "events",
  event_upcoming: "events",
  event_add: "events",
  event_remove: "events",
  event_import: "events",
  event_import_url: "events",
  event_reset: "events",
  event_list_manual: "events",
  로그채널: "logging",
  로그채널확인: "logging",
};

function commandsForGuild(guildId: string): any[] {
  const out: any[] = [botCommand];
  for (const key of getFeatures(guildId)) {
    if (FEATURES[key]) out.push(...FEATURES[key].commands);
  }
  return out;
}
async function registerGuild(guild: Guild) {
  await guild.commands.set(commandsForGuild(guild.id)).catch((e) => console.error(`명령어 등록 실패(${guild.id}):`, e?.message ?? e));
}

const inviteCache = new Map<string, Map<string, { uses: number; inviterTag: string; inviterMention: string }>>();
const eventSyncTimers = new Map<string, NodeJS.Timeout>();
async function cacheInvites(guild: Guild) {
  try {
    const invites = await guild.invites.fetch();
    const map = new Map<string, { uses: number; inviterTag: string; inviterMention: string }>();
    invites.forEach((inv) =>
      map.set(inv.code, {
        uses: inv.uses ?? 0,
        inviterTag: inv.inviter?.tag ?? "알 수 없음",
        inviterMention: inv.inviter ? `<@${inv.inviter.id}>` : "알 수 없음",
      }),
    );
    inviteCache.set(guild.id, map);
  } catch {
    /* 권한 없으면 무시 */
  }
}

function ensureEventScheduler(guild: Guild) {
  if (!envBool("ENABLE_AUTO_DISCOVERY", true)) return;
  if (eventSyncTimers.has(guild.id)) return;
  const minutes = Math.max(10, Number(process.env.EVENT_SYNC_INTERVAL_MINUTES ?? process.env.SYNC_INTERVAL_MINUTES ?? 180) || 180);
  const timer = setInterval(() => {
    if (!getFeatures(guild.id).includes("events")) return;
    syncEvents(guild).catch((e) => {
      setEventStatus(guild.id, {
        lastSyncAt: Date.now(),
        lastOk: false,
        lastMessage: e?.message ?? "자동 수집 실패",
        fetched: 0,
        posted: 0,
      });
    });
  }, minutes * 60000);
  eventSyncTimers.set(guild.id, timer);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`로그인 완료: ${c.user.tag}`);
  for (const guild of c.guilds.cache.values()) {
    await registerGuild(guild);
    if (getFeatures(guild.id).includes("logging")) await cacheInvites(guild);
    if (getFeatures(guild.id).includes("events")) {
      await ensureEventForums(guild);
      ensureEventScheduler(guild);
    }
  }
  console.log(`명령어 등록 완료: ${c.guilds.cache.size}개 서버`);
});

client.on(Events.GuildCreate, async (guild) => {
  await registerGuild(guild);
  if (getFeatures(guild.id).includes("events")) {
    await ensureEventForums(guild);
    ensureEventScheduler(guild);
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

async function ensurePublicText(guild: Guild, key: string, name: string, topic: string): Promise<TextChannel> {
  const existingId = getForumFor(guild.id, key);
  if (existingId) {
    const ch = guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
    if (ch && ch.type === ChannelType.GuildText) return ch as TextChannel;
  }
  const ch = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    topic,
    permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] }],
  });
  setForumFor(guild.id, key, ch.id);
  return ch;
}
const ensureLobby = (guild: Guild) =>
  ensurePublicText(guild, "_ctflobby", "🚩-ctf-로비", "CTF 참가 버튼을 누르면 그 대회 문제가 보입니다.");
const ensureSolveChannel = (guild: Guild) =>
  ensurePublicText(guild, "_solvelog", "🏅-solve-기록", "푼 문제 기록이 올라옵니다.");

/** CTF 참가자 역할 + 비공개 카테고리 확보. 처음 만들면 로비에 참가 버튼 게시 */
async function getOrCreateCtf(guild: Guild, ctfName: string) {
  const ctfKey = keyOf(ctfName);
  // 역할 (이 역할이 있어야 CTF 카테고리/채널이 보임)
  let roleId = getCtfRole(guild.id, ctfKey);
  let role = roleId ? guild.roles.cache.get(roleId) ?? (await guild.roles.fetch(roleId).catch(() => null)) : null;
  if (!role) {
    role = await guild.roles.create({ name: `CTF: ${ctfName}`.slice(0, 90), mentionable: false });
    setCtfRole(guild.id, ctfKey, role.id);
  }
  // 비공개 카테고리 (참가자 역할만 보임) — 장르 채널들이 이 안에 들어감
  let created = false;
  const catKey = `ctfcat:${ctfKey}`;
  const catId = getForumFor(guild.id, catKey);
  let category = catId ? guild.channels.cache.get(catId) ?? (await guild.channels.fetch(catId).catch(() => null)) : null;
  if (!category || category.type !== ChannelType.GuildCategory) {
    category = await guild.channels.create({
      name: `🚩 ${ctfName}`.slice(0, 95),
      type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: role.id, allow: [PermissionFlagsBits.ViewChannel] },
      ],
    });
    setForumFor(guild.id, catKey, category.id);
    created = true;
  }
  if (created) {
    const lobby = await ensureLobby(guild);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ctfjoin:${ctfKey}`).setLabel("참가할래요").setEmoji("🙌").setStyle(ButtonStyle.Success),
    );
    const time = getCtfTime(guild.id, ctfKey);
    const when = time
      ? `\n⏰ <t:${Math.floor(time.startsAt / 1000)}:f> ~ <t:${Math.floor(time.endsAt / 1000)}:f> (<t:${Math.floor(time.endsAt / 1000)}:R> 종료)`
      : "";
    await lobby
      .send({ content: `🚩 **${ctfName}** 대회가 열렸어요! 아래 버튼을 누르면 참가하고 문제가 보입니다.${when}`, components: [row] })
      .catch(() => {});
  }
  return { categoryId: category.id, roleId: role.id, ctfKey };
}

/** CTF 카테고리 안에 장르별 포럼 채널 확보 (참가자 역할만 보임) */
async function ensureGenreForum(guild: Guild, ctfKey: string, categoryId: string, roleId: string, genre: string): Promise<ForumChannel> {
  const key = `ctf:${ctfKey}:${keyOf(genre)}`;
  const existingId = getForumFor(guild.id, key);
  if (existingId) {
    const ch = guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
    if (ch && ch.type === ChannelType.GuildForum) return ch as ForumChannel;
  }
  const ch = await guild.channels.create({
    name: genre.slice(0, 95),
    type: ChannelType.GuildForum,
    parent: categoryId,
    topic: `${genre} 장르 문제`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: roleId, allow: [PermissionFlagsBits.ViewChannel] },
    ],
  });
  setForumFor(guild.id, key, ch.id);
  return ch as ForumChannel;
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

async function resetEventFeature(guild: Guild): Promise<{ channels: number; items: number }> {
  const items = getGuildEventItems(guild.id);
  const keys = [
    ...getForumKeysFor(guild.id, "events:"),
    ...getForumKeysFor(guild.id, "eventindex:"),
    ...getForumKeysFor(guild.id, "eventcat:"),
  ];
  let channels = 0;
  for (const key of keys) {
    const channelId = getForumFor(guild.id, key);
    if (!channelId) continue;
    await deleteChannelSafe(channelId);
    removeForumFor(guild.id, key);
    channels++;
  }
  clearGuildEvents(guild.id);
  return { channels, items: items.length };
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
  const id = genId();
  const post = await forum.threads.create({
    name: name.slice(0, 95),
    message: { embeds: [ctfCard(name, ctfName, genre, authorId)], components: [ctfButtonRow(id)] },
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
    solves: {},
    solved: false,
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
    if (interaction.isUserSelectMenu()) return void (await handleUserSelect(interaction));
  } catch (err) {
    console.error("인터랙션 처리 오류:", err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "⚠️ 처리 중 오류가 발생했습니다.", ephemeral: true }).catch(() => {});
    }
  }
});

async function handleCommand(interaction: ChatInputCommandInteraction) {
  const name = interaction.commandName;
  if (name === "봇") return handleBotCommand(interaction);
  // 꺼진 기능 가드 (보이지 않아야 정상이지만 안전망)
  const feat = COMMAND_FEATURE[name];
  if (feat && interaction.guildId && !getFeatures(interaction.guildId).includes(feat)) {
    return interaction.reply({ content: "이 기능은 꺼져 있어요. `/봇 기능 추가` 로 켜주세요.", ephemeral: true });
  }
  if (name === "문제") return handleProblemCommand(interaction);
  if (name === "ctf") return handleCtfCommand(interaction);
  if (name.startsWith("event_")) return handleEventCommand(interaction);
  if (name === "로그채널" || name === "로그채널확인") return handleLoggingCommand(interaction);
}

// ── /봇 기능 토글 ─────────────────────────────────────────────────────
async function handleBotCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
  const sub = interaction.options.getSubcommand();
  const enabled = getFeatures(interaction.guild.id);

  if (sub === "목록") {
    const lines = Object.entries(FEATURES).map(
      ([k, f]) => `${enabled.includes(k) ? "🟢" : "⚪"} **${f.label}** — ${f.desc}`,
    );
    const embed = new EmbedBuilder().setTitle("🤖 봇 기능").setColor(0x5865f2).setDescription(lines.join("\n"));
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (sub === "추가") {
    const off = Object.entries(FEATURES).filter(([k]) => !enabled.includes(k));
    if (off.length === 0) return interaction.reply({ content: "이미 모든 기능이 켜져 있어요.", ephemeral: true });
    const menu = new StringSelectMenuBuilder()
      .setCustomId("feat_add")
      .setPlaceholder("켤 기능을 고르세요 (여러 개 가능)")
      .setMinValues(1)
      .setMaxValues(off.length)
      .addOptions(off.map(([k, f]) => ({ label: f.label, value: k, description: f.desc.slice(0, 100) })));
    return interaction.reply({
      content: "켤 기능을 선택하세요. 선택하면 해당 명령어가 보이게 됩니다.",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      ephemeral: true,
    });
  }

  if (sub === "삭제") {
    if (enabled.length === 0) return interaction.reply({ content: "켜진 기능이 없어요.", ephemeral: true });
    const menu = new StringSelectMenuBuilder()
      .setCustomId("feat_del")
      .setPlaceholder("끌 기능을 고르세요")
      .setMinValues(1)
      .setMaxValues(enabled.length)
      .addOptions(enabled.map((k) => ({ label: FEATURES[k]?.label ?? k, value: k })));
    return interaction.reply({
      content: "끌 기능을 선택하세요. 해당 명령어가 숨겨집니다.",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      ephemeral: true,
    });
  }
}

// ── 로그 기능 (discord-bot 포팅) ──────────────────────────────────────
function findLogChannel(guild: Guild): SendableChannels | null {
  const saved = getLogChannel(guild.id);
  if (saved) {
    const ch = guild.channels.cache.get(saved);
    if (ch?.isSendable()) return ch;
  }
  const guess = guild.channels.cache.find(
    (ch) => ch.isTextBased() && /log|로그|welcome|입장|general|일반/i.test(ch.name),
  );
  if (guess?.isSendable()) return guess;
  return guild.systemChannel?.isSendable() ? guild.systemChannel : null;
}

async function handleLoggingCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
  if (interaction.commandName === "로그채널") {
    const channel = interaction.options.getChannel("채널", true);
    if (!("isTextBased" in channel) || !channel.isTextBased()) {
      return interaction.reply({ content: "❌ 텍스트 채널만 설정할 수 있어요!", ephemeral: true });
    }
    setLogChannel(interaction.guild.id, channel.id);
    await cacheInvites(interaction.guild);
    return interaction.reply({ content: `✅ 로그 채널이 <#${channel.id}> 로 설정됐어요!`, ephemeral: true });
  }
  // 로그채널확인
  const saved = getLogChannel(interaction.guild.id);
  if (!saved) return interaction.reply({ content: "❌ 설정된 로그 채널이 없어요. `/로그채널 #채널` 로 설정하세요.", ephemeral: true });
  return interaction.reply({ content: `📌 현재 로그 채널: <#${saved}>`, ephemeral: true });
}

// ── 보안뉴스 / 행사 공지 기능 (ctf-discord-bot 포팅 시작점) ──────────
const DEFAULT_EVENT_FEEDS = [
  "https://news.google.com/rss/search?q=%EC%A0%95%EB%B3%B4%EB%B3%B4%EC%95%88%20OR%20%EC%B7%A8%EC%95%BD%EC%A0%90%20OR%20%EB%9E%9C%EC%84%AC%EC%9B%A8%EC%96%B4&hl=ko&gl=KR&ceid=KR:ko",
  "https://news.google.com/rss/search?q=CTF%20OR%20%ED%95%B4%ED%82%B9%EB%B0%A9%EC%96%B4%EB%8C%80%ED%9A%8C%20OR%20%EB%B3%B4%EC%95%88%20%ED%95%B4%EC%BB%A4%ED%86%A4%20OR%20%EB%B3%B4%EC%95%88%20%EC%BB%A8%ED%8D%BC%EB%9F%B0%EC%8A%A4&hl=ko&gl=KR&ceid=KR:ko",
  "https://news.google.com/rss/search?q=%EC%A0%95%EB%B3%B4%EB%B3%B4%ED%98%B8%20%EA%B3%B5%EB%AA%A8%EC%A0%84%20OR%20%EC%82%AC%EC%9D%B4%EB%B2%84%EB%B3%B4%EC%95%88%20%EA%B5%90%EC%9C%A1%20OR%20%EB%B3%B4%EC%95%88%20%EC%BA%A0%ED%94%84&hl=ko&gl=KR&ceid=KR:ko",
  "https://www.boannews.com/media/news_rss.xml?mkind=1",
];

const DEFAULT_EVENT_PAGES = [
  { name: "K-CTF", url: "https://kctf.kr/" },
  { name: "DACON", url: "https://dacon.io/competitions" },
  { name: "CODEGATE", url: "https://codegate.org/" },
  { name: "SECON", url: "https://www.seconexpo.com/" },
  { name: "KISA", url: "https://www.kisa.or.kr/" },
  { name: "KISIA", url: "https://www.kisia.or.kr/" },
  { name: "보안뉴스", url: "https://www.boannews.com/" },
  { name: "WACON", url: "https://wacon.world/" },
  { name: "한국코드페어", url: "https://www.kcf.or.kr/" },
  { name: "정보보호영재교육원", url: "https://gifted.korea.ac.kr/" },
  { name: "국가사이버안보센터", url: "https://www.ncsc.go.kr/" },
];

const EVENT_KIND_LABELS: Record<string, string> = {
  ctf: "CTF 대회",
  ai: "AI 경진대회",
  conference: "국내 보안 컨퍼런스",
  hackathon: "국내 해커톤",
  security: "기타 정보보안",
  news: "정보보안 소식",
};
const EVENT_BUCKET_LABELS: Record<string, string> = {
  within_1m: "1개월-이내",
  within_2m: "2개월-이내",
  later: "그-외",
  final: "본선",
  ended: "종료",
  unknown: "날짜-미정",
  latest: "최신-소식",
};
const EVENT_BUCKETS_BY_KIND: Record<string, string[]> = {
  ctf: ["within_1m", "within_2m", "later", "final", "ended"],
  ai: ["within_1m", "within_2m", "later", "final", "ended"],
  conference: ["within_1m", "within_2m", "later", "ended"],
  hackathon: ["within_1m", "within_2m", "later", "final", "ended"],
  security: ["within_1m", "within_2m", "later", "ended"],
  news: ["latest"],
};
const EVENT_SOURCE_PRIORITY: Record<string, number> = {
  Manual: 0,
  "K-CTF": 1,
  CTFtime: 2,
  DACON: 3,
  CODEGATE: 4,
  SECON: 4,
  한국코드페어: 4,
  WACON: 4,
  KISA: 5,
  KISIA: 5,
  보안뉴스: 5,
  "검색API-보안뉴스": 6,
};

function eventForumKey(item: EventItem): string {
  const kind = item.kind ?? "security";
  if (kind === "news") return "events:news:latest";
  return `events:${kind}:bucket:${item.bucket ?? "unknown"}`;
}

function eventForumKeyFor(kind: string, bucket: string): string {
  if (kind === "news") return "events:news:latest";
  return `events:${kind}:bucket:${bucket}`;
}

function eventFeedUrls(): string[] {
  const extra = (process.env.EVENT_FEED_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...DEFAULT_EVENT_FEEDS, ...extra];
}

function eventPageSources(): { name: string; url: string }[] {
  const extra = (process.env.EVENT_PAGE_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((url) => ({ name: new URL(url).hostname, url }));
  const defaults = DEFAULT_EVENT_PAGES.filter((source) => source.name !== "K-CTF" || envBool("ENABLE_KCTF", true));
  return [...defaults, ...extra];
}

function decodeXml(input: string): string {
  return input
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .trim();
}

function stripHtml(input: string): string {
  return decodeXml(input.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

function normalizeWhitespace(input: string): string {
  return decodeXml(input).replace(/\s+/g, " ").trim();
}

function labelValue(text: string, labels: RegExp): string | undefined {
  for (const raw of text.split(/\r?\n| {2,}/)) {
    const line = normalizeWhitespace(raw);
    if (!labels.test(line)) continue;
    const value = line.split(/[:：]| - /).slice(1).join(":").trim();
    if (value) return value.slice(0, 300);
    if (line.length <= 120) return line.slice(0, 300);
  }
  return undefined;
}

function enrichEventDetails(item: EventItem, text: string) {
  const clean = normalizeWhitespace(text);
  item.organizer ??= labelValue(text, /^(주최|주관|운영|host|organizer)/i);
  item.eligibility ??= labelValue(text, /^(참가\s*대상|참가\s*자격|대상|eligibility|target)/i);
  item.registration ??= labelValue(text, /^(모집|신청|접수|등록|사전\s*등록|registration)/i);
  item.location ??= labelValue(text, /^(장소|위치|개최\s*장소|진행\s*장소|location|venue)/i);
  item.teamLimit ??= labelValue(text, /^(팀\s*(구성|인원|제한)|참가\s*인원|인원\s*제한|team)/i);
  item.participationMode ??= participationMode(clean, item.location);
}

function participationMode(text: string, location?: string): string {
  const combined = `${text} ${location ?? ""}`;
  const online = /\bonline\b|온라인|비대면|remote|virtual/i.test(combined);
  const offline = /\boffline\b|오프라인|대면|현장|서울|부산|대전|인천|광주|대구|제주|코엑스|coex|대학교|센터/i.test(combined);
  if (online && offline) return "온·오프라인 병행";
  if (online) return "온라인";
  if (offline) return "오프라인";
  return "정보 없음";
}

function tagValue(xml: string, tag: string): string {
  return decodeXml(xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1] ?? "");
}

function attrValue(html: string, attr: string): string {
  return decodeXml(html.match(new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1] ?? "");
}

function absoluteUrl(base: string, href: string): string | null {
  if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) return null;
  try {
    return new URL(decodeXml(href), base).toString();
  } catch {
    return null;
  }
}

function eventId(link: string, title: string): string {
  return createHash("sha1").update(link || title).digest("hex").slice(0, 16);
}

function normalizedEventTitle(title: string): string {
  return title
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]*(?:종합|속보|단독|포토|영상|그래픽|보도자료)[^)]*\)/g, " ")
    .replace(/["'“”‘’]/g, "")
    .replace(/\s*[-|:]\s*(?:보안뉴스|데일리시큐|전자신문|아이뉴스24|ZDNET Korea|지디넷코리아|연합뉴스|뉴스1|뉴시스|매일경제|한국경제|이데일리|파이낸셜뉴스).*$/i, "")
    .replace(/[^a-z0-9가-힣]+/gi, "")
    .toLowerCase();
}

function eventDedupeKey(item: EventItem): string {
  // 제목만 정규화해 묶는다 — 같은 기사가 매체/요약만 달라 중복되는 것을 막는다.
  const title = normalizedEventTitle(item.title);
  const day = item.kind === "news" ? "" : item.startsAt ? new Date(item.startsAt).toISOString().slice(0, 10) : "";
  return `${item.kind ?? "security"}:${title}:${day}`;
}

function isUsefulEventItem(title: string, summary: string): boolean {
  const text = `${title} ${summary}`.toLowerCase();
  return /ctf|해킹방어|사이버공격방어|정보보안|정보보호|보안|취약점|랜섬웨어|해커톤|컨퍼런스|kisa|침해사고|악성코드|제로데이|공모전|교육|캠프|세미나|대회|경진대회|codegate|secon|wacon|dacon|데이콘/i.test(text);
}

function isSecurityNews(title: string, summary: string): boolean {
  return /취약점|침해사고|랜섬웨어|악성코드|보안패치|제로데이|CVE|해킹|개인정보|유출|사이버공격|보안뉴스|위협/i.test(
    `${title} ${summary}`,
  );
}

function looksLikeResultNews(title: string, summary: string): boolean {
  return /수상|입상|최우수상|우수상|장려상|대상|성과|성료|마무리|개최\s*(?:결과|성과)|시상식|차지|선정/i.test(
    `${title} ${summary}`,
  );
}

function classifyEvent(title: string, summary: string): string {
  const titleOnly = title.toLowerCase();
  const text = `${title} ${summary}`.toLowerCase();
  if (/ctf|capture the flag|ctftime|codegate|wacon/i.test(titleOnly)) return "ctf";
  if (/해킹방어|사이버공격방어/i.test(titleOnly) && /대회|경진대회|예선|본선|참가|접수|모집|개최|안내/i.test(title)) return "ctf";
  if (/ai|인공지능|머신러닝|데이터\s*분석|dacon|데이콘/i.test(text)) return "ai";
  if (/해커톤|hackathon/i.test(text)) return "hackathon";
  if (/컨퍼런스|conference|세미나|포럼|secon|codegate/i.test(text)) return "conference";
  if (isSecurityNews(title, summary)) return "news";
  return "security";
}

function isEventAnnouncement(title: string, summary: string): boolean {
  const text = `${title} ${summary}`;
  return /대회|경진대회|해커톤|컨퍼런스|세미나|포럼|교육|캠프|공모전|모집|접수|참가|신청|개최|일정|안내|예선|본선|결승|CTF|CODEGATE|SECON|WACON|DACON/i.test(text);
}

function shouldPublishAutoEvent(item: EventItem): boolean {
  const now = Date.now();
  if (item.kind === "news") return item.publishedAt >= now - 30 * 86400000 && isSecurityNews(item.title, item.summary ?? "");
  if (looksLikeResultNews(item.title, item.summary ?? "")) return false;
  // 이미 끝난 행사는 새로 올리지 않음 (원본 봇과 동일 — 진행 예정/진행 중만 게시)
  if (item.endsAt && item.endsAt < now) return false;
  // 종료 시각을 모르면 시작 시각 기준: 12시간 넘게 지난 건 제외
  if (!item.endsAt) {
    if (!item.startsAt) return false;
    if (item.startsAt < now - 12 * 3600000) return false;
  }
  if (!item.source.startsWith("검색API") && !item.source.startsWith("자동탐색")) return true;
  return isEventAnnouncement(item.title, item.summary ?? "");
}

/** 종류별(CTF→AI→…→뉴스) 라운드로빈으로 섞어, 뉴스가 CTF를 굶기지 않게 한다. (원본 봇 interleave) */
const EVENT_KIND_ORDER = ["ctf", "ai", "conference", "hackathon", "security", "news"];
function interleaveEvents(events: EventItem[]): EventItem[] {
  const dateKey = (e: EventItem) => e.startsAt ?? e.endsAt ?? e.publishedAt ?? Number.MAX_SAFE_INTEGER;
  const queues: EventItem[][] = EVENT_KIND_ORDER.map((kind) =>
    events.filter((e) => (e.kind ?? "security") === kind).sort((a, b) => dateKey(a) - dateKey(b)),
  );
  const other = events.filter((e) => !EVENT_KIND_ORDER.includes(e.kind ?? "security")).sort((a, b) => dateKey(a) - dateKey(b));
  queues.push(other);
  const ordered: EventItem[] = [];
  let i = 0;
  let drained = false;
  while (!drained) {
    drained = true;
    for (const q of queues) {
      if (i < q.length) {
        ordered.push(q[i]);
        drained = false;
      }
    }
    i++;
  }
  return ordered;
}

function looksMostlyEnglish(input: string): boolean {
  const letters = input.match(/[A-Za-z]/g)?.length ?? 0;
  const korean = input.match(/[가-힣]/g)?.length ?? 0;
  return letters > 20 && letters > korean * 2;
}

function translatedHint(item: EventItem): string | undefined {
  if (!envBool("ENABLE_TRANSLATION", false)) return undefined;
  if (!looksMostlyEnglish(`${item.title} ${item.summary ?? ""}`)) return undefined;
  const kind = EVENT_KIND_LABELS[item.kind ?? "security"] ?? "보안 행사";
  const when = item.startsAt ? new Date(item.startsAt).toISOString().slice(0, 10) : "날짜 미정";
  return `자동 분류: ${kind} · 일정: ${when}`;
}

function extractDateMs(text: string): number | undefined {
  const nowYear = new Date().getFullYear();
  const patterns = [
    /((?:20)?\d{2})[.\-/년]\s*(\d{1,2})[.\-/월]\s*(\d{1,2})/g,
    /(\d{1,2})[.\-/월]\s*(\d{1,2})/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const year = m.length === 4 ? Number(m[1].length === 2 ? `20${m[1]}` : m[1]) : nowYear;
      const month = Number(m.length === 4 ? m[2] : m[1]);
      const day = Number(m.length === 4 ? m[3] : m[2]);
      const dt = new Date(year, month - 1, day, 9, 0, 0);
      if (dt.getMonth() === month - 1 && dt.getDate() === day) return dt.getTime();
    }
  }
  return undefined;
}

function bucketForEvent(item: Pick<EventItem, "kind" | "title" | "startsAt" | "endsAt" | "publishedAt">): string {
  const now = Date.now();
  const lowerTitle = item.title.toLowerCase();
  const target = item.endsAt ?? item.startsAt;
  if (item.kind === "news") return "latest";
  if (target && target < now) return "ended";
  if (item.kind === "ctf" && /final|main round|본선|결승|데모데이/i.test(lowerTitle)) return "final";
  if (!target) return "unknown";
  const days = (target - now) / 86400000;
  if (days <= 31) return "within_1m";
  if (days <= 62) return "within_2m";
  return "later";
}

async function fetchEventFeed(url: string): Promise<EventItem[]> {
  const res = await fetch(url, { headers: { "User-Agent": "discord-ctf-bot/1.0" } });
  if (!res.ok) throw new Error(`RSS 응답 실패 ${res.status}`);
  const xml = await res.text();
  const source = tagValue(xml, "title") || new URL(url).hostname;
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  return blocks
    .map((block) => {
      const title = stripHtml(tagValue(block, "title"));
      const link = tagValue(block, "link");
      const summary = stripHtml(tagValue(block, "description"));
      const pubDate = Date.parse(tagValue(block, "pubDate") || tagValue(block, "updated"));
      const startsAt = extractDateMs(`${title} ${summary}`);
      const kind = classifyEvent(title, summary);
      const item: EventItem = {
        id: eventId(link, title),
        guildId: "",
        title,
        link,
        source: stripHtml(source).replace(/^"|"$/g, ""),
        kind,
        summary,
        publishedAt: Number.isFinite(pubDate) ? pubDate : Date.now(),
        startsAt,
        bucket: bucketForEvent({ kind, title, startsAt, publishedAt: Number.isFinite(pubDate) ? pubDate : Date.now() }),
      };
      enrichEventDetails(item, `${title}\n${summary}`);
      return item;
    })
    .filter((item) => item.title && item.link && isUsefulEventItem(item.title, item.summary ?? ""));
}

async function fetchCtftimeRange(start: number, finish: number, limit: number): Promise<any[]> {
  const res = await fetch(`https://ctftime.org/api/v1/events/?limit=${limit}&start=${start}&finish=${finish}`, {
    headers: { "User-Agent": "discord-ctf-bot/1.0 (+Discord CTF event aggregator)" },
  });
  if (!res.ok) throw new Error(`CTFtime 응답 실패 ${res.status}`);
  const json: any = await res.json();
  return Array.isArray(json) ? json : [];
}

async function fetchCtftimeEvents(): Promise<EventItem[]> {
  const now = Math.floor(Date.now() / 1000);
  const lookaheadDays = Math.max(30, Number(process.env.LOOKAHEAD_DAYS ?? 365) || 365);
  // 원본 봇과 동일: 진행 중/방금 시작한 대회까지 잡으려고 두 구간을 합친다.
  //  - 미래: now-12h ~ now+lookahead (진행 중인 CTF 포함)
  //  - 최근: now-14d ~ now (막 끝난 CTF 포함)
  const [futureRows, recentRows] = await Promise.all([
    fetchCtftimeRange(now - 12 * 3600, now + lookaheadDays * 86400, 200),
    fetchCtftimeRange(now - 14 * 86400, now, 100),
  ]);
  const byId = new Map<string, any>();
  for (const row of [...recentRows, ...futureRows]) byId.set(String(row?.id), row);
  return [...byId.values()]
    .map((event) => {
      const title = String(event.title ?? "").trim();
      const link = String(event.url || event.ctftime_url || "").trim();
      const startsAt = Date.parse(event.start);
      const endsAt = Date.parse(event.finish);
      const publishedAt = Number.isFinite(startsAt) ? startsAt : Date.now();
      const organizers = Array.isArray(event.organizers)
        ? event.organizers.map((org: any) => org?.name).filter(Boolean).join(", ")
        : "";
      const location = event.location ? String(event.location) : undefined;
      const description = event.description ? stripHtml(String(event.description)) : "";
      const item: EventItem = {
        id: eventId(link || String(event.id), `ctftime:${event.id}:${title}`),
        guildId: "",
        title,
        link: link || String(event.ctftime_url || "https://ctftime.org/event/list/"),
        source: "CTFtime",
        kind: "ctf",
        summary: description,
        publishedAt,
        startsAt: Number.isFinite(startsAt) ? startsAt : undefined,
        endsAt: Number.isFinite(endsAt) ? endsAt : undefined,
        organizer: organizers || undefined,
        location,
        participationMode: participationMode(`${event.format ?? ""} ${description}`, location),
        genres: Array.isArray(event.categories) ? event.categories.map((x: any) => String(x?.name ?? x)).filter(Boolean) : undefined,
      };
      item.bucket = bucketForEvent(item);
      return item;
    })
    .filter((item) => item.title && item.link);
}

async function fetchEventPage(source: { name: string; url: string }): Promise<EventItem[]> {
  const res = await fetch(source.url, { headers: { "User-Agent": "discord-ctf-bot/1.0" } });
  if (!res.ok) throw new Error(`HTML 응답 실패 ${res.status}`);
  const html = await res.text();
  const items: EventItem[] = [];
  const seen = new Set<string>();
  const anchors = [...html.matchAll(/<a\b[\s\S]*?<\/a>/gi)].slice(0, 400);

  for (const match of anchors) {
    const block = match[0];
    const href = attrValue(block, "href");
    const link = absoluteUrl(source.url, href);
    if (!link || seen.has(link)) continue;
    seen.add(link);

    const title = stripHtml(block).replace(/\[[^\]]*\]/g, "").trim();
    if (title.length < 4 || title.length > 180) continue;

    const idx = Math.max(0, match.index ?? 0);
    const context = stripHtml(html.slice(Math.max(0, idx - 500), Math.min(html.length, idx + block.length + 500)));
    if (!isUsefulEventItem(title, context)) continue;

    const startsAt = extractDateMs(`${title} ${context}`);
    const kind = classifyEvent(`${source.name} ${title}`, context);
    const publishedAt = startsAt ?? Date.now();
    const item: EventItem = {
      id: eventId(link, `${source.name}:${title}`),
      guildId: "",
      title,
      link,
      source: source.name,
      kind,
      summary: normalizeWhitespace(context).slice(0, 700),
      publishedAt,
      startsAt,
    };
    enrichEventDetails(item, context);
    item.bucket = bucketForEvent(item);
    items.push(item);
  }

  const pageTitle = stripHtml(tagValue(html, "title"));
  if (isUsefulEventItem(pageTitle, html)) {
    const startsAt = extractDateMs(html);
    const kind = classifyEvent(`${source.name} ${pageTitle}`, html);
    const item: EventItem = {
      id: eventId(source.url, `${source.name}:${pageTitle}`),
      guildId: "",
      title: pageTitle || source.name,
      link: source.url,
      source: source.name,
      kind,
      summary: stripHtml(html).slice(0, 700),
      publishedAt: startsAt ?? Date.now(),
      startsAt,
    };
    enrichEventDetails(item, html);
    item.bucket = bucketForEvent(item);
    items.push(item);
  }

  return items;
}

async function fetchSingleEventUrl(url: string): Promise<EventItem | null> {
  const source = { name: new URL(url).hostname, url };
  const items = await fetchEventPage(source);
  return items[0] ?? null;
}

async function fetchNaverSearchEvents(): Promise<EventItem[]> {
  const clientId = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return [];
  if (process.env.ENABLE_SEARCH_API_DISCOVERY === "false") return [];

  const maxResults = Math.min(100, Math.max(10, Number(process.env.SEARCH_API_MAX_RESULTS ?? 30) || 30));
  const queries = [
    { name: "검색API-CTF", query: "CTF 대회 모집 OR 해킹방어대회 접수 OR 사이버공격방어대회", kind: "ctf", requireDate: true },
    { name: "검색API-CTF-해외", query: "CTF competition registration cybersecurity challenge", kind: "ctf", requireDate: true },
    { name: "검색API-AI대회", query: "AI 경진대회 모집 OR 인공지능 공모전 OR 데이터 경진대회 접수", kind: "ai", requireDate: true },
    { name: "검색API-AI보안", query: "AI 보안 해커톤 OR AI security hackathon OR 사이버보안 AI 경진대회", kind: "ai", requireDate: true },
    { name: "검색API-해커톤", query: "정보보안 해커톤 모집 OR 사이버보안 해커톤 참가", kind: "hackathon", requireDate: true },
    { name: "검색API-컨퍼런스", query: "정보보안 컨퍼런스 OR 사이버보안 세미나 OR 보안 포럼", kind: "conference", requireDate: true },
    { name: "검색API-고등학생보안", query: "고등학생 정보보안 모집 OR 고등학교 사이버보안 캠프 OR 청소년 보안 경진대회 접수", kind: "security", requireDate: true },
    { name: "검색API-보안뉴스", query: "정보보안 취약점 랜섬웨어 침해사고 보안패치", kind: "news", requireDate: false },
  ];
  const out: EventItem[] = [];

  for (const query of queries) {
    for (const api of [
      { endpoint: "webkr.json", source: "Naver Web", dated: false },
      { endpoint: "news.json", source: "Naver News", dated: true },
    ]) {
      const url = new URL(`https://openapi.naver.com/v1/search/${api.endpoint}`);
      url.searchParams.set("query", query.query);
      url.searchParams.set("display", String(Math.min(maxResults, 100)));
      url.searchParams.set("sort", api.dated ? "date" : "sim");

      const res = await fetch(url, {
        headers: {
          "X-Naver-Client-Id": clientId,
          "X-Naver-Client-Secret": clientSecret,
          "User-Agent": "discord-ctf-bot/1.0",
        },
      });
      if (!res.ok) throw new Error(`Naver ${api.source} 응답 실패 ${res.status}`);
      const json: any = await res.json();
      for (const row of Array.isArray(json?.items) ? json.items : []) {
        const title = stripHtml(String(row.title ?? ""));
        const summary = stripHtml(String(row.description ?? ""));
        const link = String(row.originallink || row.link || "");
        if (!title || !link || !isUsefulEventItem(title, summary)) continue;
        const pubDate = Date.parse(String(row.pubDate ?? ""));
        const startsAt = extractDateMs(`${title} ${summary}`);
        const kind = query.kind;
        if (kind === "news") {
          if (!isSecurityNews(title, summary)) continue;
          if (Number.isFinite(pubDate) && pubDate < Date.now() - 30 * 86400000) continue;
        } else {
          if (query.requireDate && !startsAt) continue;
          if (startsAt && startsAt < Date.now() - 3 * 86400000) continue;
          if (!isEventAnnouncement(title, summary) || looksLikeResultNews(title, summary)) continue;
        }
        const item: EventItem = {
          id: eventId(link, `naver:${query.name}:${api.source}:${title}`),
          guildId: "",
          title,
          link,
          source: query.name,
          kind,
          summary,
          publishedAt: Number.isFinite(pubDate) ? pubDate : Date.now(),
          startsAt: kind === "news" ? (Number.isFinite(pubDate) ? pubDate : Date.now()) : startsAt,
        };
        enrichEventDetails(item, `${title}\n${summary}`);
        item.bucket = bucketForEvent(item);
        out.push(item);
      }
    }
  }

  return out;
}

async function ensureEventForum(guild: Guild, item: EventItem): Promise<ForumChannel> {
  const kind = item.kind ?? "security";
  const bucket = kind === "news" ? "latest" : item.bucket ?? "unknown";
  return ensureEventForumFor(guild, kind, bucket);
}

async function ensureEventForumFor(guild: Guild, kind: string, bucket: string): Promise<ForumChannel> {
  const kindLabel = EVENT_KIND_LABELS[kind] ?? "보안 행사";
  const categoryId = await ensureEventCategory(guild, kind);
  const key = eventForumKeyFor(kind, bucket);
  const existingId = getForumFor(guild.id, key);
  if (existingId) {
    const ch = guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
    if (ch && ch.type === ChannelType.GuildForum) return ch as ForumChannel;
  }

  if (kind === "news") {
    const ch = await guild.channels.create({
      name: EVENT_BUCKET_LABELS.latest,
      type: ChannelType.GuildForum,
      parent: categoryId,
      topic: `${kindLabel} 최신 소식`,
    });
    setForumFor(guild.id, key, ch.id);
    return ch as ForumChannel;
  }

  const bucketLabel = EVENT_BUCKET_LABELS[bucket] ?? bucket;
  const ch = await guild.channels.create({
    name: bucketLabel,
    type: ChannelType.GuildForum,
    parent: categoryId,
    topic: `${kindLabel} · ${bucketLabel}`,
  });
  setForumFor(guild.id, key, ch.id);
  return ch as ForumChannel;
}

async function ensureEventForums(guild: Guild) {
  for (const kind of Object.keys(EVENT_KIND_LABELS)) {
    const buckets = EVENT_BUCKETS_BY_KIND[kind] ?? ["within_1m", "within_2m", "later", "ended"];
    for (const bucket of buckets) await ensureEventForumFor(guild, kind, bucket);
  }
}

async function ensureEventCategory(guild: Guild, kind: string): Promise<string> {
  const label = EVENT_KIND_LABELS[kind] ?? "보안 행사";
  const key = `eventcat:${kind}`;
  const existingId = getForumFor(guild.id, key);
  if (existingId) {
    const ch = guild.channels.cache.get(existingId) ?? (await guild.channels.fetch(existingId).catch(() => null));
    if (ch && ch.type === ChannelType.GuildCategory) return ch.id;
  }
  const ch = await guild.channels.create({
    name: label.slice(0, 95),
    type: ChannelType.GuildCategory,
  });
  setForumFor(guild.id, key, ch.id);
  return ch.id;
}

async function updateEventIndex(guild: Guild, forum: ForumChannel, key: string) {
  const items = getGuildEventItems(guild.id)
    .filter((item) => eventForumKey(item) === key)
    .sort((a, b) => (a.startsAt ?? a.publishedAt) - (b.startsAt ?? b.publishedAt));
  if (items.length === 0) return;

  const lines = items.slice(0, 50).map((item) => {
    const day = item.startsAt ? new Date(item.startsAt).toISOString().slice(0, 10) : "날짜 미정";
    return `• ${day} [${item.title}](${item.link})`;
  });
  const embed = new EmbedBuilder()
    .setTitle("일정표")
    .setColor(0x2b8a3e)
    .setDescription(lines.join("\n").slice(0, 4000))
    .setFooter({ text: "새 공지가 늦게 올라와도 이 일정표는 행사 날짜순으로 다시 정렬됩니다." });

  const indexKey = `eventindex:${key}`;
  const existingId = getForumFor(guild.id, indexKey);
  if (existingId) {
    const thread = await guild.channels.fetch(existingId).catch(() => null);
    if (thread?.isThread()) {
      if (thread.archived) await thread.setArchived(false).catch(() => {});
      const starter = await thread.fetchStarterMessage().catch(() => null);
      if (starter) {
        await starter.edit({ embeds: [embed] }).catch(() => {});
        return;
      }
    }
  }

  const thread = await forum.threads.create({
    name: "📌 일정표",
    message: { embeds: [embed] },
    reason: "보안뉴스/행사 날짜순 일정표 생성",
  });
  setForumFor(guild.id, indexKey, thread.id);
}

async function publishEventItem(guild: Guild, item: EventItem): Promise<boolean> {
  const next = { ...item, guildId: guild.id };
  next.kind = next.kind ?? classifyEvent(next.title, next.summary ?? "");
  next.startsAt = next.startsAt ?? (next.kind === "news" ? next.publishedAt : extractDateMs(`${next.title} ${next.summary ?? ""}`));
  next.bucket = bucketForEvent(next);
  if (hasEventItem(guild.id, next.id)) return false;
  const dedupeKey = eventDedupeKey(next);
  if (getGuildEventItems(guild.id).some((item) => eventDedupeKey(item) === dedupeKey)) return false;

  const forum = await ensureEventForum(guild, next);
  const forumKey = eventForumKey(next);
  const post = await forum.threads.create({
    name: eventPostTitle(next),
    message: { embeds: [eventEmbed(next)] },
    reason: `보안뉴스/행사 등록: ${next.title}`,
  });
  addEventItem({ ...next, postedAt: Date.now(), messageId: post.id });
  await updateEventIndex(guild, forum, forumKey);
  return true;
}

function eventPostTitle(item: EventItem): string {
  const day = item.startsAt ? new Date(item.startsAt).toISOString().slice(0, 10) : "날짜 미정";
  const region = eventRegion(item);
  const label =
    item.kind === "ctf"
      ? region === "kr"
        ? "한국 CTF"
        : "해외 CTF"
      : item.kind === "ai"
        ? "AI 경진대회"
        : item.kind === "hackathon"
          ? region === "kr"
            ? "국내 해커톤"
            : "해외 해커톤"
          : item.kind === "conference"
            ? "국내 컨퍼런스"
            : item.kind === "news"
              ? "정보보안 소식"
              : "기타 정보보안";
  return `${day} [${label}] ${item.title}`.slice(0, 95);
}

function eventRegion(item: EventItem): "kr" | "global" {
  if (item.region === "kr" || item.region === "global") return item.region;
  const text = `${item.source} ${item.link} ${item.title} ${item.summary ?? ""} ${item.location ?? ""}`;
  if (/\.kr\b|kisa|kisia|kctf|codegate|secon|wacon|dacon|데이콘|한국|국내|서울|부산|대전|인천|광주|대구|제주/i.test(text)) {
    return "kr";
  }
  return "global";
}

function eventEmbed(item: EventItem): EmbedBuilder {
  const missing = "명시되어 있지 않음";
  const isConference = item.kind === "conference";
  const isOther = item.kind === "security";
  const isNews = item.kind === "news";
  const embed = new EmbedBuilder()
    .setTitle(item.title.slice(0, 256))
    .setURL(item.link)
    .setColor(0x5865f2)
    .setTimestamp(item.publishedAt);
  const hint = translatedHint(item);
  const description = [hint, item.summary?.slice(0, 350)].filter(Boolean).join("\n\n");
  if (description) embed.setDescription(description);
  if (isNews) {
    embed.addFields(
      { name: "소식", value: item.title || missing, inline: false },
      { name: "게시일", value: formatDiscordTime(item.startsAt ?? item.publishedAt), inline: false },
      { name: "원문 링크", value: item.link || missing, inline: false },
    );
    embed.setFooter({ text: `출처: ${item.source}` });
    return embed;
  }
  embed.addFields(
    { name: isOther ? "프로그램명" : isConference ? "행사명" : "대회명", value: item.title || missing, inline: false },
    { name: "주최 기관", value: item.organizer || missing, inline: true },
    { name: "참가 대상", value: item.eligibility || missing, inline: true },
    {
      name: isOther ? "모집 일정" : isConference ? "사전 등록 일정" : "모집 및 접수 일정",
      value: item.registration || (item.registrationDeadline ? `접수 마감: ${formatDiscordTime(item.registrationDeadline)}` : missing),
      inline: false,
    },
  );
  if (item.startsAt) {
    embed.addFields({
      name: isOther ? "교육 일정" : isConference ? "행사 일정" : "대회 일정",
      value: item.endsAt ? `${formatDiscordTime(item.startsAt)} ~ ${formatDiscordTime(item.endsAt)}` : formatDiscordTime(item.startsAt),
      inline: false,
    });
  }
  if (item.genres?.length && !isConference && !isOther) embed.addFields({ name: "분야", value: item.genres.join(" · "), inline: false });
  if (item.teamLimit && !isConference && !isOther) embed.addFields({ name: "팀 제한", value: item.teamLimit, inline: true });
  embed.addFields({ name: "진행 방식", value: item.participationMode || "정보 없음", inline: true });
  embed.addFields({ name: "장소", value: item.location || missing, inline: true });
  embed.addFields({ name: isOther ? "안내 링크" : isConference ? "행사 링크" : "대회 링크", value: item.registrationUrl || item.link || missing, inline: false });
  if (item.posterUrl) embed.setImage(item.posterUrl);
  embed.setFooter({ text: `출처: ${item.source}` });
  return embed;
}

function formatDiscordTime(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:f>`;
}

async function syncEvents(guild: Guild): Promise<{ fetched: number; posted: number }> {
  const items: EventItem[] = [];
  const errors: string[] = [];
  try {
    items.push(...(await fetchCtftimeEvents()));
  } catch (e: any) {
    errors.push(`CTFtime: ${e?.message ?? "실패"}`);
  }
  for (const url of eventFeedUrls()) {
    try {
      items.push(...(await fetchEventFeed(url)));
    } catch (e: any) {
      errors.push(`${new URL(url).hostname}: ${e?.message ?? "실패"}`);
    }
  }
  for (const source of eventPageSources()) {
    try {
      items.push(...(await fetchEventPage(source)));
    } catch (e: any) {
      errors.push(`${source.name}: ${e?.message ?? "실패"}`);
    }
  }
  try {
    items.push(...(await fetchNaverSearchEvents()));
  } catch (e: any) {
    errors.push(`Naver: ${e?.message ?? "실패"}`);
  }

  const unique = new Map<string, EventItem>();
  for (const item of items) {
    const startsAt = item.startsAt ?? extractDateMs(`${item.title} ${item.summary ?? ""}`);
    const next = { ...item, guildId: guild.id, startsAt };
    next.kind = next.kind ?? classifyEvent(next.title, next.summary ?? "");
    next.bucket = bucketForEvent(next);
    if (!shouldPublishAutoEvent(next)) continue;
    const dedupeKey = eventDedupeKey(next);
    const existing = unique.get(dedupeKey);
    const existingPriority = existing ? EVENT_SOURCE_PRIORITY[existing.source] ?? 10 : 99;
    const nextPriority = EVENT_SOURCE_PRIORITY[next.source] ?? 10;
    if (!existing || nextPriority < existingPriority) unique.set(dedupeKey, next);
  }

  // 뉴스는 너무 많아지지 않게 최신 일부만 (행사/대회가 뉴스에 묻히지 않도록)
  const NEWS_LIMIT = Math.max(1, Number(process.env.NEWS_LIMIT ?? 12) || 12);
  const all = [...unique.values()];
  const news = all
    .filter((e) => e.kind === "news")
    .sort((a, b) => (b.startsAt ?? b.publishedAt) - (a.startsAt ?? a.publishedAt))
    .slice(0, NEWS_LIMIT);
  const nonNews = all.filter((e) => e.kind !== "news");
  // 종류별 라운드로빈으로 섞어 한 종류(뉴스)가 독식하지 못하게 한다.
  const ordered = interleaveEvents([...nonNews, ...news]).slice(0, 150);

  let posted = 0;
  const touchedForums = new Map<string, ForumChannel>();
  for (const item of ordered) {
    const before = getGuildEventItems(guild.id).length;
    if (await publishEventItem(guild, item).catch(() => false)) {
      const saved = getGuildEventItems(guild.id)[0];
      if (saved && getGuildEventItems(guild.id).length > before) {
        const forum = await ensureEventForum(guild, saved);
        touchedForums.set(eventForumKey(saved), forum);
      }
      posted++;
    }
  }
  for (const [key, forum] of touchedForums) await updateEventIndex(guild, forum, key);

  setEventStatus(guild.id, {
    lastSyncAt: Date.now(),
    lastOk: errors.length === 0,
    lastMessage: errors.length ? errors.join(", ").slice(0, 500) : "정상",
    fetched: unique.size,
    posted,
  });
  return { fetched: unique.size, posted };
}

function parseManualEventLine(line: string): EventItem | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split("|").map((p) => p.trim());
  const [datePart, titlePart, urlPart, kindPart] = parts.length >= 3 ? parts : ["", parts[0], parts[1], parts[2]];
  const title = titlePart?.trim();
  const link = urlPart?.trim();
  if (!title || !link) return null;
  const startsAt = extractDateMs(datePart || title);
  const kind = kindPart || classifyEvent(title, "");
  const item: EventItem = {
    id: eventId(link, `manual:${title}`),
    guildId: "",
    title,
      link,
      source: "Manual",
      kind,
      summary: datePart ? `수동 등록 날짜: ${datePart}` : "",
      publishedAt: startsAt ?? Date.now(),
      startsAt,
      manual: true,
  };
  item.bucket = bucketForEvent(item);
  return item;
}

async function handleEventCommand(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });

  if (interaction.commandName === "event_sync") {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    try {
      await ensureEventForums(interaction.guild);
      const result = await syncEvents(interaction.guild);
      return interaction.editReply(`✅ 수집 완료: ${result.fetched}개 확인, 새 글 ${result.posted}개 게시`);
    } catch (e: any) {
      setEventStatus(interaction.guild.id, {
        lastSyncAt: Date.now(),
        lastOk: false,
        lastMessage: e?.message ?? "수집 실패",
        fetched: 0,
        posted: 0,
      });
      return interaction.editReply(`❌ 수집 실패: ${e?.message ?? "알 수 없는 오류"}`);
    }
  }

  if (interaction.commandName === "event_add") {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    const title = interaction.options.getString("title", true).trim();
    const link = interaction.options.getString("url", true).trim();
    const date = interaction.options.getString("date")?.trim() ?? "";
    const startsAt = date ? extractDateMs(date) : undefined;
    const kind = interaction.options.getString("kind") ?? classifyEvent(title, "");
    const item: EventItem = {
      id: eventId(link, `manual:${title}`),
      guildId: interaction.guild.id,
      title,
      link,
      source: "Manual",
      kind,
      summary: date ? `수동 등록 날짜: ${date}` : "",
      publishedAt: startsAt ?? Date.now(),
      startsAt,
      manual: true,
    };
    item.bucket = bucketForEvent(item);
    const posted = await publishEventItem(interaction.guild, item);
    return interaction.reply({ content: posted ? "✅ 보안뉴스/행사를 등록했습니다." : "이미 등록된 항목입니다.", ephemeral: true });
  }

  if (interaction.commandName === "event_import") {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    const modal = new ModalBuilder().setCustomId("eventimport").setTitle("보안뉴스/행사 목록 가져오기").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("list")
          .setLabel("한 줄에 하나: 날짜 | 제목 | URL | 분류")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000)
          .setPlaceholder("2026-07-10 | Example CTF | https://example.com | ctf"),
      ),
    );
    return interaction.showModal(modal);
  }

  if (interaction.commandName === "event_import_url") {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const url = interaction.options.getString("url", true).trim();
    const item = await fetchSingleEventUrl(url).catch(() => null);
    if (!item) return interaction.editReply("❌ 해당 URL에서 행사 정보를 찾지 못했습니다.");
    item.manual = true;
    const posted = await publishEventItem(interaction.guild, item);
    return interaction.editReply(posted ? `✅ 등록했습니다: ${item.title}` : "이미 등록된 항목입니다.");
  }

  if (interaction.commandName === "event_remove") {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    const items = getGuildEventItems(interaction.guild.id).filter((item) => item.manual).slice(0, 25);
    if (items.length === 0) return interaction.reply({ content: "삭제할 항목이 없습니다.", ephemeral: true });
    const menu = new StringSelectMenuBuilder()
      .setCustomId("eventremove_select")
      .setPlaceholder("삭제할 항목을 고르세요")
      .addOptions(
        items.map((item) => ({
          label: `${item.startsAt ? new Date(item.startsAt).toISOString().slice(0, 10) : "날짜 미정"} ${item.title}`.slice(0, 100),
          value: item.id,
          description: (item.source ?? "").slice(0, 100),
        })),
      );
    return interaction.reply({
      content: "삭제할 보안뉴스/행사를 선택하세요.",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      ephemeral: true,
    });
  }

  if (interaction.commandName === "event_reset") {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    if (interaction.options.getBoolean("confirm") === true) {
      await interaction.deferReply({ ephemeral: true });
      const result = await resetEventFeature(interaction.guild);
      return interaction.editReply(`🧨 리셋 완료: 채널/스레드 ${result.channels}개 삭제, 수집 기록 ${result.items}개 초기화`);
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("eventreset_confirm").setLabel("삭제").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("eventreset_cancel").setLabel("취소").setStyle(ButtonStyle.Secondary),
    );
    return interaction.reply({
      content: "🧨 보안뉴스/행사 기능이 만든 포럼·일정표 스레드와 수집 기록을 삭제할까요? 되돌릴 수 없습니다.",
      components: [row],
      ephemeral: true,
    });
  }

  if (interaction.commandName === "event_list_manual") {
    const items = getGuildEventItems(interaction.guild.id).filter((item) => item.manual).slice(0, 25);
    if (items.length === 0) return interaction.reply({ content: "수동 등록 행사가 없습니다.", ephemeral: true });
    const embed = new EmbedBuilder()
      .setTitle("수동 등록 행사")
      .setColor(0x2b8a3e)
      .setDescription(
        items
          .map((item) => `• ${item.startsAt ? new Date(item.startsAt).toISOString().slice(0, 10) : "날짜 미정"} [${item.title}](${item.link})`)
          .join("\n")
          .slice(0, 4000),
      );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === "event_status") {
    const status = getEventStatus(interaction.guild.id);
    const last = status.lastSyncAt ? `<t:${Math.floor(status.lastSyncAt / 1000)}:R>` : "아직 없음";
    return interaction.reply({
      content: `상태: ${status.lastOk === false ? "오류" : "정상"}\n마지막 수집: ${last}\n확인: ${status.fetched ?? 0}개 · 게시: ${status.posted ?? 0}개\n메시지: ${status.lastMessage ?? "-"}`,
      ephemeral: true,
    });
  }

  const count = interaction.options.getInteger("count") ?? 10;
  const items = getGuildEventItems(interaction.guild.id).slice(0, count);
  if (items.length === 0) return interaction.reply({ content: "아직 수집된 보안뉴스/행사가 없습니다. `/event_sync`를 먼저 실행하세요.", ephemeral: true });
  const embed = new EmbedBuilder()
    .setTitle("최근 보안뉴스 · 행사")
    .setColor(0x2b8a3e)
    .setDescription(items.map((item) => `• [${item.title}](${item.link}) · <t:${Math.floor(item.publishedAt / 1000)}:R>`).join("\n").slice(0, 4000));
  return interaction.reply({ embeds: [embed], ephemeral: true });
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
    if (p.solved) return interaction.reply({ content: "이미 풀린 문제예요. (처음 푼 사람만 인정)", ephemeral: true });
    ctfSolveDrafts.set(interaction.user.id, { problemId: p.id, solver: interaction.user.id });
    const solverRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder().setCustomId("solve_solver").setPlaceholder("푼 사람 (기본: 나)").setMinValues(1).setMaxValues(1),
    );
    const helperRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder().setCustomId("solve_helpers").setPlaceholder("도와준 사람 (선택, 0.5솔브)").setMinValues(0).setMaxValues(10),
    );
    const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("solve_confirm").setLabel("기록").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("solve_cancel").setLabel("취소").setStyle(ButtonStyle.Danger),
    );
    return interaction.reply({
      content: `🏅 **${p.name}** (${p.ctfName}) 풀이 기록 — 푼 사람(1솔브)과 도와준 사람(0.5솔브)을 고르고 **기록**을 누르세요.`,
      components: [solverRow, helperRow, btnRow],
      ephemeral: true,
    });
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

  if (sub === "시간") {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    const ctfNameOpt = interaction.options.getString("ctf", true).trim();
    const dur = parseDuration(interaction.options.getString("기간", true));
    if (!dur) return interaction.reply({ content: "기간을 인식하지 못했어요. 예: `24h`, `2d`, `1d12h`, `90m`", ephemeral: true });
    const ctfKey = keyOf(ctfNameOpt);
    const start = Date.now();
    const end = start + dur;
    setCtfTime(guildId, ctfKey, start, end);
    return interaction.reply({
      content: `⏰ **${ctfNameOpt}** 대회 기간: <t:${Math.floor(start / 1000)}:f> ~ <t:${Math.floor(end / 1000)}:f> (<t:${Math.floor(end / 1000)}:R> 종료)`,
    });
  }

  if (sub === "스코어보드") {
    const filter = interaction.options.getString("ctf") ?? undefined;
    return interaction.reply({ embeds: [buildCtfScoreboard(guildId, filter)] });
  }

  if (sub === "점수추가") {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    const target = interaction.options.getUser("user", true);
    const amount = interaction.options.getString("기여") ?? "1";
    const problems = getGuildCtfProblems(guildId);
    if (problems.length === 0) return interaction.reply({ content: "CTF 문제가 없습니다.", ephemeral: true });
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`ctfadd:${amount}:${target.id}`)
      .setPlaceholder(`${target.username} 에게 ${amount}솔브 추가할 문제`)
      .addOptions(problems.slice(0, 25).map((p) => ({ label: `[${p.ctfName}] ${p.name}`.slice(0, 100), value: p.id })));
    return interaction.reply({
      content: `➕ <@${target.id}> 에게 **${amount}솔브** 추가할 문제를 고르세요.`,
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
        new TextInputBuilder().setCustomId("duration").setLabel("대회 기간 (선택, 예: 24h)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20),
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

  if (sub === "import") {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    const modal = new ModalBuilder().setCustomId("ctfimport").setTitle("문제 목록 붙여넣기").addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("ctfname").setLabel("이 CTF 이름").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("duration").setLabel("대회 기간 (선택, 예: 24h, 2d)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(20),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("list")
          .setLabel("문제 목록 (사이트에서 복사해 붙여넣기)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(4000)
          .setPlaceholder("[web][문제1] 설명\n[pwn][문제2] 설명\n... 한 줄에 하나씩"),
      ),
    );
    return interaction.showModal(modal);
  }
}

async function handleButton(interaction: ButtonInteraction) {
  const id = interaction.customId;

  if (id === "eventreset_cancel") {
    return interaction.update({ content: "❌ 보안뉴스/행사 리셋을 취소했습니다.", components: [] });
  }
  if (id === "eventreset_confirm") {
    if (!interaction.guild) return interaction.update({ content: "서버 안에서만 사용할 수 있습니다.", components: [] });
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    await interaction.update({ content: "🧨 보안뉴스/행사 포럼과 기록을 삭제하는 중...", components: [] });
    const result = await resetEventFeature(interaction.guild);
    return interaction.editReply({ content: `🧨 리셋 완료: 채널/스레드 ${result.channels}개 삭제, 수집 기록 ${result.items}개 초기화` });
  }

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

  // CTF 대회 참가 (역할 부여)
  if (id.startsWith("ctfjoin:")) {
    const ctfKey = id.slice("ctfjoin:".length);
    if (!interaction.guild) return;
    const roleId = getCtfRole(interaction.guild.id, ctfKey);
    if (!roleId) return interaction.reply({ content: "대회를 찾을 수 없습니다.", ephemeral: true });
    const member = interaction.member as GuildMember | null;
    await member?.roles.add(roleId).catch(() => {});
    return interaction.reply({ content: "🙌 참가 완료! 이제 이 대회의 문제 게시판이 보입니다.", ephemeral: true });
  }

  // /ctf solve 기록/취소
  if (id === "solve_cancel") {
    ctfSolveDrafts.delete(interaction.user.id);
    return interaction.update({ content: "❌ 풀이 기록을 취소했습니다.", components: [] });
  }
  if (id === "solve_confirm") return confirmCtfSolve(interaction);
}

async function confirmCtfSolve(interaction: ButtonInteraction) {
  const d = ctfSolveDrafts.get(interaction.user.id);
  if (!d) return interaction.update({ content: "세션이 만료됐어요. `/ctf solve` 를 다시 실행하세요.", components: [] });
  const p = getCtfProblem(d.problemId);
  if (!p) return interaction.update({ content: "이미 삭제된 문제입니다.", components: [] });
  if (p.solved) return interaction.update({ content: "이미 풀린 문제예요. (처음 푼 사람만 인정)", components: [] });
  const solver = d.solver ?? interaction.user.id;
  const helpers = (d.helpers ?? []).filter((h) => h !== solver);
  recordCtfSolve(p.id, solver, helpers);
  ctfSolveDrafts.delete(interaction.user.id);

  const helpTxt = helpers.length ? `\n도움: ${helpers.map((h) => `<@${h}>`).join(", ")} (각 0.5솔브)` : "";
  if (interaction.guild) {
    const solveCh = await ensureSolveChannel(interaction.guild);
    await solveCh.send(`🏅 <@${solver}> 님이 **${p.name}** (${p.ctfName}) 풀이! 🎉${helpTxt}`).catch(() => {});
  }
  return interaction.update({ content: `✅ 기록 완료! <@${solver}> 1솔브${helpers.length ? ` · 도움 ${helpers.length}명` : ""}`, components: [] });
}

async function handleUserSelect(interaction: UserSelectMenuInteraction) {
  const d = ctfSolveDrafts.get(interaction.user.id);
  if (!d) return interaction.deferUpdate();
  if (interaction.customId === "solve_solver") d.solver = interaction.values[0];
  if (interaction.customId === "solve_helpers") d.helpers = [...interaction.values];
  ctfSolveDrafts.set(interaction.user.id, d);
  return interaction.deferUpdate();
}

async function handleModal(interaction: ModalSubmitInteraction) {
  const id = interaction.customId;

  if (id === "ctfpull") return handleCtfPullModal(interaction);
  if (id === "ctfimport") return handleCtfImportModal(interaction);
  if (id === "eventimport") {
    if (!interaction.guild) return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const lines = interaction.fields.getTextInputValue("list").split(/\r?\n/);
    let parsed = 0;
    let posted = 0;
    for (const line of lines) {
      const item = parseManualEventLine(line);
      if (!item) continue;
      parsed++;
      if (await publishEventItem(interaction.guild, item).catch(() => false)) posted++;
    }
    return interaction.editReply(`✅ 가져오기 완료: ${parsed}개 인식, 새 항목 ${posted}개 등록`);
  }

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

  if (cid === "feat_add" || cid === "feat_del") {
    if (!interaction.guild) return interaction.update({ content: "서버 안에서만 사용할 수 있습니다.", components: [] });
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });

    const enabled = getFeatures(interaction.guild.id);
    const selected = interaction.values.filter((key) => FEATURES[key]);
    const next =
      cid === "feat_add"
        ? [...new Set([...enabled, ...selected])]
        : enabled.filter((key) => !selected.includes(key));

    setFeatures(interaction.guild.id, next);
    await registerGuild(interaction.guild);
    if (cid === "feat_add" && selected.includes("logging")) await cacheInvites(interaction.guild);
    if (cid === "feat_add" && selected.includes("events")) {
      await ensureEventForums(interaction.guild);
      ensureEventScheduler(interaction.guild);
    }

    const changed = selected.map((key) => FEATURES[key]?.label ?? key).join(", ");
    const enabledLabels = next.map((key) => FEATURES[key]?.label ?? key);
    return interaction.update({
      content:
        cid === "feat_add"
          ? `✅ 기능을 켰습니다: ${changed}\n이제 해당 슬래시 명령어가 보입니다.`
          : `✅ 기능을 껐습니다: ${changed}\n해당 슬래시 명령어를 숨겼습니다.`,
      embeds: [
        new EmbedBuilder()
          .setTitle("현재 켜진 기능")
          .setColor(0x5865f2)
          .setDescription(enabledLabels.length ? enabledLabels.map((label) => `• ${label}`).join("\n") : "켜진 기능이 없습니다."),
      ],
      components: [],
    });
  }

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

  if (cid === "eventremove_select") {
    if (!interaction.guildId) return interaction.update({ content: "서버 안에서만 사용할 수 있습니다.", components: [] });
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    const item = getEventItem(interaction.guildId, interaction.values[0]);
    if (!item) return interaction.update({ content: "이미 삭제된 항목입니다.", components: [] });
    await interaction.update({ content: `🗑️ '${item.title}' 삭제 중...`, components: [] });
    if (item.messageId) await deleteChannelSafe(item.messageId);
    removeEventItem(interaction.guildId, item.id);
    return interaction.editReply({ content: `🗑️ **${item.title}** 삭제 완료. 일정표는 다음 수집/등록 때 다시 정리됩니다.` });
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
    // 장르 포럼 채널들 삭제
    const genreKeys = new Set(probs.map((p) => p.genreKey));
    for (const gk of genreKeys) {
      const fid = getForumFor(guildId, `ctf:${key}:${gk}`);
      if (fid) {
        await deleteChannelSafe(fid);
        removeForumFor(guildId, `ctf:${key}:${gk}`);
      }
    }
    // 카테고리 삭제
    const catId = getForumFor(guildId, `ctfcat:${key}`);
    if (catId) {
      await deleteChannelSafe(catId);
      removeForumFor(guildId, `ctfcat:${key}`);
    }
    // 역할 삭제
    const roleId = getCtfRole(guildId, key);
    if (roleId) {
      await interaction.guild?.roles.delete(roleId).catch(() => {});
      removeCtfRole(guildId, key);
    }
    removeCtfTime(guildId, key);
    for (const p of probs) removeCtfProblem(p.id);
    return interaction.editReply({ content: `🧨 **${ctfName}** 대회(${probs.length}문제)·채널·역할을 통째로 삭제했습니다.` });
  }

  if (cid.startsWith("ctfadd:")) {
    if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
    const [, amountStr, targetId] = cid.split(":");
    const amount = Number(amountStr) || 1;
    const p = getCtfProblem(interaction.values[0]);
    if (!p) return interaction.update({ content: "이미 삭제된 문제입니다.", components: [] });
    setCtfSolve(p.id, targetId, amount);
    return interaction.update({
      content: `➕ <@${targetId}> 에게 **${p.name}** (${p.ctfName}) ${amount}솔브를 부여했습니다.`,
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
    const pts = new Map<string, number>();
    for (const p of probs) for (const [uid, v] of Object.entries(p.solves ?? {})) pts.set(uid, (pts.get(uid) ?? 0) + v);
    const ranking = [...pts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const medals = ["🥇", "🥈", "🥉"];
    const rankBody = ranking.length
      ? ranking.map(([uid, n], i) => `${medals[i] ?? `#${i + 1}`} <@${uid}> — ${n}솔브`).join("\n")
      : "_아직 푼 사람이 없습니다._";
    const time = getCtfTime(guildId, probs[0].ctfKey);
    const timeLine = time
      ? `⏰ <t:${Math.floor(time.endsAt / 1000)}:R> ${time.endsAt > Date.now() ? "종료" : "종료됨"}\n`
      : "";
    embed.addFields({ name: `📌 ${ctfName} (총 ${probs.length}문제)`, value: (timeLine + rankBody).slice(0, 1024) });
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
  const { categoryId, roleId } = await getOrCreateCtf(guild, ctfName);
  const forum = await ensureGenreForum(guild, ctfKey, categoryId, roleId, genre);
  const rec = await createCtfPost(guild, forum, ctfName, ctfKey, name, genre, interaction.user.id);
  ctfDrafts.delete(interaction.user.id);
  await interaction.editReply({
    content: `✅ **${name}** (${ctfName} · ${genre}) 추가 완료!\n· 게시글: <#${rec.postId}>\n참가하려면 🚩-ctf-로비 에서 **참가할래요** 를 누르세요.`,
  });
}

// ── 붙여넣기 일괄 등록 ────────────────────────────────────────────────
/** 한 줄에서 `[장르]...` 패턴을 찾아 {name, genre} 추출 (없으면 null) */
function parseImportLine(line: string): { name: string; genre: string } | null {
  const trimmed = line.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  const m = trimmed.match(/^\[([^\]]+)\]/);
  if (!m) return null;
  return { name: trimmed, genre: m[1].trim() };
}

async function handleCtfImportModal(interaction: ModalSubmitInteraction) {
  if (!isAdmin(interaction)) return interaction.reply({ content: "⛔ 관리자만 사용할 수 있습니다.", ephemeral: true });
  if (!interaction.guild) return interaction.reply({ content: "서버 안에서만 사용할 수 있습니다.", ephemeral: true });
  const ctfName = interaction.fields.getTextInputValue("ctfname").trim();
  const raw = interaction.fields.getTextInputValue("list");
  const seen = new Set<string>();
  const items: { name: string; genre: string }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseImportLine(line);
    if (!parsed) continue;
    const key = keyOf(parsed.name);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(parsed);
  }
  if (items.length === 0) {
    return interaction.reply({
      content: "인식된 문제가 없어요. 각 줄이 `[장르]문제명` 형태인지 확인하세요. (예: `[web][로그인우회] 설명`)",
      ephemeral: true,
    });
  }
  await interaction.deferReply({ ephemeral: true });

  const guild = interaction.guild;
  const dur = parseDuration(interaction.fields.getTextInputValue("duration") ?? "");
  if (dur) setCtfTime(guild.id, keyOf(ctfName), Date.now(), Date.now() + dur);
  const { categoryId, roleId, ctfKey } = await getOrCreateCtf(guild, ctfName);
  const forumCache = new Map<string, ForumChannel>();
  let created = 0;
  let skipped = 0;
  for (const { name, genre } of items.slice(0, 50)) {
    if (findCtfProblem(guild.id, ctfKey, keyOf(name))) {
      skipped++;
      continue;
    }
    let forum = forumCache.get(keyOf(genre));
    if (!forum) {
      forum = await ensureGenreForum(guild, ctfKey, categoryId, roleId, genre);
      forumCache.set(keyOf(genre), forum);
    }
    await createCtfPost(guild, forum, ctfName, ctfKey, name, genre, interaction.user.id).catch(() => {});
    created++;
  }
  await interaction.editReply(
    `✅ **${ctfName}** 일괄 등록: ${created}개 생성, ${skipped}개 중복 (인식 ${items.length}개, 최대 50개).\n참가하려면 🚩-ctf-로비 에서 **참가할래요** 를 누르세요.`,
  );
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
  const dur = parseDuration(interaction.fields.getTextInputValue("duration") ?? "");
  if (dur) setCtfTime(guild.id, keyOf(ctfName), Date.now(), Date.now() + dur);
  const { categoryId, roleId, ctfKey } = await getOrCreateCtf(guild, ctfName);
  const forumCache = new Map<string, ForumChannel>();
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
    let forum = forumCache.get(keyOf(genre));
    if (!forum) {
      forum = await ensureGenreForum(guild, ctfKey, categoryId, roleId, genre);
      forumCache.set(keyOf(genre), forum);
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
