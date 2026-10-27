from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse


class LocalDemoAuthTests(TestCase):
    def test_local_login_creates_user_with_custom_username_and_password(self):
        response = self.client.post(
            reverse('api:mes-login') if hasattr(reverse, 'api') else '/api/mes-login',
            data={'userName': 'demo-user', 'password': 'demo-pass'},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn('django_token_key', response.json())
        user = get_user_model().objects.get(username='demo-user')
        self.assertTrue(user.check_password('demo-pass'))

    def test_mes_proxy_returns_demo_rows_without_company_api(self):
        response = self.client.post(
            reverse('api:mes-login') if hasattr(reverse, 'api') else '/api/mes-proxy',
            data={'mfgOrder': 'WO-1001'},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200, response.content)
        payload = response.json()
        rows = payload.get('rows') or payload.get('RTDAT') or []
        self.assertTrue(len(rows) >= 1)
        self.assertEqual(rows[0].get('MfgOrderName'), 'WO-1001')
