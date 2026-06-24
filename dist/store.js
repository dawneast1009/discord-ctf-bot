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
exports.markCtfSolved = markCtfSolved;
exports.getForumFor = getForumFor;
exports.setForumFor = setForumFor;
exports.getVault = getVault;
exports.setVault = setVault;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DB_PATH = (0, node_path_1.join)(process.cwd(), "data.json");
/** 대소문자/공백 무시 비교용 키 */
function keyOf(s) {
    return s.trim().toLowerCase();
}
const empty = { problems: {}, ctfProblems: {}, forums: {}, vaults: {} };
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
function markCtfSolved(id, userId) {
    const p = db.ctfProblems[id];
    if (p && !p.solvers.includes(userId)) {
        p.solvers.push(userId);
        save();
        return true;
    }
    return false;
}
// ── 포럼 / 풀이방 채널 ────────────────────────────────────────────────
function getForumFor(guildId, sourceKey) {
    return db.forums[`${guildId}:${sourceKey}`];
}
function setForumFor(guildId, sourceKey, channelId) {
    db.forums[`${guildId}:${sourceKey}`] = channelId;
    save();
}
function getVault(guildId) {
    return db.vaults[guildId];
}
function setVault(guildId, channelId) {
    db.vaults[guildId] = channelId;
    save();
}
