// ==========================================
// কনফিগ ফাইল ৩: Affiliate + Personal Advertising
// ==========================================

export default {
  // ----- ক্লিক ট্র্যাকিং চালু/বন্ধ -----
  trackClicks: true, // true রাখলে ডাটাবেসে ক্লিক লগ হবে

  // ----- ডিফল্ট রিডাইরেক্ট URL (যদি কোনো ম্যাপ না মেলে) -----
  defaultRedirect: "https://example.com",

  // ----- বিভিন্ন অ্যাফিলিয়েট লিংকের শর্টকাট ম্যাপ -----
  redirectMap: {
    "amazon": "https://amazon.in/your-affiliate-tag",
    "daraz": "https://daraz.com/your-affiliate-tag",
    "personal": "https://your-personal-ad-page.com"
  },

  // ----- Personal Ads: নিউজ কার্ডের মাঝে দেখানোর জন্য -----
  // এখানে যত ইচ্ছা অ্যাড এড করতে পারেন
  personalAds: [
    {
      id: "ad1",
      title: "আপনার বিজ্ঞাপন দিন",
      description: "বাংলার সবচেয়ে বড় নিউজ প্ল্যাটফর্মে বিজ্ঞাপন দিন। লাখ লাখ দর্শকের কাছে পৌঁছান।",
      link: "https://your-ad-page.com/contact",
      image: "https://your-image-url.com/ad-banner.png",
      category: "sponsored"
    },
    {
      id: "ad2",
      title: "বিশেষ অফার",
      description: "আজই অর্ডার করুন এবং ৫০% ছাড় পান। সীমিত সময়ের অফার।",
      link: "https://your-offer-page.com",
      image: "https://your-image-url.com/offer.png",
      category: "sponsored"
    }
  ],

  // ----- কতটি নিউজ পর পর একটি অ্যাড দেখাবে -----
  // উদাহরণ: 2 মানে প্রতি 2টি নিউজের পর 1টি অ্যাড
  adInterval: 2,

  // ----- অ্যাড রোটেট করবে নাকি সবগুলো দেখাবে? -----
  // true = প্রতিবার ভিন্ন অ্যাড, false = সবগুলো ক্রমান্বয়ে
  rotateAds: true
};
