# Excalidraw collaboration server

Luzmo's fork of [excalidraw/excalidraw-room](https://github.com/excalidraw/excalidraw-room),
with dependency updates and validation of collaboration events.

## Development

Requires Node.js 24 and npm 11 or later.

```sh
npm ci
npm run start:dev
```

The development server listens on port 3002. To build and run in production:

```sh
npm run build
npm start
```

## Configuration

| Variable      | Default                        | Purpose                                          |
| ------------- | ------------------------------ | ------------------------------------------------ |
| `PORT`        | `8080` (`3002` in development) | HTTP and Socket.IO listening port                |
| `CORS_ORIGIN` | `*`                            | Origin allowed by Socket.IO's CORS configuration |

Production configuration can be provided through environment variables or
`.env.production`.

## Docker

```sh
docker build -t excalidraw-room .
docker run --rm -p 3002:8080 -e CORS_ORIGIN=https://your-app.example excalidraw-room
```

The image runs as a non-root user on port 8080.

## PM2

For existing PM2 deployments, build the server and use the supplied configuration:

```sh
npm run build
pm2 start pm2.production.json
```

## Checks

```sh
npm test
npm audit
```

Tests check formatting, lint, compilation, collaboration, and security regressions
over WebSocket and HTTP polling. CI runs these checks on pushes and pull requests.
