// ==========================================
// কনফিগ ফাইল: Analytics + Search Console
// ==========================================

export default {
  // ----- Google Analytics 4 (GA4) Tracking ID -----
  gaTrackingId: "G-EQGWN6G3DH",

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
