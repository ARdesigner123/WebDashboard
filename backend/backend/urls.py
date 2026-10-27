import os
from django.conf import settings
from django.urls import path, re_path, include
from django.views.static import serve
from api.views import serve_index

urlpatterns = [
    # Main frontend page
    path('', serve_index, name='index'),
    
    # API endpoints
    path('api/', include('api.urls')),
    
    # Direct static file serving to support Waitress standalone execution
    re_path(r'^static/(?P<path>.*)$', serve, {
        'document_root': os.path.join(settings.PUBLIC_DIR, 'static'),
    }),
    
    # Serve files directly from the public/ root directory (e.g., index.html, favicon.ico, etc.)
    re_path(r'^(?P<path>.*)$', serve, {
        'document_root': settings.PUBLIC_DIR,
    }),
]
