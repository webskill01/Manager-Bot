import { randomBetween, sleep, normalizePhone } from './globalConfig.js';

export function createGroupManager(sock, config, log) {
  const { paidGroups, rateLimits } = config;

  async function gapBetweenOps() {
    const ms = randomBetween(rateLimits.groupOpGapMinMs, rateLimits.groupOpGapMaxMs);
    log.info(`⏳ Group op gap: ${(ms / 1000).toFixed(1)}s`);
    await sleep(ms);
  }

  function toJid(phone) {
    const digits = normalizePhone(phone);
    return `91${digits}@s.whatsapp.net`;
  }

  async function addToAllGroups(phone, name) {
    const jid = toJid(phone);
    const added = [];
    const failed = [];

    log.info(`👤 Adding ${name} (${phone}) to ${paidGroups.length} groups...`);

    for (let i = 0; i < paidGroups.length; i++) {
      const groupId = paidGroups[i];
      try {
        await sock.groupParticipantsUpdate(groupId, [jid], 'add');
        added.push(groupId);
        log.info(`✅ Added to ${groupId}`);
      } catch (err) {
        failed.push({ groupId, reason: err.message });
        log.warn(`❌ Failed ${groupId}: ${err.message}`);
      }
      if (i < paidGroups.length - 1) await gapBetweenOps();
    }

    return { added, failed };
  }

  async function removeFromAllGroups(phone) {
    const jid = toJid(phone);
    const removed = [];
    const failed = [];

    log.info(`🚫 Removing ${phone} from ${paidGroups.length} groups...`);

    for (let i = 0; i < paidGroups.length; i++) {
      const groupId = paidGroups[i];
      try {
        await sock.groupParticipantsUpdate(groupId, [jid], 'remove');
        removed.push(groupId);
        log.info(`✅ Removed from ${groupId}`);
      } catch (err) {
        failed.push({ groupId, reason: err.message });
        log.warn(`❌ Failed ${groupId}: ${err.message}`);
      }
      if (i < paidGroups.length - 1) await gapBetweenOps();
    }

    return { removed, failed };
  }

  async function approvePendingRequests(phone) {
    const jid = toJid(phone);
    const approved = [];
    const failed = [];

    for (let i = 0; i < paidGroups.length; i++) {
      const groupId = paidGroups[i];
      try {
        const metadata = await sock.groupMetadata(groupId);
        const pending = metadata.participants?.filter(p => p.jid === jid && p.pending === true);
        if (pending && pending.length > 0) {
          await sock.groupRequestParticipantsUpdate(groupId, [jid], 'approve');
          approved.push(groupId);
          log.info(`✅ Approved in ${groupId}`);
        }
      } catch (err) {
        failed.push({ groupId, reason: err.message });
        log.warn(`❌ Approve failed ${groupId}: ${err.message}`);
      }
      if (i < paidGroups.length - 1) await gapBetweenOps();
    }

    return { approved, failed };
  }

  async function getInviteLinksForMissing(phone) {
    const jid = toJid(phone);
    const links = [];

    for (const groupId of paidGroups) {
      try {
        const metadata = await sock.groupMetadata(groupId);
        const isMember = metadata.participants?.some(p => p.jid === jid);
        if (!isMember) {
          const inviteCode = await sock.groupInviteCode(groupId);
          links.push({
            groupId,
            groupName: metadata.subject || groupId,
            link: `https://chat.whatsapp.com/${inviteCode}`,
          });
        }
      } catch (err) {
        log.warn(`❌ Invite link failed ${groupId}: ${err.message}`);
      }
    }

    return links;
  }

  async function checkMembership(phone) {
    const jid = toJid(phone);
    const inGroups = [];
    const notInGroups = [];

    for (const groupId of paidGroups) {
      try {
        const metadata = await sock.groupMetadata(groupId);
        const isMember = metadata.participants?.some(p => p.jid === jid);
        const groupName = metadata.subject || groupId;
        if (isMember) {
          inGroups.push(groupName);
        } else {
          notInGroups.push(groupName);
        }
      } catch (err) {
        log.warn(`❌ Membership check failed ${groupId}: ${err.message}`);
      }
    }

    return { inGroups, notInGroups };
  }

  return { addToAllGroups, removeFromAllGroups, approvePendingRequests, getInviteLinksForMissing, checkMembership };
}
