# Pi capability portability

Wayang v0.1 embeds pi through the `@earendil-works/pi-*` SDK packages. The backend pins `pi-agent-core`, `pi-ai`, and `pi-coding-agent` to the tested `0.80.6` release. Node.js `>=22.19.0` is required.

A global `pi` installation is not required. The checkout installs the matching CLI with the backend dependencies; release tooling should invoke that local binary (for example, `npm --prefix backend exec -- pi`).

## Authentication and settings

Use pi's supported authentication flows rather than copying credential files:

- **OAuth subscription:** start the checkout's pi CLI, run `/login`, and choose a provider. Pi manages its own authentication storage.
- **Provider API key:** set the environment variable documented by pi for the chosen provider in the Wayang process environment.

Wayang's SDK sessions honor standard pi configuration at `~/.pi/agent/settings.json`. Pi 0.80.6 applies project trust before loading `<project>/.pi/settings.json`, project extensions, skills, prompts, themes, system prompts, or project packages. For a trusted project, open the checkout's pi CLI in that project, use `/trust`, and restart the Wayang session; an unapproved project still provides basic chat and context files but its protected project-local resources are ignored. Do not set `defaultProjectTrust: "always"` unless every opened project is inside the same trust boundary.

Never copy or inspect another installation's authentication or trust stores, private extension configuration, or key files as part of Wayang setup.

## Capability classes

### Core and self-contained

These capabilities are implemented in the public Wayang source. They do not depend on a custom globally installed pi extension:

| Capability | Checkout behavior |
|---|---|
| Pi chat and model selection | Creates SDK-backed sessions using pi's built-in tools, provider registry, authentication, settings, and session format. |
| Projects, sessions, transcripts, files, and search | Implemented by the Wayang backend and frontend. |
| First-class scheduled agent jobs | Stored and run by Wayang. External system timer discovery is an additional host-dependent view, not a requirement. |
| Apps runtime and UI | Discovers app manifests, manages app processes, proxies app pages, and exchanges app state/events. Apps themselves are project content and are not included. |
| Browser workbench and human controls | Browser lifecycle, CDP transport, screenshots, input, and the noVNC UI are implemented in Wayang. A compatible local Chromium/Chrome installation and its platform libraries remain runtime prerequisites. |
| Extension discovery and generic rendering | Standard pi extensions, skills, prompts, commands, and custom session entries can load through the SDK. Generic tool calls and messages still render without a Wayang-specific extension. |

The Apps and Browser panes can therefore be used manually without agent companion tools. Agent-driven registration or browser automation is a separate optional capability.

### Optional generic pi extensions

Wayang contains adapters or UI affordances for the following extension-provided features, but v0.1 does not bundle or silently install those extensions:

| Optional capability | Behavior when a compatible extension is installed | Behavior when absent |
|---|---|---|
| Interview/questionnaire tools | A bridge renders structured questions as inline web forms and returns responses to the tool. | No interview tools are offered to the model; normal chat continues. |
| App companion tools | An agent can register, start, stop, list, and update app state through Wayang's HTTP API. | Apps remain manually discoverable and controllable in the Apps pane. |
| Browser companion tools | An agent can use the Wayang-managed browser through reviewed tool wrappers. | The Browser pane and human controls remain usable. |
| TODO tool | Wayang recognizes compatible TODO state and tool results. | The TODO-specific state is empty; chat and sessions are unaffected. |
| Agent teams, subagents, and shared goals | Compatible tools and commands appear through normal extension discovery. | Team/goal actions are not offered; single-agent sessions remain available. |
| Hooks and monitors | Compatible custom messages can appear in session history. | No hook activity is generated. |
| Skills, agents, team templates, and other pi packages | Pi loads resources from its documented global, project, npm, and Git package locations. | Only the checkout and the user's standard pi resources are present. |

The Capabilities screen is an inventory aid. A bridge card can describe the Wayang side of an integration even when its companion tool is not installed; it is not an installation or compatibility guarantee.

Pi extensions and packages execute with the user's full system permissions. Review their source, license, dependencies, network access, and non-interactive/SDK behavior before installation. Extensions that require terminal-only `ctx.ui` dialogs need an explicit Wayang web bridge or another safe non-interactive path.

### Private or security-sensitive integrations

The following are deliberately **not** part of the portable v0.1 capability set:

- command authorization guards, identity-PIN controls, and their policy/model routing;
- privileged-execution hooks and credential caches;
- provider-specific private plugins, local key-file switching, and custom credential brokers;
- personal MCP configuration, monitors, automation, or deployment hooks;
- private browser, app, interview, team, or orchestration extensions from an existing pi installation.

Wayang may recognize some messages produced by these local integrations, but a clean public checkout does not install or advertise their companion extensions. Without a separately reviewed extension, the rest of Wayang continues to work. Public provider authentication uses pi OAuth or documented provider environment variables.

Do not copy such extensions into this repository merely to make a capability badge appear available. Security-sensitive integrations require their own threat-model, source, license, and web-transport review before they can become a supported public package.

## Compatibility expectations

Wayang v0.1 is tested as a unit with pi `0.80.6`. Upgrading any of the three direct pi SDK packages should be done together, followed by a clean `npm ci`, backend tests/build, frontend build, and a smoke test covering session creation, extension loading, settings, model selection, and WebSocket chat.

Third-party extensions are outside that compatibility promise. Their presence must not be required for a clean checkout, and their failure should remove only the associated optional capability rather than basic Wayang operation.
