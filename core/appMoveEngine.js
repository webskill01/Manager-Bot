import fs from 'node:fs';
import path from 'node:path';
import { normalizePhone, randomBetween } from './globalConfig.js';
import { liveOnApp } from './appFlow.js';

// Moves app users out of the paid groups: anyone the last group scan saw in config.appGroupId
// AND in a paid group, who is live on the app right now, is removed from the paid groups they
// are in (only those — the scan says which). The sheet is not touched: they stay ACTIVE, the
// app group is where they are served now.
//
// Ban safety: one person at a time, 12–20 min apart, 8–12 s between their groups (the
// removal engine's own gaps), daytime only, never while a kickall is running on the same
// number. ~50 people a day, which drains bot-nitin's ~180 in about four days.
//
// `done` records the scan a removal was based on; a later scan that still shows them in a
// paid group (re-added, or a remove that failed) makes them a candidate again.
export function moveCandidates({ phonesInPaid, groupsOf, appGroup, admins, snapshot, exclude, done = {}, scanAt = 0 }) {
  const live = new Set([...snapshot.values()].filter(r => liveOnApp(r)).map(r => normalizePhone(String(r.phone))));
  return [...phonesInPaid]
    .filter(ph => appGroup.has(ph) && live.has(ph) && !admins.has(ph) && !exclude.has(ph))
    .filter(ph => groupsOf(ph).length > 0 && !(done[ph] >= scanAt))
    .sort();
}

export function createAppMoveEngine({ config, log, getSock, groupScan, appSync, removal, warmingUp = () => false }) {
  const file = path.join(config.botDir, 'app-move.json');
  const s = config.appMove || {};
  const gapMin = s.gapMinMs ?? 12 * 60 * 1000, gapMax = s.gapMaxMs ?? 20 * 60 * 1000;
  const startHour = s.startHour ?? 8, endHour = s.endHour ?? 22;
  let timer = null;

  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { active: false, done: {} }; } };
  const save = (st) => fs.writeFileSync(file, JSON.stringify(st, null, 2));

  function exclude() {
    const ex = new Set([...(config.allowedNumbers || []), ...(config.auditExclude || [])].map(normalizePhone));
    const self = (getSock()?.user?.id || '').split(':')[0].replace(/\D/g, '');
    if (self) ex.add(normalizePhone(self));
    return ex;
  }

  function candidates(st = load()) {
    return moveCandidates({
      phonesInPaid: groupScan.phones().keys(), groupsOf: groupScan.groupsOf, appGroup: groupScan.appGroup(),
      admins: groupScan.admins(), snapshot: appSync.snapshot(), exclude: exclude(), done: st.done, scanAt: groupScan.atMs(),
    });
  }

  function later(ms) { clearTimeout(timer); timer = setTimeout(() => tick().catch(e => log.warn(`⚠️  App move: ${e.message}`)), ms); timer.unref?.(); }

  async function tick() {
    const st = load();
    if (!st.active) return;
    const h = new Date().getHours();
    if (h < startHour || h >= endHour) return later(30 * 60 * 1000);
    if (warmingUp() || !getSock()?.user || removal.kickallActive()) return later(15 * 60 * 1000);
    const next = candidates(st)[0];
    if (!next) return later(60 * 60 * 1000);   // wait for the next scan
    const groups = groupScan.groupsOf(next);
    const { removedCount, interrupted } = await removal.removeFromGroups(next, groups);
    if (interrupted) return later(15 * 60 * 1000);
    st.done[next] = Date.now();
    save(st);
    log.info(`📲 App move: ${next} out of ${removedCount}/${groups.length} paid group(s) (in the app group, live on app)`);
    later(randomBetween(gapMin, gapMax));
  }

  function start() { const st = load(); st.active = true; save(st); later(5000); return `▶️ App move on — ${candidates(st).length} queued.`; }
  function stop() { const st = load(); st.active = false; save(st); clearTimeout(timer); return '⏸️ App move paused.'; }
  function status() {
    const st = load();
    return `📲 App move ${st.active ? 'ON' : 'off'} — ${Object.keys(st.done).length} moved, ${candidates(st).length} queued ` +
      `(scan ${groupScan.at() || 'never'}).`;
  }
  // Boot: resume if it was on.
  function resume() { if (load().active) later(10 * 60 * 1000); }

  return { start, stop, status, resume, candidates };
}
