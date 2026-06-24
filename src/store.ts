import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DB_PATH = join(process.cwd(), "data.json");

/** 생성 완료되어 저장된 문제 한 건 */
export interface ProblemRecord {
  id: string;
  name: string;
  flag: string;
  /** 장르(카테고리). 예: web, pwn, crypto, reversing */
  genre: string;
  /** 표시용 전체 티어 라벨 (예: "브론즈1") */
  tier: string;
  /** 기본 티어 (예: "브론즈") — 포럼 태그/점수 기준 */
  tierBase: string;
  /** 세부 레벨 (예: 1). 없으면 null */
  tierLevel: number | null;
  guildId: string;
  /** 공개 포럼(게시판) 채널 ID */
  forumId: string;
  /** 공개 문제 게시글(포스트=스레드) ID */
  postId: string;
  /** 정답자만 입장하는 비공개 풀이방 스레드 ID */
  vaultThreadId: string;
  authorId: string;
  /** 정답을 맞혀 입장 권한을 받은 사람들 */
  solvers: string[];
  createdAt: number;
}

interface DB {
  problems: Record<string, ProblemRecord>;
  /** `${guildId}` -> 포럼(게시판) 채널 ID */
  forums: Record<string, string>;
  /** `${guildId}` -> 비공개 풀이방을 담는 숨김 컨테이너 채널 ID */
  vaults: Record<string, string>;
}

const empty: DB = { problems: {}, forums: {}, vaults: {} };

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
  if (!p) return;
  if (!p.solvers.includes(userId)) {
    p.solvers.push(userId);
    save();
  }
}

export function getForum(guildId: string): string | undefined {
  return db.forums[guildId];
}

export function setForum(guildId: string, channelId: string) {
  db.forums[guildId] = channelId;
  save();
}

export function getVault(guildId: string): string | undefined {
  return db.vaults[guildId];
}

export function setVault(guildId: string, channelId: string) {
  db.vaults[guildId] = channelId;
  save();
}
