"""OPAL CLI entry point."""

import argparse
import sys
from pathlib import Path


def _setup_project(args: argparse.Namespace) -> None:
    """Configure project settings from CLI args.

    Always reports the resolved database and where it came from, on stderr —
    stdout is the MCP stdio protocol channel, and a silently-resolved database
    is how `opal serve` and `opal mcp` end up split across different files.
    """
    from opal.config import _default_database_url, configure_for_project, get_active_settings
    from opal.project import get_project_config

    project = None
    database_path = None

    # Explicit database path takes precedence
    if hasattr(args, "database") and args.database:
        database_path = Path(args.database)
        source = "--database"
    elif hasattr(args, "project") and args.project:
        project = get_project_config(Path(args.project))
        source = "--project"
    else:
        # Auto-detect project from current directory
        project = get_project_config()
        source = "opal.project.yaml auto-detected" if project else ""

    if project or database_path:
        settings = configure_for_project(project=project, database_path=database_path)
    else:
        settings = get_active_settings()
        if settings.database_url != _default_database_url():
            source = "OPAL_DATABASE_URL environment override"
        else:
            source = "platform default"

    if project:
        print(f"Using project: {project.name} ({project.project_dir})", file=sys.stderr)
    print(f"Database: {settings.database_url} ({source})", file=sys.stderr)

    # The database is the project: pick up DB-stored config (and import a
    # cwd yaml once) so CLI commands see the same config the server does.
    # Best-effort — the database may not exist yet (e.g. before `opal init`).
    try:
        from opal.config import apply_db_overlay, bootstrap_project_config
        from opal.db.base import SessionLocal

        with SessionLocal() as db:
            bootstrap_project_config(db)
            apply_db_overlay(db)
    except Exception:
        pass


def cmd_serve(args: argparse.Namespace) -> None:
    """Start the OPAL web server."""
    import uvicorn

    from opal.config import get_active_settings

    # Configure project first
    _setup_project(args)

    settings = get_active_settings()
    # Serve must work against a brand-new project the way the launcher
    # does: create directories and initialize/migrate the schema.
    settings.ensure_directories()
    from opal.db.base import get_engine, init_database

    init_database(get_engine())
    host = args.host or settings.host
    port = args.port or settings.port

    print(f"Starting OPAL server at http://{host}:{port}")

    uvicorn.run(
        "opal.api.app:app",
        host=host,
        port=port,
        reload=settings.debug,
    )


def cmd_migrate(args: argparse.Namespace) -> None:
    """Run database migrations."""
    import os
    import subprocess

    from opal.config import get_active_settings

    # Honor --project / --database so migrations can target any project's DB,
    # not just whatever the ambient environment points to.
    _setup_project(args)

    # Find project root by looking for alembic.ini
    opal_dir = Path(__file__).resolve().parent.parent.parent
    if not (opal_dir / "alembic.ini").exists():
        # Try one level up (installed package case)
        opal_dir = opal_dir.parent
    if not (opal_dir / "alembic.ini").exists():
        # Fall back to current working directory
        opal_dir = Path.cwd()

    # Pass database URL to alembic subprocess via environment
    settings = get_active_settings()
    env = os.environ.copy()
    env["OPAL_DATABASE_URL"] = settings.database_url

    if args.action == "upgrade":
        revision = args.revision or "head"
        subprocess.run(
            ["alembic", "upgrade", revision],
            cwd=opal_dir,
            env=env,
            check=True,
        )
    elif args.action == "downgrade":
        revision = args.revision or "-1"
        subprocess.run(
            ["alembic", "downgrade", revision],
            cwd=opal_dir,
            env=env,
            check=True,
        )
    elif args.action == "generate":
        if not args.message:
            print("Error: --message required for generate", file=sys.stderr)
            sys.exit(1)
        subprocess.run(
            ["alembic", "revision", "--autogenerate", "-m", args.message],
            cwd=opal_dir,
            env=env,
            check=True,
        )
    elif args.action == "current":
        subprocess.run(
            ["alembic", "current"],
            cwd=opal_dir,
            env=env,
            check=True,
        )
    elif args.action == "history":
        subprocess.run(
            ["alembic", "history"],
            cwd=opal_dir,
            env=env,
            check=True,
        )


def cmd_seed(args: argparse.Namespace) -> None:
    """Populate database with Mojave Sphinx demo data."""
    _setup_project(args)

    from opal.config import PROJECT_CONFIG_KEY, get_app_setting
    from opal.db.base import SessionLocal
    from opal.db.models import Part, Supplier, User, Workcenter
    from opal.seed import seed_database

    db = SessionLocal()
    try:
        # The seed OVERWRITES the project config and inserts demo users with a
        # publicly documented password — never on top of a configured instance.
        found = []
        for model, label in (
            (Part, "parts"),
            (User, "users"),
            (Workcenter, "workcenters"),
            (Supplier, "suppliers"),
        ):
            count = db.query(model).count()
            if count:
                found.append(f"{count} {label}")
        if get_app_setting(db, PROJECT_CONFIG_KEY) is not None:
            found.append("a saved project config")

        if found and not args.force:
            print(
                "Refusing to seed: this database already has "
                + ", ".join(found)
                + ".\nSeeding would overwrite the project config and add demo users "
                "with a publicly documented password.\n"
                "Use --force to seed anyway.",
                file=sys.stderr,
            )
            sys.exit(1)

        print("Seeding Mojave Sphinx data...")
        seed_database(db)
        print("Done.")
    finally:
        db.close()


def cmd_init(args: argparse.Namespace) -> None:
    """Initialize OPAL (create directories, initialize/migrate database)."""
    from opal.config import get_active_settings
    from opal.db.base import get_engine, init_database

    # Configure project first
    _setup_project(args)

    settings = get_active_settings()
    settings.ensure_directories()

    print("Created data directories")

    try:
        engine = get_engine()
        init_database(engine)
        print("Database initialized")
    except Exception as e:
        print(f"Database initialization failed: {e}")
        print("If developing, you can use: opal migrate upgrade")
        sys.exit(1)


def cmd_import_requirements(args: argparse.Namespace) -> None:
    """Import the opal.project.yaml requirement catalog into the database."""
    _setup_project(args)

    from opal.config import get_active_project
    from opal.db.base import SessionLocal
    from opal.se.import_requirements import import_requirements_from_config

    config = get_active_project()
    if config is None:
        print("No opal.project.yaml found — nothing to import.")
        sys.exit(1)
    if not config.requirements:
        print(f"Project '{config.name}' defines no requirements in opal.project.yaml.")
        sys.exit(0)

    db = SessionLocal()
    try:
        result = import_requirements_from_config(db, config)
        db.commit()
    finally:
        db.close()

    print(result.summary())
    for req_number in result.created:
        print(f"  created {req_number}")
    for req_number in result.skipped:
        print(f"  skipped {req_number} (already in database)")


def cmd_import_project(args: argparse.Namespace) -> None:
    """Import an opal.project.yaml into the database (one-shot migration)."""
    _setup_project(args)

    from opal.config import save_project_to_db
    from opal.db.base import SessionLocal
    from opal.project import load_project_config

    yaml_path = Path(args.file) if args.file else Path.cwd() / "opal.project.yaml"
    if not yaml_path.exists():
        print(f"No project config found at {yaml_path}")
        sys.exit(1)

    config = load_project_config(yaml_path)
    db = SessionLocal()
    try:
        save_project_to_db(db, config)
        db.commit()
    finally:
        db.close()

    print(f"Imported project config '{config.name}' from {yaml_path} into the database.")
    print("The yaml file is no longer read at runtime — you can archive or delete it.")


def cmd_tui(args: argparse.Namespace) -> None:
    """Launch the TUI (Terminal User Interface)."""
    from opal.config import get_active_settings
    from opal.tui import run_tui

    # Configure project first
    _setup_project(args)

    settings = get_active_settings()
    api_url = args.api_url or f"http://{settings.host}:{settings.port}"

    print(f"Connecting to OPAL API at {api_url}")
    print("Press 'q' to quit, '?' for help")

    run_tui(api_url=api_url)


def cmd_mcp(args: argparse.Namespace) -> None:
    """Start the MCP server for Claude Code integration."""
    import asyncio

    # Configure project first
    _setup_project(args)

    from opal.mcp.server import run_server

    print("Starting OPAL MCP server...", file=sys.stderr)
    asyncio.run(run_server())


def cmd_audit_prune(args: argparse.Namespace) -> None:
    """Prune (and optionally archive) audit log entries older than a cutoff."""
    import json
    from datetime import UTC, datetime
    from pathlib import Path

    # Configure project first
    _setup_project(args)

    try:
        cutoff = datetime.strptime(args.before, "%Y-%m-%d").replace(tzinfo=UTC)
    except ValueError:
        print(f"Invalid date: {args.before!r} (expected YYYY-MM-DD)", file=sys.stderr)
        sys.exit(1)

    from opal.db.models.audit import AuditLog
    from opal.db.session import get_session

    with get_session() as db:
        query = db.query(AuditLog).filter(AuditLog.timestamp < cutoff)
        total = query.count()
        if total == 0:
            print(f"No audit entries older than {args.before}.")
            return

        if args.dry_run:
            print(f"Would prune {total} audit entries older than {args.before}.")
            return

        if args.archive:
            archive_path = Path(args.archive)
            with archive_path.open("a", encoding="utf-8") as fh:
                # Stream in batches so huge tables do not load into memory
                for entry in query.order_by(AuditLog.id).yield_per(1000):
                    fh.write(
                        json.dumps(
                            {
                                "id": entry.id,
                                "timestamp": entry.timestamp.isoformat()
                                if entry.timestamp
                                else None,
                                "table_name": entry.table_name,
                                "record_id": entry.record_id,
                                "action": entry.action.value
                                if hasattr(entry.action, "value")
                                else entry.action,
                                "user_id": entry.user_id,
                                "old_values": entry.old_values,
                                "new_values": entry.new_values,
                            }
                        )
                        + "\n"
                    )
            print(f"Archived {total} entries to {archive_path}")

        deleted = query.delete(synchronize_session=False)
        print(f"Pruned {deleted} audit entries older than {args.before}.")


def main() -> None:
    """Main CLI entry point."""
    parser = argparse.ArgumentParser(
        prog="opal",
        description="OPAL - Operations, Procedures, Assets, Logistics",
    )
    from opal.version import get_version_info

    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {get_version_info().display}",
    )

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # Common project arguments
    def add_project_args(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--project",
            type=str,
            help="Project directory (auto-detects opal.project.yaml)",
        )
        p.add_argument(
            "--database",
            type=str,
            help="Explicit database path (overrides project)",
        )

    # serve command
    serve_parser = subparsers.add_parser("serve", help="Start the web server")
    serve_parser.add_argument("--host", type=str, help="Host to bind to")
    serve_parser.add_argument("--port", type=int, help="Port to bind to")
    add_project_args(serve_parser)
    serve_parser.set_defaults(func=cmd_serve)

    # migrate command
    migrate_parser = subparsers.add_parser("migrate", help="Database migrations")
    migrate_parser.add_argument(
        "action",
        choices=["upgrade", "downgrade", "generate", "current", "history"],
        help="Migration action",
    )
    migrate_parser.add_argument("--revision", type=str, help="Target revision")
    migrate_parser.add_argument("--message", "-m", type=str, help="Migration message")
    add_project_args(migrate_parser)
    migrate_parser.set_defaults(func=cmd_migrate)

    # seed command
    seed_parser = subparsers.add_parser("seed", help="Seed demo data")
    seed_parser.add_argument(
        "--force",
        action="store_true",
        help="Seed even if the database already has users/parts/config (overwrites project config)",
    )
    add_project_args(seed_parser)
    seed_parser.set_defaults(func=cmd_seed)

    # init command
    init_parser = subparsers.add_parser("init", help="Initialize OPAL")
    add_project_args(init_parser)
    init_parser.set_defaults(func=cmd_init)

    # import-requirements command
    import_req_parser = subparsers.add_parser(
        "import-requirements",
        help="Import opal.project.yaml requirements into the database (one-shot, idempotent)",
    )
    add_project_args(import_req_parser)
    import_req_parser.set_defaults(func=cmd_import_requirements)

    # import-project command
    import_proj_parser = subparsers.add_parser(
        "import-project",
        help="Import an opal.project.yaml into the database (one-shot; DB is the source of truth)",
    )
    import_proj_parser.add_argument(
        "--file", type=str, help="Path to the yaml file (default: ./opal.project.yaml)"
    )
    add_project_args(import_proj_parser)
    import_proj_parser.set_defaults(func=cmd_import_project)

    # tui command
    tui_parser = subparsers.add_parser("tui", help="Launch the TUI")
    tui_parser.add_argument(
        "--api-url",
        type=str,
        help="OPAL API URL (default: http://127.0.0.1:8000)",
    )
    add_project_args(tui_parser)
    tui_parser.set_defaults(func=cmd_tui)

    # mcp command
    mcp_parser = subparsers.add_parser(
        "mcp",
        help="Start MCP server for Claude Code integration",
    )
    add_project_args(mcp_parser)
    mcp_parser.set_defaults(func=cmd_mcp)

    # audit command
    audit_parser = subparsers.add_parser("audit", help="Audit log maintenance")
    audit_sub = audit_parser.add_subparsers(dest="audit_command", required=True)
    prune_parser = audit_sub.add_parser(
        "prune",
        help="Delete audit entries older than a date (optionally archiving to JSONL first)",
    )
    prune_parser.add_argument(
        "--before",
        required=True,
        help="Prune entries with a timestamp before this date (YYYY-MM-DD)",
    )
    prune_parser.add_argument(
        "--archive",
        type=str,
        help="Append pruned entries to this JSONL file before deleting",
    )
    prune_parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report how many entries would be pruned without deleting",
    )
    add_project_args(prune_parser)
    prune_parser.set_defaults(func=cmd_audit_prune)

    args = parser.parse_args()

    if args.command is None:
        parser.print_help()
        sys.exit(0)

    args.func(args)


if __name__ == "__main__":
    main()
