"""Names the unique constraint on user.exe_user_id, so real Alembic can drop it.

A database made by `opal init` has it unnamed, and migration e7a1c93f2b48 fails on that. Only used
to get the expected result for a fresh database out of real Alembic: see build.sh.
"""

import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
sql = db.execute("SELECT sql FROM sqlite_master WHERE name = 'user'").fetchone()[0]
if "UNIQUE (exe_user_id)" in sql:
    db.execute("PRAGMA writable_schema = ON")
    db.execute(
        "UPDATE sqlite_master SET sql = ? WHERE name = 'user'",
        (sql.replace("UNIQUE (exe_user_id)", "CONSTRAINT uq_user_exe_user_id UNIQUE (exe_user_id)"),),
    )
    db.commit()
    db.execute("PRAGMA writable_schema = OFF")
db.close()
