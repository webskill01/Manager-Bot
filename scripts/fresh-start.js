// Fresh start for one bot: back up and clear its reminder/contact state, and set the day the
// new ladder starts counting from.
//
//   node scripts/fresh-start.js bot-nitin 16-11-2026
//
// Then `pm2 restart <bot>`. Members already 7+ days overdue on that date restart their
// ladder from the day the drip first reaches them (perDay a day, config.freshStart.perDay).
// Delays (delayUntil) are NOT cleared — on 14-11-2026 there were none; clear by hand if needed.
import fs from 'node:fs';
import path from 'node:path';

const [bot, from] = process.argv.slice(2);
if (!bot || !/^\d{2}-\d{2}-\d{4}$/.test(from || '')) {
  console.error('usage: node scripts/fresh-start.js <bot> <DD-MM-YYYY>');
  process.exit(1);
}
const dir = path.join(process.cwd(), 'bots', bot);
if (!fs.existsSync(path.join(dir, 'config.json'))) { console.error(`no bots/${bot}/config.json`); process.exit(1); }

const STATE = ['qr-sent.json', 'drip-state.json', 'reminder-state.json', 'overdue-state.json', 'catchup-state.json'];
const backup = path.join(dir, `fresh-backup-${Date.now()}`);
fs.mkdirSync(backup);
for (const f of STATE) {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) continue;
  fs.copyFileSync(p, path.join(backup, f));
  fs.unlinkSync(p);
  console.log(`cleared ${f}`);
}
fs.writeFileSync(path.join(dir, 'fresh-start.json'), JSON.stringify({ from }, null, 2));
console.log(`fresh start from ${from}; backup in ${backup}`);
