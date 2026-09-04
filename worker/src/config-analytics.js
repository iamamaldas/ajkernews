// ==========================================
// কনফিগ ফাইল ১: Analytics + Search Console
// ==========================================

export default {
  // ----- Google Analytics 4 (GA4) Tracking ID -----
  // আপনার GA4 আইডি দিন (যেমন: G-123456ABCD)
  gaTrackingId: "G-XXXXXXXXXX",

  // ----- Google Search Console Verification -----
  searchConsole: {
    // গুগল যে HTML ফাইলের নাম দেয় (যেমন: google-site-verification-abc123.html)
    filePath: "/google-site-verification-XXXXX.html",
    // ফাইলের কনটেন্ট (গুগল যা দেয়)
    content: `google-site-verification: YOUR_VERIFICATION_CODE_HERE`
  },

  // ----- অতিরিক্ত হেড স্ক্রিপ্ট (ঐচ্ছিক) -----
  extraHeadScripts: `
    <!-- আপনার অতিরিক্ত স্ক্রিপ্ট এখানে দিন -->
  `
};
