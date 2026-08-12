.DEFAULT_GOAL := help

.PHONY: help doctor bootstrap install configure local-https-check local-https setup-capability-approval pi-login browser-credentials-unlock build start dev test test-scripts test-e2e install-e2e-browser check smoke

help: ## Show this help (the safe, non-mutating default)
	@printf '%s\n' 'Wayang v0.1 source-checkout commands:'
	@printf '%s\n' ''
	@awk 'BEGIN { FS = ":.*## " } /^[a-zA-Z0-9_-]+:.*## / { printf "  %-20s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf '%s\n' ''
	@printf '%s\n' 'Recommended first run: make bootstrap'

doctor: ## Check required and optional prerequisites without printing secrets
	@node scripts/doctor.mjs

bootstrap: ## Install, build, interactively configure, and smoke-test Wayang
	@sh scripts/bootstrap.sh

install: ## Deterministically install backend, frontend, and E2E dependencies
	npm --prefix backend ci --include=dev
	npm --prefix frontend ci --include=dev
	npm --prefix e2e ci --include=dev

configure: ## Run the interactive, secret-safe configuration wizard
	@node scripts/configure.mjs

local-https-check: ## Validate the optional foreground Caddy HTTPS proxy configuration
	@node scripts/local-https.mjs --check

local-https: ## Run the optional Caddy HTTPS reverse proxy in the foreground
	@node scripts/local-https.mjs

setup-capability-approval: ## Optional manual preflight; service startup initializes missing cooldown state automatically
	@node scripts/run-with-env.mjs -- node scripts/setup-capability-approval.mjs

pi-login: ## Start the checkout's pi CLI for an interactive /login
	@test -x backend/node_modules/.bin/pi || { printf '%s\n' 'Local pi is missing; run make install first.' >&2; exit 1; }
	@printf '%s\n' 'In pi, run /login, choose a provider, then run /quit.'
	@./backend/node_modules/.bin/pi --no-session

browser-credentials-unlock: ## Unlock Bitwarden for guarded Browser-panel fills (interactive)
	@node scripts/run-with-env.mjs -- node scripts/browser-credentials-unlock.mjs

build: ## Build the backend and production frontend
	npm --prefix backend run build
	npm --prefix frontend run build

start: build ## Build and run production Wayang in the foreground
	@node scripts/run-with-env.mjs -- node backend/dist/index.js

dev: ## Run backend and frontend development servers with signal cleanup
	@node scripts/dev.mjs

test-scripts: ## Run bootstrap/configuration script unit tests
	@node --test scripts/tests/*.test.mjs

test: ## Run backend tests, frontend lint/build, and script tests
	npm --prefix backend test
	npm --prefix frontend run lint
	npm --prefix frontend run build
	@$(MAKE) test-scripts

test-e2e: ## Run isolated Playwright tests (Chromium must already be installed)
	npm --prefix e2e test

install-e2e-browser: ## Download Playwright Chromium into the user cache (no sudo)
	npm --prefix e2e exec -- playwright install chromium

smoke: build ## Start an isolated production server and verify /healthz
	@node scripts/smoke.mjs

check: test build ## Run the release unit/lint/build gate
