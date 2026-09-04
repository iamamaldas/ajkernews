// ==========================================
// কনফিগ ফাইল ২: AdSense / Adstera / অ্যাড নেটওয়ার্ক
// ==========================================

export default {
  // ----- Google AdSense / Ads.txt -----
  // আপনার পাবলিশার আইডি বসান (pub-XXXXXXXXXXXXX)
  adsTxtContent: `google.com, pub-XXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0`,

  // ----- অ্যাড নেটওয়ার্কের স্ক্রিপ্ট (যেমন Adstera, PropellerAds) -----
  // এটি ওয়েবসাইটের <head>-এ ইনজেক্ট হবে
  adNetworkScripts: `
    <!-- উদাহরণ: Adstera Script -->
    <!-- 
    <script type="text/javascript" src="https://cdn.adstera.com/ads/abc123.js"></script>
    -->

    <!-- উদাহরণ: Google AdSense Auto Ads (যদি চান) -->
    <!-- 
    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-xxxx"></script>
    <script>
      (adsbygoogle = window.adsbygoogle || []).push({
        google_ad_client: "ca-pub-xxxx",
        enable_page_level_ads: true
      });
    </script>
    -->
  `,

  // ----- ফুটারে অতিরিক্ত স্ক্রিপ্ট (ঐচ্ছিক) -----
  extraFooterScripts: `
    <!-- বিজ্ঞাপন পিক্সেল বা কন্টেইনার -->
  `
};
