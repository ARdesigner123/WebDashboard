from django.db import models

class UrgentWO(models.Model):
    wo_number = models.CharField(max_length=100, primary_key=True, db_column='wo_number')
    list_type = models.CharField(max_length=20, default='wo', db_column='list_type')
    sort_index = models.IntegerField(default=0, db_column='sort_index')
    created_at = models.DateTimeField(auto_now_add=True, db_column='created_at')

    class Meta:
        db_table = 'urgent_wos'
        ordering = ['sort_index', '-created_at']

    def __str__(self):
        return f"{self.wo_number} ({self.list_type})"

class OnlineUser(models.Model):
    user_id = models.CharField(max_length=100, primary_key=True, db_column='user_id')
    username = models.CharField(max_length=100, default='Anonymous', db_column='username', null=True, blank=True)
    computer_name = models.CharField(max_length=100, default='Workstation', db_column='computer_name', null=True, blank=True)
    user_join = models.DateTimeField(db_column='user_join')
    user_logout = models.DateTimeField(db_column='user_logout')
    active_time = models.IntegerField(default=0, db_column='active_time')

    class Meta:
        db_table = 'users'

    def __str__(self):
        return f"{self.username} ({self.user_id})"

class WOHistory(models.Model):
    id = models.AutoField(primary_key=True, db_column='id')
    wo_number = models.CharField(max_length=100, db_column='wo_number')
    completion_pct = models.FloatField(db_column='completion_pct')
    recorded_at = models.DateTimeField(db_column='recorded_at')

    class Meta:
        db_table = 'wo_history'

    def __str__(self):
        return f"{self.wo_number} - {self.completion_pct}%"
