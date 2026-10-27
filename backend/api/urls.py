from django.urls import path, include
from .views import (
    mes_login, guest_login, mes_proxy, task_report,
    get_urgent, add_urgent, remove_urgent, reorder_urgent,
    history_log, history_compare,
    assembly_live_query, export_excel_api
)

urlpatterns = [
    # Built-in DRF and dj-rest-auth registration/login system
    path('auth/', include('dj_rest_auth.urls')),
    path('auth/registration/', include('dj_rest_auth.registration.urls')),
    
    # Local demo authentication and dashboard endpoints
    path('mes-login', mes_login),
    path('guest-login', guest_login),
    path('mes-proxy', mes_proxy),
    path('export-excel', export_excel_api),
    path('task-report', task_report),
    path('urgent-wos', get_urgent),
    path('urgent-wos/add', add_urgent),
    path('urgent-wos/remove', remove_urgent),
    path('urgent-wos/reorder', reorder_urgent),
    path('history/log', history_log),
    path('history/compare', history_compare),
    path('assembly-live-query', assembly_live_query),
]
