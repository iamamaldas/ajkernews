// worker/src/config-ads.js
// 🟢 ADSTERRA — Full Script Support (Popunder + Social Bar + Native Banner)

export default {
  // ✅ ১. আপনার আসল Adsterra Publisher ID
  publisherId: "6096923", // ← এখানে আপনার আসল ID বসান

  // ✅ ২. ads.txt content (Adsterra আর এটি দেয় না)
  adsTxtContent: `# Adsterra ads.txt
`,

  // ✅ ৩. Popunder — ঠিক আছে
  popunderUrl: "https://afders.org/1/cefd70fdb5260cccd9456ab45e1e7512",

  // ✅ ৪. Social Bar — ঠিক আছে
  socialBarScript: `<script data-cfasync="false" src="https://bicea.org/14/3f58b0818e43e5e2e8f28449d29e9937"></script>`,

  // ✅ ৫. Native Banner — ঠিক আছে
  nativeBannerScript: `<script async="async" data-cfasync="false" src="https://bicea.org/21/25ee2c0a822da5cf3429cd2cb222524f"></script>`,

  // ✅ ৬. Native Banner Container ID — ঠিক আছে
  nativeBannerContainerId: "container-25ee2c0a822da5cf3429cd2cb222524f"
};
