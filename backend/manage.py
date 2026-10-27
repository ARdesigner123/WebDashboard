#!/usr/bin/env python
import os
import sys
from pathlib import Path

def main():
    """Run administrative tasks."""
    project_root = Path(__file__).resolve().parent.parent
    sys.path[:] = [
        path for path in sys.path
        if Path(path or os.getcwd()).resolve() != project_root
    ]
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'backend.settings')
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Couldn't import Django. Are you sure it's installed and "
            "available on your PYTHONPATH environment variable? Did you "
            "forget to activate a virtual environment?"
        ) from exc
    execute_from_command_line(sys.argv)

if __name__ == '__main__':
    main()
