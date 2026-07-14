# mouaif 🚀

CLI tool with an integrated HTTP server — REST API + Server-Sent Events (SSE).

## Installation

```bash
npm install -g mouaif
```

Or run directly from source:

```bash
git clone <repo-url>
cd mouaif
npm install
npm link
```

## Usage

### Start the server

```bash
mouaif serve
```

With custom port and host:

```bash
mouaif serve --port 5732 --host 0.0.0.0
```

### API Endpoints

| Method | Path       | Description                          |
|--------|------------|--------------------------------------|
| GET    | `/`        | Server info                          |
| GET    | `/data`    | Get stored data                      |
| POST   | `/data`    | Update data (send JSON body)         |
| GET    | `/events`  | Subscribe to Server-Sent Events      |

### SSE (Server-Sent Events)

Connect to the SSE stream:

```bash
curl -N http://localhost:5732/events
```

Events are broadcast to all SSE clients when data is updated via `POST /data`.

### CLI Commands

```bash
mouaif info          # Show server info
mouaif serve         # Start the HTTP server
mouaif emit <e> <m>  # Emit a test event
```

## Project structure

```
mouaif/
├── bin/
│   └── mouaif.js        # CLI entry point
├── src/
│   └── index.js          # HTTP server (REST + SSE)
├── package.json
└── README.md
```

## License

MIT