/*
 * IndexNow — Bing, Yandex, Naver, Seznam
 * Google also accepts IndexNow via api.indexnow.org
 */

const INDEXNOW_ENDPOINTS = [
  "https://api.indexnow.org/indexnow",
  "https://www.bing.com/indexnow",
  "https://yandex.com/indexnow",
  "https://searchadvisor.naver.com/indexnow",
  "https://search.seznam.cz/indexnow"
];

export async function submitToIndexNow(env, urls, host = "ajkernews.in") {
  if (!env.INDEXNOW_KEY) {
    console.warn("[INDEXNOW] INDEXNOW_KEY missing — skipped");
    return { submitted: 0, total: 0, skipped: true };
  }

  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) return { submitted: 0, total: 0 };

  const keyLocation = `https://${host}/${env.INDEXNOW_KEY}.txt`;
  const payload = { host, key: env.INDEXNOW_KEY, keyLocation, urlList: list };

  const results = await Promise.allSettled(
    INDEXNOW_ENDPOINTS.map(endpoint =>
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload)
      }).then(res => ({ endpoint, status: res.status, ok: res.ok }))
    )
  );

  let success = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.ok) success++;
  }

  console.log(`[INDEXNOW] ${success}/${INDEXNOW_ENDPOINTS.length} endpoints accepted ${list.length} URLs`);
  return { submitted: success > 0 ? list.length : 0, total: list.length, endpointsOk: success };
}
