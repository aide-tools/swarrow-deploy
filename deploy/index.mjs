import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SAFE_CLAIMS = [
  "iss",
  "aud",
  "sub",
  "repository",
  "repository_id",
  "repository_owner",
  "repository_owner_id",
  "workflow",
  "workflow_ref",
  "workflow_sha",
  "job_workflow_ref",
  "job_workflow_sha",
  "ref",
  "ref_type",
  "sha",
  "environment",
  "event_name",
  "runner_environment",
];

const commandValue = (value) =>
  String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

const command = (name, value = "") => {
  process.stdout.write(`::${name}::${commandValue(value)}\n`);
};

const setOutput = (environment, name, value) => {
  if (environment.GITHUB_OUTPUT) {
    appendFileSync(environment.GITHUB_OUTPUT, `${name}=${value}\n`, "utf8");
  }
};

const requiredInput = (environment, name) => {
  const value = environment[`INPUT_${name.toUpperCase()}`];
  if (!value) {
    throw new Error(`Input ${name.toLowerCase()} is required`);
  }

  return value;
};

export const parseBoolean = (value, name = "debug") => {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  throw new Error(`Input ${name} must be true or false`);
};

export const decodeSafeClaims = (token) => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("OIDC token is not a JWT");
  }

  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  const safe = Object.fromEntries(
    SAFE_CLAIMS.filter((key) => Object.hasOwn(claims, key)).map((key) => [key, claims[key]]),
  );
  safe.job_workflow_ref_present = Object.hasOwn(claims, "job_workflow_ref");
  return safe;
};

const reportIdentity = (token, status) => {
  command("group", status ? `Safe OIDC diagnostics for HTTP ${status}` : "Safe OIDC diagnostics");
  try {
    process.stdout.write(`${JSON.stringify(decodeSafeClaims(token))}\n`);
    return true;
  } catch (error) {
    process.stderr.write(`Unable to decode the allowlisted OIDC identity claims: ${error.message}\n`);
    return false;
  } finally {
    command("endgroup");
  }
};

const requestToken = async (environment, audience, fetchImpl) => {
  const requestURL = environment.ACTIONS_ID_TOKEN_REQUEST_URL;
  const oidcRequestToken = environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestURL || !oidcRequestToken) {
    throw new Error("GitHub OIDC is unavailable; grant the job id-token: write permission");
  }

  const url = new URL(requestURL);
  url.searchParams.set("audience", audience);
  const response = await fetchImpl(url, {
    headers: { Authorization: `bearer ${oidcRequestToken}` },
  });
  if (!response.ok) {
    throw new Error(`GitHub OIDC token request concluded with HTTP ${response.status}`);
  }

  const body = await response.json();
  if (typeof body.value !== "string" || body.value === "") {
    throw new Error("GitHub OIDC token response omitted its value");
  }

  command("add-mask", body.value);
  return body.value;
};

const deploymentURL = (base, deployment) => {
  const url = new URL(base);
  if (url.protocol !== "https:") {
    throw new Error("Input url must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Input url must not contain credentials");
  }
  if (url.search || url.hash) {
    throw new Error("Input url must not contain a query or fragment");
  }

  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/deployments/${encodeURIComponent(deployment)}`;
  return url;
};

const responseErrorCode = (body) => {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.error?.code === "string" ? parsed.error.code : "";
  } catch {
    return "";
  }
};

const retryDelay = (response) => {
  const value = response.headers.get("retry-after") ?? "";
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("Swarrow omitted a valid Retry-After value");
  }

  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds)) {
    throw new Error("Swarrow omitted a valid Retry-After value");
  }

  return seconds;
};

export const run = async ({
  environment = process.env,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  outputWriter = setOutput,
  identityReporter = reportIdentity,
} = {}) => {
  const url = requiredInput(environment, "url");
  const audience = requiredInput(environment, "audience");
  const deployment = requiredInput(environment, "deployment");
  const digest = requiredInput(environment, "digest");
  const debug = parseBoolean(environment.INPUT_DEBUG || "false");

  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error("Input digest must be a canonical sha256 digest");
  }

  const endpoint = deploymentURL(url, deployment);

  if (debug) {
    const token = await requestToken(environment, audience, fetchImpl);
    if (identityReporter(token)) {
      outputWriter(environment, "diagnostic", "true");
    }
    throw new Error("Debug mode intentionally fails before contacting Swarrow");
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const token = await requestToken(environment, audience, fetchImpl);
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ digest }),
    });
    const body = await response.text();
    process.stdout.write(`${body}\n`);

    if (response.status === 200) {
      return;
    }

    const retryableWarmup =
      response.status === 503 &&
      responseErrorCode(body) === "authentication_warming_up" &&
      attempt < 2;
    if (retryableWarmup) {
      const delay = retryDelay(response);
      process.stderr.write(`Swarrow is warming up; retrying with a new token in ${delay} seconds\n`);
      await sleep(delay * 1000);
      continue;
    }

    identityReporter(token, response.status);
    throw new Error(`Swarrow concluded with HTTP ${response.status}`);
  }
};

const main = async () => {
  try {
    await run();
  } catch (error) {
    command("error", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
