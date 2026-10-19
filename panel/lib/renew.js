import { createMemberStore } from '../../core/memberStore.js';
import { createRenewalHandlers } from '../../core/handlers/renewalHandlers.js';

// "Mark renewed" from the panel runs the bot's own `renewed` handler, so the billing-day
// math, the same-month guard and the referral price exist in exactly one place.
//
// seenBillingDate is the billing date the user was looking at. If the sheet no longer
// says that, somebody (the bot, the app sync, another panel user) got there first and
// renewing again would charge the member a second month: refuse and make them reload.

const quietLog = { info() {}, warn() {}, error() {} };

export function createRenewer({ sync, botCfg, db, log = quietLog }) {
  let chain = Promise.resolve();   // ponytail: one write at a time, per process; plenty for a few users

  async function run({ phone, bot, seenBillingDate, user }) {
    if (!botCfg[bot]) return { status: 400, error: `Unknown bot ${bot}` };
    const store = createMemberStore(sync.client(bot), bot);
    await store.refresh();
    const member = store.findByPhone(phone);
    if (!member) return { status: 404, error: 'Member not found on that sheet' };
    if (member.status !== 'ACTIVE' || member.billingDate !== seenBillingDate) {
      return { status: 409, error: `Changed since you opened it (now ${member.status}, billing ${member.billingDate}). Reload.` };
    }

    // botDir: null keeps the bot's reminder-state file alone; that belongs to the bot process.
    const { handleRenewed } = createRenewalHandlers(store, { ...botCfg[bot], botDir: null }, log);
    const reply = await handleRenewed([phone]);
    if (/^[❌⚠]/u.test(reply)) return { status: 400, error: reply.replace(/\nTo override:.*$/s, '') };

    db.audit(user.id, 'renewed', phone, { bot, from: seenBillingDate, verified: user.role === 'admin', reply });
    db.logInteraction({ phone, bot, userId: user.id, outcome: 'paid', note: 'Marked renewed in panel' });
    await sync.recheck(phone);
    return { status: 200, message: reply };
  }

  return {
    markRenewed(args) {
      const next = chain.then(() => run(args));
      chain = next.catch(() => {});
      return next;
    },
  };
}
