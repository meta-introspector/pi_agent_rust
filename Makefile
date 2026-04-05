.PHONY: build test lint check clean check-all

build:
	nix build

test:
	nix develop -c cargo test --all-features

lint:
	nix develop -c cargo clippy --all-targets -- -D warnings

check:
	nix develop -c cargo check --all-targets

check-all: check lint
	@echo "All checks passed"

clean:
	rm -rf result