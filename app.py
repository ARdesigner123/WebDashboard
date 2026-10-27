from pathlib import Path
import os
import sys

ROOT_DIR = Path(__file__).resolve().parent
BACKEND_DIR = ROOT_DIR / "backend"
MANAGE_PY = BACKEND_DIR / "manage.py"


def main() -> None:
    if not MANAGE_PY.exists():
        raise SystemExit(f"Could not find Django project at: {BACKEND_DIR}. Expected {MANAGE_PY}.")

    # Keep the repo root as the working directory so Django's autoreloader can
    # restart the real project script, backend/manage.py, instead of looking for
    # app.py in the wrong directory.
    sys.path.insert(0, str(ROOT_DIR))
    sys.path.insert(0, str(BACKEND_DIR))
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "backend.settings")

    try:
        import django
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Django is not installed in this Python environment. "
            "Open a terminal in this project folder and install requirements before running this app."
        ) from exc

    from django.core.management import execute_from_command_line

    print("Applying database migrations...")
    execute_from_command_line([str(MANAGE_PY), "migrate", "--noinput"])

    print("\nStarting web app at http://localhost:8080")
    execute_from_command_line([str(MANAGE_PY), "runserver", "0.0.0.0:8080"])


if __name__ == "__main__":
    main()
