"use strict";

const MEITUAN_IMAGE_HOST = /meituan\.net/i;
const MEITUAN_THUMB_SUFFIX = /@\d+w_\d+h/i;

/** 点评/美团图床（dpmerchantpic、img.meituan.net/content 等） */
function isMeituanMerchantImageUrl(imageUrl) {
  return MEITUAN_IMAGE_HOST.test(String(imageUrl || ""));
}

function isMeituanThumbnailUrl(imageUrl) {
  const url = String(imageUrl || "").trim();
  return isMeituanMerchantImageUrl(url) && MEITUAN_THUMB_SUFFIX.test(url);
}

/** 去掉 @340w_255h 等缩略参数，换原图 URL */
function normalizeMerchantImageUrl(imageUrl) {
  const url = String(imageUrl || "").trim();
  if (!url || !isMeituanThumbnailUrl(url)) return url;
  const full = url.replace(/@\d+w_\d+h[^|]*(\|.*)?$/i, "");
  return full || url;
}

module.exports = {
  isMeituanMerchantImageUrl,
  isMeituanThumbnailUrl,
  normalizeMerchantImageUrl,
};
