const assert = require("assert");
const { isDailyScheduleDue, normalizeDailyTime } = require("./merchant-bubble-daily");

assert.strictEqual(normalizeDailyTime("9:05"), "09:05:00");
assert.strictEqual(normalizeDailyTime("4:00:05"), "04:00:05");
assert.strictEqual(normalizeDailyTime("23:59:59"), "23:59:59");
assert.strictEqual(normalizeDailyTime("24:00"), "");
assert.strictEqual(normalizeDailyTime("04:00:60"), "");

const schedule = { enabled: true, time: "04:00:05", last_run_on: "" };
assert.strictEqual(isDailyScheduleDue(schedule, { date: "2026-09-27", time: "04:00:05" }), true);
assert.strictEqual(isDailyScheduleDue(schedule, { date: "2026-09-27", time: "04:00:20" }), true);
assert.strictEqual(isDailyScheduleDue(schedule, { date: "2026-09-27", time: "04:00:04" }), false);
assert.strictEqual(isDailyScheduleDue(schedule, { date: "2026-09-27", time: "04:00:35" }), false);
assert.strictEqual(isDailyScheduleDue({ ...schedule, last_run_on: "2026-09-27" }, { date: "2026-09-27", time: "04:00:05" }), false);
assert.strictEqual(isDailyScheduleDue({ ...schedule, enabled: false }, { date: "2026-09-27", time: "04:00:05" }), false);

console.log("merchant-bubble-daily tests passed");
