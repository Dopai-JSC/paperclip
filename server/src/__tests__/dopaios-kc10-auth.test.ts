import { describe, expect, it } from "vitest";
import { buildKc10SessionCookie } from "../dopaios/kc10-auth.js";

describe("KC-10 browser session cookie", () => {
  it("builds the instance-scoped Better Auth signed-cookie wire format", () => {
    expect(buildKc10SessionCookie({
      instanceId: "kc10",
      token: "session-token",
      secret: "test-secret",
    })).toEqual({
      name: "paperclip-kc10.session_token",
      value: "session-token.MC4qXRSc0YeETAIGOYpzsaYqgcLZ4NqivSfk%2Bs7oo34%3D",
    });
  });

  it.each([
    { instanceId: "", token: "session-token", secret: "test-secret" },
    { instanceId: "kc10", token: "", secret: "test-secret" },
    { instanceId: "kc10", token: "session-token", secret: "" },
  ])("rejects incomplete session material: %o", (input) => {
    expect(() => buildKc10SessionCookie(input)).toThrow(/required/);
  });
});
