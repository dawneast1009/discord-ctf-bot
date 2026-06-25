import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DB_PATH = process.env.DATABASE_PATH?.trim() || join(process.cwd(), "data.json");

/** 대소문자/공백 무시 비교용 키 */
export function keyOf(s: string): string {
  return s.trim().toLowerCase();
}

/** 드림핵(플래그형) 문제 한 건 */
export interface ProblemRecord {
  id: string;
  name: string;
  flag: string;
  /** 장르(카테고리). 예: web, pwn, crypto, reversing */
  genre: string;
  /** 표시용 전체 티어 라벨 (예: "브론즈1") */
  tier: string;
  /** 기본 티어 (예: "브론즈") — 포럼 태그 기준 */
  tierBase: string;
  /** 세부 레벨 (예: 1). 없으면 null */
  tierLevel: number | null;
  guildId: string;
  forumId: string;
  postId: string;
  /** 정답자만 입장하는 비공개 풀이방 스레드 ID */
  vaultThreadId: string;
  authorId: string;
  solvers: string[];
  createdAt: number;
}

/** CTF/워게임 문제 한 건 (플래그를 봇이 보관하지 않음 — 토론 + 수동 solve) */
export interface CtfProblem {
  id: string;
  guildId: string;
  /** 표시용 CTF 이름 */
  ctfName: string;
  /** 대소문자 무시 그룹 키 */
  ctfKey: string;
  name: string;
  nameKey: string;
  genre: string;
  genreKey: string;
  forumId: string;
  /** 공개 포럼 게시글(=토론 스레드) ID */
  postId: string;
  authorId: string;
  /** userId -> 솔브 점수 (푼 사람 1, 도와준 사람 0.5) */
  solves: Record<string, number>;
  /** 첫 솔브가 기록되면 잠김 (처음 푼 사람만 인정) */
  solved: boolean;
  createdAt: number;
}

export interface EventItem {
  id: string;
  guildId: string;
  title: string;
  link: string;
  source: string;
  kind?: string;
  summary?: string;
  publishedAt: number;
  startsAt?: number;
  endsAt?: number;
  bucket?: string;
  postedAt?: number;
  messageId?: string;
}

export interface EventStatus {
  lastSyncAt?: number;
  lastOk?: boolean;
  lastMessage?: string;
  fetched?: number;
  posted?: number;
}

interface DB {
  problems: Record<string, ProblemRecord>;
  ctfProblems: Record<string, CtfProblem>;
  /** `${guildId}:${sourceKey}` -> 포럼(게시판) 채널 ID. sourceKey = "dreamhack" | `ctf:${ctfKey}` */
  forums: Record<string, string>;
  /** `${guildId}` -> 비공개 풀이방을 담는 숨김 컨테이너 채널 ID */
  vaults: Record<string, string>;
  /** `${guildId}:${ctfKey}` -> 참가자 역할 ID */
  ctfRoles: Record<string, string>;
  /** `${guildId}:${ctfKey}` -> 대회 시작/종료 시각(ms) */
  ctfTimes: Record<string, { startsAt: number; endsAt: number }>;
  /** `${guildId}` -> 켜진 기능 키 목록 */
  features: Record<string, string[]>;
  /** `${guildId}` -> 입장/퇴장 로그 채널 ID */
  logChannels: Record<string, string>;
  /** `${guildId}:${itemId}` -> 보안뉴스/행사 수집 항목 */
  eventItems: Record<string, EventItem>;
  /** `${guildId}` -> 마지막 보안뉴스/행사 수집 상태 */
  eventStatus: Record<string, EventStatus>;
}

const empty: DB = {
  problems: {},
  ctfProblems: {},
  forums: {},
  vaults: {},
  ctfRoles: {},
  ctfTimes: {},
  features: {},
  logChannels: {},
  eventItems: {},
  eventStatus: {},
};

function load(): DB {
  if (!existsSync(DB_PATH)) return structuredClone(empty);
  try {
    const parsed = JSON.parse(readFileSync(DB_PATH, "utf8"));
    return { ...structuredClone(empty), ...parsed };
  } catch {
    return structuredClone(empty);
  }
}

let db: DB = load();

function save() {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

// ── 드림핵 문제 ───────────────────────────────────────────────────────
export function addProblem(p: ProblemRecord) {
  db.problems[p.id] = p;
  save();
}
export function getProblem(id: string): ProblemRecord | undefined {
  return db.problems[id];
}
export function removeProblem(id: string) {
  delete db.problems[id];
  save();
}
export function getGuildProblems(guildId: string): ProblemRecord[] {
  return Object.values(db.problems)
    .filter((p) => p.guildId === guildId)
    .sort((a, b) => b.createdAt - a.createdAt);
}
export function markSolved(id: string, userId: string) {
  const p = db.problems[id];
  if (p && !p.solvers.includes(userId)) {
    p.solvers.push(userId);
    save();
  }
}

// ── CTF 문제 ──────────────────────────────────────────────────────────
export function addCtfProblem(p: CtfProblem) {
  db.ctfProblems[p.id] = p;
  save();
}
export function getCtfProblem(id: string): CtfProblem | undefined {
  return db.ctfProblems[id];
}
export function removeCtfProblem(id: string) {
  delete db.ctfProblems[id];
  save();
}
export function updateCtfProblem(id: string, patch: Partial<CtfProblem>) {
  const p = db.ctfProblems[id];
  if (p) {
    Object.assign(p, patch);
    save();
  }
}
export function getGuildCtfProblems(guildId: string): CtfProblem[] {
  return Object.values(db.ctfProblems)
    .filter((p) => p.guildId === guildId)
    .sort((a, b) => b.createdAt - a.createdAt);
}
export function getCtfProblemByPost(postId: string): CtfProblem | undefined {
  return Object.values(db.ctfProblems).find((p) => p.postId === postId);
}
/** 같은 CTF 안에서 같은 이름(대소문자 무시) 중복 찾기 */
export function findCtfProblem(guildId: string, ctfKey: string, nameKey: string): CtfProblem | undefined {
  return Object.values(db.ctfProblems).find(
    (p) => p.guildId === guildId && p.ctfKey === ctfKey && p.nameKey === nameKey,
  );
}
/** 첫 솔브 기록 (푼 사람 1점, 도와준 사람 0.5점). 이미 풀렸으면 false */
export function recordCtfSolve(id: string, solverId: string, helperIds: string[]): boolean {
  const p = db.ctfProblems[id];
  if (!p || p.solved) return false;
  p.solves[solverId] = 1;
  for (const h of helperIds) if (h !== solverId) p.solves[h] = Math.max(p.solves[h] ?? 0, 0.5);
  p.solved = true;
  save();
  return true;
}

/** 수동 보정: 특정 유저에게 점수 부여(잠김 무시) */
export function setCtfSolve(id: string, userId: string, amount: number): boolean {
  const p = db.ctfProblems[id];
  if (!p) return false;
  p.solves[userId] = amount;
  p.solved = true;
  save();
  return true;
}

// ── 포럼 / 풀이방 채널 ────────────────────────────────────────────────
export function getForumFor(guildId: string, sourceKey: string): string | undefined {
  return db.forums[`${guildId}:${sourceKey}`];
}
export function setForumFor(guildId: string, sourceKey: string, channelId: string) {
  db.forums[`${guildId}:${sourceKey}`] = channelId;
  save();
}
export function removeForumFor(guildId: string, sourceKey: string) {
  delete db.forums[`${guildId}:${sourceKey}`];
  save();
}
export function getVault(guildId: string): string | undefined {
  return db.vaults[guildId];
}
export function setVault(guildId: string, channelId: string) {
  db.vaults[guildId] = channelId;
  save();
}

// ── CTF 참가자 역할 ───────────────────────────────────────────────────
export function getCtfRole(guildId: string, ctfKey: string): string | undefined {
  return db.ctfRoles[`${guildId}:${ctfKey}`];
}
export function setCtfRole(guildId: string, ctfKey: string, roleId: string) {
  db.ctfRoles[`${guildId}:${ctfKey}`] = roleId;
  save();
}
export function removeCtfRole(guildId: string, ctfKey: string) {
  delete db.ctfRoles[`${guildId}:${ctfKey}`];
  save();
}

// ── CTF 대회 시간 ─────────────────────────────────────────────────────
export function getCtfTime(guildId: string, ctfKey: string): { startsAt: number; endsAt: number } | undefined {
  return db.ctfTimes[`${guildId}:${ctfKey}`];
}
export function setCtfTime(guildId: string, ctfKey: string, startsAt: number, endsAt: number) {
  db.ctfTimes[`${guildId}:${ctfKey}`] = { startsAt, endsAt };
  save();
}
export function removeCtfTime(guildId: string, ctfKey: string) {
  delete db.ctfTimes[`${guildId}:${ctfKey}`];
  save();
}

// ── 봇 기능 토글 / 로그 채널 ──────────────────────────────────────────
export function getFeatures(guildId: string): string[] {
  return db.features[guildId] ?? [];
}
export function setFeatures(guildId: string, keys: string[]) {
  db.features[guildId] = [...new Set(keys)];
  save();
}
export function getLogChannel(guildId: string): string | undefined {
  return db.logChannels[guildId];
}
export function setLogChannel(guildId: string, channelId: string) {
  db.logChannels[guildId] = channelId;
  save();
}

// ── 보안뉴스 / 행사 공지 ─────────────────────────────────────────────
export function getGuildEventItems(guildId: string): EventItem[] {
  return Object.values(db.eventItems)
    .filter((item) => item.guildId === guildId)
    .sort((a, b) => b.publishedAt - a.publishedAt);
}
export function hasEventItem(guildId: string, id: string): boolean {
  return Boolean(db.eventItems[`${guildId}:${id}`]);
}
export function addEventItem(item: EventItem) {
  db.eventItems[`${item.guildId}:${item.id}`] = item;
  save();
}
export function getEventStatus(guildId: string): EventStatus {
  return db.eventStatus[guildId] ?? {};
}
export function setEventStatus(guildId: string, status: EventStatus) {
  db.eventStatus[guildId] = status;
  save();
}
