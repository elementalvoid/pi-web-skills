/**
 * One real-browser smoke test for the Skills panel against an isolated PI WEB
 * instance. Run with `npm run test:e2e`; it is deliberately outside `npm test`
 * so the unit suite stays fast and browser-free.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
// Playwright resolves Chromium from PLAYWRIGHT_BROWSERS_PATH when set, otherwise
// from the user cache (~/.cache/ms-playwright). Install it with
// `npx playwright install chromium` if the smoke test cannot find it.
const { chromium } = await import("playwright");

const children = [];
let browser;
let temporaryRoot;

try {
  temporaryRoot = await mkdtemp(join(tmpdir(), "pi-web-skills-e2e-"));
  const home = join(temporaryRoot, "home");
  const agentDir = join(temporaryRoot, "agent");
  const dataDir = join(temporaryRoot, "data");
  const workspace = join(temporaryRoot, "workspace");
  const fixture = join(temporaryRoot, "fixture");
  const managedDirectory = join(home, ".agents", "skills");
  const lockfilePath = join(home, ".agents", ".skill-lock.json");

  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(join(dataDir, "plugins"), { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(fixture, { recursive: true }),
  ]);

  await seedInstance({ home, dataDir, workspace, managedDirectory, lockfilePath, fixture });
  await symlink(repoRoot, join(dataDir, "plugins", "pi-web-skills"), "dir");

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_WEB_DATA_DIR: dataDir,
    PI_WEB_SESSIOND_SOCKET: join(dataDir, "sessiond.sock"),
    PI_WEB_PORT: String(port),
  };

  const sessiond = startChild(join(repoRoot, "node_modules", ".bin", "pi-web-sessiond"), env);
  await waitForSocket(join(dataDir, "sessiond.sock"), 20_000);
  const server = startChild(join(repoRoot, "node_modules", ".bin", "pi-web-server"), env);
  await waitForHttp(`${baseUrl}/api/pi-web/health`, 20_000);
  await waitForProject(baseUrl, "e2e-project", 20_000);
  const manifest = await waitForSkillsManifest(baseUrl, 20_000);
  assert.ok(
    manifest.server?.activeRevision === manifest.server?.desiredRevision,
    "the Skills server module is active; restart the test daemon after a build",
  );

  const workspaces = await getJson(`${baseUrl}/api/machines/local/projects/e2e-project/workspaces`);
  const workspaceId = workspaces.workspaces?.[0]?.id;
  assert.equal(typeof workspaceId, "string", "the seeded project has a git workspace");

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  // The documentation shot uses the bundled dark theme. The test itself does
  // not depend on the theme; this only pins it so README images are stable.
  await page.addInitScript(() => {
    try {
      localStorage.setItem(
        "pi-web-app-theme",
        JSON.stringify({ themeId: "themes:pi-web-dark", auto: false }),
      );
    } catch {
      // about:blank and opaque origins may reject storage; the test still runs.
    }
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && /PI WEB plugin skills|dynamically imported module/i.test(text)) {
      pageErrors.push(text);
    }
  });
  // The test itself never leaves localhost; blocked external requests also keep
  // release checks and any other web traffic out of the run.
  await page.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    if (target.hostname === "127.0.0.1" || target.hostname === "localhost") {
      await route.continue();
      return;
    }
    await route.abort();
  });

  const panelUrl = `${baseUrl}/?project=e2e-project&workspace=${encodeURIComponent(String(workspaceId))}&view=workspace&tool=skills:skills`;
  await page.goto(panelUrl, { waitUntil: "load" });
  await page.getByRole("heading", { name: "Skills", exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText("Changes apply to every workspace on this machine", { exact: false }).first().waitFor();
  await page.getByText(managedDirectory, { exact: true }).waitFor();
  await page.getByText(lockfilePath, { exact: true }).waitFor();

  // Seeded list states: one managed, three unmanaged (one invalid), one broken.
  await page.getByRole("heading", { name: "Managed skills (1)", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Unmanaged skills (3)", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Broken entries (1)", exact: true }).waitFor();
  await page.getByText("Invalid frontmatter: description is missing", { exact: false }).waitFor();
  if (process.env.E2E_SCREENSHOT !== undefined) {
    // A taller documentation shot: show the panel controls plus one expanded
    // skill row with its metadata and actions. The screenshot is opt-in so the
    // normal smoke test never writes into the package.
    await page.setViewportSize({ width: 1400, height: 1400 });
    const firstRow = page.locator(".skills-panel .skills-row").first();
    await firstRow.locator(".skills-row-title").click();
    await page.locator(".skills-panel").screenshot({ path: process.env.E2E_SCREENSHOT });
  }
  const unmanaged = page.getByRole("heading", { name: /^Unmanaged skills/ }).locator("..");
  assert.equal(
    await unmanaged.getByRole("button", { name: "Remove", exact: true }).count(),
    0,
    "unmanaged skills stay read-only",
  );

  // Add from a local git fixture: resolve, select one of two, confirm overwrite,
  // install, and check the managed directory and lockfile on disk.
  const lockBefore = JSON.parse(await readFile(lockfilePath, "utf8"));
  await page.getByLabel("Source", { exact: true }).fill(pathToFileURL(fixture).href);
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await page.getByRole("checkbox", { name: /notes/ }).waitFor({ timeout: 20_000 });
  await page.getByText("Unmanaged — an overwrite confirmation will come before install", { exact: false }).waitFor();
  await page.getByRole("checkbox", { name: /notes/ }).check();
  await page.getByRole("button", { name: "Install selected (1)" }).click();
  await page.getByText("Confirm to overwrite", { exact: false }).waitFor();
  assert.equal(
    Object.hasOwn(lockBefore.skills, "notes"),
    false,
    "the fixture skill starts outside the lock",
  );
  assert.equal(
    JSON.parse(await readFile(lockfilePath, "utf8")).skills.notes,
    undefined,
    "the confirmation gates the write",
  );
  await page.getByRole("button", { name: "Overwrite and install" }).click();
  await page.getByText(/Replaced: notes|Installed: notes/).waitFor({ timeout: 20_000 });
  await page.getByText("Run /reload", { exact: false }).first().waitFor();
  await page.getByRole("heading", { name: "Managed skills (2)", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Unmanaged skills (2)", exact: true }).waitFor();
  const installed = await readFile(join(managedDirectory, "notes", "SKILL.md"), "utf8");
  assert.match(installed, /Fixture notes skill/);
  const lockAfterAdd = JSON.parse(await readFile(lockfilePath, "utf8"));
  assert.equal(lockAfterAdd.skills.notes?.sourceType, "git");

  await page.getByRole("button", { name: "Dismiss", exact: true }).first().click();
  assert.equal(
    await page.getByText("Run /reload", { exact: false }).count(),
    0,
    "the install reload reminder is dismissible",
  );

  // The whole compact row is the disclosure: name, description, and state pill
  // each toggle the details, not just the "Details & actions" hint.
  const managed = page.getByRole("heading", { name: /^Managed skills/ }).locator("..");
  const managedOne = managed.locator("li").filter({ hasText: "managed-one" });
  await managedOne.locator(".skills-row-title").click();
  assert.equal(await managedOne.locator("details[open]").count(), 1, "the name opens the row");
  await managedOne.locator(".skills-description").click();
  assert.equal(await managedOne.locator("details[open]").count(), 0, "the description closes it");
  await managedOne.locator(".skills-chip-managed").click();
  assert.equal(await managedOne.locator("details[open]").count(), 1, "the pill opens it");
  await managedOne.locator(".skills-chip-managed").click();

  // Remove the added skill through the row's confirmation.
  const notesRow = managed.locator("li").filter({ hasText: "notes" });
  await notesRow.locator(".skills-row-title").click();
  await notesRow.getByRole("button", { name: "Remove", exact: true }).click();
  await page.getByText("Remove notes?", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Yes, remove", exact: true }).click();
  await page.getByText("Removed notes", { exact: false }).waitFor({ timeout: 20_000 });
  await page.getByText("Run /reload", { exact: false }).first().waitFor();
  await assert.rejects(readFile(join(managedDirectory, "notes", "SKILL.md")));
  const lockAfterRemove = JSON.parse(await readFile(lockfilePath, "utf8"));
  assert.equal(lockAfterRemove.skills.notes, undefined);
  assert.equal(lockAfterRemove.skills["managed-one"]?.sourceType, "github", "other entries survive");
  await page.getByRole("button", { name: "Dismiss", exact: true }).first().click();
  assert.equal(await page.getByText("Run /reload", { exact: false }).count(), 0);

  // Broken cleanup deletes only the stale lock entry.
  const broken = page.getByRole("heading", { name: /^Broken entries/ }).locator("..");
  await broken.locator(".skills-chip-broken").click();
  await broken.getByRole("button", { name: "Remove entry" }).click();
  await page.getByText("already missing", { exact: false }).waitFor();
  await page.getByRole("button", { name: "Yes, remove entry" }).click();
  await page.getByText("Removed the stale lock entry for broken-one", { exact: false }).waitFor({
    timeout: 20_000,
  });
  assert.equal(
    JSON.parse(await readFile(lockfilePath, "utf8")).skills["broken-one"],
    undefined,
  );
  assert.equal(
    await page.getByRole("heading", { name: /^Broken entries/ }).count(),
    0,
    "the cleaned entry leaves no stale row",
  );

  // Update's confirmation and cancel are local; the update itself needs GitHub.
  const update = page.getByRole("heading", { name: "Update skills", exact: true }).locator("..");
  await update.getByRole("button", { name: "Update all" }).click();
  await update.getByText("Update checks every managed skill at its locked ref", { exact: false }).waitFor();
  await update.getByRole("button", { name: "Confirm update" }).waitFor();
  await update.getByRole("button", { name: "Cancel", exact: true }).click();
  await update.getByText("Update was not started", { exact: false }).waitFor();
  assert.equal(await update.getByRole("button", { name: "Confirm update" }).count(), 0);

  assert.equal(await page.getByText("Skills unavailable", { exact: false }).count(), 0);
  assert.deepEqual(pageErrors, [], "the panel loads without a browser error");
  console.log("Skills panel smoke test passed");
} catch (error) {
  console.error("Skills panel smoke test failed");
  for (const child of children) {
    const log = child.log.join("");
    if (log !== "") console.error(`--- ${child.name} output ---\n${log.slice(-4000)}`);
  }
  throw error;
} finally {
  if (browser !== undefined) await browser.close().catch(() => undefined);
  for (const child of children) await stopChild(child);
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
}

function startChild(path, env) {
  const child = spawn(path, [], {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { name: path.split("/").at(-1), child, log: [] };
  const append = (chunk) => {
    record.log.push(chunk.toString());
    if (record.log.length > 200) record.log.shift();
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  children.push(record);
  return record;
}

async function stopChild(record) {
  if (record.child.exitCode !== null || record.child.signalCode !== null) return;
  const signal = (name) => {
    try {
      process.kill(-record.child.pid, name);
    } catch {
      // The group is gone already.
    }
  };
  signal("SIGTERM");
  await Promise.race([
    new Promise((resolve) => record.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  signal("SIGKILL");
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForSocket(path, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if ((await stat(path)).isSocket()) return;
    } catch {
      // The daemon has not bound the socket yet.
    }
    await sleep(100);
  }
  throw new Error(`sessiond socket did not appear: ${path}`);
}

async function waitForHttp(url, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await sleep(150);
  }
  throw new Error(`PI WEB did not become ready: ${url}`);
}

async function waitForProject(baseUrl, projectId, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const projects = await getJson(`${baseUrl}/api/machines/local/projects`);
      if (projects.some((project) => project.id === projectId)) return;
    } catch {
      // The daemon may still be binding.
    }
    await sleep(150);
  }
  throw new Error("the seeded project was not discovered");
}

async function waitForSkillsManifest(baseUrl, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const manifest = await getJson(`${baseUrl}/pi-web-plugins/manifest.json`);
      const skills = manifest.plugins.find((plugin) => plugin.id === "skills");
      if (skills !== undefined) {
        const plugins = await getJson(`${baseUrl}/api/plugins`);
        const detail = plugins.plugins.find((plugin) => plugin.id === "skills");
        const asset = await fetch(new URL(skills.module, baseUrl));
        if (asset.ok) return { ...skills, server: detail?.server };
      }
    } catch {
      // The web process has not read the plugin catalog yet.
    }
    await sleep(150);
  }
  throw new Error("the Skills browser entry was not served; run npm run build first");
}

async function getJson(url) {
  const response = await fetch(url);
  assert.ok(response.ok, `${url} answered ${String(response.status)}`);
  return await response.json();
}

async function seedInstance({ home, dataDir, workspace, managedDirectory, lockfilePath, fixture }) {
  await writeSkill(managedDirectory, "managed-one", "A managed skill.");
  await writeSkill(managedDirectory, "unmanaged-one", "A handmade skill.");
  await writeSkill(managedDirectory, "notes", "Handmade notes.");
  await mkdir(join(managedDirectory, "invalid-one"), { recursive: true });
  await writeFile(join(managedDirectory, "invalid-one", "SKILL.md"), "---\nname: invalid-one\n---\n");

  await mkdir(dirname(lockfilePath), { recursive: true });
  await writeFile(
    lockfilePath,
    `${JSON.stringify(
      {
        version: 3,
        skills: {
          "managed-one": lockEntry("managed-one"),
          "broken-one": lockEntry("broken-one"),
        },
        dismissed: {},
        unknownTopLevel: "kept",
      },
      null,
      2,
    )}\n`,
  );

  await writeSkill(join(fixture, "skills"), "notes", "Fixture notes skill.");
  await writeSkill(join(fixture, "skills"), "alpha", "Fixture alpha skill.");
  await git(fixture, ["init", "-q"]);
  await git(fixture, ["config", "user.email", "e2e@example.invalid"]);
  await git(fixture, ["config", "user.name", "E2E"]);
  await git(fixture, ["add", "."]);
  await git(fixture, ["commit", "-qm", "fixture"]);
  await git(fixture, ["branch", "-M", "main"]);

  await writeFile(join(workspace, "README.md"), "e2e workspace\n");
  await git(workspace, ["init", "-q"]);
  await git(workspace, ["config", "user.email", "e2e@example.invalid"]);
  await git(workspace, ["config", "user.name", "E2E"]);
  await git(workspace, ["add", "."]);
  await git(workspace, ["commit", "-qm", "workspace"]);

  await writeFile(
    join(dataDir, "projects.json"),
    `${JSON.stringify(
      {
        projects: [
          {
            id: "e2e-project",
            name: "E2E project",
            path: workspace,
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function lockEntry(name) {
  return {
    source: "owner/repo",
    sourceType: "github",
    sourceUrl: "https://github.com/owner/repo.git",
    ref: "main",
    skillPath: `skills/${name}/SKILL.md`,
    skillFolderHash: "0123456789abcdef0123456789abcdef01234567",
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

async function writeSkill(directory, name, description) {
  await mkdir(join(directory, name), { recursive: true });
  await writeFile(
    join(directory, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
}

async function git(cwd, args) {
  await new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-01-01T00:00:00.000Z",
        GIT_COMMITTER_DATE: "2026-01-01T00:00:00.000Z",
      },
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} exited ${String(code)}`));
    });
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
