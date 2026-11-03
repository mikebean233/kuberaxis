import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SAMPLE = fileURLToPath(new URL("../../test-data/usbank-sample-statement.pdf", import.meta.url));
// The sample statement has a checking account with 51 transactions and a savings account with 3.
const SAMPLE_TRANSACTIONS = 54;

// Set these to test prebuilt images (as the release workflow does); otherwise they're built from the Dockerfile.
const API_IMAGE = process.env.IMAGE_API;
const WEB_IMAGE = process.env.IMAGE_WEB;

const id = `kuberaxis-test-${process.pid}`;
const names = { network: id, db: `${id}-db`, api: `${id}-api`, web: `${id}-web` };

const docker = async (...args: string[]) => (await exec("docker", args, { maxBuffer: 64 * 1024 * 1024 })).stdout.trim();

async function build(target: string): Promise<string> {
  const tag = `kuberaxis-${target}:test`;
  await docker("build", "--target", target, "-t", tag, ROOT);
  return tag;
}

/** Runs a container with `port` published on a random localhost port, and returns that port's base URL. */
async function run(name: string, image: string, port: number, env: Record<string, string> = {}): Promise<string> {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  await docker("run", "-d", "--name", name, "--network", names.network, "-p", `127.0.0.1::${port}`, ...envArgs, image);
  const published = await docker("port", name, `${port}/tcp`);
  return `http://${published.split("\n")[0]}`;
}

async function waitFor(what: string, container: string, check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    if ((await docker("inspect", "-f", "{{.State.Running}}", container)) !== "true") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const logs = await exec("docker", ["logs", "--tail", "50", container]).catch(() => ({ stdout: "", stderr: "" }));
  throw new Error(`${what} did not become ready:\n${logs.stdout}${logs.stderr}`);
}

const imageUser = (image: string) => docker("image", "inspect", "-f", "{{.Config.User}}", image);

let api: { image: string; url: string };
let web: { image: string; url: string };

beforeAll(async () => {
  const [apiImage, webImage] = await Promise.all([API_IMAGE ?? build("api"), WEB_IMAGE ?? build("web")]);

  await docker("network", "create", names.network);
  await docker(
    "run", "-d", "--name", names.db, "--network", names.network,
    "-e", "POSTGRES_USER=kuberaxis", "-e", "POSTGRES_PASSWORD=kuberaxis", "-e", "POSTGRES_DB=kuberaxis",
    "postgres:18",
  );
  // Over TCP, so the temporary server the image runs during initialization doesn't count as ready.
  await waitFor("PostgreSQL", names.db, async () => {
    await docker("exec", names.db, "pg_isready", "-h", "127.0.0.1", "-U", "kuberaxis");
    return true;
  });

  // Same environment the Helm chart sets, with the password passed separately as PGPASSWORD.
  const apiUrl = await run(names.api, apiImage, 3001, {
    DATABASE_URL: `postgres://kuberaxis@${names.db}:5432/kuberaxis`,
    PGPASSWORD: "kuberaxis",
  });
  const webUrl = await run(names.web, webImage, 8080);
  api = { image: apiImage, url: apiUrl };
  web = { image: webImage, url: webUrl };

  await waitFor("API", names.api, async () => (await fetch(`${api.url}/api/health`)).ok);
  await waitFor("web", names.web, async () => (await fetch(web.url)).ok);
});

afterAll(async () => {
  await docker("rm", "-f", "-v", names.api, names.web, names.db).catch(() => {});
  await docker("network", "rm", names.network).catch(() => {});
});

describe("api image", () => {
  it("runs as a non-root user", async () => {
    expect(await imageUser(api.image)).toBe("node");
  });

  it("applies migrations on start and reports healthy", async () => {
    expect(await (await fetch(`${api.url}/api/health`)).json()).toEqual({ ok: true });
  });

  it("imports a statement PDF", async () => {
    const form = new FormData();
    form.append("file", new Blob([readFileSync(SAMPLE)], { type: "application/pdf" }), "statement.pdf");
    const response = await fetch(`${api.url}/api/imports`, { method: "POST", body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ parsed: SAMPLE_TRANSACTIONS, inserted: SAMPLE_TRANSACTIONS });

    const transactions = (await (await fetch(`${api.url}/api/transactions`)).json()) as unknown[];
    expect(transactions).toHaveLength(SAMPLE_TRANSACTIONS);
  });

  it("rejects files that aren't PDFs", async () => {
    const form = new FormData();
    form.append("file", new Blob(["not a pdf"]), "notes.txt");
    expect((await fetch(`${api.url}/api/imports`, { method: "POST", body: form })).status).toBe(415);
  });

  it("disables the purge endpoint in production", async () => {
    expect((await fetch(`${api.url}/api/data`, { method: "DELETE" })).status).toBe(404);
  });

  // Last, since it stops the container.
  it("shuts down cleanly on SIGTERM", async () => {
    const started = Date.now();
    await docker("stop", "-t", "10", names.api);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await docker("inspect", "-f", "{{.State.ExitCode}}", names.api)).toBe("0");
  });
});

describe("web image", () => {
  it("runs as a non-root user", async () => {
    expect(await imageUser(web.image)).not.toMatch(/^(|root|0)$/);
  });

  it("serves the app and its assets", async () => {
    const response = await fetch(web.url);
    const html = await response.text();
    expect(html).toContain('<div id="root"></div>');
    expect(response.headers.get("cache-control")).toBe("no-cache");

    const script = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
    expect(script).toMatch(/^\/assets\//);
    const asset = await fetch(new URL(script!, web.url));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });

  it("falls back to the app for client-side routes", async () => {
    const response = await fetch(`${web.url}/some/client/route`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root"></div>');
  });

  it("does not answer /api requests with the app", async () => {
    expect((await fetch(`${web.url}/api/transactions`)).status).toBe(404);
  });
});
