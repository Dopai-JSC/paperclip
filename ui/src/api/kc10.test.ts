import { describe, expect, it, vi } from "vitest";
import { api } from "./client";
import { kc10Api } from "./kc10";

vi.mock("./client", () => ({ api: { get: vi.fn() } }));

describe("kc10Api", () => {
  it("encodes an object lookup and never exceeds the 50-row contract", async () => {
    vi.mocked(api.get).mockResolvedValue({ items: [] });
    await kc10Api.listObjects("company / 1", {
      objectId: "object/1",
      kinds: ["work_item", "action_request"],
      query: "risk & owner",
      limit: 500,
      offset: 25,
    });
    expect(api.get).toHaveBeenCalledWith(
      "/companies/company%20%2F%201/kc10/objects?objectId=object%2F1&kind=work_item%2Caction_request&q=risk+%26+owner&limit=50&offset=25",
    );
  });
});
