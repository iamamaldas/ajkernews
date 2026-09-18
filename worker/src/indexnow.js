/*
 * IndexNow — Bing, Yandex, Naver, Seznam, IndexNow.org
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
    return { ok: false, submitted: 0, total: 0, skipped: true, error: "missing_key" };
  }

  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) return { ok: false, submitted: 0, total: 0 };

  const keyLocation = `https://${host}/${env.INDEXNOW_KEY}.txt`;
  const payload = {
    host,
    key: env.INDEXNOW_KEY,
    keyLocation,
    urlList: list
  };

  const results = await Promise.allSettled(
    INDEXNOW_ENDPOINTS.map(endpoint =>
      fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "keyLocation": keyLocation
        },
        body: JSON.stringify(payload)
      }).then(async res => {
        let text = "";
        try { text = await res.text(); } catch (_) {}
        return { endpoint, status: res.status, ok: res.ok, response: text.slice(0, 200) };
      })
    )
  );

  let success = 0;
  const details = [];

  for (const r of results) {
    if (r.status === "fulfilled") {
      const v = r.value;
      if (v.ok) success++;
      details.push({ endpoint: v.endpoint, status: v.status, ok: v.ok });
    } else {
      details.push({ error: r.reason?.message || String(r.reason) });
    }
  }

  console.log(`[INDEXNOW] ${success}/${INDEXNOW_ENDPOINTS.length} endpoints accepted ${list.length} URLs`);

  return {
    ok: success > 0,
    submitted: success > 0 ? list.length : 0,
    total: list.length,
    endpointsOk: success,
    details
  };
}
