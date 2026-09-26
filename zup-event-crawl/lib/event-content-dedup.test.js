"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  eventTitlesLikelySame,
  fuzzyNormalizeEventTitle,
} = require("./event-content-dedup");

test("巡回、巡演等票务写法不影响同活动判断", () => {
  const douban = "“原来你也睡不着”周菲戈2026《24:01》巡回演唱会 北京站";
  const motianlun = "“原来你也睡不着”周菲戈2026《24:01》演唱会 北京站";

  assert.equal(fuzzyNormalizeEventTitle(douban), fuzzyNormalizeEventTitle(motianlun));
  assert.equal(eventTitlesLikelySame(douban, motianlun), true);
  assert.equal(
    eventTitlesLikelySame(
      "白百EndlessWhite「水溶于水」2026全国巡演 上海站",
      "白百EndlessWhite「水溶于水」上海站",
    ),
    true,
  );
});

test("同场地但不同艺人的演出不会被判成同一个活动", () => {
  assert.equal(
    eventTitlesLikelySame(
      "“原来你也睡不着”周菲戈2026《24:01》巡回演唱会 北京站",
      "辉子「雾中人」2026巡演-北京站",
    ),
    false,
  );
});
