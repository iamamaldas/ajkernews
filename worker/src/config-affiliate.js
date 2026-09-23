// worker/src/config-affiliate.js
// ✅ FIXED: শুধু ব্যবহৃত fields রাখা (personalAds, adInterval, rotateAds সরানো)

export default {
  trackClicks: true,

  defaultRedirect: "https://example.com",

  redirectMap: {
    "amazon": "https://amazon.in/your-affiliate-tag",
    "daraz": "https://daraz.com/your-affiliate-tag",
    "personal": "https://your-personal-ad-page.com"
  }
};
