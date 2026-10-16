import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createSign } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_DIR = join(ROOT, "extension-work");
const DEFAULT_OUTPUT_DIR = join(ROOT, "generated-artifacts", "extension-releases");
const CWS_API = "https://chromewebstore.googleapis.com";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CWS_SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;

function getOption(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value after ${name}.`);
  }
  return value;
}

const shouldPublish = args.includes("--publish");
const outputDir = resolve(getOption("--output-dir") || DEFAULT_OUTPUT_DIR);
const unknownArgs = args.filter((arg, index) =>
  arg.startsWith("--") &&
  !["--publish", "--output-dir"].includes(arg) &&
  args[index - 1] !== "--output-dir",
);
if (unknownArgs.length) throw new Error(`Unknown option: ${unknownArgs[0]}`);

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Required environment variable is missing: ${name}`);
  return value;
}

function extensionApiBaseUrl() {
  const raw = requiredEnv("EXTENSION_LICENSE_API_BASE_URL");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("EXTENSION_LICENSE_API_BASE_URL must be a valid public HTTPS URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("EXTENSION_LICENSE_API_BASE_URL must be an HTTPS API origin without credentials, path, query, or fragment.");
  }
  return url.origin;
}

function validateManifest(manifest) {
  if (manifest.manifest_version !== 3) {
    throw new Error("Only Manifest V3 extensions are supported by this release script.");
  }
  if (typeof manifest.version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
    throw new Error("The extension manifest must have a valid Chrome version (one to four integer components).");
  }
  if (manifest.version.split(".").some(component => Number(component) > 65535)) {
    throw new Error("Chrome version components must not exceed 65535.");
  }
}

function shouldSkip(relativePath, entryName) {
  const parts = relativePath.split(sep);
  if (parts.some(part => part === "native-companion" || part === "_metadata")) return true;
  if (entryName === "README.md" || entryName === "RELEASE.md" || entryName === "kur.bat") return true;
  if (
    entryName === ".DS_Store" ||
    entryName === "Thumbs.db" ||
    /^\.env(?:\.|$)/i.test(entryName) ||
    /\.(?:pem|key|crx|zip)$/i.test(entryName)
  ) return true;
  return parts.some(part => part === ".git" || part === "node_modules");
}

async function copyExtensionFiles(sourceDir, stageDir, relativeDir = "") {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryRelative = relativeDir ? join(relativeDir, entry.name) : entry.name;
    if (shouldSkip(entryRelative, entry.name)) continue;
    const sourcePath = join(sourceDir, entry.name);
    const destinationPath = join(stageDir, entryRelative);
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      await copyExtensionFiles(sourcePath, stageDir, entryRelative);
    } else if (entry.isFile()) {
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(`Unsupported file type in extension package: ${entryRelative}`);
    }
  }
}

function runZip(outputPath, stageDir) {
  const result = spawnSync("zip", ["-q", "-X", "-r", outputPath, "."], {
    cwd: stageDir,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`Could not run zip: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Could not create extension ZIP.").trim());
  }
  const validation = spawnSync("zip", ["-T", outputPath], { encoding: "utf8" });
  if (validation.status !== 0) {
    throw new Error((validation.stderr || validation.stdout || "The extension ZIP failed its integrity check.").trim());
  }
}

async function createPackage() {
  const apiBaseUrl = extensionApiBaseUrl();
  const manifestPath = join(EXTENSION_DIR, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);
  const files = await readdir(EXTENSION_DIR);
  if (!files.includes("env.js")) throw new Error("extension-work/env.js is missing.");

  await mkdir(outputDir, { recursive: true });
  const archivePath = join(outputDir, `takipci-paneli-v${manifest.version}.zip`);
  const stageDir = await mkdtemp(join(tmpdir(), "takipci-paneli-release-"));
  try {
    await copyExtensionFiles(EXTENSION_DIR, stageDir);
    const stagedEnvPath = join(stageDir, "env.js");
    const stagedEnv = await readFile(stagedEnvPath, "utf8");
    const setting = /LICENSE_API_BASE_URL:\s*("[^"]*")/;
    if (!setting.test(stagedEnv)) {
      throw new Error("Could not find LICENSE_API_BASE_URL in extension-work/env.js.");
    }
    await writeFile(
      stagedEnvPath,
      stagedEnv.replace(setting, `LICENSE_API_BASE_URL: ${JSON.stringify(apiBaseUrl)}`),
      "utf8",
    );

    const stagedManifest = JSON.parse(await readFile(join(stageDir, "manifest.json"), "utf8"));
    validateManifest(stagedManifest);
    await rm(archivePath, { force: true });
    runZip(archivePath, stageDir);

    return { archivePath, version: manifest.version, apiBaseUrl };
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function getServiceAccountAccessToken() {
  const email = requiredEnv("CWS_SERVICE_ACCOUNT_EMAIL");
  const privateKey = requiredEnv("CWS_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(JSON.stringify({
      iss: email,
      scope: CWS_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })),
  ].join(".");
  let signature;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signature = signer.sign(privateKey, "base64url");
  } catch {
    throw new Error("CWS_SERVICE_ACCOUNT_PRIVATE_KEY is not a valid service-account private key.");
  }
  const assertion = `${unsigned}.${signature}`;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const payload = await readResponse(response, "Google service-account token request");
  if (!payload.access_token) throw new Error("Google did not return an access token.");
  return payload.access_token;
}

async function readResponse(response, operation) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text.slice(0, 1000) };
  }
  if (!response.ok) {
    const message = body?.error?.message || body?.error_description || body?.message || response.statusText;
    throw new Error(`${operation} failed (${response.status}): ${String(message).slice(0, 1000)}`);
  }
  return body;
}

function webStoreItemUrl(publisherId, itemId, method) {
  return `${CWS_API}/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}:${method}`;
}

async function cwsRequest(accessToken, url, options = {}, operation) {
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
  });
  return readResponse(response, operation);
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function publishedVersions(status) {
  return (status?.publishedItemRevisionStatus?.distributionChannels || [])
    .map(channel => channel.crxVersion)
    .filter(version => typeof version === "string" && /^\d+(?:\.\d+){0,3}$/.test(version));
}

async function ensureUploadFinished(accessToken, publisherId, itemId, upload) {
  if (upload.uploadState !== "UPLOAD_IN_PROGRESS") {
    if (!upload.crxVersion) throw new Error(`Upload did not report a package version (state: ${upload.uploadState || "unknown"}).`);
    return;
  }

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise(resolveDelay => setTimeout(resolveDelay, 3000));
    const status = await cwsRequest(
      accessToken,
      webStoreItemUrl(publisherId, itemId, "fetchStatus"),
      {},
      "Chrome Web Store upload status check",
    );
    const uploadState = status.lastAsyncUploadState;
    if (uploadState && /FAIL|ERROR|REJECT/i.test(uploadState)) {
      throw new Error(`Chrome Web Store rejected the upload (state: ${uploadState}).`);
    }
    if (uploadState && uploadState !== "UPLOAD_IN_PROGRESS") {
      const submittedVersions = status?.submittedItemRevisionStatus?.distributionChannels || [];
      if (submittedVersions.some(channel => channel.crxVersion === upload.crxVersion)) return;
      if (uploadState === "UPLOAD_COMPLETE" || uploadState === "UPLOAD_SUCCESS") return;
      throw new Error(`Chrome Web Store upload ended in an unexpected state: ${uploadState}.`);
    }
  }
  throw new Error("Chrome Web Store is still processing the upload; check the publisher dashboard before retrying.");
}

async function submitToChromeWebStore(archivePath, version) {
  const publisherId = requiredEnv("CWS_PUBLISHER_ID");
  const itemId = requiredEnv("CWS_EXTENSION_ID");
  if (!/^[a-p]{32}$/.test(itemId)) {
    throw new Error("CWS_EXTENSION_ID must be the 32-character Chrome Web Store item ID.");
  }
  const accessToken = await getServiceAccountAccessToken();
  const statusUrl = webStoreItemUrl(publisherId, itemId, "fetchStatus");
  const currentStatus = await cwsRequest(
    accessToken,
    statusUrl,
    {},
    "Chrome Web Store item status check",
  );
  if (currentStatus.takenDown) throw new Error("The Chrome Web Store item is taken down; resolve this in the publisher dashboard first.");
  const versions = publishedVersions(currentStatus);
  if (!versions.length) {
    throw new Error("No published version was found. Create and publish the first store listing manually before using the automated update command.");
  }
  const latestVersion = versions.reduce((latest, candidate) =>
    compareVersions(candidate, latest) > 0 ? candidate : latest,
  );
  if (compareVersions(version, latestVersion) <= 0) {
    throw new Error(`Manifest version ${version} must be greater than the published version ${latestVersion}.`);
  }
  if (currentStatus.submittedItemRevisionStatus) {
    throw new Error("A Chrome Web Store submission is already pending. Check its status in the publisher dashboard before releasing another version.");
  }

  const packageBytes = await readFile(archivePath);
  const upload = await cwsRequest(
    accessToken,
    `${CWS_API}/upload/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}:upload`,
    {
      method: "POST",
      headers: { "content-type": "application/zip" },
      body: packageBytes,
    },
    "Chrome Web Store package upload",
  );
  if (upload.crxVersion && upload.crxVersion !== version) {
    throw new Error(`The store received version ${upload.crxVersion}, not the expected ${version}.`);
  }
  await ensureUploadFinished(accessToken, publisherId, itemId, upload);

  const publishResponse = await cwsRequest(
    accessToken,
    webStoreItemUrl(publisherId, itemId, "publish"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
    "Chrome Web Store publish submission",
  );
  console.log(`Submitted version ${version} to Chrome Web Store review.`);
  if (publishResponse.status) console.log(`Submission status: ${publishResponse.status}`);
  console.log("Chrome will deliver the update automatically after the store approves it.");
}

async function main() {
  const { archivePath, version, apiBaseUrl } = await createPackage();
  console.log(`Packaged Takipçi Paneli ${version}: ${relative(ROOT, archivePath) || basename(archivePath)}`);
  console.log(`Production license API: ${apiBaseUrl}`);
  if (shouldPublish) {
    await submitToChromeWebStore(archivePath, version);
  } else {
    console.log("Package only. To upload and submit it for store review, run pnpm run extension:publish.");
  }
}

main().catch(error => {
  console.error(`Extension release failed: ${error.message}`);
  process.exitCode = 1;
});
