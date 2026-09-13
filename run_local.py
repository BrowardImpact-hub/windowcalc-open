"""Run WindowCalc on this computer.

    .venv\\Scripts\\python.exe run_local.py

SQLite database in .local/ (ignored by Git), chat media on local disk, port
8080, demo data seeded. Any of those can be overridden with the usual
environment variables. Production never uses this file: Cloud Run runs
`gunicorn server:app` against Cloud SQL.
"""
import os
import pathlib
import runpy

ROOT = pathlib.Path(__file__).resolve().parent
(ROOT / ".local").mkdir(exist_ok=True)

os.environ.setdefault("DB_PATH", str(ROOT / ".local" / "windowcalc.db"))
os.environ.setdefault("CHAT_MEDIA_STORAGE", "local")
os.environ.setdefault("PORT", "8080")

os.chdir(ROOT)
print(f"WindowCalc local: http://127.0.0.1:{os.environ['PORT']}  (db: {os.environ['DB_PATH']})")
runpy.run_path(str(ROOT / "server.py"), run_name="__main__")
