# Docker smoke test

## Overview

The Docker smoke test builds a production mouaif image, starts the server with isolated storage, mounts an example project, and validates the built UI and core project, file, chat, and message APIs.

## Usage

Docker with the Compose plugin is required. Run the complete test from the repository root:

```bash
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from test
```

Remove the containers and isolated test volume afterward:

```bash
docker compose -f compose.test.yaml down --volumes
```

A successful run ends with `Docker smoke test passed.` and exits with status zero. The example fixture is available at `examples/docker-test-project/`.
