# ponytail: placeholder image so /edge/wrangler.toml's [[containers]] block is a
# valid config (wrangler validates this path eagerly for `wrangler types`,
# `wrangler dev`, and the vitest smoke test) before issue #3 lands the real
# bioconductor_docker/TaxSEA image. Nothing in issue #8 dispatches to the
# container, so this never needs to actually serve traffic yet. Replace wholesale
# in issue #3 -- do not build on top of this.
FROM alpine:3.20
CMD ["sleep", "infinity"]
