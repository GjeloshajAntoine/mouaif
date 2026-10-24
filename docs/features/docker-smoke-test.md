# Docker smoke test

## Overview

The Docker smoke test builds a production mouaif image, starts the server with isolated storage, mounts an example project, and validates the built UI plus core settings, project, file, chat, and message APIs. It also verifies that DB-backed project settings persist without writing a `.mouaif.json` file.

## Usage

Docker with the Compose plugin is required. Run the complete test from the repository root:

```bash
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from test
```

Remove the containers and isolated test volume afterward:

```bash
docker compose -f compose.test.yaml down --volumes
```

The run is capped at 0.5 CPU and 384 MiB for the app and 0.25 CPU and 128 MiB for the test client; set `MOUAIF_APP_CPUS`, `MOUAIF_APP_MEM`, `MOUAIF_TEST_CPUS` or `MOUAIF_TEST_MEM` to change them. The image build runs at low priority with a 1 GiB Node heap; pass `--build-arg BUILD_HEAP_MB=2048` to `docker build` if the UI bundle outgrows it.

A successful run ends with `Docker smoke test passed.` and exits with status zero. The example fixture is available at `examples/docker-test-project/`. If the local Docker CLI cannot read its default Buildx state, use a writable temporary config for the run:

```bash
DOCKER_CONFIG=/tmp/mouaif-docker-config npm run test:docker
```
