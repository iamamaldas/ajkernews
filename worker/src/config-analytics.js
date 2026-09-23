// worker/src/config-analytics.js
// ✅ FIXED: GA4 ID একবার define, তারপর interpolate

const GA_ID = "G-EQGW6G3DH";

export default {
  gaTrackingId: GA_ID,

  extraHeadScripts: `
    <!-- Google tag (gtag.js) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag(){dataLayer.push(arguments);}
      gtag('js', new Date());
      gtag('config', '${GA_ID}');
    </script>
  `
};
