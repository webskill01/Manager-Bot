import fs from 'fs';
import path from 'path';

// Invite links, cached on disk at <botDir>/links.json.
//
// They used to be fetched live on every `add`: groupMetadata + groupInviteCode for each of
// nitin's 12 groups is 24 sequential WhatsApp round trips, which is why `add` took the best
// part of a minute to answer. A link changes only when a group is reset or an invite revoked
// — maybe monthly — so fetching it per member was paying a per-add cost for a per-month fact.
//
// The cache lives in botDir, not config.json: config is committed and pushed, so a link
// change meant editing a file and redeploying. links.json is written BY the bot (`refreshlinks`
// pulls every code live in one pass, `setlink` overwrites one by hand) and survives restarts,
// so a link change never leaves the chat.
export function createLinkStore(config, log) {
  const file = path.join(config.botDir || '.', 'links.json');
  const groups = config.paidGroups || [];
  const names = config.groupNames || [];

  const nameOf = (groupId, i) => names[i] || groupId;

  function read() {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) { log?.warn?.(`⚠️  links.json unreadable: ${err.message}`); }
    return {};
  }

  function write(data) {
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      return true;
    } catch (err) {
      log?.error?.(`❌ links.json write failed: ${err.message}`);
      return false;
    }
  }

  // Always returned in config.paidGroups order, so the numbering the operator sees in
  // `links` is the same numbering `setlink 3 <url>` expects. Groups with no cached link
  // are omitted rather than emitted as blanks — a batch must never carry a dead entry.
  function all() {
    const data = read();
    return groups
      .map((groupId, i) => ({ groupId, groupName: nameOf(groupId, i), ...data[groupId] }))
      .filter(g => g.link);
  }

  // 1-based, matching what `links` prints.
  function set(index, link) {
    const groupId = groups[index - 1];
    if (!groupId) return null;
    const data = read();
    data[groupId] = { link, savedAt: new Date().toISOString() };
    return write(data) ? { groupId, groupName: nameOf(groupId, index - 1), link } : null;
  }

  // Bulk write from a live refresh. Only overwrites the groups actually fetched, so one
  // group failing its groupInviteCode call cannot wipe the eleven links that still work.
  function saveMany(fetched) {
    const data = read();
    const now = new Date().toISOString();
    for (const { groupId, link } of fetched) data[groupId] = { link, savedAt: now };
    return write(data);
  }

  function missing() {
    const data = read();
    return groups
      .map((groupId, i) => ({ groupId, groupName: nameOf(groupId, i), index: i + 1 }))
      .filter(g => !data[g.groupId]);
  }

  return { all, set, saveMany, missing, nameOf, file };
}
