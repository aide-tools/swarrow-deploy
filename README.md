# Swarrow Deploy (GitHub Action)

Swarrow Deploy is a step-level GitHub Action that submits an immutable container image digest to a [Swarrow](https://github.com/aide-tools/swarrow) deployment relay. It obtains a short-lived GitHub Actions OIDC token, waits for Swarrow's restart authentication window when necessary and treats only a completed deployment as success.

## Usage

The calling job owns its runner, environment, timeout and permissions. Grant `id-token: write`, then invoke the action without checking out this repository:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: production
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Deploy through Swarrow
        uses: aide-tools/swarrow-deploy@<full-commit-sha>
        with:
          url: https://deploy.example.net
          audience: https://deploy.example.net
          deployment: example-web
          digest: ${{ needs.publish.outputs.digest }}
```

Swarrow policy authorises the calling workflow directly:

```yaml
github:
  audience: https://deploy.example.net

deployments:
  - name: example-web
    identity:
      repository_id: "123456789"
      repository: example/example-web
      workflow_ref: example/example-web/.github/workflows/cd.yml@refs/heads/main
      environment: production
    target:
      service: example_web
      image: ghcr.io/example/example-web
```

The action uses Node.js 24, which is available on current GitHub-hosted runners.

## Inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `url` | Yes | | HTTPS base URL of the Swarrow server |
| `audience` | Yes | | Audience requested in the GitHub OIDC token |
| `deployment` | Yes | | Deployment policy name configured in Swarrow |
| `digest` | Yes | | Canonical immutable digest in `sha256:<64 lowercase hexadecimal characters>` form |
| `debug` | No | `false` | Report safe OIDC identity claims, then fail without contacting Swarrow |

## Debugging identity

Set `debug: true` when an operator needs to compare the caller's signed GitHub identity with Swarrow policy. Debug mode obtains and masks an OIDC token, prints only an allowlist of identity claims and deliberately fails before sending a deployment request.

```yaml
with:
  debug: true
```

Normal deployment failures also report the same allowlisted identity claims. The action never prints the complete token, its unique `jti` value or the GitHub credential used to request it.

## Result handling

The action:

- accepts only `200 OK` as success
- treats `202 Accepted` as failure because Swarrow stopped observing while the rollout remained in progress
- retries `authentication_warming_up` once after the server-provided `Retry-After` delay
- obtains a new OIDC token before that retry
- prints Swarrow's response body for the workflow log

## Version pinning

Pin the action to a full commit SHA. Release tags are convenient for discovery, but an immutable reference gives each caller an explicit, reviewable dependency.

## Licence

Swarrow Deploy is licensed under the [Apache License 2.0](LICENSE).
