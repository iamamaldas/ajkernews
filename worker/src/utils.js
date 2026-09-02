export function jsonResponse(
  data,
  extraHeaders = {}
) {

  const headers = new Headers({
    "Content-Type": "application/json; charset=UTF-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  });

  return new Response(
    JSON.stringify(data),
    {
      status: 200,
      headers
    }
  );
}


export function errorResponse(
  message,
  status = 500
) {

  return new Response(
    JSON.stringify({
      ok: false,
      error: message
    }),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",
        "Cache-Control": "no-store"
      }
    }
  );
}


export function makeId() {

  return crypto.randomUUID();
}


export function getDayKey(date = new Date()) {

  return date
    .toISOString()
    .slice(0, 10);
}


export function normalizeText(text = "") {

  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}


export function getCronSlot(scheduledTime) {

  const date =
    new Date(scheduledTime);

  const hour =
    date.getUTCHours();

  return Math.floor(hour / 3);
}