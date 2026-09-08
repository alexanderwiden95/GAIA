import assert from "node:assert/strict";
import test from "node:test";

import { isQuietTime, parseProactivityConfig } from "../src/scheduler.ts";

test("proactivity configuration validates timezone and local times", () => {
  assert.deepEqual(parseProactivityConfig({
    GAIA_PROACTIVE_CHANNEL_ID: "999999999999999999",
    GAIA_TIMEZONE: "Europe/Stockholm",
    GAIA_DAILY_DIGEST_TIME: "08:30",
    GAIA_QUIET_HOURS_START: "22:00",
    GAIA_QUIET_HOURS_END: "07:00",
  }), {
    channelId: "999999999999999999",
    timezone: "Europe/Stockholm",
    digestTime: "08:30",
    quietStart: "22:00",
    quietEnd: "07:00",
  });
  assert.throws(() => parseProactivityConfig({
    GAIA_PROACTIVE_CHANNEL_ID: "999999999999999999",
    GAIA_TIMEZONE: "Nowhere/Invalid",
    GAIA_DAILY_DIGEST_TIME: "08:30",
    GAIA_QUIET_HOURS_START: "22:00",
    GAIA_QUIET_HOURS_END: "07:00",
  }), /GAIA_TIMEZONE/);
});

test("quiet hours support overnight and daytime ranges", () => {
  assert.equal(isQuietTime("23:00", "22:00", "07:00"), true);
  assert.equal(isQuietTime("06:59", "22:00", "07:00"), true);
  assert.equal(isQuietTime("12:00", "22:00", "07:00"), false);
  assert.equal(isQuietTime("12:00", "09:00", "17:00"), true);
  assert.equal(isQuietTime("12:00", "00:00", "00:00"), false);
});
