import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { kc10Routes } from "../routes/kc10.js";

const list = vi.fn();
const get = vi.fn();

function createApp(enabled = true) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "kc10-user-01",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", kc10Routes({} as never, { enabled: () => enabled, list, get }));
  app.use(errorHandler);
  return app;
}

describe("KC-10 operational routes", () => {
  beforeEach(() => {
    list.mockReset();
    get.mockReset();
  });

  it("passes authenticated user and bounded filters to the projection", async () => {
    list.mockResolvedValue({ indexState: "complete", items: [], hasMore: false, limit: 50, offset: 0 });

    const response = await request(createApp())
      .get("/api/companies/company-1/kc10/objects")
      .query({ objectId: "object-1", kind: "work_item,action_request", state: "ready", ownerId: "STAFF-01", limit: "500" })
      .expect(200);

    expect(list).toHaveBeenCalledWith(expect.anything(), {
      companyId: "company-1",
      userId: "kc10-user-01",
      objectId: "object-1",
      kinds: ["work_item", "action_request"],
      state: "ready",
      ownerId: "STAFF-01",
      projectId: undefined,
      query: undefined,
      from: undefined,
      to: undefined,
      limit: 50,
      offset: 0,
    });
    expect(response.headers["x-kc10-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers["server-timing"]).toMatch(/^kc10-db;dur=/);
  });

  it("returns not found when ACL-filtered lookup yields no object", async () => {
    get.mockResolvedValue(null);
    await request(createApp())
      .get("/api/companies/company-1/kc10/objects/secret-object")
      .expect(404, { error: "KC-10 object not found" });
    expect(get).toHaveBeenCalledWith(expect.anything(), {
      companyId: "company-1",
      userId: "kc10-user-01",
      objectId: "secret-object",
    });
  });

  it("keeps the spike endpoint closed when KC-10 mode is disabled", async () => {
    await request(createApp(false))
      .get("/api/companies/company-1/kc10/objects")
      .expect(404, { error: "KC-10 verification mode is disabled" });
    expect(list).not.toHaveBeenCalled();
  });
});
