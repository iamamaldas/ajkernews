// worker/src/config-affiliate.js
// 🟡 PERSONAL ADS + AFFILIATE URLs
// ⚠️ AdSense এর কিছু এখানে না

export default {
  trackClicks: true,

  defaultRedirect: "https://ajkernews.in",

  redirectMap: {
    "amazon": "https://amazon.in/your-affiliate-tag",
    "angelone": "https://angel-one.onelink.me/Wjgr/m0h5ge9c",
    "personal": "https://your-personal-ad-page.com"
  },

  // 🟡 PERSONAL ADS (Footer Display)
  ads: {
    footer: [
      {
        id: "angel-one-footer",
        title: "🎯 ফ্রি ডিম্যাট অ্যাকাউন্ট খুলুন",
        description: "Angel One — ₹20 এ ট্রেড, ফ্রি অ্যাকাউন্ট, 5 মিনিটে খুলুন",
        image: "https://ajkernews.in/ads/angelone-wide.jpg",
        url: "/api/affiliate?ref=angelone",
        cta: "এখনই খুলুন"
      },
      {
        id: "amazon-footer",
        title: "🛒 আজকের সেরা অফার",
        description: "Amazon এ বিশাল ছাড় — সীমিত সময়ের জন্য",
        image: "https://ajkernews.in/ads/amazon-wide.jpg",
        url: "/api/affiliate?ref=amazon",
        cta: "Shop Now"
      }
    ]
  }
};
