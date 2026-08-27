import assert from "node:assert/strict";
import test from "node:test";

import { decodeSafeClaims, parseBoolean, run } from "./index.mjs";

const digest = `sha256:${"a".repeat(64)}`;

const token = (claims) =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");

const environment = (overrides = {}) => ({
  INPUT_URL: "https://deploy.example.net",
  INPUT_AUDIENCE: "https://deploy.example.net",
  INPUT_DEPLOYMENT: "example-web",
  INPUT_DIGEST: digest,
  INPUT_DEBUG: "false",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/id-token",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
  ...overrides,
});

const oidcResponse = (value) => Response.json({ value });

test("parseBoolean accepts only explicit booleans", () => {
  assert.equal(parseBoolean("true"), true);
  assert.equal(parseBoolean("false"), false);
  assert.throws(() => parseBoolean("yes"), /must be true or false/);
});

test("decodeSafeClaims excludes token and replay claims", () => {
  const claims = decodeSafeClaims(
    token({
      repository_id: "123456789",
      workflow_ref: "example/example/.github/workflows/deploy.yml@refs/heads/main",
      job_workflow_ref: "example/swarrow-deploy/.github/workflows/deploy.yml@refs/tags/v1",
      jti: "secret-token-id",
      actor: "someone",
    }),
  );

  assert.deepEqual(claims, {
    repository_id: "123456789",
    workflow_ref: "example/example/.github/workflows/deploy.yml@refs/heads/main",
    job_workflow_ref: "example/swarrow-deploy/.github/workflows/deploy.yml@refs/tags/v1",
    job_workflow_ref_present: true,
  });
  assert.equal(JSON.stringify(claims).includes("secret-token-id"), false);
});

test("debug mode obtains identity and fails without contacting Swarrow", async () => {
  const calls = [];
  const outputs = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return oidcResponse(token({ repository_id: "123456789" }));
  };

  await assert.rejects(
    run({
      environment: environment({ INPUT_DEBUG: "true" }),
      fetchImpl,
      outputWriter: (_environment, name, value) => outputs.push([name, value]),
    }),
    /intentionally fails before contacting Swarrow/,
  );
  assert.deepEqual(calls, ["https://token.actions.example/id-token?audience=https%3A%2F%2Fdeploy.example.net"]);
  assert.deepEqual(outputs, [["diagnostic", "true"]]);
});

test("debug mode does not mark malformed identity diagnostics complete", async () => {
  const outputs = [];

  await assert.rejects(
    run({
      environment: environment({ INPUT_DEBUG: "true" }),
      fetchImpl: async () => oidcResponse("not-a-jwt"),
      outputWriter: (_environment, name, value) => outputs.push([name, value]),
    }),
    /intentionally fails before contacting Swarrow/,
  );
  assert.deepEqual(outputs, []);
});

test("an empty optional debug input uses its false default", async () => {
  const responses = [
    oidcResponse(token({ repository_id: "123456789" })),
    Response.json({ action: "no_change", conclusion: "completed" }),
  ];

  await run({
    environment: environment({ INPUT_DEBUG: "" }),
    fetchImpl: async () => responses.shift(),
  });
});

test("successful deployment submits only the digest", async () => {
  const requests = [];
  const identityToken = token({ repository_id: "123456789" });
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (requests.length === 1) {
      return oidcResponse(identityToken);
    }

    return Response.json({ action: "updated", conclusion: "completed" });
  };

  await run({ environment: environment(), fetchImpl });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "https://deploy.example.net/v1/deployments/example-web");
  assert.equal(requests[1].options.method, "POST");
  assert.equal(requests[1].options.headers.Authorization, `Bearer ${identityToken}`);
  assert.deepEqual(JSON.parse(requests[1].options.body), { digest });
});

test("authentication warm-up waits and retries with a fresh token", async () => {
  const firstToken = token({ jti: "first" });
  const secondToken = token({ jti: "second" });
  const responses = [
    oidcResponse(firstToken),
    Response.json(
      { error: { code: "authentication_warming_up" } },
      { status: 503, headers: { "Retry-After": "2" } },
    ),
    oidcResponse(secondToken),
    Response.json({ action: "no_change", conclusion: "completed" }),
  ];
  const authorisations = [];
  const delays = [];
  const diagnostics = [];
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === "POST") {
      authorisations.push(options.headers.Authorization);
    }
    return responses.shift();
  };

  await run({
    environment: environment(),
    fetchImpl,
    sleep: async (milliseconds) => delays.push(milliseconds),
    identityReporter: (_token, status) => diagnostics.push(status),
  });

  assert.deepEqual(delays, [2000]);
  assert.deepEqual(authorisations, [`Bearer ${firstToken}`, `Bearer ${secondToken}`]);
  assert.deepEqual(diagnostics, []);
});

test("an in-progress deployment remains a failure", async () => {
  const responses = [
    oidcResponse(token({ repository_id: "123456789" })),
    Response.json({ action: "updated", conclusion: "in_progress" }, { status: 202 }),
  ];

  await assert.rejects(
    run({ environment: environment(), fetchImpl: async () => responses.shift() }),
    /Swarrow concluded with HTTP 202/,
  );
});

test("invalid inputs fail before requesting a token", async () => {
  let called = false;
  await assert.rejects(
    run({
      environment: environment({ INPUT_DIGEST: "latest" }),
      fetchImpl: async () => {
        called = true;
      },
    }),
    /canonical sha256 digest/,
  );
  assert.equal(called, false);
});

test("plain HTTP is rejected before requesting a token", async () => {
  let called = false;
  await assert.rejects(
    run({
      environment: environment({ INPUT_URL: "http://deploy.example.net" }),
      fetchImpl: async () => {
        called = true;
      },
    }),
    /must use HTTPS/,
  );
  assert.equal(called, false);
});
