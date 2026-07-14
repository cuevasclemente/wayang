# Project-local apps framework

Wayang can host small, project-local interactive applications in its Apps pane. Chat remains the orchestration surface while an app provides a visualization, dashboard, form, map, or workflow-specific control panel.

Apps execute with the host user's authority. Review their manifests, commands, dependencies, and source before starting them. The iframe is not a sandbox for hostile code; see [SECURITY.md](../SECURITY.md).

## App layout

```text
<project>/.pi/apps/<app-id>/
├── app.json
├── package.json
└── src/...
```

An app is an ordinary local project. Wayang discovers/registers its manifest, allocates a loopback port when requested, starts its development command, checks its health path, and renders it in the right pane.

## Manifest

```json
{
  "schemaVersion": 1,
  "id": "hello-app",
  "name": "Hello App",
  "description": "Generic test app",
  "entry": {
    "type": "managed-process",
    "workingDirectory": ".pi/apps/hello-app",
    "devCommand": "npm run dev -- --host 127.0.0.1",
    "healthPath": "/",
    "port": 0
  }
}
```

`port: 0` lets the backend choose a free loopback port and pass it to the process as `PORT` and `PI_APP_PORT`. Keep managed app servers on loopback. Do not place credentials in a manifest or command.

## Agent tools are optional

The backend and UI can register and manage apps without a global pi installation. Agent-initiated conveniences such as `register_app`, `list_apps`, `start_app`, `stop_app`, and `update_app_state` require a compatible, separately reviewed Wayang/pi extension. A public checkout must not assume a personal extension is installed; workflows should degrade to manual Apps-pane controls.

Companion tools normally address the backend through `WAYANG_URL`, defaulting to `http://127.0.0.1:8787`. If built-in authentication is enabled, an external tool also needs an intentionally designed authenticated integration; do not embed browser cookies or shared passwords in tool arguments or source.

## Browser bridge

An app can send an event or state update to its parent:

```js
window.parent.postMessage({
  source: "pi-app",
  appId: "hello-app",
  type: "event",
  event: "ready",
  payload: { ok: true },
  summary: "Hello app is ready"
}, window.location.origin);
```

Wayang sends state updates to the iframe:

```js
const expectedWayangOrigin = "http://127.0.0.1:8787";
window.addEventListener("message", (event) => {
  if (event.origin === expectedWayangOrigin &&
      event.data?.source === "wayang" && event.data.type === "state:update") {
    console.log(event.data.state);
  }
});
```

Wayang accepts bridge messages only from the registered iframe window on the same origin, and sends state only to that same origin. Apps must validate `event.origin`, `event.source`, and the message schema. Do not redirect the embedded app to an external origin or include secrets or unnecessarily sensitive project data in bridge messages.

## Remote access

Direct localhost iframe URLs are suitable only when the browser and app processes share a host. Remote use requires Wayang's same-origin app proxy and an HTTPS/authenticated deployment that protects app routes and WebSocket transports. The proxy deliberately strips browser cookies and authorization/forwarding headers in both directions; apps must not use cookies for state or authentication through this route. Never expose a managed app's loopback port separately as an authentication bypass.

## Current scope

- Multiple apps may be registered per project and switched in the Apps pane.
- Wayang manages local app process lifecycle and bridge state.
- There is no app marketplace, per-app permissions model, hostile-code isolation, or multi-user authorization in v0.1.
- Automatic agent-driven focus/opening depends on optional companion tooling; manual selection is the portable default.
