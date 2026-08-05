import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  getKc10OperationalObject,
  listKc10OperationalObjects,
  type ListKc10OperationalObjectsInput,
} from "../dopaios/kc10-operations.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

interface Kc10RouteOptions {
  enabled?: () => boolean;
  list?: typeof listKc10OperationalObjects;
  get?: typeof getKc10OperationalObject;
}

function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function queryInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function kc10Routes(db: Db, options: Kc10RouteOptions = {}) {
  const router = Router();
  const enabled = options.enabled ?? (() => process.env.DOPAIOS_KC10_ENABLED === "true");
  const list = options.list ?? listKc10OperationalObjects;
  const get = options.get ?? getKc10OperationalObject;

  router.use("/companies/:companyId/kc10", (req, res, next) => {
    if (!enabled()) {
      res.status(404).json({ error: "KC-10 verification mode is disabled" });
      return;
    }
    next();
  });

  router.get("/companies/:companyId/kc10/objects", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const kind = queryString(req.query.kind);
    const input: ListKc10OperationalObjectsInput = {
      companyId,
      userId: actor.actorId,
      objectId: queryString(req.query.objectId),
      kinds: kind ? kind.split(",").map((value) => value.trim()).filter(Boolean) : undefined,
      state: queryString(req.query.state),
      ownerId: queryString(req.query.ownerId),
      projectId: queryString(req.query.projectId),
      query: queryString(req.query.q),
      from: queryString(req.query.from),
      to: queryString(req.query.to),
      limit: queryInteger(req.query.limit, 50, 1, 50),
      offset: queryInteger(req.query.offset, 0, 0, 1_000_000),
    };
    const correlationId = randomUUID();
    const startedAt = performance.now();
    const result = await list(db, input);
    res.setHeader("X-KC10-Correlation-Id", correlationId);
    res.setHeader("Server-Timing", `kc10-db;dur=${(performance.now() - startedAt).toFixed(3)}`);
    res.json({ ...result, correlationId });
  });

  router.get("/companies/:companyId/kc10/objects/:objectId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);
    const result = await get(db, {
      companyId,
      userId: actor.actorId,
      objectId: req.params.objectId as string,
    });
    if (!result) {
      res.status(404).json({ error: "KC-10 object not found" });
      return;
    }
    res.json(result);
  });

  return router;
}
