import os
import re
import io
import json
import logging
import random
import requests
import urllib3
import openpyxl
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.workbook.properties import CalcProperties

from datetime import datetime, timedelta
from django.conf import settings
from django.db import transaction
from django.http import FileResponse, JsonResponse, HttpResponse
from django.middleware.csrf import get_token
from rest_framework.decorators import api_view, permission_classes, authentication_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.authentication import TokenAuthentication
from .models import UrgentWO, OnlineUser, WOHistory

logger = logging.getLogger(__name__)

# Disable insecure request warnings for corporate SSL blocks
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

def get_sg_now(offset_ms=0):
    """Returns naive Singapore time matching the local database records."""
    # Since settings.USE_TZ = False, datetime.now() yields Singapore local time
    return datetime.now() + timedelta(milliseconds=offset_ms)

@api_view(['GET'])
@permission_classes([AllowAny])
def serve_index(request):
    """Serves the static index.html frontend page."""
    # Always hand out a CSRF cookie together with the HTML shell.
    # DRF's SessionAuthentication enforces CSRF on any request that carries a
    # Django session cookie, and it needs the `csrftoken` cookie to be present
    # before it will accept the `X-CSRFToken` header the SPA sends back.
    # Without this the browser never receives the cookie and every POST logs
    # "Forbidden (CSRF cookie not set.): /api/mes-proxy".
    get_token(getattr(request, '_request', request))

    index_path = os.path.join(settings.PUBLIC_DIR, 'index.html')
    if os.path.exists(index_path):
        return FileResponse(open(index_path, 'rb'), content_type='text/html')
    return JsonResponse({'error': 'index.html not found'}, status=404)

# ==========================================
# LOCAL DEMO AUTHENTICATION + SAMPLE DATA
# ==========================================

def _demo_rows(requested_wo=None, requested_pn=None, count=4):
    requested_wo = str(requested_wo or 'WO-1001').strip() or 'WO-1001'
    requested_pn = str(requested_pn or '').strip()
    rng = random.Random(requested_wo)
    if not requested_pn:
        requested_pn = f'PN-{rng.randint(1000, 9999)}'
    rows = []
    statuses = ['In Progress', 'Completed', 'Queued', 'Hold']
    lines = ['WH', 'BB', 'SI']

    for index in range(count):
        wo_name = requested_wo if index == 0 else f"{requested_wo}-{index + 1}"
        pn_name = requested_pn if index == 0 else f"{requested_pn}-{index + 1}"
        planned_start = datetime.now().date() - timedelta(days=rng.randint(0, 30))
        rows.append({
            'TopMfgOrderName': wo_name,
            'FatherMfgOrderName': wo_name,
            'MfgOrderName': wo_name,
            'mfgOrder': wo_name,
            'WorkOrder': wo_name,
            'workOrder': wo_name,
            'ProductName': pn_name,
            'productName': pn_name,
            'CustomerProduct': pn_name,
            'CustomerName': f'Demo Customer {rng.randint(1, 12)}',
            'ContainerStatus': statuses[index % len(statuses)],
            'SpecName': 'Line WH' if lines[index % len(lines)] == 'WH' else 'Assembly Demo',
            'MfgLineName': lines[index % len(lines)],
            'mfgLineName': lines[index % len(lines)],
            'WorkflowName': 'Demo Workflow',
            'workflowName': 'Demo Workflow',
            'TaskListName': f'Demo Task {index + 1}',
            'Factory': 'Demo Factory',
            'DataNo': str(1000 + index),
            'OrderQty': rng.randint(10, 250),
            'Qty': rng.randint(10, 250),
            'CompletedQty': 10 + index * 5,
            'ManTime': round(rng.uniform(1, 30), 2),
            'PlannedStartDate': planned_start.isoformat(),
            'PlannedCompletionDate': (planned_start + timedelta(days=rng.randint(1, 21))).isoformat(),
            'TraverlerCard': f'TC-{rng.randint(10000, 99999)}',
            'Location': 'Demo Line A',
            'ContainerName': f'CTN-{1000 + index}',
            'StartDate': planned_start.isoformat(),
            'EndDate': (planned_start + timedelta(days=4)).isoformat(),
        })
    return rows


@api_view(['POST'])
@permission_classes([AllowAny])
def mes_login(request):
    """Authenticates a user against the local Django database instead of a company MES system."""
    try:
        from django.contrib.auth import authenticate, get_user_model, login
        from rest_framework.authtoken.models import Token

        username = str(request.data.get('userName') or request.data.get('username') or '').strip()
        password = str(request.data.get('password') or request.data.get('pass') or '').strip()

        if len(username) < 5:
            return JsonResponse({'error': 'Username must be at least 5 characters long.'}, status=400)
        if len(password) < 5:
            return JsonResponse({'error': 'Password must be at least 5 characters long.'}, status=400)
        if not re.search(r'\d', password):
            return JsonResponse({'error': 'Password must include at least one number.'}, status=400)
        if not re.search(r'[^A-Za-z0-9]', password):
            return JsonResponse({'error': 'Password must include at least one special character.'}, status=400)

        User = get_user_model()
        existing_user = User.objects.filter(username=username).first()
        if existing_user and not existing_user.check_password(password):
            return JsonResponse({'error': 'Incorrect password for this username.'}, status=401)

        user = None
        if existing_user:
            user = existing_user
            if user.check_password(password):
                user = authenticate(request, username=username, password=password)
            else:
                user = None

        if user is None:
            user = User.objects.create_user(username=username, password=password)

        user = authenticate(request, username=username, password=password)
        if user is None:
            return JsonResponse({'error': 'Authentication failed. Please enter your own username and password.'}, status=401)

        login(request, user)
        django_token, _ = Token.objects.get_or_create(user=user)

        return JsonResponse({
            'message': 'Login successful',
            'username': user.username,
            'token': django_token.key,
            'accessToken': django_token.key,
            'django_token_key': django_token.key,
        })
    except Exception as exc:
        return JsonResponse({'error': str(exc)}, status=500)

CLEAN_EXCEL_RE = re.compile(r'[\000-\x08\x0b\x0c\x0e-\x1f]')

def clean_excel_val(val):
    if val is None:
        return ''
    s = str(val)
    return CLEAN_EXCEL_RE.sub('', s).strip()

def parse_excel_num(val):
    if val is None or val == "":
        return 0
    try:
        s = str(val).strip()
        if '.' in s:
            return float(s)
        return int(s)
    except Exception:
        return clean_excel_val(val)

@api_view(['POST'])
@permission_classes([AllowAny])
def export_excel_api(request):
    """Generates a native XLSX spreadsheet file from raw JSON container records."""
    try:
        payload = request.data
        if payload is None:
            payload = {}
        elif isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except Exception:
                payload = {}
        elif not isinstance(payload, dict):
            try:
                payload = dict(payload)
            except Exception:
                payload = {}

        records = payload.get('records', [])
        headers = payload.get('headers', [])
        filename = payload.get('filename', 'BizLink_WO_Detailed_Status.xlsx')
        sheet_name = payload.get('sheet_name', 'WO Detailed Status')
        is_ethan_task = payload.get('is_ethan_task', False)
        wo_history_records = payload.get('wo_history_records', [])

        if not filename.endswith('.xlsx'):
            filename += '.xlsx'

        wb = openpyxl.Workbook()
        wb.properties.calcPr = CalcProperties(fullCalcOnLoad=True)

        ws = wb.active
        if is_ethan_task and sheet_name == 'Row Data':
            sheet_name = 'Raw Data'

        ws = wb.active
        ws.title = sheet_name  # "Raw Data" for Ethan's Task

        if headers:
            ws.append([clean_excel_val(h) for h in headers])

        def is_task_packing_with_end_time(r):
            if isinstance(r, dict):
                task_val = str(r.get("Task", r.get("TaskListName", "")) or "").strip().upper()
                end_time = str(r.get("End Time", r.get("EndTime", "")) or "").strip()
            elif isinstance(r, (list, tuple)):
                task_val = str(r[7] if len(r) > 7 else "").strip().upper()
                end_time = str(r[13] if len(r) > 13 else "").strip()
            else:
                task_val = ""
                end_time = ""
            has_end_time = bool(end_time and end_time not in ["null", "undefined", "--", "#N/A"])
            return ("PACKING" in task_val) and has_end_time

        def get_wo_target_rows(dataset):
            target_rows = set()
            for row_idx, r in enumerate(dataset, start=2):
                if is_task_packing_with_end_time(r):
                    target_rows.add(row_idx)
            return target_rows

        max_data_row = len(records) + 1
        target_rows_data = get_wo_target_rows(records) if is_ethan_task else set()

        for row_idx, row in enumerate(records, start=2):
            if isinstance(row, dict):
                wo = str(row.get("Work Order", row.get("MfgOrderName", ""))).strip()
                raw_unit_ct = row.get("Unit CT", row.get("UnitCT", 0))
                raw_order_qty = row.get("Order Qty", row.get("OrderQty", 0))
                raw_lot_qty = row.get("Lot Qty", row.get("Qty", 1))
            else:
                wo = str(row[0]).strip() if len(row) > 0 else ""
                raw_unit_ct = row[16] if len(row) > 16 else 0
                raw_order_qty = row[5] if len(row) > 5 else 0
                raw_lot_qty = row[4] if len(row) > 4 else 1

            try:
                unit_ct = float(raw_unit_ct) if raw_unit_ct not in [None, ''] else 0.0
            except Exception:
                unit_ct = 0.0

            try:
                order_qty = float(raw_order_qty) if raw_order_qty not in [None, ''] else 0.0
            except Exception:
                order_qty = 0.0

            is_target = row_idx in target_rows_data

            # Hide non-matching rows by default!
            if not is_target and is_ethan_task:
                ws.row_dimensions[row_idx].hidden = True

            for h_idx, h in enumerate(headers, start=1):
                cell = ws.cell(row=row_idx, column=h_idx)
                if h == "Actual CT" and is_ethan_task:
                    if is_target:
                        cell.value = f"=SUMIF($A$2:$A${max_data_row}, A{row_idx}, $O$2:$O${max_data_row})/60"
                        cell.number_format = '0.00'
                    else:
                        cell.value = ""
                elif h == "Standard CT" and is_ethan_task:
                    if is_target:
                        cell.value = f"=(Q{row_idx}*F{row_idx})/60"
                        cell.number_format = '0.00'
                    else:
                        cell.value = ""
                elif h == "Processing Time":
                    try:
                        proc_val = row.get("Processing Time", row.get("ProcessingTime", 0)) if isinstance(row, dict) else (row[14] if len(row) > 14 else 0)
                        cell.value = float(proc_val) if proc_val not in [None, ''] else 0.0
                    except Exception:
                        cell.value = 0.0
                    cell.number_format = '0.00'
                elif h == "Unit CT":
                    cell.value = unit_ct
                    cell.number_format = '0.00'
                elif h == "Order Qty":
                    cell.value = order_qty
                    cell.number_format = '0'
                elif h == "Lot Qty":
                    try:
                        cell.value = float(raw_lot_qty)
                    except Exception:
                        cell.value = 1
                else:
                    raw_val = row.get(h, '') if isinstance(row, dict) else (row[h_idx - 1] if isinstance(row, list) and h_idx <= len(row) else '')
                    cell.value = clean_excel_val(raw_val)

        # Enable AutoFilter across all headers
        if len(headers) > 0 and len(records) > 0:
            last_col_letter = openpyxl.utils.get_column_letter(len(headers))
            ws.auto_filter.ref = f"A1:{last_col_letter}{max_data_row}"

        # Auto-fit column widths
        for col in ws.columns:
            max_len = max(len(str(cell.value or '')) for cell in col)
            col_letter = openpyxl.utils.get_column_letter(col[0].column)
            ws.column_dimensions[col_letter].width = max(max_len + 3, 12)

        # If Ethan's Task, create the PivotTable1 sheet
        if is_ethan_task:
            ws_pivot = wb.create_sheet(title="PivotTable1")
            ws_pivot.append(["Work Order", "Standard CT", "Actual CT", "Total Order Qty", "Record Count"])
            
            # Header styling for Pivot sheet
            from openpyxl.styles import Font, PatternFill
            header_fill = PatternFill(start_color="722ED1", end_color="722ED1", fill_type="solid")
            header_font = Font(color="FFFFFF", bold=True)
            for col_num in range(1, 6):
                p_cell = ws_pivot.cell(row=1, column=col_num)
                p_cell.fill = header_fill
                p_cell.font = header_font

            # Find unique Work Orders that have Task PACKING with End Time
            distinct_wos = []
            for r in records:
                if is_task_packing_with_end_time(r):
                    if isinstance(r, dict):
                        wo = str(r.get("Work Order", r.get("MfgOrderName", ""))).strip()
                    elif isinstance(r, (list, tuple)):
                        wo = str(r[0]).strip() if len(r) > 0 else ""
                    else:
                        wo = ""

                    if wo and wo not in distinct_wos:
                        distinct_wos.append(wo)

            for p_idx, wo in enumerate(distinct_wos, start=2):
                ws_pivot.cell(row=p_idx, column=1, value=wo)
                
                # Column B: Standard CT (from Raw Data Column S)
                sum_std_ct_cell = ws_pivot.cell(row=p_idx, column=2)
                sum_std_ct_cell.value = f"=SUMIF('Raw Data'!$A$2:$A${max_data_row}, A{p_idx}, 'Raw Data'!$S$2:$S${max_data_row})"
                sum_std_ct_cell.number_format = '0.00'

                # Column C: Actual CT (from Raw Data Column R)
                sum_act_ct_cell = ws_pivot.cell(row=p_idx, column=3)
                sum_act_ct_cell.value = f"=SUMIF('Raw Data'!$A$2:$A${max_data_row}, A{p_idx}, 'Raw Data'!$R$2:$R${max_data_row})"
                sum_act_ct_cell.number_format = '0.00'

                # Column D: Total Order Qty
                sum_qty_cell = ws_pivot.cell(row=p_idx, column=4)
                sum_qty_cell.value = f"=VLOOKUP(A{p_idx}, 'Raw Data'!$A$2:$F${max_data_row}, 6, 0)"
                sum_qty_cell.number_format = '0'

                # Column E: Record Count
                count_cell = ws_pivot.cell(row=p_idx, column=5)
                count_cell.value = f"=COUNTIF('Raw Data'!$A$2:$A${max_data_row}, A{p_idx})"
                count_cell.number_format = '0'

            if len(distinct_wos) > 0:
                tot_row = len(distinct_wos) + 2

                c_tot_label = ws_pivot.cell(row=tot_row, column=1, value="Total")
                c_tot_label.font = Font(bold=True)
                
                tot_std_ct_cell = ws_pivot.cell(row=tot_row, column=2, value=f"=SUM(B2:B{tot_row-1})")
                tot_std_ct_cell.font = Font(bold=True)
                tot_std_ct_cell.number_format = '0.00'

                tot_act_ct_cell = ws_pivot.cell(row=tot_row, column=3, value=f"=SUM(C2:C{tot_row-1})")
                tot_act_ct_cell.font = Font(bold=True)
                tot_act_ct_cell.number_format = '0.00'

                tot_qty_cell = ws_pivot.cell(row=tot_row, column=4, value=f"=SUM(D2:D{tot_row-1})")
                tot_qty_cell.font = Font(bold=True)
                tot_qty_cell.number_format = '0'

                tot_cnt_cell = ws_pivot.cell(row=tot_row, column=5, value=f"=SUM(E2:E{tot_row-1})")
                tot_cnt_cell.font = Font(bold=True)
                tot_cnt_cell.number_format = '0'

            for col in ws_pivot.columns:
                max_len = max(len(str(cell.value or '')) for cell in col)
                col_letter = openpyxl.utils.get_column_letter(col[0].column)
                ws_pivot.column_dimensions[col_letter].width = max(max_len + 4, 15)



        output = io.BytesIO()
        wb.save(output)
        output.seek(0)

        response = HttpResponse(
            output.getvalue(),
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        response['Content-Disposition'] = f'attachment; filename="{filename}"'
        return response
    except Exception as e:
        import traceback
        traceback.print_exc()
        return JsonResponse({'error': str(e)}, status=500)

_cached_auto_token = None
_cached_token_time = 0

def get_auto_mes_token(force_refresh=False):
    global _cached_auto_token, _cached_token_time
    import time
    now = time.time()
    
    if not force_refresh and _cached_auto_token and (now - _cached_token_time < 600):
        return _cached_auto_token
        
    try:
        import sqlite3, requests, re, json
        username = None
        password = None
        
        # 1. Try reading credentials from persistent SQLite database
        try:
            db_path = settings.DATABASES['default']['NAME']
            if os.path.exists(db_path):
                conn = sqlite3.connect(db_path)
                cursor = conn.cursor()
                cursor.execute("CREATE TABLE IF NOT EXISTS _bg_sync_config (key TEXT PRIMARY KEY, value TEXT);")
                cursor.execute("SELECT value FROM _bg_sync_config WHERE key = 'username';")
                row_u = cursor.fetchone()
                cursor.execute("SELECT value FROM _bg_sync_config WHERE key = 'password';")
                row_p = cursor.fetchone()
                conn.close()
                if row_u and row_p:
                    username = row_u[0]
                    password = row_p[0]
        except Exception as db_err:
            print(f"[Auto Token DB Error] {db_err}")
            
        # 2. Fall back to reading credentials_cache.json if SQLite had no saved credentials
        if not username or not password:
            possible_cache_paths = [
                os.path.join(settings.BASE_DIR, 'credentials_cache.json'),
                os.path.join(settings.BASE_DIR, '..', 'credentials_cache.json'),
                'credentials_cache.json'
            ]
            for cache_p in possible_cache_paths:
                if os.path.exists(cache_p):
                    try:
                        with open(cache_p, 'r') as f:
                            creds = json.load(f)
                        u = creds.get('username')
                        p = creds.get('password')
                        if u and p:
                            username = u
                            password = p
                            # Auto-populate SQLite table for future fast lookups
                            try:
                                conn = sqlite3.connect(settings.DATABASES['default']['NAME'])
                                conn.execute("CREATE TABLE IF NOT EXISTS _bg_sync_config (key TEXT PRIMARY KEY, value TEXT);")
                                conn.execute("INSERT OR REPLACE INTO _bg_sync_config (key, value) VALUES ('username', ?);", (username,))
                                conn.execute("INSERT OR REPLACE INTO _bg_sync_config (key, value) VALUES ('password', ?);", (password,))
                                conn.commit()
                                conn.close()
                            except Exception:
                                pass
                            break
                    except Exception as f_err:
                        print(f"[Auto Token Cache Read Error] {f_err}")

        if username and password:
            login_url = 'https://smssgidcprd02.bizlinktech.com:9100/api/user/login'
            resp = requests.post(login_url, json={"userName": username, "password": password}, verify=False, timeout=12)
            if resp.status_code == 200:
                m = re.search(r'(eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)', resp.text)
                if m:
                    _cached_auto_token = "Bearer " + m.group(1)
                    _cached_token_time = now
                    return _cached_auto_token
    except Exception as err:
        print(f"[Auto Token Fallback Error] {err}")
    return None

def _is_line_wh_row(r):
    """True when a row is a synthetic 'Line WH' roll-up row rather than a real WO line."""
    spec = str((r.get('SpecName') if isinstance(r, dict) else '') or '').strip().lower()
    return 'linewh' in ''.join(c for c in spec if c.isalnum())


def _row_matches_requested_wo(r, requested_wo):
    """True when a MES row belongs to the requested Work Order.

    `requested_wo` must already be lower-cased and trimmed.

    A row belongs to the WO when any identity field equals it, contains it
    (children of a Bundle WO are usually named `<bundle>-1`), or is contained
    by it.  The Bundle / parent link lives in TopMfgOrderName and
    FatherMfgOrderName - both must be checked, otherwise a Bundle WO only
    matches its own single header row and the totals collapse to 1.
    """
    if not isinstance(r, dict) or not requested_wo:
        return False
    wo_fields = [
        r.get('TopMfgOrderName'), r.get('FatherMfgOrderName'),
        r.get('MfgOrderName'), r.get('mfgOrder'), r.get('mfgOrderName'),
        r.get('WorkOrder'), r.get('workOrder'),
        r.get('ParentMfgOrder'), r.get('parentMfgOrder'),
        r.get('TraverlerCard'), r.get('TravelerCard'), r.get('ContainerName'),
    ]
    for f in wo_fields:
        if f is None:
            continue
        s = str(f).strip().lower()
        if s and (s == requested_wo or s in requested_wo or requested_wo in s):
            return True
    return False


def _row_matches_requested_pn(r, requested_pn):
    """True when a MES row belongs to the requested Part Number."""
    if not isinstance(r, dict) or not requested_pn:
        return False
    for f in (r.get('ProductName'), r.get('productName'), r.get('CustomerProduct')):
        if f is None:
            continue
        s = str(f).strip().lower()
        if s and s == requested_pn:
            return True
    return False


def _filter_rows_for_request(rows, requested_wo, requested_pn):
    """Restrict a MES response to the rows that belong to the requested WO / PN.

    Every branch of ``mes_proxy`` runs its answer through this so the frontend
    always receives the same row set for the same WO, no matter which MES
    server answered the request.
    """
    if not rows or (not requested_wo and not requested_pn):
        return rows

    if requested_pn:
        rows = [r for r in rows if not _is_line_wh_row(r)]

    matching_rows = [
        r for r in rows
        if _row_matches_requested_wo(r, requested_wo)
        or _row_matches_requested_pn(r, requested_pn)
    ]
    return matching_rows


@api_view(['POST'])
@permission_classes([AllowAny])
@authentication_classes([TokenAuthentication])
def mes_proxy(request):
    """Returns local demo work-order data instead of reaching a company MES API."""
    try:
        payload = request.data or {}
        if not isinstance(payload, dict):
            try:
                payload = dict(payload)
            except Exception:
                payload = {}

        requested_wo = str(payload.get('mfgOrder') or payload.get('MfgOrderName') or payload.get('wo') or 'WO-1001').strip()
        requested_pn = str(payload.get('ProductName') or payload.get('productName') or '').strip()
        rows = _demo_rows(requested_wo=requested_wo, requested_pn=requested_pn, count=4)

        if requested_wo and requested_wo.lower() != 'all':
            rows = [row for row in rows if str(row.get('MfgOrderName') or row.get('WorkOrder') or '').startswith(requested_wo.split('-')[0]) or str(row.get('MfgOrderName') or row.get('WorkOrder') or '').startswith(requested_wo)]

        return JsonResponse({
            'status': 'success',
            'rows': rows,
            'RTDAT': rows,
            'total': len(rows),
            'message': 'Demo data only. No external MES connection required.'
        })
    except Exception as exc:
        return JsonResponse({'error': str(exc)}, status=500)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def task_report(request):
    """Returns demo task report data instead of calling a company traceability API."""
    payload = request.data or {}
    requested_wo = str(payload.get('mfgOrder') or payload.get('MfgOrderName') or payload.get('wo') or 'WO-1001').strip()
    requested_pn = str(payload.get('ProductName') or payload.get('productName') or 'PN-2001').strip()
    rows = _demo_rows(requested_wo=requested_wo, requested_pn=requested_pn, count=3)
    return JsonResponse(rows, safe=False)

# ==========================================
# LOCAL DATABASE ENDPOINTS (PROTECTED)
# ==========================================

def ensure_urgent_wo_schema():
    try:
        from django.db import connection
        with connection.cursor() as cursor:
            cursor.execute("PRAGMA table_info(urgent_wos)")
            columns = [row[1] for row in cursor.fetchall()]
            if 'list_type' not in columns:
                cursor.execute("ALTER TABLE urgent_wos ADD COLUMN list_type varchar(20) DEFAULT 'wo'")
    except Exception as e:
        pass

@api_view(['GET'])
@permission_classes([AllowAny])
def get_urgent(request):
    """Retrieves demo urgent work order numbers for the local dashboard."""
    list_type = request.GET.get('list_type', 'wo') or request.GET.get('listType', 'wo')
    demo_wos = ['WO-1001', 'WO-1002', 'WO-1003'] if list_type == 'wo' else ['PN-2001', 'PN-2002']
    return JsonResponse(demo_wos, safe=False)

@api_view(['POST'])
@permission_classes([AllowAny])
def add_urgent(request):
    """Inserts one or more urgent work orders for a specific list_type."""
    try:
        ensure_urgent_wo_schema()
        list_type = request.data.get('list_type', 'wo') or request.data.get('listType', 'wo')
        wos = request.data.get('wos', [])
        wos_clean = list(dict.fromkeys([str(wo_num).strip() for wo_num in wos if str(wo_num).strip()]))
        if wos_clean:
            with transaction.atomic():
                existing = set(UrgentWO.objects.filter(list_type=list_type, wo_number__in=wos_clean).values_list('wo_number', flat=True))
                to_create = [UrgentWO(wo_number=w, list_type=list_type, sort_index=0) for w in wos_clean if w not in existing]
                if to_create:
                    UrgentWO.objects.bulk_create(to_create, ignore_conflicts=True)
        return JsonResponse({'success': True})
    except Exception as e:
        logger.error(f"Error in add_urgent: {e}")
        return JsonResponse({'success': False, 'error': str(e)}, status=200)

@api_view(['POST'])
@permission_classes([AllowAny])
def remove_urgent(request):
    """Removes one or more urgent work orders for a specific list_type."""
    try:
        ensure_urgent_wo_schema()
        list_type = request.data.get('list_type', 'wo') or request.data.get('listType', 'wo')
        clear_all = request.data.get('clear_all', False)
        wos = request.data.get('wos', [])
        
        if clear_all or not wos:
            UrgentWO.objects.filter(list_type=list_type).delete()
        else:
            wos_clean = list(dict.fromkeys([str(w).strip().lower() for w in wos if str(w).strip()]))
            if wos_clean:
                with transaction.atomic():
                    all_db = UrgentWO.objects.filter(list_type=list_type)
                    to_delete = [wo.pk for wo in all_db if str(wo.wo_number).strip().lower() in wos_clean or str(wo.wo_number).strip() in wos]
                    if to_delete:
                        UrgentWO.objects.filter(pk__in=to_delete).delete()

        remaining_wos = [wo.wo_number for wo in UrgentWO.objects.filter(list_type=list_type).order_by('sort_index', '-created_at')]
        return JsonResponse({'success': True, 'count': len(remaining_wos), 'wos': remaining_wos})
    except Exception as e:
        logger.error(f"Error in remove_urgent: {e}")
        return JsonResponse({'success': False, 'error': str(e)}, status=200)

@api_view(['POST'])
@permission_classes([AllowAny])
def reorder_urgent(request):
    """Updates sorting indices for a customized work order list for a specific list_type."""
    try:
        ensure_urgent_wo_schema()
        list_type = request.data.get('list_type', 'wo') or request.data.get('listType', 'wo')
        ordered_wos = request.data.get('orderedWOs', []) or request.data.get('ordered_wos', [])
        if not ordered_wos:
            UrgentWO.objects.filter(list_type=list_type).delete()
        else:
            ordered_clean = list(dict.fromkeys([str(w).strip() for w in ordered_wos if str(w).strip()]))
            if ordered_clean:
                with transaction.atomic():
                    UrgentWO.objects.filter(list_type=list_type).exclude(wo_number__in=ordered_clean).delete()
                    existing_objs = {wo.wo_number: wo for wo in UrgentWO.objects.filter(list_type=list_type, wo_number__in=ordered_clean)}
                    
                    to_create = []
                    to_update = []
                    for index, wo_clean in enumerate(ordered_clean):
                        if wo_clean in existing_objs:
                            obj = existing_objs[wo_clean]
                            obj.sort_index = index
                            to_update.append(obj)
                        else:
                            to_create.append(UrgentWO(wo_number=wo_clean, list_type=list_type, sort_index=index))
                    
                    if to_create:
                        UrgentWO.objects.bulk_create(to_create, ignore_conflicts=True)
                    if to_update:
                        UrgentWO.objects.bulk_update(to_update, ['sort_index'])
            else:
                UrgentWO.objects.filter(list_type=list_type).delete()
                
        remaining_wos = [wo.wo_number for wo in UrgentWO.objects.filter(list_type=list_type).order_by('sort_index', '-created_at')]
        return JsonResponse({'success': True, 'wos': remaining_wos})
    except Exception as e:
        logger.error(f"Error in reorder_urgent: {e}")
        return JsonResponse({'success': False, 'error': str(e)}, status=200)



@api_view(['POST'])
@permission_classes([IsAuthenticated])
def history_log(request):
    """Stores demo-only completion logs for the local dashboard."""
    return JsonResponse({'success': True, 'demo': True})

@api_view(['POST'])
@permission_classes([IsAuthenticated])
def history_compare(request):
    """Returns a demo comparison response without relying on stored company history."""
    data = request.data or {}
    wos = data.get('wos', []) or []
    if not wos:
        return JsonResponse([], safe=False)

    results = []
    for index, wo in enumerate(wos):
        current_pct = data.get('currentPcts', {}).get(wo, 50 + index)
        results.append({
            'wo_number': wo,
            'startPct': max(0, current_pct - 15),
            'endPct': current_pct,
            'increase': max(0, current_pct - max(0, current_pct - 15)),
            'actualStartDate': '2026-10-01',
            'isBaseline': True,
        })
    return JsonResponse(results, safe=False)

@api_view(['GET', 'POST'])
@permission_classes([AllowAny])
def assembly_live_query(request):
    """Returns local demo assembly live data instead of calling a company API."""
    query_params = request.GET.dict() if request.GET else {}
    body_data = request.data if isinstance(request.data, dict) else {}

    location = body_data.get('location') or query_params.get('location') or 'Demo Line A'
    data_no = body_data.get('dataNo') or query_params.get('dataNo') or '1'
    factory = body_data.get('factory') or query_params.get('factory') or 'Demo Factory'
    section = body_data.get('section') or query_params.get('section') or 'Demo Section'
    algorithm = body_data.get('algorithm') or query_params.get('algorithm') or 'TaskQty'

    rows = [
        {
            'location': location,
            'dataNo': data_no,
            'factory': factory,
            'section': section,
            'algorithm': algorithm,
            'value': 120,
            'status': 'Healthy',
            'updatedAt': '2026-10-26T09:00:00',
        },
        {
            'location': location,
            'dataNo': data_no,
            'factory': factory,
            'section': section,
            'algorithm': algorithm,
            'value': 98,
            'status': 'Monitoring',
            'updatedAt': '2026-10-26T09:05:00',
        },
    ]

    return JsonResponse({
        'status': 'success',
        'rows': rows,
        'RTDAT': rows,
        'total': len(rows),
    })
