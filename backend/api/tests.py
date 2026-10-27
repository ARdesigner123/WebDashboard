from django.contrib.auth import get_user_model
from django.test import TestCase
from django.urls import reverse


class LocalDemoAuthTests(TestCase):
    def test_local_login_creates_user_with_custom_username_and_password(self):
        response = self.client.post(
            reverse('api:mes-login') if hasattr(reverse, 'api') else '/api/mes-login',
            data={'userName': 'demo-user', 'password': 'demo-pass1!'},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn('django_token_key', response.json())
        user = get_user_model().objects.get(username='demo-user')
        self.assertTrue(user.check_password('demo-pass1!'))

        login_response = self.client.post(
            '/api/mes-login',
            data={'userName': 'demo-user', 'password': 'demo-pass1!'},
            content_type='application/json',
        )
        self.assertEqual(login_response.status_code, 200, login_response.content)
        self.assertEqual(get_user_model().objects.filter(username='demo-user').count(), 1)

    def test_local_login_enforces_username_and_password_requirements(self):
        invalid_credentials = [
            ('user', 'valid1!'),
            ('valid-user', 'a1!'),
            ('valid-user', 'missingspecial1'),
            ('valid-user', 'missingnumber!'),
        ]
        for username, password in invalid_credentials:
            with self.subTest(username=username, password=password):
                response = self.client.post(
                    '/api/mes-login',
                    data={'userName': username, 'password': password},
                    content_type='application/json',
                )
                self.assertEqual(response.status_code, 400, response.content)

        self.assertEqual(get_user_model().objects.count(), 0)

    def test_existing_username_cannot_be_replaced_with_a_different_password(self):
        self.client.post(
            '/api/mes-login',
            data={'userName': 'saved-user', 'password': 'saved-pass1!'},
            content_type='application/json',
        )
        response = self.client.post(
            '/api/mes-login',
            data={'userName': 'saved-user', 'password': 'other-pass2!'},
            content_type='application/json',
        )

        self.assertEqual(response.status_code, 401, response.content)
        user = get_user_model().objects.get(username='saved-user')
        self.assertTrue(user.check_password('saved-pass1!'))
        self.assertFalse(user.check_password('other-pass2!'))

    def test_guest_login_returns_token_without_password(self):
        response = self.client.post('/api/guest-login', data={}, content_type='application/json')

        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn('django_token_key', response.json())
        guest_user = get_user_model().objects.get(username='dashboard-guest')
        self.assertFalse(guest_user.has_usable_password())

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
        self.assertTrue(rows[0].get('ProductName', '').startswith('PN-'))
        self.assertGreater(rows[0].get('OrderQty', 0), 0)
        self.assertTrue(rows[0].get('PlannedStartDate'))
