/*
 * WebSub — Real-time RSS push
 */

const HUBS = [
  "https://pubsubhubbub.appspot.com/publish",
  "https://pubsubhubbub.superfeedr.com/publish"
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
  for (const r of results) {
    if (r.status === "fulfilled" && r.value.ok) ok++;
  }
  console.log(`[WEBSUB] ${ok}/${HUBS.length} hubs accepted`);
  return { ok: ok > 0 };
}
