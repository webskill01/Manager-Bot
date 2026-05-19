import { randomBetween, sleep, normalizePhone } from './globalConfig.js';

export function createGroupManager(sock, config, log) {
  const { paidGroups, rateLimits } = config;

  // Set when the session dies mid-operation so loops abort gracefully
  let _aborted = false;
  function markAborted() { _aborted = true; }

  // Track last batch end time for cooldown enforcement
  let _lastBatchEndMs = 0;
  const _batchCooldownMs = rateLimits.batchCooldownMs ?? 600000; // 10 min default

  function checkCooldown(opName) {
    const elapsed = Date.now() - _lastBatchEndMs;
    if (_lastBatchEndMs > 0 && elapsed < _batchCooldownMs) {
      const waitSec = Math.ceil((_batchCooldownMs - elapsed) / 1000);
      return `⏳ ${opName} blocked — last group batch finished ${Math.floor(elapsed / 1000)}s ago. Wait ${waitSec}s before next batch.`;
    }
    return null;
  }

  // Sequential operation queue — prevents concurrent group ops from racing
  let _opQueue = Promise.resolve();
  function enqueue(fn) {
    const next = _opQueue.then(() => fn());
    _opQueue = next.catch(() => {});
    return next;
  }

  async function gapBetweenOps() {
    if (_aborted) return;
    const ms = randomBetween(rateLimits.groupOpGapMinMs, rateLimits.groupOpGapMaxMs);
    log.info(`⏳ Group op gap: ${(ms / 1000).toFixed(1)}s`);
    await sleep(ms);
  }

  function toJid(phone) {
    const digits = normalizePhone(phone);
    return `91${digits}@s.whatsapp.net`;
  }

  // Classify Baileys groupParticipantsUpdate errors into meaningful categories
  function classifyAddError(err) {
    const msg = (err.message || '').toLowerCase();
    const statusCode = err?.output?.statusCode || err?.data?.status || 0;
    if (statusCode === 403 || msg.includes('not-authorized') || msg.includes('not authorized')) return 'not_admin';
    if (statusCode === 409 || msg.includes('already in') || msg.includes('participant already')) return 'already_member';
    return 'privacy_restricted';
  }

  async function _addToAllGroups(phone, name) {
    const jid = toJid(phone);
    const added = [];
    const failed = [];

    log.info(`👤 Adding ${name} (${phone}) to ${paidGroups.length} groups...`);

    for (let i = 0; i < paidGroups.length; i++) {
      if (_aborted) {
        log.warn('⚠️  Session lost mid-add — aborting remaining groups');
        break;
      }
      const groupId = paidGroups[i];
      try {
        await sock.groupParticipantsUpdate(groupId, [jid], 'add');
        added.push(groupId);
        log.info(`✅ Added to ${groupId}`);
      } catch (err) {
        if (_aborted) { log.warn('⚠️  Session lost — stopping'); break; }
        const reason = classifyAddError(err);
        let groupName = groupId;
        let inviteLink = null;
        try {
          const meta = await sock.groupMetadata(groupId);
          groupName = meta.subject || groupId;
          if (reason === 'privacy_restricted') {
            const code = await sock.groupInviteCode(groupId);
            inviteLink = `https://chat.whatsapp.com/${code}`;
          }
        } catch (metaErr) {
          log.warn(`⚠️  Metadata fetch failed ${groupId}: ${metaErr.message}`);
        }
        failed.push({ groupId, groupName, reason, inviteLink });
        log.warn(`❌ Failed ${groupName} [${reason}]: ${err.message}`);
      }
      if (i < paidGroups.length - 1) await gapBetweenOps();
    }

    _lastBatchEndMs = Date.now();
    return { added, failed };
  }

  async function _removeFromAllGroups(phone) {
    const jid = toJid(phone);
    const removed = [];
    const failed = [];

    log.info(`🚫 Removing ${phone} from ${paidGroups.length} groups...`);

    for (let i = 0; i < paidGroups.length; i++) {
      if (_aborted) {
        log.warn('⚠️  Session lost mid-remove — aborting remaining groups');
        break;
      }
      const groupId = paidGroups[i];
      try {
        await sock.groupParticipantsUpdate(groupId, [jid], 'remove');
        removed.push(groupId);
        log.info(`✅ Removed from ${groupId}`);
      } catch (err) {
        if (_aborted) { log.warn('⚠️  Session lost — stopping'); break; }
        failed.push({ groupId, reason: err.message });
        log.warn(`❌ Failed ${groupId}: ${err.message}`);
      }
      if (i < paidGroups.length - 1) await gapBetweenOps();
    }

    _lastBatchEndMs = Date.now();
    return { removed, failed };
  }

  // Public wrappers — all group ops run sequentially via the op queue
  // Cooldown is checked before queuing to give instant feedback
  function addToAllGroups(phone, name) {
    const blocked = checkCooldown('Add');
    if (blocked) return Promise.resolve({ added: [], failed: [], blocked });
    return enqueue(() => _addToAllGroups(phone, name));
  }
  function removeFromAllGroups(phone) {
    const blocked = checkCooldown('Kick');
    if (blocked) return Promise.resolve({ removed: [], failed: [], blocked });
    return enqueue(() => _removeFromAllGroups(phone));
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

  // Scan all groups for pending join requests using the correct Baileys API
  async function getAllPendingRequests() {
    const result = [];
    for (let i = 0; i < paidGroups.length; i++) {
      if (_aborted) { log.warn('⚠️  Session lost mid-scan — stopping'); break; }
      const groupId = paidGroups[i];
      try {
        const pendingList = await sock.groupRequestParticipantsList(groupId);
        if (pendingList && pendingList.length > 0) {
          let groupName = groupId;
          try {
            const meta = await sock.groupMetadata(groupId);
            groupName = meta.subject || groupId;
          } catch {}
          result.push({
            groupId,
            groupName,
            pending: pendingList.map(p => ({ jid: p.jid })),
          });
        }
      } catch (err) {
        if (_aborted) break;
        log.warn(`❌ Pending scan failed ${groupId}: ${err.message}`);
      }
      if (i < paidGroups.length - 1) await gapBetweenOps();
    }
    return result;
  }

  // Approve all pending join requests across all groups
  async function _approveAllPendingRequests() {
    const pendingByGroup = await getAllPendingRequests();
    const approved = [];
    const failed = [];
    let totalApproved = 0;

    for (let i = 0; i < pendingByGroup.length; i++) {
      const { groupId, groupName, pending } = pendingByGroup[i];
      const jids = pending.map(p => p.jid);
      try {
        await sock.groupRequestParticipantsUpdate(groupId, jids, 'approve');
        approved.push({ groupId, groupName, count: jids.length });
        totalApproved += jids.length;
        log.info(`✅ Approved ${jids.length} in ${groupName}`);
      } catch (err) {
        failed.push({ groupId, groupName, reason: err.message });
        log.warn(`❌ Approve failed ${groupName}: ${err.message}`);
      }
      if (i < pendingByGroup.length - 1) await gapBetweenOps();
    }

    return { approved, failed, totalApproved, totalGroups: pendingByGroup.length };
  }

  // Reject all pending join requests across all groups
  async function _rejectAllPendingRequests() {
    const pendingByGroup = await getAllPendingRequests();
    const rejected = [];
    const failed = [];
    let totalRejected = 0;

    for (let i = 0; i < pendingByGroup.length; i++) {
      const { groupId, groupName, pending } = pendingByGroup[i];
      const jids = pending.map(p => p.jid);
      try {
        await sock.groupRequestParticipantsUpdate(groupId, jids, 'reject');
        rejected.push({ groupId, groupName, count: jids.length });
        totalRejected += jids.length;
        log.info(`🚫 Rejected ${jids.length} in ${groupName}`);
      } catch (err) {
        failed.push({ groupId, groupName, reason: err.message });
        log.warn(`❌ Reject failed ${groupName}: ${err.message}`);
      }
      if (i < pendingByGroup.length - 1) await gapBetweenOps();
    }

    return { rejected, failed, totalRejected, totalGroups: pendingByGroup.length };
  }

  // Approve/reject — deduped so rapid repeat commands don't stack in the queue
  let _approvePending = false;
  function approveAllPendingRequests() {
    if (_approvePending) return Promise.resolve({ approved: [], failed: [], totalApproved: 0, totalGroups: 0, alreadyRunning: true });
    _approvePending = true;
    return enqueue(() => _approveAllPendingRequests().finally(() => { _approvePending = false; }));
  }
  function rejectAllPendingRequests() { return enqueue(() => _rejectAllPendingRequests()); }

  // Send a sequence of messages to a member's number with a small gap between each.
  // Used for the invite-link onboarding flow in handleAdd.
  async function sendToMember(phone, messages) {
    const jid = toJid(phone);
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < messages.length; i++) {
      if (_aborted) break;
      try {
        await sock.sendMessage(jid, { text: messages[i] });
        sent++;
      } catch (err) {
        failed++;
        log.warn(`⚠️  Message ${i + 1}/${messages.length} to ${phone} failed: ${err.message}`);
      }
      if (i < messages.length - 1) await sleep(1200);
    }
    return { sent, failed };
  }

  return { addToAllGroups, removeFromAllGroups, getInviteLinksForMissing, checkMembership, getAllPendingRequests, approveAllPendingRequests, rejectAllPendingRequests, markAborted, sendToMember };
}
