.PHONY: install verify dev infra-up infra-down
install:
	corepack enable && pnpm install
verify:
	pnpm verify
dev:
	pnpm dev
infra-up:
	cp -n .env.example .env || true
	pnpm infra:up
infra-down:
	pnpm infra:down
