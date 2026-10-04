// worker/src/config-ads.js
// 🟢 ADSTERRA — Social Bar + Native Banner + Popunder (HTML থেকে trigger)

export default {
  // ✅ আপনার Adsterra Publisher ID
  publisherId: "6096923",

  // ✅ ads.txt (Adsterra authorize)
  adsTxtContent: `# Adsterra ads.txt
adsterra.com, 6096923, DIRECT
`,

  // ✅ Popunder HTML থেকে trigger হবে, তাই খালি
  popunderUrl: "",

  // ✅ Social Bar — `<\/script>` escape করা
  socialBarScript: `<script data-cfasync="false" src="https://bicea.org/14/3f58b0818e43e5e2e8f28449d29e9937"><\/script>`,

  // ✅ Native Banner — `<\/script>` escape করা
  nativeBannerScript: `<script async="async" data-cfasync="false" src="https://bicea.org/21/25ee2c0a822da5cf3429cd2cb222524f"><\/script>`,

  // ✅ Native Banner Container ID
  nativeBannerContainerId: "container-25ee2c0a822da5cf3429cd2cb222524f"
};
