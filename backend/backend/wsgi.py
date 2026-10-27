import os
import sys
from pathlib import Path

# Exclude vendored packages at the repository root so installed dependencies win.
project_root = Path(__file__).resolve().parents[2]
sys.path[:] = [
    path for path in sys.path
    if Path(path or os.getcwd()).resolve() != project_root
]

from django.core.wsgi import get_wsgi_application

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'backend.settings')

application = get_wsgi_application()
