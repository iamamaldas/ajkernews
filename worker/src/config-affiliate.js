// worker/src/config-affiliate.js
// ✅ FIXED: শুধু ব্যবহৃত fields রাখা (personalAds, adInterval, rotateAds সরানো)

export default {
  trackClicks: true,

  defaultRedirect: "https://example.com",

  redirectMap: {
    "amazon": "https://amazon.in/your-affiliate-tag",
    "Angel One": "*Open your Trading & Investment account with Angel One for FREE* 

You will get:
✅ All trades in Rs.20 💹
✅ Quick SIP in Direct MF ⚡
✅ 1Lac MTF @ 0% interest 💰


Download only using my referral link to get Free Demat Account⬇
https://angel-one.onelink.me/Wjgr/m0h5ge9c
_link may expire within 48hrs_

_T&C Apply_",
    "personal": "https://your-personal-ad-page.com"
  }
};
