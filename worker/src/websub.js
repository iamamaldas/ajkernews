/*
 * WebSub — Real-time RSS push
 * Hubs: Google PubSubHubbub + Superfeedr
 */

const HUBS = [
  "https://pubsubhubbub.appspot.com/",
  "https://pubsubhubbub.superfeedr.com/"
];

export async function notifyWebSub(env, feedUrl) {
  if (!feedUrl) return { ok: false, reason: "no_feed_url" };

  const body = new URLSearchParams({
    "hub.mode": "publish",
    "hub.url": feedUrl
  });

  const results = await Promise.allSettled(
    HUBS.map(hub =>
      fetch(hub, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString()
      }).then(res => ({ hub, ok: res.ok, status: res.status }))
    )
  );

  let ok = 0;
  const details = [];
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value.ok) ok++;
      details.push({ hub: r.value.hub, status: r.value.status, ok: r.value.ok });
    } else {
      details.push({ error: r.reason?.message || String(r.reason) });
    }
  }

  console.log(`[WEBSUB] ${ok}/${HUBS.length} hubs accepted`);
  return { ok: ok > 0, hubsOk: ok, total: HUBS.length, details };
}
