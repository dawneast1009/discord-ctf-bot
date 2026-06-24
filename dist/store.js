"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addProblem = addProblem;
exports.getProblem = getProblem;
exports.removeProblem = removeProblem;
exports.getGuildProblems = getGuildProblems;
exports.markSolved = markSolved;
exports.getForum = getForum;
exports.setForum = setForum;
exports.getVault = getVault;
exports.setVault = setVault;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DB_PATH = (0, node_path_1.join)(process.cwd(), "data.json");
const empty = { problems: {}, forums: {}, vaults: {} };
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
    if (!p)
        return;
    if (!p.solvers.includes(userId)) {
        p.solvers.push(userId);
        save();
    }
}
function getForum(guildId) {
    return db.forums[guildId];
}
function setForum(guildId, channelId) {
    db.forums[guildId] = channelId;
    save();
}
function getVault(guildId) {
    return db.vaults[guildId];
}
function setVault(guildId, channelId) {
    db.vaults[guildId] = channelId;
    save();
}
