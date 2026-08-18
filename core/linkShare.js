import { waMeLink } from './manualGroupManager.js';

// Turn a member's group invite links into messages the OPERATOR sends by hand.
//
// The bot used to send these itself: handleAdd built an array of 12 link messages plus a
// welcome and handed it to groupManager.sendToMember, which fired all 13 at a fixed 1,200 ms
// interval. Nobody types 13 messages in 16 seconds, and that machine cadence is a stronger
// signal to WhatsApp than the invite links ever were — a linked device's timing is the part
// that cannot be explained away by context.
//
// The links themselves are fine. By the time they go out there is a real two-way
// conversation: the member sent their name, ID proof and payment confirmation, so the
// outbound-to-inbound ratio is healthy and report probability is near zero. What was wrong
// was the shape, so only the shape changed.
//
// Splitting exists for the member, not for safety: WhatsApp collapses a message behind
// "Read more" at roughly 700-800 characters, and 12 links plus a greeting is ~880. A single
// message would hide most of the links from someone who has just paid. Six per message lands
// near 440, and both parts are fully visible.
export function buildLinkBatches({ links, batchSize = 6, welcome = null, greeting = null }) {
  const size = Math.max(1, Number(batchSize) || 6);
  const batches = [];
  for (let i = 0; i < links.length; i += size) {
    const lines = links.slice(i, i + size)
      .map((l, j) => `${i + j + 1}. ${l.groupName}\n${l.link}`);
    batches.push(lines.join('\n\n'));
  }
  if (batches.length === 0) return welcome ? [welcome] : [];
  if (greeting) batches[0] = `${greeting}\n\n${batches[0]}`;
  if (welcome) batches[batches.length - 1] += `\n\n${welcome}`;
  return batches;
}

// One tap per batch. The operator taps, WhatsApp opens with the message already typed, they
// hit send — so it leaves their own phone as a normal human message, fifteen to thirty
// seconds apart, which is what a person catching up actually looks like.
// batchSize must be the SAME value buildLinkBatches used. Deriving it as total/batches
// instead gets uneven splits wrong: 7 links at 6 per batch is [1-6] and [7-7], but the
// derived figure is ceil(7/2)=4 and labels them [1-4] and [5-7] — numbers that match no
// message actually sent.
export function renderTapLinks(phone, batches, total, batchSize = 6) {
  if (batches.length === 0) return '⚠️ No group links available.';
  if (batches.length === 1) {
    return `📲 Send them the links — 1 tap:\n${waMeLink(phone, batches[0])}`;
  }
  const size = Math.max(1, Number(batchSize) || 6);
  const lines = [`📲 Send them the links — ${batches.length} taps:`];
  batches.forEach((b, i) => {
    const from = i * size + 1;
    const to = Math.min(from + size - 1, total);
    lines.push(`   Part ${i + 1} (groups ${from}-${to}):\n   ${waMeLink(phone, b)}`);
  });
  return lines.join('\n');
}
