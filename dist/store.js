"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addProblem = addProblem;
exports.getProblem = getProblem;
exports.markSolved = markSolved;
exports.getTierChannel = getTierChannel;
exports.setTierChannel = setTierChannel;
exports.getAnnounceChannel = getAnnounceChannel;
exports.setAnnounceChannel = setAnnounceChannel;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const DB_PATH = (0, node_path_1.join)(process.cwd(), "data.json");
const empty = { problems: {}, tierChannels: {}, announceChannels: {} };
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
function markSolved(id, userId) {
    const p = db.problems[id];
    if (!p)
        return;
    if (!p.solvers.includes(userId)) {
        p.solvers.push(userId);
        save();
    }
}
function getTierChannel(guildId, tier) {
    return db.tierChannels[`${guildId}:${tier}`];
}
function setTierChannel(guildId, tier, channelId) {
    db.tierChannels[`${guildId}:${tier}`] = channelId;
    save();
}
function getAnnounceChannel(guildId) {
    return db.announceChannels[guildId];
}
function setAnnounceChannel(guildId, channelId) {
    db.announceChannels[guildId] = channelId;
    save();
}
