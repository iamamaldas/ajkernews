// worker/src/config-ads.js
// 🟢 ADSTERRA — Social Bar + Native Banner + Popunder (HTML থেকে ট্রিগার)

export default {
  // ✅ ১. আপনার আসল Adsterra Publisher ID
  publisherId: "6096923",

  // ✅ ২. ads.txt content (Adsterra আর এটি দেয় না)
  adsTxtContent: `# Adsterra ads.txt
`,

  // ✅ ৩. Popunder — খালি রাখুন (কারণ HTML থেকে ট্রিগার হবে)
  popunderUrl: "",

  // ✅ ৪. Social Bar — ঠিক আছে
  socialBarScript: `<script data-cfasync="false" src="https://bicea.org/14/3f58b0818e43e5e2e8f28449d29e9937"></script>`,

  // ✅ ৫. Native Banner — ঠিক আছে
  nativeBannerScript: `<script async="async" data-cfasync="false" src="https://bicea.org/21/25ee2c0a822da5cf3429cd2cb222524f"></script>`,

  // ✅ ৬. Native Banner Container ID — ঠিক আছে
  nativeBannerContainerId: "container-25ee2c0a822da5cf3429cd2cb222524f"
};
