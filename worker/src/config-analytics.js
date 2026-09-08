// ==========================================
// কনফিগ ফাইল ১: Analytics + Search Console
// ==========================================

export default {
  // ----- Google Analytics 4 (GA4) Tracking ID -----
  // আপনার GA4 আইডি (আপনার দেওয়া স্ক্রিপ্ট থেকে নেওয়া)
  gaTrackingId: "G-EQGWN6G3DH",

  // ----- Google Search Console Verification -----
  searchConsole: {
    // গুগল যে HTML ফাইলের নাম দেয়
    filePath: "/google-site-verification-XXXXX.html",
    // ফাইলের কনটেন্ট (আপনার নিজের ভেরিফিকেশন কোড দিন)
    content: `google-site-verification: YOUR_VERIFICATION_CODE_HERE`
  },

  // ----- অতিরিক্ত হেড স্ক্রিপ্ট (GA4 gtag.js) -----
  extraHeadScripts: `
    <!-- Google tag (gtag.js) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-EQGWN6G3DH"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', 'G-EQGWN6G3DH');
    </script>
  `
};
