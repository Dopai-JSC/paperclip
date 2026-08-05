import { createHmac } from "node:crypto";
import { deriveAuthCookiePrefix } from "../auth/better-auth.js";

export type Kc10SessionCookie = {
  name: string;
  value: string;
};

export function buildKc10SessionCookie(input: {
  instanceId: string;
  token: string;
  secret: string;
}): Kc10SessionCookie {
  if (!input.instanceId.trim()) throw new Error("KC-10 instanceId is required");
  if (!input.token.trim()) throw new Error("KC-10 session token is required");
  if (!input.secret.trim()) throw new Error("KC-10 Better Auth secret is required");

  const signature = createHmac("sha256", input.secret)
    .update(input.token)
    .digest("base64");

  return {
    name: `${deriveAuthCookiePrefix(input.instanceId)}.session_token`,
    value: encodeURIComponent(`${input.token}.${signature}`),
  };
}
