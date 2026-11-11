#!/bin/bash
# Makes the test databases from the released code. Run by hand; the results are committed.
#
#   build.sh <output folder> [scratch folder]
#
# Needs git and uv, and the release tags in this repository. Each database is made by the code at
# its tag with `opal init` and `opal seed`, then fill.py. Every run happens in a private HOME with
# OPAL_DATA_DIR set, so the default data folder is never touched.
#
# <tag>.db.gz               what that release makes on a fresh install
# <tag>.alembic.db.gz       the same file taken to b8d2f1a5c3e0 by real Alembic, the expected result
# v1.3.2-migrated.db.gz     made by 1.2.8 and upgraded by the 1.3.2 code, not by `opal init`
#
# A fresh database from before beta.3 cannot be upgraded by real Alembic: e7a1c93f2b48 drops a constraint by a
# name that only migrated databases have. The expected result comes from a copy with that one
# constraint named first.
set -euo pipefail

out=$(readlink -f "$1")
scratch=$(readlink -f "${2:-$(mktemp -d)}")
here=$(dirname "$(readlink -f "$0")")
repo=$(git -C "$here" rev-parse --show-toplevel)
# The last commit that has the Python code and migrations up to the importer's schema.
last_python=b94901e0d5d82410a5e7a9b3dfcabc004a43d39a
tags=(v1.2.8 v1.3.0-beta v1.3.0 v1.3.2 v1.4.0-beta.1 v1.4.0-beta.2 v1.4.0-beta.3)
mkdir -p "$out" "$scratch"

checkout() { # <ref> -> path of a worktree with its virtualenv
	local dir="$scratch/src/$1"
	if [ ! -d "$dir" ]; then
		git -C "$repo" worktree add --detach -q "$dir" "$1"
		(cd "$dir" && UV_PROJECT_ENVIRONMENT="$scratch/venv/$1" uv sync -q)
	fi
	echo "$dir"
}

with_tag() { # <ref> <data folder> <command...>, in a private HOME with the code of <ref>
	local ref=$1 data=$2; shift 2
	local src home
	src=$(checkout "$ref")
	home=$(mktemp -d -p "$scratch" home.XXXX)
	mkdir -p "$data"
	(
		export HOME="$home" XDG_DATA_HOME="$home/share" OPAL_DATA_DIR="$data" OPAL_DATABASE_URL="sqlite:///$data/opal.db" OPAL_UPLOAD_DIR="$data/attachments" PYTHONPATH="$src/src"
		cd "$home"
		PATH="$scratch/venv/$ref/bin:$PATH" "$@"
		# 1.3.2's seed writes its project file to the current folder.
		[ -f opal.project.yaml ] && cp opal.project.yaml "$data/" || true
	)
}

pack() { # <data folder> <name>: one file with the journal folded in, and its attachments
	python3 -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA wal_checkpoint(TRUNCATE)'); c.execute('PRAGMA journal_mode=DELETE'); c.close()" "$1/opal.db"
	gzip -9 -n -c "$1/opal.db" > "$out/$2.db.gz"
	if [ -d "$1/attachments" ] && [ -n "$(ls -A "$1/attachments")" ]; then
		# No owner, time or file name of this machine: the repository is public.
		tar -C "$1" --sort=name --owner=0 --group=0 --numeric-owner --mtime='2000-01-01 00:00:00Z' -cf - attachments | gzip -9 -n > "$out/$2.attachments.tgz"
	fi
	if [ -f "$1/opal.project.yaml" ]; then cp "$1/opal.project.yaml" "$out/$2.project.yaml"; fi
}

fresh() { # <tag> <data folder>
	rm -rf "$2"
	with_tag "$1" "$2" python -m opal init
	with_tag "$1" "$2" python -m opal seed
	with_tag "$1" "$2" python "$here/fill.py"
}

migrate() { # <ref> <data folder>: alembic.ini names its migrations relative to the checkout
	with_tag "$1" "$2" bash -c 'cd "$1" && python -m alembic upgrade head' _ "$(checkout "$1")"
}

alembic_upgrade() { # <data folder of the source> <name of the result>
	local data="$scratch/db/$2"
	[ -f "$out/$2.db.gz" ] && return 0
	rm -rf "$data"; mkdir -p "$data"
	python3 -c "import sqlite3,sys; a=sqlite3.connect(sys.argv[1]); b=sqlite3.connect(sys.argv[2]); a.backup(b)" "$1/opal.db" "$data/opal.db"
	if [ "${3:-}" = name-exe-constraint ]; then
		python3 "$here/name-exe-constraint.py" "$data/opal.db"
	fi
	migrate "$last_python" "$data"
	pack "$data" "$2"
}

for tag in "${tags[@]}"; do
	# A rerun keeps what it already made. Empty the output folder to make everything again.
	[ -f "$out/$tag.db.gz" ] && [ -f "$scratch/db/$tag/opal.db" ] && continue
	fresh "$tag" "$scratch/db/$tag"
	pack "$scratch/db/$tag" "$tag"
done

for tag in v1.3.2 v1.2.8 v1.3.0-beta v1.3.0 v1.4.0-beta.1 v1.4.0-beta.2; do
	alembic_upgrade "$scratch/db/$tag" "$tag.alembic" name-exe-constraint
done
for tag in v1.4.0-beta.3; do
	alembic_upgrade "$scratch/db/$tag" "$tag.alembic"
done

# The other way a 1.3.2 database comes to exist: made by an older release, upgraded by the 1.3.2
# code. The 1.3.2 migrations cannot make one from empty that its seed accepts: 00d3ac121e5e is a stub.
data="$scratch/db/v1.3.2-migrated"
rm -rf "$data"; mkdir -p "$data"
cp -a "$scratch/db/v1.2.8/." "$data/"
migrate v1.3.2 "$data"
pack "$data" v1.3.2-migrated
alembic_upgrade "$data" v1.3.2-migrated.alembic name-exe-constraint

# Worktrees: `git worktree prune` after deleting the scratch folder.
