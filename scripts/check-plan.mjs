// Health check for the plan. Runs every night after the scheduler (GitHub Action);
// any ERROR makes the run fail, so GitHub emails the owner. Also writes the
// summary to $GITHUB_STEP_SUMMARY when it is set. The rules live in
// checkPlan() in lib/plan.mjs, shared with the planner page (public/plan.json).
//
//   node scripts/check-plan.mjs
//
// ERROR: a day in the next BUFFER_DAYS without five valid buildings; today or
//        tomorrow without an Instagram post, or a post whose building is not in
//        that day; fewer than 7 days of fresh buildings beyond the locked days;
//        a pin problem.
// WARN:  fresh stock under STOCK_DAYS; a locked day without an Instagram post
//        (the Sunday routine adds the next week); a repeat on a locked day that
//        comes back too soon or with a clue it has shown; locked-day buildings
//        closer than 500 km; a building in the next two weeks without a photo.
import { appendFileSync } from 'node:fs';
import { read, checkPlan } from './lib/plan.mjs';

const { summary, errors, warns } = checkPlan({ pool: read('data/buildings.json'), schedule: read('data/schedule.json') });
const out = [...summary, ...errors.map((e) => 'ERROR ' + e), ...warns.map((w) => 'WARN  ' + w)];
console.log(out.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Plan check\n\n' + out.map((l) => `- ${l}`).join('\n') + '\n');
if (errors.length) process.exit(1);
