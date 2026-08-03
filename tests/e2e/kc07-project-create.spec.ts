import fs from "node:fs";
import { createRequire } from "node:module";
import { expect, test } from "@playwright/test";

const requireFromServer = createRequire(new URL("../../server/package.json", import.meta.url));
const { Client } = requireFromServer("pg") as typeof import("pg");

const TARGET_REVISION = "4a56a0c9781b35e53386b2be7bcd74443f4a8bc5";
const DESCRIPTION = "KC-07 deterministic live-product evaluator project.";
const COMPANY_NAME = "KC07 Evaluator Company";
const BROWSER_EXECUTABLE = process.env.KC07_BROWSER_EXECUTABLE;
const RUNS = 10;

if (!BROWSER_EXECUTABLE) throw new Error("KC07_BROWSER_EXECUTABLE must be pinned by the KC-07 config.");

test.describe.serial("KC-07 Playwright API/CLI — create Project", () => {
  for (let attempt = 1; attempt <= RUNS; attempt += 1) {
    const ordinal = String(attempt).padStart(2, "0");
    const projectName = `KC07-EVAL-A${ordinal}`;

    test(`A${ordinal} creates, verifies, and removes a Project`, async ({ page }, testInfo) => {
      const consoleMessages: Array<{ type: string; text: string }> = [];
      const pageErrors: string[] = [];
      page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
      page.on("pageerror", (error) => pageErrors.push(error.message));

      const companiesResponse = await page.request.get("/api/companies");
      expect(companiesResponse.ok()).toBe(true);
      const companies = (await companiesResponse.json()) as Array<{ id: string; name: string }>;
      let company = companies.find((candidate) => candidate.name === COMPANY_NAME);
      if (!company) {
        const createCompanyResponse = await page.request.post("/api/companies", {
          data: {
            name: COMPANY_NAME,
            description: "Deterministic company fixture for KC-07 evaluator runs.",
          },
        });
        expect(createCompanyResponse.ok()).toBe(true);
        company = await createCompanyResponse.json() as { id: string; name: string };
      }

      const beforeResponse = await page.request.get(`/api/companies/${company.id}/projects`);
      expect(beforeResponse.ok()).toBe(true);
      const beforeProjects = (await beforeResponse.json()) as Array<{ id: string; name: string }>;
      for (const stale of beforeProjects.filter((project) => project.name === projectName)) {
        const cleanupResponse = await page.request.delete(`/api/projects/${stale.id}?companyId=${company.id}`);
        expect(cleanupResponse.ok()).toBe(true);
      }

      await page.goto("/projects");
      await expect(page.getByRole("button", { name: "Add Project" }).first()).toBeVisible();
      const beforeScreenshot = testInfo.outputPath("before-create.png");
      await page.screenshot({ path: beforeScreenshot, fullPage: true });
      await testInfo.attach("before-create", { path: beforeScreenshot, contentType: "image/png" });

      await page.getByRole("button", { name: "Add Project" }).first().click();
      await page.getByPlaceholder("Project name").fill(projectName);
      await page.getByRole("textbox", { name: "editable markdown" }).fill(DESCRIPTION);

      const createResponsePromise = page.waitForResponse((response) =>
        response.request().method() === "POST"
        && response.url().includes(`/api/companies/${company.id}/projects`),
      );
      await page.getByRole("button", { name: "Create project" }).click();
      const createResponse = await createResponsePromise;
      expect(createResponse.ok()).toBe(true);
      const created = (await createResponse.json()) as {
        id: string;
        companyId: string;
        name: string;
        description: string | null;
        status: string;
      };

      await expect(page.getByPlaceholder("Project name")).toHaveCount(0);
      await expect(page.getByText(projectName, { exact: true })).toBeVisible();

      const apiResponse = await page.request.get(`/api/projects/${created.id}?companyId=${company.id}`);
      expect(apiResponse.ok()).toBe(true);
      const apiProject = await apiResponse.json() as typeof created;
      expect(apiProject).toMatchObject({
        id: created.id,
        companyId: company.id,
        name: projectName,
        description: DESCRIPTION,
        status: "planned",
      });

      const db = new Client({ connectionString: process.env.DATABASE_URL });
      await db.connect();
      const dbResult = await db.query(
        "select id, company_id, name, description, status from projects where id = $1",
        [created.id],
      );
      await db.end();
      expect(dbResult.rows).toEqual([{
        id: created.id,
        company_id: company.id,
        name: projectName,
        description: DESCRIPTION,
        status: "planned",
      }]);

      const afterScreenshot = testInfo.outputPath("after-create.png");
      await page.screenshot({ path: afterScreenshot, fullPage: true });
      await testInfo.attach("after-create", { path: afterScreenshot, contentType: "image/png" });

      const deleteResponse = await page.request.delete(`/api/projects/${created.id}?companyId=${company.id}`);
      expect(deleteResponse.ok()).toBe(true);

      const verifyDb = new Client({ connectionString: process.env.DATABASE_URL });
      await verifyDb.connect();
      const afterDelete = await verifyDb.query("select count(*)::int as count from projects where id = $1", [created.id]);
      await verifyDb.end();
      expect(afterDelete.rows[0].count).toBe(0);
      expect(pageErrors).toEqual([]);

      const oraclePath = testInfo.outputPath("oracle.json");
      fs.writeFileSync(oraclePath, `${JSON.stringify({
        adapter: "playwright-api-cli",
        attempt: `A${ordinal}`,
        targetRevision: TARGET_REVISION,
        browserExecutable: BROWSER_EXECUTABLE,
        project: apiProject,
        uiVisible: true,
        dbMatched: true,
        cleanupVerified: true,
        pageErrors,
        consoleMessages,
      }, null, 2)}\n`, "utf8");
      await testInfo.attach("oracle", { path: oraclePath, contentType: "application/json" });
    });
  }
});
