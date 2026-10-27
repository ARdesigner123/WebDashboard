import os
import sys
import dj_database_url

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', 'demo-company-dashboard-secret-key-local-development')

DEBUG = os.environ.get('DJANGO_DEBUG', '1').lower() in {'1', 'true', 'yes', 'on'}

ALLOWED_HOSTS = [
    host.strip() for host in os.environ.get('DJANGO_ALLOWED_HOSTS', 'localhost,127.0.0.1,[::1],*').split(',')
    if host.strip()
]

# Application definition

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'django.contrib.sites',
    
    # Third party packages
    'rest_framework',
    'rest_framework.authtoken',
    'corsheaders',
    
    'dj_rest_auth',
    'allauth',
    'allauth.account',
    'allauth.socialaccount',
    'dj_rest_auth.registration',
    
    # Local apps
    'api.apps.ApiConfig',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
    'allauth.account.middleware.AccountMiddleware',
]

ROOT_URLCONF = 'backend.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'backend.wsgi.application'

# Database
# Use the existing SQLite database from the parent folder (root of the workspace)
# In PyInstaller, save the database in the same directory as the executable (sys.executable)
def get_db_path():
    """
    Returns the persistent SQLite database path located in the user's Downloads folder.
    This guarantees that all WOs added to the database persist across new .exe versions/launches,
    and are never lost or wiped when launching a new app.exe executable!
    """
    import shutil
    user_home = os.path.expanduser('~')
    downloads_dir = os.path.join(user_home, 'Downloads')
    
    if os.path.exists(downloads_dir):
        target_db = os.path.join(downloads_dir, 'database.sqlite')
    else:
        # Fallback if Downloads directory is unavailable
        if getattr(sys, 'frozen', False):
            target_db = os.path.join(os.path.dirname(sys.executable), 'database.sqlite')
        else:
            target_db = os.path.join(BASE_DIR, '..', 'database.sqlite')

    # If the target database in Downloads does not exist yet, copy from existing populated source
    if not os.path.exists(target_db):
        possible_sources = [
            os.path.join(os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else '', 'database.sqlite'),
            os.path.join(getattr(sys, '_MEIPASS', ''), 'database.sqlite'),
            os.path.join(BASE_DIR, '..', 'database.sqlite'),
            os.path.join(BASE_DIR, 'database.sqlite')
        ]
        for src in possible_sources:
            if src and os.path.exists(src) and os.path.abspath(src) != os.path.abspath(target_db):
                try:
                    shutil.copy2(src, target_db)
                    print(f"📦 Successfully initialized database in Downloads folder: {target_db}")
                    break
                except Exception as e:
                    print(f"⚠️ Could not copy initial database to {target_db}: {e}")
                    
    return target_db

if os.environ.get('DATABASE_URL'):
    DATABASES = {
        'default': dj_database_url.parse(
            os.environ['DATABASE_URL'],
            conn_max_age=600,
            ssl_require=not DEBUG,
        )
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': get_db_path(),
            'OPTIONS': {
                'timeout': 60,  # 60 seconds busy timeout to completely prevent 'database is locked' errors under concurrency
            }
        }
    }

# Password validation
AUTH_PASSWORD_VALIDATORS = [
    {
        'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator',
    },
    {
        'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator',
    },
]

# Internationalization
LANGUAGE_CODE = 'en-us'

# Ensure Singapore Time Zone and naive local time matching original database records
TIME_ZONE = 'Asia/Singapore'
USE_I18N = True
USE_TZ = False

# Static files
# Handle PyInstaller compilation where sys._MEIPASS holds the unpacked executable paths
def get_resource_path(relative_path):
    base_path = getattr(sys, '_MEIPASS', os.path.abspath(os.path.join(BASE_DIR, '..')))
    return os.path.join(base_path, relative_path)

PUBLIC_DIR = get_resource_path('public')

STATIC_URL = '/static/'
STATICFILES_DIRS = [
    os.path.join(PUBLIC_DIR, 'static'),
]
STATIC_ROOT = os.path.join(BASE_DIR, 'staticfiles')

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# DRF & dj-rest-auth configurations
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework.authentication.TokenAuthentication',
        'rest_framework.authentication.SessionAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
}

if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True

# Django Sites
SITE_ID = 1

# Authentication Settings
AUTHENTICATION_BACKENDS = [
    'django.contrib.auth.backends.ModelBackend',
    'allauth.account.auth_backends.AuthenticationBackend',
]

# dj-rest-auth & allauth settings for quick local setup without emails
ACCOUNT_EMAIL_VERIFICATION = 'none'
ACCOUNT_EMAIL_REQUIRED = False
ACCOUNT_LOGIN_METHODS = ['username']
ACCOUNT_SIGNUP_FIELDS = ['username*', 'password1*', 'password2*']

# CORS
CORS_ALLOW_ALL_ORIGINS = os.environ.get(
    'CORS_ALLOW_ALL_ORIGINS', '1' if DEBUG else '0'
).lower() in {'1', 'true', 'yes', 'on'}
CORS_ALLOW_CREDENTIALS = True
CORS_ALLOWED_ORIGINS = [
    origin.strip() for origin in os.environ.get('CORS_ALLOWED_ORIGINS', '').split(',')
    if origin.strip()
]

# ---------------------------------------------------------------------------
# CSRF (Django double-submit cookie flow)
# ---------------------------------------------------------------------------
# The SPA is served from the same origin as the API, so the browser picks up
# the `csrftoken` cookie that `serve_index()` sets and echoes it back in the
# `X-CSRFToken` header (see the fetch interceptor in public/static/script.js).
# DRF's SessionAuthentication enforces this on any request that carries a
# Django session cookie, so both halves are required.
CSRF_COOKIE_HTTPONLY = False   # JavaScript must be able to read this cookie
CSRF_COOKIE_SAMESITE = 'None' if not DEBUG else 'Lax'
CSRF_USE_SESSIONS = False
SESSION_COOKIE_SAMESITE = 'None' if not DEBUG else 'Lax'

# Only needed when the app is reached through a reverse proxy or a different
# public hostname, e.g.:
#   CSRF_TRUSTED_ORIGINS=https://dash.example.com,https://*.example.com
CSRF_TRUSTED_ORIGINS = [
    o.strip() for o in os.environ.get('CSRF_TRUSTED_ORIGINS', '').split(',')
    if o.strip()
]

if not DEBUG:
    host_list = [
        f'https://{host.strip()}'
        for host in ALLOWED_HOSTS
        if host.strip()
        and not host.strip().startswith('.')
        and host.strip() not in {'*', 'localhost', '127.0.0.1', '[::1]'}
    ]
    CSRF_TRUSTED_ORIGINS.extend(host_list)
    CORS_ALLOWED_ORIGINS.extend(host_list)
