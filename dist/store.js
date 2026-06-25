"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.keyOf = keyOf;
exports.addProblem = addProblem;
exports.getProblem = getProblem;
exports.removeProblem = removeProblem;
exports.getGuildProblems = getGuildProblems;
exports.markSolved = markSolved;
exports.addCtfProblem = addCtfProblem;
exports.getCtfProblem = getCtfProblem;
exports.removeCtfProblem = removeCtfProblem;
exports.updateCtfProblem = updateCtfProblem;
exports.getGuildCtfProblems = getGuildCtfProblems;
exports.getCtfProblemByPost = getCtfProblemByPost;
exports.findCtfProblem = findCtfProblem;
exports.recordCtfSolve = recordCtfSolve;
exports.setCtfSolve = setCtfSolve;
exports.getForumFor = getForumFor;
exports.setForumFor = setForumFor;
exports.removeForumFor = removeForumFor;
exports.getVault = getVault;
exports.setVault = setVault;
exports.getCtfRole = getCtfRole;
exports.setCtfRole = setCtfRole;
exports.removeCtfRole = removeCtfRole;
exports.getCtfTime = getCtfTime;
exports.setCtfTime = setCtfTime;
exports.removeCtfTime = removeCtfTime;
exports.getFeatures = getFeatures;
exports.setFeatures = setFeatures;
exports.getLogChannel = getLogChannel;
exports.setLogChannel = setLogChannel;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DB_PATH = (0, node_path_1.join)(process.cwd(), "data.json");
/** 대소문자/공백 무시 비교용 키 */
function keyOf(s) {
    return s.trim().toLowerCase();
}
const empty = {
    problems: {},
    ctfProblems: {},
    forums: {},
    vaults: {},
    ctfRoles: {},
    ctfTimes: {},
    features: {},
    logChannels: {},
};
function load() {
    if (!(0, node_fs_1.existsSync)(DB_PATH))
        return structuredClone(empty);
    try {
        const parsed = JSON.parse((0, node_fs_1.readFileSync)(DB_PATH, "utf8"));
        return { ...structuredClone(empty), ...parsed };
    }
    catch {
        return structuredClone(empty);
    }
}
let db = load();
function save() {
    (0, node_fs_1.writeFileSync)(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}
// ── 드림핵 문제 ───────────────────────────────────────────────────────
function addProblem(p) {
    db.problems[p.id] = p;
    save();
}
function getProblem(id) {
    return db.problems[id];
}
function removeProblem(id) {
    delete db.problems[id];
    save();
}
function getGuildProblems(guildId) {
    return Object.values(db.problems)
        .filter((p) => p.guildId === guildId)
        .sort((a, b) => b.createdAt - a.createdAt);
}
function markSolved(id, userId) {
    const p = db.problems[id];
    if (p && !p.solvers.includes(userId)) {
        p.solvers.push(userId);
        save();
    }
}
// ── CTF 문제 ──────────────────────────────────────────────────────────
function addCtfProblem(p) {
    db.ctfProblems[p.id] = p;
    save();
}
function getCtfProblem(id) {
    return db.ctfProblems[id];
}
function removeCtfProblem(id) {
    delete db.ctfProblems[id];
    save();
}
function updateCtfProblem(id, patch) {
    const p = db.ctfProblems[id];
    if (p) {
        Object.assign(p, patch);
        save();
    }
}
function getGuildCtfProblems(guildId) {
    return Object.values(db.ctfProblems)
        .filter((p) => p.guildId === guildId)
        .sort((a, b) => b.createdAt - a.createdAt);
}
function getCtfProblemByPost(postId) {
    return Object.values(db.ctfProblems).find((p) => p.postId === postId);
}
/** 같은 CTF 안에서 같은 이름(대소문자 무시) 중복 찾기 */
function findCtfProblem(guildId, ctfKey, nameKey) {
    return Object.values(db.ctfProblems).find((p) => p.guildId === guildId && p.ctfKey === ctfKey && p.nameKey === nameKey);
}
/** 첫 솔브 기록 (푼 사람 1점, 도와준 사람 0.5점). 이미 풀렸으면 false */
function recordCtfSolve(id, solverId, helperIds) {
    const p = db.ctfProblems[id];
    if (!p || p.solved)
        return false;
    p.solves[solverId] = 1;
    for (const h of helperIds)
        if (h !== solverId)
            p.solves[h] = Math.max(p.solves[h] ?? 0, 0.5);
    p.solved = true;
    save();
    return true;
}
/** 수동 보정: 특정 유저에게 점수 부여(잠김 무시) */
function setCtfSolve(id, userId, amount) {
    const p = db.ctfProblems[id];
    if (!p)
        return false;
    p.solves[userId] = amount;
    p.solved = true;
    save();
    return true;
}
// ── 포럼 / 풀이방 채널 ────────────────────────────────────────────────
function getForumFor(guildId, sourceKey) {
    return db.forums[`${guildId}:${sourceKey}`];
}
function setForumFor(guildId, sourceKey, channelId) {
    db.forums[`${guildId}:${sourceKey}`] = channelId;
    save();
}
function removeForumFor(guildId, sourceKey) {
    delete db.forums[`${guildId}:${sourceKey}`];
    save();
}
function getVault(guildId) {
    return db.vaults[guildId];
}
function setVault(guildId, channelId) {
    db.vaults[guildId] = channelId;
    save();
}
// ── CTF 참가자 역할 ───────────────────────────────────────────────────
function getCtfRole(guildId, ctfKey) {
    return db.ctfRoles[`${guildId}:${ctfKey}`];
}
function setCtfRole(guildId, ctfKey, roleId) {
    db.ctfRoles[`${guildId}:${ctfKey}`] = roleId;
    save();
}
function removeCtfRole(guildId, ctfKey) {
    delete db.ctfRoles[`${guildId}:${ctfKey}`];
    save();
}
// ── CTF 대회 시간 ─────────────────────────────────────────────────────
function getCtfTime(guildId, ctfKey) {
    return db.ctfTimes[`${guildId}:${ctfKey}`];
}
function setCtfTime(guildId, ctfKey, startsAt, endsAt) {
    db.ctfTimes[`${guildId}:${ctfKey}`] = { startsAt, endsAt };
    save();
}
function removeCtfTime(guildId, ctfKey) {
    delete db.ctfTimes[`${guildId}:${ctfKey}`];
    save();
}
// ── 봇 기능 토글 / 로그 채널 ──────────────────────────────────────────
function getFeatures(guildId) {
    return db.features[guildId] ?? [];
}
function setFeatures(guildId, keys) {
    db.features[guildId] = [...new Set(keys)];
    save();
}
function getLogChannel(guildId) {
    return db.logChannels[guildId];
}
function setLogChannel(guildId, channelId) {
    db.logChannels[guildId] = channelId;
    save();
}
