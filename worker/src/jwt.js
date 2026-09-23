// worker/src/jwt.js
// ✅ NEW: Shared JWT signing + Google OAuth token helper
// Replaces 3× duplicated JWT code in index.js and fast-index.js

import { base64url } from "./utils.js";

/**
 * Create a signed JWT for Google OAuth2 (RS256)
 */
export async function createSignedJWT(clientEmail, privateKey, scope, aud) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    scope,
    aud,
    iat: now,
    exp: now + 3600
  };

  const unsigned = `${base64url(header)}.${base64url(payload)}`;

  const pemContents = String(privateKey)
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${unsigned}.${sigB64}`;
}

/**
 * Exchange JWT for Google OAuth2 access token
 */
export async function getGoogleAccessToken(signedJWT) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJWT}`
  });
  return await res.json();
}

/**
 * Get FCM access token + project ID from service account JSON
 */
export async function getFcmCredentials(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON missing");
  }

  let sa;
  try {
    sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_JSON: " + e.message);
  }

  const jwt = await createSignedJWT(
    sa.client_email,
    sa.private_key,
    "https://www.googleapis.com/auth/firebase.messaging",
    "https://oauth2.googleapis.com/token"
  );

  const tokenData = await getGoogleAccessToken(jwt);
  if (!tokenData.access_token) {
    throw new Error("FCM token exchange failed: " + JSON.stringify(tokenData));
  }

  return {
    accessToken: tokenData.access_token,
    projectId: sa.project_id,
    serviceAccount: sa
  };
}
