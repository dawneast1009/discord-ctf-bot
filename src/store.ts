import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DB_PATH = join(process.cwd(), "data.json");

/** 생성 완료되어 저장된 문제 한 건 */
export interface ProblemRecord {
  id: string;
  name: string;
  flag: string;
  tier: string;
  guildId: string;
  /** 티어 채널(숨김) ID */
  tierChannelId: string;
  /** 문제 비공개 스레드(포스트) ID */
  threadId: string;
  /** 알림 채널 ID */
  announceChannelId: string;
  /** 알림 메시지 ID */
  announceMessageId: string;
  authorId: string;
  /** 정답을 맞혀 입장 권한을 받은 사람들 */
  solvers: string[];
  createdAt: number;
}

interface DB {
  problems: Record<string, ProblemRecord>;
  /** `${guildId}:${tier}` -> 티어 채널 ID */
  tierChannels: Record<string, string>;
  /** `${guildId}` -> 알림 채널 ID */
  announceChannels: Record<string, string>;
}

const empty: DB = { problems: {}, tierChannels: {}, announceChannels: {} };

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

export function addProblem(p: ProblemRecord) {
  db.problems[p.id] = p;
  save();
}

export function getProblem(id: string): ProblemRecord | undefined {
  return db.problems[id];
}

export function markSolved(id: string, userId: string) {
  const p = db.problems[id];
  if (!p) return;
  if (!p.solvers.includes(userId)) {
    p.solvers.push(userId);
    save();
  }
}

export function getTierChannel(guildId: string, tier: string): string | undefined {
  return db.tierChannels[`${guildId}:${tier}`];
}

export function setTierChannel(guildId: string, tier: string, channelId: string) {
  db.tierChannels[`${guildId}:${tier}`] = channelId;
  save();
}

export function getAnnounceChannel(guildId: string): string | undefined {
  return db.announceChannels[guildId];
}

export function setAnnounceChannel(guildId: string, channelId: string) {
  db.announceChannels[guildId] = channelId;
  save();
}
