# OPAL legacy backend

The Python backend, kept as a reference during the TypeScript rewrite. It is deleted at cutover.

```bash
uv sync --all-extras
uv run opal init
uv run opal seed
uv run pytest --no-cov
```
